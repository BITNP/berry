import type { Router } from "h3";
import { createError, defineEventHandler } from "h3";
import { Type } from "typebox";

import type { BerryApp } from "../../app.ts";
import { parseBody, parseChatKeyParam, parseQuery } from "../http.ts";
import { summarizeMessageTraces } from "../traces.ts";

const nonBlankString = Type.String({ minLength: 1, pattern: "\\S" });

const triggerModeSchema = Type.Union([
  Type.Literal("off"),
  Type.Literal("mention_only"),
  Type.Literal("smart_observe"),
]);

const chatKindSchema = Type.Union([
  Type.Literal("group"),
  Type.Literal("private"),
]);

const messagesQuerySchema = Type.Object({
  search: Type.Optional(Type.String()),
  limit: Type.Integer({ minimum: 1, default: 80 }),
  beforeId: Type.Optional(Type.Integer({ minimum: 1 })),
});

const createChatBodySchema = Type.Object({
  kind: chatKindSchema,
  chatId: nonBlankString,
  title: Type.Optional(Type.String()),
  enabled: Type.Optional(Type.Boolean()),
  triggerMode: Type.Optional(triggerModeSchema),
});

const patchChatBodySchema = Type.Object({
  title: Type.Optional(Type.String()),
  enabled: Type.Optional(Type.Boolean()),
  triggerMode: Type.Optional(triggerModeSchema),
  stylePrompt: Type.Optional(Type.String({ maxLength: 600 })),
});

const backfillBodySchema = Type.Object({
  count: Type.Integer({ minimum: 1, maximum: 500, default: 200 }),
});

const digestBodySchema = Type.Object({
  lookbackHours: Type.Number({ minimum: 1, default: 24 }),
});

const injectBodySchema = Type.Object({
  content: nonBlankString,
});

export function registerChatRoutes(router: Router, berry: BerryApp): void {
  router.get(
    "/api/admin/chats",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);
      const chats = await berry.store.chats.list();

      return { items: chats };
    }),
  );

  router.post(
    "/api/admin/chats",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);
      const body = await parseBody(
        event,
        createChatBodySchema,
        "请填写有效的会话类型和号码",
      );

      const chatId = body.chatId.trim();
      const title =
        body.title?.trim() ||
        (await berry.gateway.resolveChatTitle(body.kind, chatId)) ||
        "";

      return berry.store.chats.upsert({
        kind: body.kind,
        chatId,
        title,
        enabled: body.enabled ?? true,
        triggerMode:
          body.triggerMode ??
          (body.kind === "group" ? "mention_only" : "smart_observe"),
      });
    }),
  );

  router.post(
    "/api/admin/chats/sync",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);
      const groups = await berry.gateway.getGroupList();

      for (const group of groups) {
        await berry.store.chats.ensure("group", String(group.group_id), {
          title: group.group_name,
          enabled: berry.settings.policy.groupDefaultMode !== "off",
          triggerMode: berry.settings.policy.groupDefaultMode,
        });
      }

      await berry.gateway.backfillEmptyChatTitles();

      return {
        synced: groups.length,
        items: await berry.store.chats.list(),
      };
    }),
  );

  router.patch(
    "/api/admin/chats/:chatKey",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);
      const { chatKey } = await parseChatKeyParam(event);
      const body = await parseBody(event, patchChatBodySchema);

      return berry.store.chats.update(chatKey, body);
    }),
  );

  router.post(
    "/api/admin/chats/:chatKey/style/generate",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);
      const { chatKey } = await parseChatKeyParam(event);
      const chat = await berry.social.distillChatStyle(chatKey);

      return { ok: true, chat };
    }),
  );

  router.get(
    "/api/admin/chats/:chatKey/messages",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);
      const { chatKey } = await parseChatKeyParam(event);
      const query = await parseQuery(event, messagesQuerySchema);
      const items = await berry.store.messages.search(chatKey, {
        query: query.search,
        limit: query.limit,
        beforeId: query.beforeId,
      });

      const [assetMap, reactionMap] = await Promise.all([
        berry.store.assets.listForMessages(items.map((m) => m.id)),
        berry.store.reactions.aggregateForMessages(
          chatKey,
          items.map((m) => m.onebotMessageId),
        ),
      ]);
      const traceSummaryMap = await summarizeMessageTraces(
        berry,
        items,
        assetMap,
      );

      return {
        items: items.map((msg) => ({
          ...msg,
          assets: assetMap.get(msg.id) ?? [],
          reactions: reactionMap.get(msg.onebotMessageId) ?? [],
          traceSummary: traceSummaryMap.get(msg.id) ?? {
            gateAction: null,
            gateReason: null,
            aiCalls: 0,
            aiErrors: 0,
            hasTrace: false,
          },
        })),
      };
    }),
  );

  router.post(
    "/api/admin/chats/:chatKey/backfill",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);
      const { kind, chatId } = await parseChatKeyParam(event);

      if (!berry.gateway.configured) {
        throw createError({
          statusCode: 400,
          message: "message-gateway 未配置，无法拉取历史记录",
        });
      }

      const { count } = await parseBody(event, backfillBodySchema);
      const result = await berry.gateway.syncChatHistory(kind, chatId, {
        count,
        mode: "latest",
        maxPages: 1,
        stepBackIfLatestCached: true,
      });

      return {
        total: result.fetched,
        imported: result.imported,
        oldestSentAt: result.oldestSentAt,
        reachedStart: result.reachedStart,
      };
    }),
  );

  router.post(
    "/api/admin/chats/:chatKey/digest",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);
      const { kind, chatId } = await parseChatKeyParam(event);

      if (kind !== "group") {
        throw createError({
          statusCode: 400,
          message: "仅支持对群聊生成讨论摘要",
        });
      }

      const { lookbackHours } = await parseBody(event, digestBodySchema);

      await berry.scheduler.enqueueDigestNow(chatId, lookbackHours);

      return { queued: true };
    }),
  );

  router.post(
    "/api/admin/chats/:chatKey/inject",
    defineEventHandler(async (event) => {
      const session = await berry.auth.requireAdmin(event);
      const { chatKey, kind, chatId } = await parseChatKeyParam(event);
      const { content } = await parseBody(
        event,
        injectBodySchema,
        "请输入指令内容",
      );

      await berry.store.jobs.enqueue(
        "invoke",
        `admin:${chatKey}:${Date.now()}`,
        chatKey,
        {
          source: "admin_inject",
          chatKey,
          kind,
          chatId,
          triggerMessageIds: [],
          senderName: session.name,
          content: content.trim(),
        },
      );
      berry.worker.wake();

      return { queued: true };
    }),
  );

  router.get(
    "/api/admin/users",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);
      const [speakers, chats, userMemories] = await Promise.all([
        berry.store.messages.listKnownUsers(300),
        berry.store.chats.list(),
        berry.store.memories.list({ scope: "user" }),
      ]);

      const byId = new Map<string, string>();

      for (const s of speakers) {
        byId.set(s.userId, s.name);
      }

      for (const c of chats) {
        if (c.kind === "private" && c.chatId) {
          const existing = byId.get(c.chatId);

          if (!existing && c.title.trim()) {
            byId.set(c.chatId, c.title.trim());
          } else if (!byId.has(c.chatId)) {
            byId.set(c.chatId, "");
          }
        }
      }

      for (const mem of userMemories) {
        if (mem.ownerId && !byId.has(mem.ownerId)) {
          byId.set(mem.ownerId, "");
        }
      }

      return {
        items: [...byId.entries()].map(([userId, name]) => ({ userId, name })),
      };
    }),
  );
}
