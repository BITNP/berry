import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import {
  createApp,
  createError,
  createEventStream,
  createRouter,
  defineEventHandler,
  readBody,
  serveStatic,
  setHeader,
  setResponseStatus,
} from "h3";
import { lookup } from "mrmime";
import { Type } from "typebox";

import type { BerryApp } from "../app.ts";
import { parseSettings, scheduleSpecSchema } from "../config/settings.ts";
import { errorMessage } from "../utils/time.ts";
import { hasConsoleAccess } from "./auth.ts";
import {
  idParamSchema,
  parseBody,
  parseChatKeyParam,
  parseParams,
  parseQuery,
  stringIdParamSchema,
} from "./http.ts";

const avatarParamsSchema = Type.Object({
  kind: Type.Union([Type.Literal("user"), Type.Literal("group")]),
  id: Type.String({ minLength: 1 }),
});

const guildTaskParamSchema = Type.Object({
  task: Type.Union([
    Type.Literal("due"),
    Type.Literal("assignments"),
    Type.Literal("weekly"),
  ]),
});

const logsQuerySchema = Type.Object({
  level: Type.Optional(
    Type.Union([
      Type.Literal("debug"),
      Type.Literal("info"),
      Type.Literal("warn"),
      Type.Literal("error"),
    ]),
  ),
  scope: Type.Optional(Type.String()),
  search: Type.Optional(Type.String()),
  afterId: Type.Optional(Type.Integer()),
  limit: Type.Integer({ minimum: 1, default: 250 }),
});

const gateQuerySchema = Type.Object({
  action: Type.Optional(
    Type.Union([
      Type.Literal("reply"),
      Type.Literal("memory"),
      Type.Literal("ignore"),
    ]),
  ),
  stage: Type.Optional(
    Type.Union([
      Type.Literal("l0_rule"),
      Type.Literal("l1_classifier"),
      Type.Literal("dry_run"),
    ]),
  ),
  chatKey: Type.Optional(Type.String()),
  search: Type.Optional(Type.String()),
  limit: Type.Integer({ minimum: 1, default: 50 }),
  offset: Type.Integer({ minimum: 0, default: 0 }),
});

const llmCallsQuerySchema = Type.Object({
  purpose: Type.Optional(Type.String()),
  excludePurpose: Type.Optional(Type.String()),
  status: Type.Optional(
    Type.Union([Type.Literal("ok"), Type.Literal("error")]),
  ),
  chatKey: Type.Optional(Type.String()),
  search: Type.Optional(Type.String()),
  limit: Type.Integer({ minimum: 1, maximum: 200, default: 80 }),
});

const jobsQuerySchema = Type.Object({
  kind: Type.Optional(Type.String()),
  lane: Type.Optional(
    Type.Union([
      Type.Literal("gate"),
      Type.Literal("dialog"),
      Type.Literal("background"),
    ]),
  ),
  state: Type.Optional(
    Type.Union([
      Type.Literal("pending"),
      Type.Literal("running"),
      Type.Literal("done"),
      Type.Literal("failed"),
    ]),
  ),
  chatKey: Type.Optional(Type.String()),
  limit: Type.Integer({ minimum: 1, maximum: 200, default: 100 }),
});

const messagesQuerySchema = Type.Object({
  search: Type.Optional(Type.String()),
  limit: Type.Integer({ minimum: 1, default: 80 }),
  beforeId: Type.Optional(Type.Integer({ minimum: 1 })),
});

const memoryScopeSchema = Type.Union([
  Type.Literal("global"),
  Type.Literal("chat"),
  Type.Literal("user"),
]);

const listMemoriesQuerySchema = Type.Object({
  scope: Type.Optional(memoryScopeSchema),
  ownerId: Type.Optional(Type.String()),
});

const deleteMemoryQuerySchema = Type.Object({
  scope: memoryScopeSchema,
  ownerId: Type.String({ default: "" }),
  key: Type.String({ default: "" }),
});

const tapeQuerySchema = Type.Object({
  tapeId: Type.String({ default: "global" }),
  limit: Type.Integer({ minimum: 1, maximum: 500, default: 200 }),
  beforeId: Type.Optional(Type.Integer({ minimum: 1 })),
  afterId: Type.Optional(Type.Integer({ minimum: 1 })),
});

const triggerModeSchema = Type.Union([
  Type.Literal("off"),
  Type.Literal("mention_only"),
  Type.Literal("smart_observe"),
]);

const chatKindSchema = Type.Union([
  Type.Literal("group"),
  Type.Literal("private"),
]);

const nonBlankString = Type.String({ minLength: 1, pattern: "\\S" });

const botStateBodySchema = Type.Object({
  paused: Type.Boolean({ default: false }),
});

const dryRunBodySchema = Type.Object({
  chatKey: Type.String({ default: "group:100000" }),
  triggerMode: Type.Union(
    [Type.Literal("mention_only"), Type.Literal("smart_observe")],
    { default: "smart_observe" },
  ),
  senderName: Type.String({ default: "测试群友" }),
  userId: Type.String({ default: "10001" }),
  mentionedBot: Type.Boolean({ default: false }),
  quotedBot: Type.Boolean({ default: false }),
  text: nonBlankString,
  recentContext: Type.Array(Type.String(), { default: [] }),
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

const upsertMemoryBodySchema = Type.Object({
  scope: memoryScopeSchema,
  ownerId: Type.String({ default: "" }),
  key: Type.String({ minLength: 1 }),
  summary: Type.String({ default: "" }),
  content: Type.String({ default: "" }),
  expiresAt: Type.Optional(
    Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  ),
});

const scheduleKindSchema = Type.Union([chatKindSchema, Type.Literal("")]);

const createScheduleBodySchema = Type.Object({
  title: nonBlankString,
  kind: Type.Optional(scheduleKindSchema),
  chatId: Type.Optional(Type.String()),
  content: nonBlankString,
  schedule: scheduleSpecSchema,
  enabled: Type.Optional(Type.Boolean()),
});

const patchScheduleBodySchema = Type.Object({
  title: Type.Optional(nonBlankString),
  kind: Type.Optional(scheduleKindSchema),
  chatId: Type.Optional(Type.String()),
  content: Type.Optional(nonBlankString),
  schedule: Type.Optional(scheduleSpecSchema),
  enabled: Type.Optional(Type.Boolean()),
});

const purgeBodySchema = Type.Object({
  olderThanDays: Type.Integer({ minimum: 1, default: 30 }),
});

export function createHttpApp(berry: BerryApp, webDistDir: string) {
  const app = createApp({
    onBeforeResponse: (event) => {
      setHeader(event, "X-Content-Type-Options", "nosniff");
      setHeader(event, "X-Frame-Options", "DENY");
      setHeader(event, "Referrer-Policy", "same-origin");
      setHeader(
        event,
        "Content-Security-Policy",
        "default-src 'self'; img-src 'self' https: data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self' data:; frame-ancestors 'none'",
      );
    },
  });

  const router = createRouter();

  router.get(
    "/api/healthz",
    defineEventHandler(async () => ({
      status: "ok",
      gatewayConfigured: berry.gateway.configured,
      gatewayStreamConnected: berry.gatewayEvents.connected,
      bunkoConfigured: berry.bunko.enabled,
      workerRunning: berry.worker.running,
      devAuthBypass: berry.auth.devBypass,
      oidcConfigured: berry.auth.oidcConfigured,
    })),
  );

  router.get(
    "/api/auth/login",
    defineEventHandler((event) => berry.auth.startLogin(event)),
  );

  router.get(
    "/api/auth/callback",
    defineEventHandler((event) => berry.auth.callback(event)),
  );

  router.get(
    "/api/auth/status",
    defineEventHandler(async (event) => {
      setHeader(event, "Cache-Control", "no-store");
      const session = await berry.auth.getSession(event);

      if (!session || !hasConsoleAccess(session.permissions)) {
        return {
          state: "anonymous",
          user: null,
          oidcConfigured: berry.auth.oidcConfigured,
          devAuthBypass: berry.auth.devBypass,
        };
      }

      return {
        state: "active",
        user: {
          subject: session.subject,
          name: session.name,
          email: session.email,
          avatar: session.avatar || null,
          permissions: session.permissions,
        },
        csrfToken: session.csrfToken,
        oidcConfigured: berry.auth.oidcConfigured,
        devAuthBypass: berry.auth.devBypass,
      };
    }),
  );

  router.get(
    "/api/auth/csrf",
    defineEventHandler(async (event) => {
      setHeader(event, "Cache-Control", "no-store");
      const session = await berry.auth.requireAdmin(event);

      return { token: session.csrfToken, headerName: "X-CSRF-Token" };
    }),
  );

  router.post(
    "/api/auth/logout",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);
      await berry.auth.logout(event);
      setResponseStatus(event, 204);

      return null;
    }),
  );

  router.get(
    "/api/admin/overview",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);
      const since24h = Date.now() - 86_400 * 1000;
      const [
        gatewayHealth,
        jobCounts,
        gate24h,
        chats,
        todayUsage,
        botAccount,
        storageSummary,
        usageBuckets,
      ] = await Promise.all([
        berry.gateway.checkHealth(),
        berry.store.jobs.counts(berry.jobs.kindsForLane("background")),
        berry.store.gate.summarySince(since24h),
        berry.store.chats.list(),
        berry.store.usage.todaySummary(berry.settings.bot.timezone),
        berry.gateway.getLoginInfo(),
        berry.store.maintenance.inspectStorage(),
        berry.store.usage.dailySummary(30),
      ]);

      return {
        workerRunning: berry.worker.running,
        botPaused: berry.settings.bot.paused,
        botQQ: berry.settings.bot.botQQ,
        botAccount,
        gatewayHealth,
        gatewayStreamConnected: berry.gatewayEvents.connected,
        pendingJobs: jobCounts.pending + jobCounts.running,
        activeBackgroundJobs: jobCounts.backgroundActive,
        failedJobs: jobCounts.failed,
        gate24h,
        chatCount: chats.length,
        activeChatCount: chats.filter((c) => c.enabled).length,
        todayUsage,
        guildApiConfigured: berry.guild.enabled,
        guildStreamConnected: berry.guildAutomation.streamConnected,
        guildPublicUrl: berry.env.guildPublicUrl,
        bunkoConfigured: berry.bunko.enabled,
        bunkoWorkspaceUrl: berry.bunko.workspaceUrl(),
        keycloakConfigured: berry.directory.enabled,
        mcpServers: berry.mcp.statuses,
        storage: storageSummary,
        usageBuckets,
      };
    }),
  );

  router.post(
    "/api/admin/bot/state",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);
      const { paused } = await parseBody(event, botStateBodySchema);
      const saved = await berry.updateSettings({
        ...berry.settings,
        bot: {
          ...berry.settings.bot,
          paused,
        },
      });

      return { botPaused: saved.bot.paused };
    }),
  );

  router.get(
    "/api/admin/logs",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);
      const query = await parseQuery(event, logsQuerySchema);

      return berry.logs.list(query);
    }),
  );

  router.post(
    "/api/admin/logs/clear",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);
      berry.logs.clear();

      return { ok: true };
    }),
  );

  router.get(
    "/api/admin/avatars/:kind/:id",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);
      const { kind, id } = await parseParams(
        event,
        avatarParamsSchema,
        "无效的头像类型",
      );
      const avatar = await berry.avatars.get(kind, id);

      setHeader(event, "Content-Type", avatar.contentType);
      setHeader(event, "Cache-Control", "public, max-age=3600");

      return avatar.data;
    }),
  );

  router.get(
    "/api/admin/assets/:id/raw",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);
      const { id } = await parseParams(event, idParamSchema, "无效的附件编号");
      const asset = await berry.store.assets.get(id);

      if (!asset?.filePath) {
        throw createError({ statusCode: 404, message: "本地缓存图片不存在" });
      }

      const abs = resolve(asset.filePath);
      const root = `${resolve(berry.store.assetsDir)}${sep}`;

      if (!abs.startsWith(root)) {
        throw createError({ statusCode: 403, message: "非法路径访问" });
      }

      const data = await readFile(abs);

      setHeader(
        event,
        "Content-Type",
        asset.mimeType || "application/octet-stream",
      );
      setHeader(event, "Cache-Control", "private, max-age=86400");

      return data;
    }),
  );

  router.get(
    "/api/admin/events",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);
      const stream = createEventStream(event);
      const unsubscribe = berry.events.subscribe((payload) => {
        void stream.push({
          event: payload.type,
          data: JSON.stringify(payload.data),
        });
      });

      void stream.push({ event: "ping", data: String(Date.now()) });
      const keepAlive = setInterval(() => {
        void stream.push({ event: "ping", data: String(Date.now()) });
      }, 25_000);

      keepAlive.unref();

      stream.onClosed(async () => {
        clearInterval(keepAlive);
        unsubscribe();
        await stream.close();
      });

      return stream.send();
    }),
  );

  router.get(
    "/api/admin/gate-decisions",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);
      const query = await parseQuery(event, gateQuerySchema);

      return berry.store.gate.list(query);
    }),
  );

  router.get(
    "/api/admin/llm-calls",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);
      const query = await parseQuery(event, llmCallsQuerySchema);

      return berry.store.usage.listRecent(query);
    }),
  );

  router.post(
    "/api/admin/gate-decisions/dry-run",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);
      const body = await parseBody(
        event,
        dryRunBodySchema,
        "请输入待测试的消息内容",
      );

      return berry.classifier.dryRun(berry.settings, {
        ...body,
        chatKey: body.chatKey || "group:100000",
        senderName: body.senderName || "测试群友",
        userId: body.userId || "10001",
        text: body.text.trim(),
      });
    }),
  );

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

  router.get(
    "/api/admin/conversation",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);

      return berry.store.conversations.open();
    }),
  );

  router.post(
    "/api/admin/conversation/reset",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);
      const afterId = await berry.store.messages.maxId();

      return berry.store.conversations.reset(afterId);
    }),
  );

  router.get(
    "/api/admin/tape",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);
      const query = await parseQuery(event, tapeQuerySchema);
      const entries = await berry.store.conversations.listEntries(query);

      return {
        tapeId: query.tapeId,
        entries,
      };
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

      return {
        items: items.map((msg) => ({
          ...msg,
          assets: assetMap.get(msg.id) ?? [],
          reactions: reactionMap.get(msg.onebotMessageId) ?? [],
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

  router.get(
    "/api/admin/memories",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);
      const query = await parseQuery(event, listMemoriesQuerySchema);

      return {
        items: await berry.store.memories.list(query),
      };
    }),
  );

  router.put(
    "/api/admin/memories",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);
      const body = await parseBody(event, upsertMemoryBodySchema);

      return berry.store.memories.upsert(body);
    }),
  );

  router.delete(
    "/api/admin/memories",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);
      const { scope, ownerId, key } = await parseQuery(
        event,
        deleteMemoryQuerySchema,
      );

      return {
        deleted: await berry.store.memories.remove(scope, ownerId, key),
      };
    }),
  );

  router.post(
    "/api/admin/guild/trigger/:task",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);
      const { task } = await parseParams(
        event,
        guildTaskParamSchema,
        "未知公会任务类型",
      );
      const { job, alreadyActive } = await berry.store.jobs.enqueueUniqueActive(
        "guild_task",
        `guild:${task}`,
        { task },
      );

      berry.worker.wake();

      return {
        queued: true,
        alreadyActive,
        jobId: job.id,
        state: job.state,
        task,
      };
    }),
  );

  router.get(
    "/api/admin/schedules",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);

      return { items: await berry.store.schedules.list() };
    }),
  );

  router.post(
    "/api/admin/schedules",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);
      const body = await parseBody(event, createScheduleBodySchema);

      return berry.store.schedules.create(body, berry.settings.bot.timezone);
    }),
  );

  router.patch(
    "/api/admin/schedules/:id",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);
      const { id } = await parseParams(event, stringIdParamSchema);
      const body = await parseBody(event, patchScheduleBodySchema);
      const updated = await berry.store.schedules.update(
        id,
        body,
        berry.settings.bot.timezone,
      );

      if (!updated) {
        throw createError({ statusCode: 404, message: "定时任务不存在" });
      }

      return updated;
    }),
  );

  router.delete(
    "/api/admin/schedules/:id",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);
      const { id } = await parseParams(event, stringIdParamSchema);

      return { deleted: await berry.store.schedules.remove(id) };
    }),
  );

  router.post(
    "/api/admin/schedules/:id/run",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);
      const { id } = await parseParams(event, stringIdParamSchema);
      const ok = await berry.scheduler.triggerScheduleNow(id);

      if (!ok) {
        throw createError({ statusCode: 404, message: "定时任务不存在" });
      }

      return { queued: true };
    }),
  );

  router.get(
    "/api/admin/bunko/folders",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);

      if (!berry.bunko.enabled) {
        return {
          configured: false,
          workspaceUrl: berry.bunko.workspaceUrl(),
          folders: [],
        };
      }

      try {
        return {
          configured: true,
          workspaceUrl: berry.bunko.workspaceUrl(),
          folders: await berry.bunko.listAllFolders(),
        };
      } catch (error) {
        return {
          configured: true,
          workspaceUrl: berry.bunko.workspaceUrl(),
          folders: [],
          error: errorMessage(error),
        };
      }
    }),
  );

  router.get(
    "/api/admin/mcp",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);

      return {
        statuses: berry.mcp.statuses,
        tools: berry.mcp.tools,
      };
    }),
  );

  router.get(
    "/api/admin/settings",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);

      return {
        settings: berry.settings,
        thinkingTasks: [
          { key: "dialog", label: "主对话" },
          { key: "subagent", label: "子代理（默认）" },
          ...berry.subagents.list().map((sub) => ({
            key: `subagent:${sub.kind}`,
            label: `子代理：${sub.title}`,
            ...(sub.thinkingEffort ? { fallback: sub.thinkingEffort } : {}),
          })),
          { key: "report", label: "公会周报" },
          { key: "memory_update", label: "记忆提炼" },
          { key: "compaction", label: "摘要压缩" },
        ],
        envSummary: {
          gatewayUrl: berry.env.gatewayUrl,
          gatewayAccount: berry.env.gatewayAccount,
          oidcIssuer: berry.env.oidcIssuer,
          guildApiUrl: berry.env.guildApiUrl,
          guildPublicUrl: berry.env.guildPublicUrl,
          guildConfigured: berry.guild.enabled,
          guildStreamConnected: berry.guildAutomation.streamConnected,
          bunkoApiUrl: berry.env.bunkoApiUrl,
          bunkoPublicUrl: berry.bunko.workspaceUrl(),
          bunkoConfigured: berry.bunko.enabled,
        },
      };
    }),
  );

  router.put(
    "/api/admin/settings",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);
      const body = await readBody<unknown>(event);

      try {
        const parsed = parseSettings(body);
        const saved = await berry.updateSettings(parsed);

        return { settings: saved };
      } catch (error) {
        throw createError({
          statusCode: 400,
          message: errorMessage(error),
        });
      }
    }),
  );

  router.get(
    "/api/admin/usage",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);
      const todayUsage = await berry.store.usage.todaySummary(
        berry.settings.bot.timezone,
      );

      return {
        todayUsage,
        buckets: await berry.store.usage.dailySummary(30),
      };
    }),
  );

  router.get(
    "/api/admin/jobs",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);
      const q = await parseQuery(event, jobsQuerySchema);
      const kindsFilter = q.kind
        ? undefined
        : q.lane
          ? berry.jobs.kindsForLane(q.lane)
          : undefined;

      const [rows, counts] = await Promise.all([
        berry.store.jobs.list({
          limit: q.limit,
          kind: q.kind,
          kinds: kindsFilter,
          state: q.state,
          chatKey: q.chatKey,
        }),
        berry.store.jobs.counts(berry.jobs.kindsForLane("background")),
      ]);

      const msgIds = berry.jobs.collectMessageIds(rows);
      const msgRows = await berry.store.messages.getByIds(msgIds);
      const messagesById = new Map(msgRows.map((m) => [m.id, m]));

      return {
        items: rows.map((job) => ({
          ...job,
          ...berry.jobs.describeJob(job, { messagesById }),
        })),
        kinds: berry.jobs.descriptors(),
        counts,
      };
    }),
  );

  router.post(
    "/api/admin/jobs/retry-failed",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);
      const count = await berry.store.jobs.retryAllFailed();

      if (count > 0) {
        berry.worker.wake();
      }

      return { retried: count };
    }),
  );

  router.post(
    "/api/admin/jobs/:id/retry",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);
      const { id } = await parseParams(event, idParamSchema, "无效的任务编号");
      const ok = await berry.store.jobs.retry(id);

      if (ok) {
        berry.worker.wake();
      }

      return { retried: ok };
    }),
  );

  router.post(
    "/api/admin/jobs/:id/cancel",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);
      const { id } = await parseParams(event, idParamSchema, "无效的任务编号");

      return { cancelled: await berry.store.jobs.cancel(id) };
    }),
  );

  router.get(
    "/api/admin/storage",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);

      return berry.store.maintenance.inspectStorage();
    }),
  );

  router.post(
    "/api/admin/storage/purge",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);
      const { olderThanDays } = await parseBody(
        event,
        purgeBodySchema,
        "保留天数须为大于或等于 1 的整数",
      );

      return berry.store.maintenance.purgeOldData(olderThanDays);
    }),
  );

  router.get(
    "/api/admin/deliveries",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);

      return { items: await berry.store.deliveries.list(100) };
    }),
  );

  app.use(router);

  // Unknown API routes return JSON 404 before static SPA fallback.
  app.use(
    "/api",
    defineEventHandler(() => {
      throw createError({ statusCode: 404, message: "接口不存在" });
    }),
  );

  // Static SPA serving from dist/web.
  const resolvedDist = resolve(webDistDir);

  app.use(
    defineEventHandler(async (event) => {
      const served = await serveStatic(event, {
        fallthrough: true,
        indexNames: ["/index.html"],
        getMeta: async (id) => {
          const rel = id.replace(/^\/+/, "");
          const candidate = resolve(resolvedDist, rel);

          if (
            candidate !== resolvedDist &&
            !candidate.startsWith(`${resolvedDist}${sep}`)
          ) {
            return;
          }

          const info = await stat(candidate).catch(() => null);

          if (!info?.isFile()) {
            return;
          }

          if (rel.startsWith("assets/")) {
            setHeader(
              event,
              "Cache-Control",
              "public, max-age=31536000, immutable",
            );
          } else if (rel === "index.html") {
            setHeader(event, "Cache-Control", "no-store");
          }

          return {
            type: lookup(candidate) || "application/octet-stream",
            size: info.size,
            mtime: info.mtimeMs,
          };
        },
        getContents: (id) =>
          createReadStream(resolve(resolvedDist, id.replace(/^\/+/, ""))),
      });

      if (served !== false) {
        return;
      }

      if (event.method !== "GET" && event.method !== "HEAD") {
        throw createError({ statusCode: 404, message: "Not Found" });
      }

      try {
        const html = await readFile(join(resolvedDist, "index.html"), "utf8");

        setHeader(event, "Content-Type", "text/html; charset=utf-8");
        setHeader(event, "Cache-Control", "no-store");

        return html;
      } catch {
        setHeader(event, "Content-Type", "text/plain; charset=utf-8");

        return "berry console build not found. Run `pnpm build` or use Vite dev server.";
      }
    }),
  );

  return app;
}
