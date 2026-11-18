import { jsonrepair } from "jsonrepair";
import { Type } from "typebox";
import * as Value from "typebox/value";

import type { RuntimeSettings } from "../config/settings.ts";
import type { MessageGatewayClient } from "../gateway/client.ts";
import type { GuildInternalClient } from "../guild/client.ts";
import type { IdentityDirectory } from "../identity/keycloak.ts";
import type { KnowledgeBase } from "../knowledge/files.ts";
import type { McpHub } from "../mcp/hub.ts";
import type { MediaProcessor } from "../media/processor.ts";
import type { Store } from "../store/index.ts";
import type { ChatKey } from "../types.ts";
import { makeChatKey, parseChatKey } from "../types.ts";
import { errorMessage } from "../utils/time.ts";
import type { AgentTool } from "./loop.ts";
import { runChatToolLoop } from "./loop.ts";
import type { ModelIds } from "./model-ids.ts";

export type SubagentKind =
  | "chat_analyst"
  | "guild_operator"
  | "workspace_operator"
  | "chat_history"
  | "guild_inspector"
  | "knowledge";

type NormalizedSubagentKind =
  "chat_analyst" | "guild_operator" | "workspace_operator";

const subagentOutputSchema = Type.Object(
  {
    brief: Type.String({ minLength: 1, maxLength: 4000 }),
    references: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: false },
);

export interface SubagentResult {
  brief: string;
  references: string[];
  mutated: boolean;
}

function normalizeKind(kind: SubagentKind): NormalizedSubagentKind {
  switch (kind) {
    case "chat_history":
    case "chat_analyst": {
      return "chat_analyst";
    }

    case "guild_inspector":
    case "guild_operator": {
      return "guild_operator";
    }

    case "knowledge":
    case "workspace_operator": {
      return "workspace_operator";
    }
  }
}

export async function runSubagent(options: {
  kind: SubagentKind;
  task: string;
  chatKey: ChatKey;
  senderQQ: string | null;
  actorSubject: string | null;
  actorName: string | null;
  actorIsAdmin: boolean;
  settings: RuntimeSettings;
  store: Store;
  gateway: MessageGatewayClient;
  media: MediaProcessor;
  knowledge: KnowledgeBase;
  directory: IdentityDirectory;
  guild: GuildInternalClient;
  mcp: McpHub;
  ids: ModelIds;
}): Promise<SubagentResult> {
  const {
    chatKey,
    senderQQ,
    actorSubject,
    actorName,
    actorIsAdmin,
    store,
    gateway,
    media,
    knowledge,
    directory,
    guild,
    mcp,
    ids,
  } = options;
  const kind = normalizeKind(options.kind);
  const tools: AgentTool[] = [];
  let roleDesc = "";

  function resolveAuthorizedChat(rawTargetRef?: unknown): {
    targetChatKey: ChatKey;
    kind: "group" | "private";
    chatId: string;
  } {
    const targetChatKey =
      typeof rawTargetRef === "string" && rawTargetRef.trim()
        ? ids.resolveTargetChatKey(rawTargetRef)
        : chatKey;
    const parsed = parseChatKey(targetChatKey);

    if (
      parsed.kind === "private" &&
      parsed.chatId !== senderQQ &&
      !actorIsAdmin
    ) {
      throw new Error("无权读取其他用户的私聊消息");
    }

    return { targetChatKey, kind: parsed.kind, chatId: parsed.chatId };
  }

  if (kind === "chat_analyst") {
    roleDesc =
      "你是隔离运行的聊天消息及媒体分析子代理。可列出会话并跨群检索历史消息（含图片识图、语音转写、合并转发与表情回应），按要求总结结论并保留相关 m_* 引用。只返回精炼结论，绝不把整段原始日志搬进主对话。";

    tools.push(
      {
        name: "list_chats",
        description:
          "列出已登记的群聊和当前发言人自己的私聊会话（返回 targetRef、标题与模式）。可传 includeGatewayGroups=true 补充拉取网关群列表。",
        parameters: {
          type: "object",
          properties: {
            includeGatewayGroups: { type: "boolean" },
          },
          additionalProperties: false,
        },
        execute: async (args) => {
          const all = await store.chats.list();
          const visible = all.filter(
            (c) => c.kind === "group" || c.chatId === senderQQ || actorIsAdmin,
          );
          const seenKeys = new Set<string>(visible.map((c) => c.chatKey));
          const items = visible.map((c) => ({
            targetRef:
              c.kind === "group"
                ? ids.groupRef(c.chatId)
                : ids.userRef(c.chatId),
            kind: c.kind,
            title: c.title,
            enabled: c.enabled,
            triggerMode: c.triggerMode,
          }));

          if (args.includeGatewayGroups && gateway.configured) {
            const gwGroups = await gateway.getGroupList().catch(() => []);

            for (const g of gwGroups) {
              const key = makeChatKey("group", String(g.group_id));

              if (!seenKeys.has(key)) {
                seenKeys.add(key);
                items.push({
                  targetRef: ids.groupRef(String(g.group_id)),
                  kind: "group",
                  title: g.group_name,
                  enabled: true,
                  triggerMode: options.settings.policy.groupDefaultMode,
                });
              }
            }
          }

          return { total: items.length, chats: items };
        },
      },
      {
        name: "search_chat_messages",
        description:
          "按关键词或时间范围搜索指定会话的历史消息（留空 targetRef 则检索当前会话，传 g_* 可跨群检索）。",
        parameters: {
          type: "object",
          properties: {
            targetRef: { type: "string" },
            query: { type: "string" },
            startTimeIso: { type: "string" },
            endTimeIso: { type: "string" },
            limit: { type: "integer", minimum: 1, maximum: 120 },
          },
          additionalProperties: false,
        },
        execute: async (args) => {
          const { targetChatKey, kind: targetKind } = resolveAuthorizedChat(
            args.targetRef,
          );
          const startTimeMs = args.startTimeIso
            ? Date.parse(String(args.startTimeIso))
            : undefined;
          const endTimeMs = args.endTimeIso
            ? Date.parse(String(args.endTimeIso))
            : undefined;
          const rows = await store.messages.search(targetChatKey, {
            query: typeof args.query === "string" ? args.query : undefined,
            startTimeMs: Number.isFinite(startTimeMs) ? startTimeMs : undefined,
            endTimeMs: Number.isFinite(endTimeMs) ? endTimeMs : undefined,
            limit: typeof args.limit === "number" ? args.limit : 60,
          });
          const enriched = await media.enrichMessagesText(targetChatKey, rows);

          return {
            chatType: targetKind,
            count: rows.length,
            messages: rows.map((row) => ({
              id: row.id,
              quoteRef: ids.messageRef(row.onebotMessageId, targetChatKey),
              userRef: ids.userRef(row.userId),
              senderName: row.isBot ? "树莓娘(bot)" : row.senderName,
              text: (enriched.get(row.id) ?? row.text).slice(0, 800),
              sentAt: new Date(row.sentAt).toISOString(),
            })),
          };
        },
      },
      {
        name: "read_chat_window",
        description:
          "读取指定会话最近的连续消息窗口（含媒体识别摘要与表情回应；留空 targetRef 则读当前会话，传 g_* 可跨群读取）。",
        parameters: {
          type: "object",
          properties: {
            targetRef: { type: "string" },
            beforeId: { type: "integer" },
            limit: { type: "integer", minimum: 1, maximum: 120 },
          },
          additionalProperties: false,
        },
        execute: async (args) => {
          const { targetChatKey } = resolveAuthorizedChat(args.targetRef);
          const rows = await store.messages.recent(
            targetChatKey,
            typeof args.limit === "number" ? args.limit : 50,
            {
              beforeId:
                typeof args.beforeId === "number" ? args.beforeId : undefined,
            },
          );
          const [enriched, reactionMap] = await Promise.all([
            media.enrichMessagesText(targetChatKey, rows),
            store.reactions.aggregateForMessages(
              targetChatKey,
              rows.map((r) => r.onebotMessageId),
            ),
          ]);

          return {
            count: rows.length,
            messages: rows.map((row) => ({
              id: row.id,
              quoteRef: ids.messageRef(row.onebotMessageId, targetChatKey),
              userRef: ids.userRef(row.userId),
              senderName: row.isBot ? "树莓娘(bot)" : row.senderName,
              text: (enriched.get(row.id) ?? row.text).slice(0, 800),
              reactions: reactionMap.get(row.onebotMessageId) ?? [],
              sentAt: new Date(row.sentAt).toISOString(),
            })),
          };
        },
      },
      {
        name: "inspect_media",
        description:
          "查看消息附带的图片识图结论、语音转写文本或合并转发内容；inspectNow=true 时立即触发未完成的识别。",
        parameters: {
          type: "object",
          properties: {
            targetRef: { type: "string" },
            messageId: { type: "integer", minimum: 1 },
            quoteRef: { type: "string" },
            inspectNow: { type: "boolean" },
          },
          additionalProperties: false,
        },
        execute: async (args) => {
          let targetId =
            typeof args.messageId === "number" ? args.messageId : null;

          if (!targetId && args.quoteRef) {
            const meta = ids.resolveMessageMeta(String(args.quoteRef));
            const lookupKey = meta.chatKey
              ? meta.chatKey
              : resolveAuthorizedChat(args.targetRef).targetChatKey;
            const parsedLookup = parseChatKey(lookupKey);

            if (
              parsedLookup.kind === "private" &&
              parsedLookup.chatId !== senderQQ &&
              !actorIsAdmin
            ) {
              throw new Error("无权读取其他用户的私聊媒体");
            }

            const msg = await store.messages.findByOnebotId(
              lookupKey,
              meta.rawId,
            );

            targetId = msg?.id ?? null;
          }

          if (!targetId) {
            throw new Error("请提供有效的 messageId 或 quoteRef");
          }

          const msgRow = await store.messages.get(targetId);

          if (!msgRow) {
            throw new Error("未找到指定消息");
          }

          if (
            msgRow.kind === "private" &&
            msgRow.chatId !== senderQQ &&
            !actorIsAdmin
          ) {
            throw new Error("无权读取其他用户的私聊媒体");
          }

          await media.waitForMessages([targetId]);
          let assets = await store.assets.listForMessage(targetId);

          if (args.inspectNow) {
            assets = await Promise.all(
              assets.map((asset) =>
                asset.status === "ready" && asset.transcript
                  ? Promise.resolve(asset)
                  : media.inspectAssetOnDemand(asset.id),
              ),
            );
          }

          return { messageId: targetId, assets };
        },
      },
      {
        name: "qq_directory",
        description:
          "分页查询已连接的 QQ 群列表、指定群的成员名单，或好友列表。返回的编号统一转换为 g_*/u_* 引用句柄。",
        parameters: {
          type: "object",
          properties: {
            scope: { type: "string", enum: ["groups", "members", "friends"] },
            groupRef: { type: "string" },
            page: { type: "integer", minimum: 1 },
            pageSize: { type: "integer", minimum: 1, maximum: 100 },
          },
          required: ["scope"],
          additionalProperties: false,
        },
        execute: async (args) => {
          if (!gateway.configured) {
            throw new Error("message-gateway 未配置，无法查询 QQ 通讯录");
          }

          const page = typeof args.page === "number" ? args.page : 1;
          const pageSize =
            typeof args.pageSize === "number" ? args.pageSize : 40;
          const offset = (page - 1) * pageSize;
          const scope = String(args.scope);

          if (scope === "groups") {
            const all = await gateway.getGroupList();

            return {
              total: all.length,
              page,
              items: all.slice(offset, offset + pageSize).map((g) => ({
                groupRef: ids.groupRef(String(g.group_id)),
                name: g.group_name,
                memberCount: g.member_count ?? null,
              })),
            };
          }

          if (scope === "friends") {
            const all = await gateway.getFriendList();

            return {
              total: all.length,
              page,
              items: all.slice(offset, offset + pageSize).map((f) => ({
                userRef: ids.userRef(String(f.user_id)),
                nickname: f.remark || f.nickname,
              })),
            };
          }

          const resolved = resolveAuthorizedChat(args.groupRef);

          if (resolved.kind !== "group") {
            throw new Error("查询群成员需要提供 groupRef 或在群聊内调用");
          }

          const all = await gateway.getGroupMemberList(resolved.chatId);

          return {
            total: all.length,
            page,
            items: all.slice(offset, offset + pageSize).map((m) => ({
              userRef: ids.userRef(String(m.user_id)),
              name: m.card?.trim() || m.nickname,
              role: m.role ?? "member",
            })),
          };
        },
      },
    );
  } else if (kind === "guild_operator") {
    roleDesc =
      "你是隔离运行的公会看板协作子代理。按发言人权限检索成员身份与公会节点，必要时执行创建、更新节点或发布评论，并在完成后返回精炼简报与节点直达链接。";

    if (!guild.enabled) {
      return {
        brief: "公会内部服务接口未配置，无法操作公会看板。",
        references: [],
        mutated: false,
      };
    }

    if (!actorSubject) {
      return {
        brief:
          "当前发言人尚未在网协通行证绑定 QQ 号，无法代理查询或操作公会看板。请先前往网协通行证绑定 QQ 号。",
        references: [],
        mutated: false,
      };
    }

    const activeSubject = actorSubject;

    tools.push(
      {
        name: "guild_resolve_member",
        description:
          "通过姓名、用户名、QQ 号或 u_* 句柄查找网协 Keycloak 成员，返回 subject、姓名、职务与准入状态。",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string" },
            userRef: { type: "string" },
          },
          additionalProperties: false,
        },
        execute: async (args) => {
          if (!directory.enabled) {
            throw new Error("Keycloak Admin API 未配置，无法查询成员身份");
          }

          if (args.userRef) {
            const qq = ids.resolveUser(String(args.userRef));
            const user = await directory.byQQ(qq);

            return {
              matches: user
                ? [
                    {
                      subject: user.subject,
                      name: user.name,
                      username: user.username,
                      admitted: user.permissions.admitted,
                      manager: user.permissions.manager,
                      positions: user.permissions.positions.map((p) => p.label),
                    },
                  ]
                : [],
            };
          }

          const query = String(args.query ?? "").trim();
          const matches = await directory.searchMembers(query);

          return {
            matches: matches.map((user) => ({
              subject: user.subject,
              name: user.name,
              username: user.username,
              qqBound: Boolean(user.qq),
              admitted: user.permissions.admitted,
              manager: user.permissions.manager,
              positions: user.permissions.positions.map((p) => p.label),
            })),
          };
        },
      },
      {
        name: "guild_search_nodes",
        description: "检索公会看板节点列表（按标题、标签或 ID 匹配）。",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
          additionalProperties: false,
        },
        execute: async (args) => ({
          nodes: await guild.searchNodes(
            activeSubject,
            String(args.query ?? ""),
          ),
        }),
      },
      {
        name: "guild_get_node",
        description: "获取单个公会节点的详情、面包屑、负责人与子节点列表。",
        parameters: {
          type: "object",
          properties: { nodeId: { type: "integer", minimum: 1 } },
          required: ["nodeId"],
          additionalProperties: false,
        },
        execute: (args) => guild.getNode(activeSubject, Number(args.nodeId)),
      },
      {
        name: "guild_node_progress",
        description: "读取公会节点最近的进展评论与描述变更。",
        parameters: {
          type: "object",
          properties: {
            nodeId: { type: "integer", minimum: 1 },
            limit: { type: "integer", minimum: 1, maximum: 50 },
          },
          required: ["nodeId"],
          additionalProperties: false,
        },
        execute: (args) =>
          guild.listProgress(
            activeSubject,
            Number(args.nodeId),
            typeof args.limit === "number" ? args.limit : 20,
          ),
      },
      {
        name: "guild_create_node",
        description:
          "代表当前发言人在公会看板创建根节点或子节点。创建前应先确认父节点 ID 与成员 subject。",
        mutating: true,
        parameters: {
          type: "object",
          properties: {
            parentId: {
              anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }],
            },
            title: { type: "string", minLength: 1, maxLength: 200 },
            description: { type: "string" },
            dueAt: { anyOf: [{ type: "string" }, { type: "null" }] },
            tags: { type: "array", items: { type: "string" } },
            leaderSubjects: { type: "array", items: { type: "string" } },
            memberSubjects: { type: "array", items: { type: "string" } },
          },
          required: ["title"],
          additionalProperties: false,
        },
        execute: async (args) => {
          const payload = {
            parentId:
              args.parentId === undefined || args.parentId === null
                ? null
                : Number(args.parentId),
            title: String(args.title ?? "").trim(),
            description:
              typeof args.description === "string" ? args.description : "",
            dueAt:
              args.dueAt === undefined || args.dueAt === null
                ? null
                : String(args.dueAt),
            tags: Array.isArray(args.tags) ? args.tags.map(String) : [],
            leaderSubjects: Array.isArray(args.leaderSubjects)
              ? args.leaderSubjects.map(String)
              : [],
            memberSubjects: Array.isArray(args.memberSubjects)
              ? args.memberSubjects.map(String)
              : [],
          };

          try {
            const detail = await guild.createNode(activeSubject, payload);

            await store.guildAudit.record({
              chatKey,
              qqUserId: senderQQ ?? "",
              actorSubject: activeSubject,
              actorName: actorName ?? activeSubject,
              action: "create_node",
              nodeId: detail.id,
              targetTitle: detail.title,
              requestJson: JSON.stringify(payload),
              responseJson: JSON.stringify({ id: detail.id, url: detail.url }),
            });

            return detail;
          } catch (error) {
            await store.guildAudit.record({
              chatKey,
              qqUserId: senderQQ ?? "",
              actorSubject: activeSubject,
              actorName: actorName ?? activeSubject,
              action: "create_node",
              nodeId: null,
              targetTitle: payload.title,
              requestJson: JSON.stringify(payload),
              responseJson: "{}",
              error: errorMessage(error),
            });

            throw error;
          }
        },
      },
      {
        name: "guild_update_node",
        description: "更新公会节点的标题、描述、截止时间、标签或完成状态。",
        mutating: true,
        parameters: {
          type: "object",
          properties: {
            nodeId: { type: "integer", minimum: 1 },
            title: { type: "string" },
            description: { type: "string" },
            dueAt: { anyOf: [{ type: "string" }, { type: "null" }] },
            tags: { type: "array", items: { type: "string" } },
            completed: { type: "boolean" },
          },
          required: ["nodeId", "title", "description", "completed"],
          additionalProperties: false,
        },
        execute: async (args) => {
          const nodeId = Number(args.nodeId);
          const payload = {
            title: String(args.title ?? ""),
            description: String(args.description ?? ""),
            dueAt:
              args.dueAt === undefined || args.dueAt === null
                ? null
                : String(args.dueAt),
            tags: Array.isArray(args.tags) ? args.tags.map(String) : [],
            completed: Boolean(args.completed),
          };

          try {
            const detail = await guild.updateNode(
              activeSubject,
              nodeId,
              payload,
            );

            await store.guildAudit.record({
              chatKey,
              qqUserId: senderQQ ?? "",
              actorSubject: activeSubject,
              actorName: actorName ?? activeSubject,
              action: "update_node",
              nodeId,
              targetTitle: detail.title,
              requestJson: JSON.stringify(payload),
              responseJson: JSON.stringify({ id: detail.id, url: detail.url }),
            });

            return detail;
          } catch (error) {
            await store.guildAudit.record({
              chatKey,
              qqUserId: senderQQ ?? "",
              actorSubject: activeSubject,
              actorName: actorName ?? activeSubject,
              action: "update_node",
              nodeId,
              targetTitle: payload.title,
              requestJson: JSON.stringify(payload),
              responseJson: "{}",
              error: errorMessage(error),
            });

            throw error;
          }
        },
      },
      {
        name: "guild_add_comment",
        description: "在指定公会节点下发布一条进展评论。",
        mutating: true,
        parameters: {
          type: "object",
          properties: {
            nodeId: { type: "integer", minimum: 1 },
            body: { type: "string", minLength: 1, maxLength: 5000 },
          },
          required: ["nodeId", "body"],
          additionalProperties: false,
        },
        execute: async (args) => {
          const nodeId = Number(args.nodeId);
          const body = String(args.body ?? "").trim();

          try {
            const comment = await guild.addComment(activeSubject, nodeId, body);

            await store.guildAudit.record({
              chatKey,
              qqUserId: senderQQ ?? "",
              actorSubject: activeSubject,
              actorName: actorName ?? activeSubject,
              action: "create_comment",
              nodeId,
              targetTitle: `#${nodeId}`,
              requestJson: JSON.stringify({ nodeId, body }),
              responseJson: JSON.stringify(comment),
            });

            return comment;
          } catch (error) {
            await store.guildAudit.record({
              chatKey,
              qqUserId: senderQQ ?? "",
              actorSubject: activeSubject,
              actorName: actorName ?? activeSubject,
              action: "create_comment",
              nodeId,
              targetTitle: `#${nodeId}`,
              requestJson: JSON.stringify({ nodeId, body }),
              responseJson: "{}",
              error: errorMessage(error),
            });

            throw error;
          }
        },
      },
    );
  } else {
    roleDesc =
      "你是隔离运行的资料库、记事本与外部 MCP 工具子代理。按要求检索文档、写入 notebooks/ 笔记或执行外部 MCP 工具，最后只返回精炼结果与出处。";
    tools.push(
      {
        name: "list_knowledge_files",
        description: "列出 knowledge 与 notebooks 目录中的文件。",
        parameters: {
          type: "object",
          properties: {
            scope: { type: "string", enum: ["all", "knowledge", "notebook"] },
            prefix: { type: "string" },
          },
          additionalProperties: false,
        },
        execute: (args) =>
          knowledge.listFiles(
            (args.scope as "all" | "knowledge" | "notebook") ?? "all",
            typeof args.prefix === "string" ? args.prefix : "",
          ),
      },
      {
        name: "search_knowledge",
        description: "在知识库与记事本中按字面检索。",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string" },
            scope: { type: "string", enum: ["all", "knowledge", "notebook"] },
          },
          required: ["query"],
          additionalProperties: false,
        },
        execute: (args) =>
          knowledge.search(
            String(args.query ?? ""),
            (args.scope as "all" | "knowledge" | "notebook") ?? "all",
          ),
      },
      {
        name: "read_knowledge_lines",
        description: "读取指定知识库或记事本文件的行片段。",
        parameters: {
          type: "object",
          properties: {
            scope: { type: "string", enum: ["knowledge", "notebook"] },
            path: { type: "string" },
            startLine: { type: "integer", minimum: 1 },
            endLine: { type: "integer", minimum: 1 },
          },
          required: ["scope", "path"],
          additionalProperties: false,
        },
        execute: (args) =>
          knowledge.readLines(
            args.scope as "knowledge" | "notebook",
            String(args.path ?? ""),
            typeof args.startLine === "number" ? args.startLine : 1,
            typeof args.endLine === "number" ? args.endLine : 120,
          ),
      },
      {
        name: "notebook_write",
        description: "新建或更新记事本（notebooks/）内的 Markdown 文档。",
        mutating: true,
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            content: { type: "string" },
            mode: { type: "string", enum: ["replace", "append"] },
          },
          required: ["path", "content"],
          additionalProperties: false,
        },
        execute: (args) =>
          knowledge.writeNotebook(
            String(args.path ?? ""),
            String(args.content ?? ""),
            (args.mode as "replace" | "append") ?? "replace",
          ),
      },
      {
        name: "notebook_delete",
        description: "删除记事本（notebooks/）内指定的 Markdown 文档。",
        mutating: true,
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
          additionalProperties: false,
        },
        execute: (args) => knowledge.deleteNotebook(String(args.path ?? "")),
      },
    );

    for (const remote of mcp.tools) {
      tools.push({
        name: remote.exposedName,
        description: remote.description,
        parameters: remote.inputSchema,
        mutating: true,
        execute: (args) => mcp.call(remote.exposedName, args),
      });
    }
  }

  const systemPrompt = `${roleDesc}
完成检索或操作后，最终只输出一个 JSON 对象：{"brief":"简练准确的结论（不超过 1200 字）","references":["可选引用来源、节点URL或m_*句柄"]}`;

  const result = await runChatToolLoop<{
    brief: string;
    references?: string[];
  }>({
    purpose: "subagent",
    chatKey,
    settings: options.settings,
    store,
    systemPrompt,
    history: [],
    userContent: JSON.stringify({ task: options.task }),
    tools,
    maxRounds: 8,
    validateFinal: (text) => {
      try {
        let parsed: unknown;

        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = JSON.parse(jsonrepair(text));
        }

        if (!Value.Check(subagentOutputSchema, parsed)) {
          return {
            ok: false,
            issue:
              'JSON 必须包含非空字符串 "brief" 和可选字符串数组 "references"',
          };
        }

        return {
          ok: true,
          value: {
            brief: parsed.brief,
            references: parsed.references ?? [],
          },
        };
      } catch (error) {
        return {
          ok: false,
          issue: `JSON 解析失败: ${errorMessage(error)}`,
        };
      }
    },
  });

  return {
    brief: result.structured.brief,
    references: result.structured.references ?? [],
    mutated: result.mutated,
  };
}
