import { Type } from "typebox";

import { searchQFaceCatalog } from "../gateway/qface.ts";
import { isAdmin } from "./access.ts";
import { resolveAuthorizedChat } from "./chat.ts";
import { defineTool } from "./define.ts";

export const qqDirectoryTool = defineTool({
  name: "qq_directory",
  description:
    "查询已连接的 QQ 群列表（groups）、指定群成员（members）、好友列表（friends），或按姓名/昵称/群名片/QQ 号跨通行证、好友及共同群查找联系人（users），返回 g_*/u_* 引用句柄。",
  available: (services) =>
    services.gateway.configured || services.directory.enabled,
  parameters: Type.Object(
    {
      scope: Type.Union([
        Type.Literal("groups"),
        Type.Literal("members"),
        Type.Literal("friends"),
        Type.Literal("users"),
      ]),
      groupRef: Type.Optional(Type.String()),
      query: Type.Optional(Type.String()),
      page: Type.Optional(Type.Integer({ minimum: 1 })),
      pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 60 })),
    },
    { additionalProperties: false },
  ),
  execute: async (args, ctx) => {
    const { gateway, directory } = ctx.services;
    const { ids } = ctx;

    const page = args.page ?? 1;
    const pageSize = args.pageSize ?? 30;
    const offset = (page - 1) * pageSize;
    const rawQuery = args.query?.trim() ?? "";
    const kw = rawQuery.toLowerCase();

    if (args.scope === "users") {
      if (!isAdmin(ctx.actor)) {
        throw new Error("仅管理员或网协管理层可跨来源检索联系人");
      }

      if (!rawQuery) {
        throw new Error("请提供姓名、昵称、群名片或 QQ 号作为 query");
      }

      const byQQ = new Map<
        string,
        {
          userRef: string;
          name: string;
          sources: Set<string>;
          positions?: string[];
          groups: string[];
        }
      >();

      function addMatch(
        qq: string,
        name: string,
        source: string,
        extra?: { positions?: string[]; groupName?: string },
      ) {
        const cleanQQ = qq.trim();

        if (!cleanQQ) {
          return;
        }

        const existing = byQQ.get(cleanQQ);

        if (existing) {
          existing.sources.add(source);
          if (extra?.positions?.length && !existing.positions?.length) {
            existing.positions = extra.positions;
          }

          if (extra?.groupName && !existing.groups.includes(extra.groupName)) {
            existing.groups.push(extra.groupName);
          }

          return;
        }

        byQQ.set(cleanQQ, {
          userRef: ids.userRef(cleanQQ),
          name: name.trim() || cleanQQ,
          sources: new Set([source]),
          ...(extra?.positions?.length ? { positions: extra.positions } : {}),
          groups: extra?.groupName ? [extra.groupName] : [],
        });
      }

      if (directory.enabled) {
        const kcMatches = await directory
          .searchMembers(rawQuery)
          .catch(() => []);

        for (const user of kcMatches) {
          if (user.qq) {
            addMatch(user.qq, user.name, "keycloak", {
              positions: user.permissions.positions.map((p) => p.label),
            });
          }
        }
      }

      if (gateway.configured) {
        const friends = await gateway.getFriendList().catch(() => []);

        for (const f of friends) {
          const qq = String(f.user_id);
          const text = `${f.remark || ""} ${f.nickname} ${qq}`.toLowerCase();

          if (text.includes(kw)) {
            addMatch(qq, f.remark || f.nickname, "friend");
          }
        }

        const groupsToScan = args.groupRef
          ? [
              (() => {
                const resolved = resolveAuthorizedChat(ctx, args.groupRef);

                if (resolved.kind !== "group") {
                  throw new Error("groupRef 必须指向 QQ 群");
                }

                return { group_id: Number(resolved.chatId), group_name: "" };
              })(),
            ]
          : byQQ.size === 0
            ? await gateway.getGroupList().catch(() => [])
            : [];

        for (const g of groupsToScan) {
          const members = await gateway
            .getGroupMemberList(String(g.group_id))
            .catch(() => []);

          for (const m of members) {
            const qq = String(m.user_id);
            const text = `${m.card || ""} ${m.nickname} ${qq}`.toLowerCase();

            if (text.includes(kw)) {
              addMatch(qq, m.card?.trim() || m.nickname, "group_member", {
                groupName: g.group_name || undefined,
              });
            }
          }
        }
      }

      const items = [...byQQ.values()].map((entry) => ({
        userRef: entry.userRef,
        name: entry.name,
        sources: [...entry.sources],
        ...(entry.positions ? { positions: entry.positions } : {}),
        ...(entry.groups.length > 0 ? { sharedGroups: entry.groups } : {}),
      }));

      return {
        total: items.length,
        page,
        items: items.slice(offset, offset + pageSize),
      };
    }

    if (!gateway.configured) {
      throw new Error("message-gateway 未配置，无法查询 QQ 通讯录");
    }

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
    '检索全部 380+ QQNT 官方原生表情及 53 个白名单 Unicode 回应 Emoji（支持按中文名称、关键词联想词、Emoji 字符或数字 ID 搜索）。查到后在最终回复 JSON 的 units 中使用 kind="qq_reaction"（不要把 qq_reaction 当工具调用）。',
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

export const recallMessageTool = defineTool({
  name: "recall_message",
  description:
    "撤回 QQ 消息（调用 OneBot delete_msg）。树莓娘发错话/发错图、或管理员要求撤回时调用：传 messageRef（上下文里的 quoteRef / replyToQuoteRef 等 m_* 句柄）可撤回指定消息；省略 messageRef 时自动撤回目标会话中树莓娘最近一条未撤回消息。权限：撤回他人消息或跨会话撤回仅管理员可用（且撤回他人群消息需机器人具备群主/群管理权限）；撤回自己发的消息受 QQ 2 分钟时限约束。",
  available: (services) => services.gateway.configured,
  mutating: true,
  parameters: Type.Object(
    {
      messageRef: Type.Optional(Type.String({ minLength: 1 })),
      targetRef: Type.Optional(Type.String({ minLength: 1 })),
    },
    { additionalProperties: false },
  ),
  execute: async (args, ctx) => {
    const { store, gateway } = ctx.services;
    const admin = isAdmin(ctx.actor);

    let target = null;

    if (args.messageRef?.trim()) {
      const meta = ctx.ids.resolveMessageMeta(args.messageRef.trim());
      const targetChatKey = meta.chatKey ?? ctx.actor.chatKey;

      if (targetChatKey !== ctx.actor.chatKey && !admin) {
        throw new Error("仅管理员或网协管理层可跨会话撤回消息");
      }

      target = await store.messages.findByOnebotId(targetChatKey, meta.rawId);
      if (!target) {
        throw new Error(`未找到消息 ${args.messageRef}`);
      }
    } else {
      const chat = resolveAuthorizedChat(ctx, args.targetRef);
      const recent = await store.messages.recent(chat.targetChatKey, 30);

      for (let i = recent.length - 1; i >= 0; i -= 1) {
        const msg = recent[i]!;

        if (msg.isBot && msg.recalledAt === null) {
          target = msg;

          break;
        }
      }

      if (!target) {
        throw new Error("近期没有可撤回的树莓娘消息");
      }
    }

    if (target.chatKey !== ctx.actor.chatKey && !admin) {
      throw new Error("仅管理员或网协管理层可跨会话撤回消息");
    }

    if (!target.isBot) {
      if (!admin) {
        throw new Error("仅管理员或网协管理层可要求撤回他人的消息");
      }

      if (target.kind !== "group") {
        throw new Error("私聊无法撤回对方发送的消息");
      }
    }

    if (target.recalledAt !== null) {
      return {
        ok: true,
        alreadyRecalled: true,
        messageRef: ctx.ids.messageRef(target.onebotMessageId, target.chatKey),
      };
    }

    await gateway.recallMessage(target.onebotMessageId);
    await store.messages.markRecalled(
      target.chatKey,
      target.onebotMessageId,
      Date.now(),
    );

    return {
      ok: true,
      recalled: true,
      isBotMessage: target.isBot,
      messageRef: ctx.ids.messageRef(target.onebotMessageId, target.chatKey),
      preview: target.text.slice(0, 80),
    };
  },
});
