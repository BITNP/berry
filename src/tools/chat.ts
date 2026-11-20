import { Type } from "typebox";

import type { ChatKey } from "../types.ts";
import { makeChatKey, parseChatKey } from "../types.ts";
import type { ToolActor, ToolContext, ToolDefinition } from "./types.ts";
import { defineTool } from "./types.ts";

export function assertCanReadChat(
  actor: ToolActor,
  kind: "group" | "private",
  chatId: string,
): void {
  if (kind === "private" && chatId !== actor.senderQQ && !actor.actorIsAdmin) {
    throw new Error("无权读取其他用户的私聊消息");
  }
}

export function resolveAuthorizedChat(
  ctx: ToolContext,
  rawTargetRef?: string,
): {
  targetChatKey: ChatKey;
  kind: "group" | "private";
  chatId: string;
} {
  const targetChatKey = rawTargetRef?.trim()
    ? ctx.ids.resolveTargetChatKey(rawTargetRef)
    : ctx.actor.chatKey;
  const parsed = parseChatKey(targetChatKey);

  assertCanReadChat(ctx.actor, parsed.kind, parsed.chatId);

  return { targetChatKey, kind: parsed.kind, chatId: parsed.chatId };
}

export const listChatsTool = defineTool({
  name: "list_chats",
  description:
    "列出已登记的群聊和当前发言人自己的私聊会话（返回 targetRef、标题与模式）。可传 includeGatewayGroups=true 补充拉取网关群列表。",
  parameters: Type.Object(
    {
      includeGatewayGroups: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  ),
  execute: async (args, ctx) => {
    const { store, gateway } = ctx.services;
    const settings = ctx.services.getSettings();
    const { actor, ids } = ctx;
    const all = await store.chats.list();
    const visible = all.filter(
      (c) =>
        c.kind === "group" || c.chatId === actor.senderQQ || actor.actorIsAdmin,
    );
    const seenKeys = new Set<string>(visible.map((c) => c.chatKey));
    const items = visible.map((c) => ({
      targetRef:
        c.kind === "group" ? ids.groupRef(c.chatId) : ids.userRef(c.chatId),
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
            triggerMode: settings.policy.groupDefaultMode,
          });
        }
      }
    }

    return { total: items.length, chats: items };
  },
});

export const searchChatMessagesTool = defineTool({
  name: "search_chat_messages",
  description:
    "按关键词或时间范围搜索指定会话的历史消息（留空 targetRef 则检索当前会话，传 g_* 可跨群检索；本地历史未覆盖 startTimeIso 时会自动向 QQ 网关向前拉取）。",
  parameters: Type.Object(
    {
      targetRef: Type.Optional(Type.String()),
      query: Type.Optional(Type.String()),
      startTimeIso: Type.Optional(Type.String()),
      endTimeIso: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 120 })),
    },
    { additionalProperties: false },
  ),
  execute: async (args, ctx) => {
    const { store, gateway, media } = ctx.services;
    const { ids } = ctx;
    const {
      targetChatKey,
      kind: targetKind,
      chatId: targetChatId,
    } = resolveAuthorizedChat(ctx, args.targetRef);
    const startTimeMs = args.startTimeIso
      ? Date.parse(args.startTimeIso)
      : undefined;
    const endTimeMs = args.endTimeIso ? Date.parse(args.endTimeIso) : undefined;
    const validStartMs = Number.isFinite(startTimeMs) ? startTimeMs : undefined;
    const validEndMs = Number.isFinite(endTimeMs) ? endTimeMs : undefined;

    if (gateway.configured) {
      await gateway.warmChatHistory(targetKind, targetChatId, 200);

      if (validStartMs !== undefined) {
        const oldestBefore = await store.messages.oldest(targetChatKey);

        if (!oldestBefore || oldestBefore.sentAt > validStartMs) {
          await gateway
            .syncChatHistory(targetKind, targetChatId, {
              mode: "older",
              count: 200,
              maxPages: 4,
              targetStartTimeMs: validStartMs,
            })
            .catch(() => undefined);
        }
      }
    }

    const rows = await store.messages.search(targetChatKey, {
      query: args.query,
      startTimeMs: validStartMs,
      endTimeMs: validEndMs,
      limit: args.limit ?? 60,
    });
    const [enriched, oldestAfter] = await Promise.all([
      media.enrichMessagesText(targetChatKey, rows),
      store.messages.oldest(targetChatKey),
    ]);

    return {
      chatType: targetKind,
      count: rows.length,
      localOldestSentAt: oldestAfter
        ? new Date(oldestAfter.sentAt).toISOString()
        : null,
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
});

export const readChatWindowTool = defineTool({
  name: "read_chat_window",
  description:
    "读取指定会话最近的连续消息窗口（含媒体识别摘要与表情回应；留空 targetRef 则读当前会话，传 g_* 可跨群读取；本地消息不足时会自动向 QQ 网关拉取补全）。",
  parameters: Type.Object(
    {
      targetRef: Type.Optional(Type.String()),
      beforeId: Type.Optional(Type.Integer()),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 120 })),
    },
    { additionalProperties: false },
  ),
  execute: async (args, ctx) => {
    const { store, gateway, media } = ctx.services;
    const { ids } = ctx;
    const {
      targetChatKey,
      kind: targetKind,
      chatId: targetChatId,
    } = resolveAuthorizedChat(ctx, args.targetRef);
    const limit = args.limit ?? 50;

    if (gateway.configured) {
      await gateway.warmChatHistory(
        targetKind,
        targetChatId,
        Math.max(100, limit),
      );
    }

    let rows = await store.messages.recent(targetChatKey, limit, {
      beforeId: args.beforeId,
    });

    if (rows.length < limit && gateway.configured) {
      const synced = await gateway
        .syncChatHistory(targetKind, targetChatId, {
          mode: "older",
          count: Math.max(100, limit),
          maxPages: 2,
        })
        .catch(() => null);

      if (synced && synced.imported > 0) {
        rows = await store.messages.recent(targetChatKey, limit, {
          beforeId: args.beforeId,
        });
      }
    }

    const [enriched, reactionMap, oldestAfter] = await Promise.all([
      media.enrichMessagesText(targetChatKey, rows),
      store.reactions.aggregateForMessages(
        targetChatKey,
        rows.map((r) => r.onebotMessageId),
      ),
      store.messages.oldest(targetChatKey),
    ]);

    return {
      count: rows.length,
      localOldestSentAt: oldestAfter
        ? new Date(oldestAfter.sentAt).toISOString()
        : null,
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
});

export const fetchOlderHistoryTool = defineTool({
  name: "fetch_older_history",
  description:
    "从 QQ 网关向前翻页拉取指定会话更早的历史消息并缓存到本地（按本地最早一条消息继续向前翻页）。当关键词检索未命中或需要查看更早几天的讨论时调用。",
  parameters: Type.Object(
    {
      targetRef: Type.Optional(Type.String()),
      pages: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })),
      countPerPage: Type.Optional(Type.Integer({ minimum: 50, maximum: 500 })),
    },
    { additionalProperties: false },
  ),
  execute: async (args, ctx) => {
    const { store, gateway } = ctx.services;

    if (!gateway.configured) {
      throw new Error("message-gateway 未配置，无法拉取远端历史消息");
    }

    const {
      targetChatKey,
      kind: targetKind,
      chatId: targetChatId,
    } = resolveAuthorizedChat(ctx, args.targetRef);
    const result = await gateway.syncChatHistory(targetKind, targetChatId, {
      mode: "older",
      count: args.countPerPage ?? 200,
      maxPages: args.pages ?? 2,
    });
    const oldestAfter = await store.messages.oldest(targetChatKey);

    return {
      fetched: result.fetched,
      imported: result.imported,
      pages: result.pages,
      reachedStart: result.reachedStart,
      localOldestSentAt: oldestAfter
        ? new Date(oldestAfter.sentAt).toISOString()
        : null,
    };
  },
});

export const inspectMediaTool = defineTool({
  name: "inspect_media",
  description:
    "查看消息附带的图片识图结论、语音转写文本或合并转发内容；inspectNow=true 时立即触发未完成的识别。",
  parameters: Type.Object(
    {
      targetRef: Type.Optional(Type.String()),
      messageId: Type.Optional(Type.Integer({ minimum: 1 })),
      quoteRef: Type.Optional(Type.String()),
      inspectNow: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  ),
  execute: async (args, ctx) => {
    const { store, media } = ctx.services;
    const { actor, ids } = ctx;
    let targetId = args.messageId ?? null;

    if (!targetId && args.quoteRef) {
      const meta = ids.resolveMessageMeta(args.quoteRef);
      const lookupKey =
        meta.chatKey ??
        resolveAuthorizedChat(ctx, args.targetRef).targetChatKey;
      const parsedLookup = parseChatKey(lookupKey);

      assertCanReadChat(actor, parsedLookup.kind, parsedLookup.chatId);
      const msg = await store.messages.findByOnebotId(lookupKey, meta.rawId);

      targetId = msg?.id ?? null;
    }

    if (!targetId) {
      throw new Error("请提供有效的 messageId 或 quoteRef");
    }

    const msgRow = await store.messages.get(targetId);

    if (!msgRow) {
      throw new Error("未找到指定消息");
    }

    assertCanReadChat(actor, msgRow.kind, msgRow.chatId);
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
});

export const qqDirectoryTool = defineTool({
  name: "qq_directory",
  description:
    "分页查询已连接的 QQ 群列表、指定群的成员名单，或好友列表。返回的编号统一转换为 g_*/u_* 引用句柄。",
  parameters: Type.Object(
    {
      scope: Type.Union([
        Type.Literal("groups"),
        Type.Literal("members"),
        Type.Literal("friends"),
      ]),
      groupRef: Type.Optional(Type.String()),
      page: Type.Optional(Type.Integer({ minimum: 1 })),
      pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    },
    { additionalProperties: false },
  ),
  execute: async (args, ctx) => {
    const { gateway } = ctx.services;
    const { ids } = ctx;

    if (!gateway.configured) {
      throw new Error("message-gateway 未配置，无法查询 QQ 通讯录");
    }

    const page = args.page ?? 1;
    const pageSize = args.pageSize ?? 40;
    const offset = (page - 1) * pageSize;

    if (args.scope === "groups") {
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

    if (args.scope === "friends") {
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

    const resolved = resolveAuthorizedChat(ctx, args.groupRef);

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
});

export const chatTools: readonly ToolDefinition[] = [
  listChatsTool,
  searchChatMessagesTool,
  readChatWindowTool,
  fetchOlderHistoryTool,
  inspectMediaTool,
  qqDirectoryTool,
];
