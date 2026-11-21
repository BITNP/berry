import { Type } from "typebox";

import type { ModelIds } from "../agent/model-ids.ts";
import type { DirectoryUser } from "../identity/keycloak.ts";
import type { GuildAuditAction } from "../types.ts";
import { errorMessage } from "../utils/time.ts";
import { defineTool } from "./define.ts";
import type { Tool, ToolContext } from "./types.ts";

const formatDirectoryMember = (user: DirectoryUser, ids: ModelIds) => ({
  subject: user.subject,
  name: user.name,
  username: user.username,
  qqBound: Boolean(user.qq),
  userRef: user.qq ? ids.userRef(user.qq) : null,
  admitted: user.permissions.admitted,
  manager: user.permissions.manager,
  positions: user.permissions.positions.map((p) => p.label),
});

function requireActorSubject(ctx: ToolContext): string {
  if (!ctx.actor.actorSubject) {
    throw new Error(
      "当前发言人尚未在网协通行证绑定 QQ 号，无法代理查询或操作公会看板",
    );
  }

  return ctx.actor.actorSubject;
}

async function auditGuildMutation<
  R extends { id?: number; title?: string; url?: string },
>(
  ctx: ToolContext,
  action: GuildAuditAction,
  fallbackNodeId: number | null,
  fallbackTitle: string,
  requestPayload: unknown,
  fn: (actorSubject: string) => Promise<R>,
  summarizeResponse: (result: R) => unknown = (result) => ({
    id: result.id,
    url: result.url,
  }),
): Promise<R> {
  const actorSubject = requireActorSubject(ctx);
  const { store } = ctx.services;
  const { actor } = ctx;

  try {
    const result = await fn(actorSubject);

    await store.guildAudit.record({
      chatKey: actor.chatKey,
      qqUserId: actor.senderQQ ?? "",
      actorSubject,
      actorName: actor.actorName ?? actorSubject,
      action,
      nodeId: fallbackNodeId ?? result.id ?? null,
      targetTitle: result.title ?? fallbackTitle,
      requestJson: JSON.stringify(requestPayload),
      responseJson: JSON.stringify(summarizeResponse(result)),
    });

    return result;
  } catch (error) {
    await store.guildAudit.record({
      chatKey: actor.chatKey,
      qqUserId: actor.senderQQ ?? "",
      actorSubject,
      actorName: actor.actorName ?? actorSubject,
      action,
      nodeId: fallbackNodeId,
      targetTitle: fallbackTitle,
      requestJson: JSON.stringify(requestPayload),
      responseJson: "{}",
      error: errorMessage(error),
    });

    throw error;
  }
}

export const guildResolveMemberTool = defineTool({
  name: "guild_resolve_member",
  description:
    "通过姓名、用户名、QQ 号或 u_* 句柄查找网协 Keycloak 成员，返回 subject、姓名、职务、准入状态及对应的 u_* 句柄。",
  parameters: Type.Object(
    {
      query: Type.Optional(Type.String()),
      userRef: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
  ),
  execute: async (args, ctx) => {
    const { directory } = ctx.services;

    if (!directory.enabled) {
      throw new Error("Keycloak Admin API 未配置，无法查询成员身份");
    }

    if (args.userRef) {
      const user = await directory.byQQ(ctx.ids.resolveUser(args.userRef));

      return {
        matches: user ? [formatDirectoryMember(user, ctx.ids)] : [],
      };
    }

    const matches = await directory.searchMembers((args.query ?? "").trim());

    return {
      matches: matches.map((user) => formatDirectoryMember(user, ctx.ids)),
    };
  },
});

export const guildListTreeTool = defineTool({
  name: "guild_list_tree",
  description:
    "一次拉取公会看板完整节点树（所有顶层大节点及其层级子节点、完成状态、截止时间、标签与链接）。查看全局结构或核对所有顶层节点时优先调用此工具。",
  parameters: Type.Object(
    {
      rootId: Type.Optional(Type.Integer({ minimum: 1 })),
      maxDepth: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })),
    },
    { additionalProperties: false },
  ),
  execute: (args, ctx) =>
    ctx.services.guild.listNodeTree(requireActorSubject(ctx), {
      rootId: args.rootId,
      maxDepth: args.maxDepth,
    }),
});

export const guildSearchNodesTool = defineTool({
  name: "guild_search_nodes",
  description:
    "按关键词检索公会看板节点（按标题、标签或 ID 匹配；留空 query 返回前 100 个节点）。查看全部顶层节点请优先使用 guild_list_tree。",
  parameters: Type.Object(
    {
      query: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
    },
    { additionalProperties: false },
  ),
  execute: async (args, ctx) => {
    const nodes = await ctx.services.guild.searchNodes(
      requireActorSubject(ctx),
      args.query ?? "",
      args.limit ?? 100,
    );

    return { count: nodes.length, nodes };
  },
});

export const guildGetNodeTool = defineTool({
  name: "guild_get_node",
  description: "获取单个公会节点的详情、面包屑、负责人与子节点列表。",
  parameters: Type.Object(
    { nodeId: Type.Integer({ minimum: 1 }) },
    { additionalProperties: false },
  ),
  execute: (args, ctx) =>
    ctx.services.guild.getNode(requireActorSubject(ctx), args.nodeId),
});

export const guildNodeProgressTool = defineTool({
  name: "guild_node_progress",
  description: "读取公会节点最近的进展评论与描述变更。",
  parameters: Type.Object(
    {
      nodeId: Type.Integer({ minimum: 1 }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    },
    { additionalProperties: false },
  ),
  execute: (args, ctx) =>
    ctx.services.guild.listProgress(
      requireActorSubject(ctx),
      args.nodeId,
      args.limit ?? 20,
    ),
});

export const guildCreateNodeTool = defineTool({
  name: "guild_create_node",
  description:
    "代表当前发言人在公会看板创建任务/项目节点。公会看板仅用于项目管理及任务拆解，周报、会议纪要、复盘及归档型文档请写入 Bunko 云文档（通过 bunko_operator），不要作为公会节点创建。创建前先通过 guild_list_tree 确认现有层级及父节点 ID 以及成员 subject。",
  mutating: true,
  parameters: Type.Object(
    {
      parentId: Type.Optional(
        Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
      ),
      title: Type.String({ minLength: 1, maxLength: 200 }),
      description: Type.Optional(Type.String()),
      dueAt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      tags: Type.Optional(Type.Array(Type.String())),
      leaderSubjects: Type.Optional(Type.Array(Type.String())),
      memberSubjects: Type.Optional(Type.Array(Type.String())),
    },
    { additionalProperties: false },
  ),
  execute: (args, ctx) => {
    const payload = {
      parentId: args.parentId ?? null,
      title: args.title.trim(),
      description: args.description ?? "",
      dueAt: args.dueAt ?? null,
      tags: args.tags ?? [],
      leaderSubjects: args.leaderSubjects ?? [],
      memberSubjects: args.memberSubjects ?? [],
    };

    return auditGuildMutation(
      ctx,
      "create_node",
      null,
      payload.title,
      payload,
      (actorSubject) => ctx.services.guild.createNode(actorSubject, payload),
    );
  },
});

export const guildUpdateNodeTool = defineTool({
  name: "guild_update_node",
  description: "更新公会节点的标题、描述、截止时间、标签或完成状态。",
  mutating: true,
  parameters: Type.Object(
    {
      nodeId: Type.Integer({ minimum: 1 }),
      title: Type.String(),
      description: Type.String(),
      dueAt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      tags: Type.Optional(Type.Array(Type.String())),
      completed: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
  execute: (args, ctx) => {
    const payload = {
      title: args.title,
      description: args.description,
      dueAt: args.dueAt ?? null,
      tags: args.tags ?? [],
      completed: args.completed,
    };

    return auditGuildMutation(
      ctx,
      "update_node",
      args.nodeId,
      payload.title,
      payload,
      (actorSubject) =>
        ctx.services.guild.updateNode(actorSubject, args.nodeId, payload),
    );
  },
});

export const guildMoveNodeTool = defineTool({
  name: "guild_move_node",
  description: "将公会节点及其子树移动到另一个父节点下，或传 null 移为根节点。",
  mutating: true,
  parameters: Type.Object(
    {
      nodeId: Type.Integer({ minimum: 1 }),
      parentId: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    },
    { additionalProperties: false },
  ),
  execute: (args, ctx) =>
    auditGuildMutation(
      ctx,
      "move_node",
      args.nodeId,
      `#${args.nodeId}`,
      { nodeId: args.nodeId, parentId: args.parentId },
      (actorSubject) =>
        ctx.services.guild.moveNode(actorSubject, args.nodeId, args.parentId),
    ),
});

export const guildReplaceMembersTool = defineTool({
  name: "guild_replace_members",
  description:
    "全量替换公会节点的直接负责人（leaders，至少 1 人）和直接成员（members，不能和 leaders 重叠）。调整前应先调用 guild_get_node 查看现有人员，避免误删需保留的成员。",
  mutating: true,
  parameters: Type.Object(
    {
      nodeId: Type.Integer({ minimum: 1 }),
      leaders: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
      members: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    },
    { additionalProperties: false },
  ),
  execute: (args, ctx) => {
    const payload = {
      leaders: args.leaders,
      members: args.members ?? [],
    };

    return auditGuildMutation(
      ctx,
      "replace_members",
      args.nodeId,
      `#${args.nodeId}`,
      { nodeId: args.nodeId, ...payload },
      (actorSubject) =>
        ctx.services.guild.replaceMembers(actorSubject, args.nodeId, payload),
    );
  },
});

export const guildAddCommentTool = defineTool({
  name: "guild_add_comment",
  description: "在指定公会节点下发布一条进展评论。",
  mutating: true,
  parameters: Type.Object(
    {
      nodeId: Type.Integer({ minimum: 1 }),
      body: Type.String({ minLength: 1, maxLength: 5000 }),
    },
    { additionalProperties: false },
  ),
  execute: (args, ctx) => {
    const body = args.body.trim();

    return auditGuildMutation(
      ctx,
      "create_comment",
      args.nodeId,
      `#${args.nodeId}`,
      { nodeId: args.nodeId, body },
      (actorSubject) =>
        ctx.services.guild.addComment(actorSubject, args.nodeId, body),
      (comment) => comment,
    );
  },
});

export const guildTools: readonly Tool[] = [
  guildResolveMemberTool,
  guildListTreeTool,
  guildSearchNodesTool,
  guildGetNodeTool,
  guildNodeProgressTool,
  guildCreateNodeTool,
  guildUpdateNodeTool,
  guildMoveNodeTool,
  guildReplaceMembersTool,
  guildAddCommentTool,
];
