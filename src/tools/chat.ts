import { Type } from "typebox";

import type { ChatKey } from "../types.ts";
import { makeChatKey, parseChatKey } from "../utils/chat-key.ts";
import { isAdmin } from "./access.ts";
import { defineTool } from "./define.ts";
import type { Tool, ToolContext } from "./types.ts";

export function assertCanReadChat(
  ctx: ToolContext,
  kind: "group" | "private",
  chatId: string,
): void {
  const targetChatKey = makeChatKey(kind, chatId);

  if (!isAdmin(ctx.actor) && targetChatKey !== ctx.actor.chatKey) {
    throw new Error(
      "仅管理员或网协管理层可跨群或跨会话读取历史消息，当前仅可查阅本会话记录",
    );
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

  assertCanReadChat(ctx, parsed.kind, parsed.chatId);

  return { targetChatKey, kind: parsed.kind, chatId: parsed.chatId };
}

export const listChatsTool = defineTool({
  name: "list_chats",
  description:
    "列出当前发言人有权访问的会话（管理员及网协管理层可列出全部会话；其他用户仅可见当前会话）。可传 includeGatewayGroups=true 补充拉取网关群列表（仅管理员及网协管理层）。",
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
    const admin = isAdmin(actor);
    const all = await store.chats.list();
    const visible = admin
      ? all
      : all.filter((c) => c.chatKey === actor.chatKey);
    const seenKeys = new Set<string>(visible.map((c) => c.chatKey));
    const items = visible.map((c) => ({
      targetRef:
        c.kind === "group" ? ids.groupRef(c.chatId) : ids.userRef(c.chatId),
      kind: c.kind,
      title: c.title,
      enabled: c.enabled,
      triggerMode: c.triggerMode,
    }));

    if (args.includeGatewayGroups && admin && gateway.configured) {
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
    "类似 rg 按关键词/正则、发言人或时间范围搜索指定会话的历史消息（留空 targetRef 则检索当前会话，传 g_* 可跨群检索；regex=true 时支持正则及多关键词 OR 如 '断电|UPS|502'；contextLines 可附带每条命中前后 N 条上下文；本地历史未覆盖 startTimeIso 时会自动向 QQ 网关向前拉取）。",
  parameters: Type.Object(
    {
      targetRef: Type.Optional(Type.String()),
      query: Type.Optional(Type.String()),
      regex: Type.Optional(Type.Boolean()),
      userRef: Type.Optional(Type.String()),
      contextLines: Type.Optional(Type.Integer({ minimum: 0, maximum: 10 })),
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
    const filterUserId = args.userRef?.trim()
      ? ids.resolveUser(args.userRef)
      : undefined;
    const startTimeMs = args.startTimeIso
      ? Date.parse(args.startTimeIso)
      : undefined;
    const endTimeMs = args.endTimeIso ? Date.parse(args.endTimeIso) : undefined;
    const validStartMs = Number.isFinite(startTimeMs) ? startTimeMs : undefined;
    const validEndMs = Number.isFinite(endTimeMs) ? endTimeMs : undefined;
    const contextLines = args.contextLines ?? 0;

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

    const matches = await store.messages.search(targetChatKey, {
      query: args.query,
      regex: args.regex,
      userId: filterUserId,
      startTimeMs: validStartMs,
      endTimeMs: validEndMs,
      limit: args.limit ?? 60,
    });
    const matchIds = new Set(matches.map((row) => row.id));
    const rows =
      contextLines > 0
        ? await store.messages.expandContext(
            targetChatKey,
            matches,
            contextLines,
          )
        : matches;
    const [enriched, oldestAfter] = await Promise.all([
      media.enrichMessagesText(targetChatKey, rows, ids),
      store.messages.oldest(targetChatKey),
    ]);

    return {
      chatType: targetKind,
      matchCount: matches.length,
      count: rows.length,
      localOldestSentAt: oldestAfter
        ? new Date(oldestAfter.sentAt).toISOString()
        : null,
      messages: rows.map((row) => ({
        id: row.id,
        ...(contextLines > 0 ? { matched: matchIds.has(row.id) } : {}),
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
      media.enrichMessagesText(targetChatKey, rows, ids),
      store.reactions.aggregateForMessages(
        targetChatKey,
        rows.map((r) => r.onebotMessageId),
      ),
      store.messages.oldest(targetChatKey),
    ]);
    const reactorIds = new Set<string>();

    for (const list of reactionMap.values()) {
      for (const r of list) {
        for (const uid of r.userIds) {
          reactorIds.add(uid);
        }
      }
    }

    const reactorNames =
      reactorIds.size > 0
        ? await media.resolveUserNames(targetChatKey, reactorIds, rows)
        : new Map<string, string>();
    const botQQ = ctx.services.getSettings().bot.botQQ;

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
        reactions: (reactionMap.get(row.onebotMessageId) ?? []).map((r) => ({
          emojiId: r.emojiId,
          emojiName: r.emojiName,
          count: r.count,
          users: r.userIds.map((uid) => {
            const isSelf = uid === "bot" || (Boolean(botQQ) && uid === botQQ);

            return {
              userRef:
                !isSelf && uid && uid !== "unknown" ? ids.userRef(uid) : null,
              name: isSelf
                ? "树莓娘"
                : (reactorNames.get(uid) ??
                  (uid === "unknown" ? "未知用户" : null)),
            };
          }),
        })),
        sentAt: new Date(row.sentAt).toISOString(),
      })),
    };
  },
});

export const fetchOlderHistoryTool = defineTool({
  name: "fetch_older_history",
  description:
    "从 QQ 网关向前翻页拉取指定会话更早的历史消息并缓存到本地（按本地最早一条消息继续向前翻页）。当关键词检索未命中或需要查看更早几天的讨论时调用。",
  available: (services) => services.gateway.configured,
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

export const chatHistoryTools: readonly Tool[] = [
  listChatsTool,
  searchChatMessagesTool,
  readChatWindowTool,
  fetchOlderHistoryTool,
];
