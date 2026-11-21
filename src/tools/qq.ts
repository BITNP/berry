import { Type } from "typebox";

import { searchQFaceCatalog } from "../gateway/qface.ts";
import { isAdmin } from "./access.ts";
import { resolveAuthorizedChat } from "./chat.ts";
import { defineTool } from "./define.ts";

export const qqDirectoryTool = defineTool({
  name: "qq_directory",
  description:
    "按关键词或分页查询已连接的 QQ 群列表、指定群的成员名单或好友列表，返回 g_*/u_* 引用句柄。",
  available: (services) => services.gateway.configured,
  parameters: Type.Object(
    {
      scope: Type.Union([
        Type.Literal("groups"),
        Type.Literal("members"),
        Type.Literal("friends"),
      ]),
      groupRef: Type.Optional(Type.String()),
      query: Type.Optional(Type.String()),
      page: Type.Optional(Type.Integer({ minimum: 1 })),
      pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 60 })),
    },
    { additionalProperties: false },
  ),
  execute: async (args, ctx) => {
    const { gateway } = ctx.services;
    const { ids } = ctx;

    const page = args.page ?? 1;
    const pageSize = args.pageSize ?? 30;
    const offset = (page - 1) * pageSize;
    const kw = args.query?.trim().toLowerCase() ?? "";

    if (args.scope === "groups") {
      if (!isAdmin(ctx.actor)) {
        throw new Error("仅管理员或网协管理层可查询机器人所在的 QQ 群列表");
      }

      const all = await gateway.getGroupList();
      const filtered = kw
        ? all.filter((g) => g.group_name.toLowerCase().includes(kw))
        : all;

      return {
        total: filtered.length,
        page,
        items: filtered.slice(offset, offset + pageSize).map((g) => ({
          groupRef: ids.groupRef(String(g.group_id)),
          name: g.group_name,
          memberCount: g.member_count ?? null,
        })),
      };
    }

    if (args.scope === "friends") {
      if (!isAdmin(ctx.actor)) {
        throw new Error("仅管理员或网协管理层可查询机器人好友列表");
      }

      const all = await gateway.getFriendList();
      const filtered = kw
        ? all.filter((f) =>
            `${f.remark || ""} ${f.nickname}`.toLowerCase().includes(kw),
          )
        : all;

      return {
        total: filtered.length,
        page,
        items: filtered.slice(offset, offset + pageSize).map((f) => ({
          userRef: ids.userRef(String(f.user_id)),
          nickname: f.remark || f.nickname,
        })),
      };
    }

    const resolved = resolveAuthorizedChat(ctx, args.groupRef);

    if (resolved.kind !== "group") {
      throw new Error("查询群成员需要提供 groupRef 或在群聊内调用");
    }

    const all = await gateway.getGroupMemberList(resolved.chatId);
    const filtered = kw
      ? all.filter((m) =>
          `${m.card || ""} ${m.nickname} ${m.role || ""}`
            .toLowerCase()
            .includes(kw),
        )
      : all;

    return {
      total: filtered.length,
      page,
      items: filtered.slice(offset, offset + pageSize).map((m) => ({
        userRef: ids.userRef(String(m.user_id)),
        name: m.card?.trim() || m.nickname,
        role: m.role ?? "member",
      })),
    };
  },
});

export const searchQqEmojisTool = defineTool({
  name: "search_qq_emojis",
  description:
    "检索全部 380+ QQNT 官方原生表情（支持按中文名称、关键词联想词或数字 ID 搜索，也可传入白名单内的常用 Unicode Emoji 查其回应码点）。",
  parameters: Type.Object(
    {
      query: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    },
    { additionalProperties: false },
  ),
  execute: async (args) =>
    searchQFaceCatalog(args.query ?? "", args.limit ?? 30),
});
