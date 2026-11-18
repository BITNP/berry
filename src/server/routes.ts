import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";

import {
  createApp,
  createError,
  createEventStream,
  createRouter,
  defineEventHandler,
  getHeader,
  getQuery,
  getRouterParam,
  readBody,
  readRawBody,
  setHeader,
  setResponseStatus,
} from "h3";

import type { BerryApp } from "../app.ts";
import { maskSettings, mergeMaskedSettings } from "../config/settings.ts";
import type { OneBotWebhookEvent } from "../gateway/webhook.ts";
import { verifyWebhookSignature } from "../gateway/webhook.ts";
import type {
  ChatKind,
  GateAction,
  GateStage,
  GroupTriggerMode,
  LogLevel,
  MemoryScope,
  ScheduleSpec,
} from "../types.ts";
import { parseChatKey } from "../types.ts";
import { errorMessage } from "../utils/time.ts";

const MIME_BY_EXT: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
};

function decodeParam(raw: string | undefined): string {
  if (!raw) {
    throw createError({ statusCode: 400, message: "Missing route parameter" });
  }

  return decodeURIComponent(raw);
}

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
  let botInfoCache: {
    value: { user_id: number; nickname: string } | null;
    expiresAt: number;
  } = { value: null, expiresAt: 0 };

  async function cachedBotAccount() {
    if (!berry.gateway.configured) {
      return null;
    }

    if (Date.now() < botInfoCache.expiresAt) {
      return botInfoCache.value;
    }

    const value = await berry.gateway.getLoginInfo().catch(() => null);

    botInfoCache = { value, expiresAt: Date.now() + 60_000 };

    return value;
  }

  router.get(
    "/api/healthz",
    defineEventHandler(async () => ({
      status: "ok",
      gatewayConfigured: berry.gateway.configured,
      workerRunning: berry.worker.running,
      devAuthBypass: berry.auth.devBypass,
      oidcConfigured: berry.auth.oidcConfigured,
    })),
  );

  router.post(
    "/api/webhooks/onebot",
    defineEventHandler(async (event) => {
      const rawBody = (await readRawBody(event, "utf8")) ?? "";
      const authorized = verifyWebhookSignature(
        berry.env.webhookToken,
        rawBody,
        getHeader(event, "authorization"),
        getHeader(event, "x-signature"),
      );

      if (!authorized) {
        throw createError({
          statusCode: 401,
          message: "Invalid webhook signature or token",
        });
      }

      let payload: OneBotWebhookEvent;

      try {
        payload = JSON.parse(rawBody || "{}") as OneBotWebhookEvent;
      } catch {
        throw createError({ statusCode: 400, message: "Malformed JSON body" });
      }

      return berry.webhook.handle(payload);
    }),
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

      if (!session?.permissions.systemAdmin) {
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
        pendingJobs,
        gate24h,
        chats,
        todayUsage,
        botAccount,
        storageSummary,
        usageBuckets,
      ] = await Promise.all([
        berry.gateway.checkHealth(),
        berry.store.jobs.countPending(),
        berry.store.gate.summarySince(since24h),
        berry.store.chats.list(),
        berry.store.usage.todaySummary(berry.settings.bot.timezone),
        cachedBotAccount(),
        berry.store.maintenance.inspectStorage(),
        berry.store.usage.dailySummary(30),
      ]);

      return {
        workerRunning: berry.worker.running,
        botPaused: berry.settings.bot.paused,
        botQQ: berry.settings.bot.botQQ,
        botAccount,
        gatewayHealth,
        pendingJobs,
        gate24h,
        chatCount: chats.length,
        activeChatCount: chats.filter((c) => c.enabled).length,
        todayCalls: todayUsage.calls,
        todayUsage,
        guildApiConfigured: berry.guild.enabled,
        guildDatabaseConfigured: berry.guildAutomation.databaseConfigured,
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
      const body = await readBody<{ paused?: boolean }>(event);
      const paused = Boolean(body?.paused);
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
      const query = getQuery(event);
      const levelRaw = typeof query.level === "string" ? query.level : "";
      const level = (["debug", "info", "warn", "error"] as const).includes(
        levelRaw as LogLevel,
      )
        ? (levelRaw as LogLevel)
        : undefined;

      return berry.logs.list({
        level,
        scope:
          typeof query.scope === "string" && query.scope
            ? query.scope
            : undefined,
        search:
          typeof query.search === "string" && query.search
            ? query.search
            : undefined,
        afterId: query.afterId ? Number(query.afterId) : undefined,
        limit: query.limit ? Number(query.limit) : 250,
      });
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
      const kind = getRouterParam(event, "kind");
      const id = decodeParam(getRouterParam(event, "id"));

      if (kind !== "user" && kind !== "group") {
        throw createError({ statusCode: 400, message: "无效的头像类型" });
      }

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
      const id = Number(getRouterParam(event, "id"));

      if (!Number.isInteger(id) || id <= 0) {
        throw createError({ statusCode: 400, message: "无效的附件编号" });
      }

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
      const keepAlive = setInterval(() => {
        void stream.push({ event: "ping", data: String(Date.now()) });
      }, 25_000);

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
      const query = getQuery(event);

      return berry.store.gate.list({
        action:
          typeof query.action === "string" && query.action
            ? (query.action as GateAction)
            : undefined,
        stage:
          typeof query.stage === "string" && query.stage
            ? (query.stage as GateStage)
            : undefined,
        chatKey:
          typeof query.chatKey === "string" && query.chatKey
            ? query.chatKey
            : undefined,
        search:
          typeof query.search === "string" && query.search
            ? query.search
            : undefined,
        limit: query.limit ? Number(query.limit) : 50,
        offset: query.offset ? Number(query.offset) : 0,
      });
    }),
  );

  router.post(
    "/api/admin/gate-decisions/dry-run",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);
      const body = await readBody<{
        chatKey?: string;
        triggerMode?: "mention_only" | "smart_observe";
        senderName?: string;
        userId?: string;
        mentionedBot?: boolean;
        quotedBot?: boolean;
        text?: string;
        recentContext?: string[];
      }>(event);

      if (!body?.text?.trim()) {
        throw createError({
          statusCode: 400,
          message: "请输入待测试的消息内容",
        });
      }

      return berry.classifier.dryRun(berry.settings, {
        chatKey: body.chatKey || "group:100000",
        triggerMode: body.triggerMode || "smart_observe",
        senderName: body.senderName || "测试群友",
        userId: body.userId || "10001",
        mentionedBot: Boolean(body.mentionedBot),
        quotedBot: Boolean(body.quotedBot),
        text: body.text.trim(),
        recentContext: Array.isArray(body.recentContext)
          ? body.recentContext
          : [],
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
      const body = await readBody<{
        kind: ChatKind;
        chatId: string;
        title?: string;
        enabled?: boolean;
        triggerMode?: GroupTriggerMode;
      }>(event);

      if (
        !body?.chatId?.trim() ||
        (body.kind !== "group" && body.kind !== "private")
      ) {
        throw createError({
          statusCode: 400,
          message: "请填写有效的会话类型和号码",
        });
      }

      return berry.store.chats.upsert({
        kind: body.kind,
        chatId: body.chatId.trim(),
        title: body.title?.trim() ?? "",
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
      const chatKey = decodeParam(getRouterParam(event, "chatKey"));
      const body = await readBody<{
        title?: string;
        enabled?: boolean;
        triggerMode?: GroupTriggerMode;
      }>(event);

      return berry.store.chats.update(chatKey, body ?? {});
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
    "/api/admin/chats/:chatKey/conversation",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);

      return berry.store.conversations.open();
    }),
  );

  router.post(
    "/api/admin/chats/:chatKey/reset",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);
      const afterId = await berry.store.messages.maxId();

      return berry.store.conversations.reset(afterId);
    }),
  );

  router.get(
    "/api/admin/chats/:chatKey/messages",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);
      const chatKey = decodeParam(getRouterParam(event, "chatKey"));
      const parsed = parseChatKey(chatKey);
      const query = getQuery(event);
      const items = await berry.store.messages.search(chatKey, {
        query: typeof query.search === "string" ? query.search : undefined,
        limit: query.limit ? Number(query.limit) : 80,
        beforeId: query.beforeId ? Number(query.beforeId) : undefined,
      });

      const [assetMap, reactionMap] = await Promise.all([
        berry.store.assets.listForMessages(items.map((m) => m.id)),
        berry.store.reactions.aggregateForMessages(
          `${parsed.kind}:${parsed.chatId}`,
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
      const chatKey = decodeParam(getRouterParam(event, "chatKey"));
      const parsed = parseChatKey(chatKey);

      if (parsed.kind !== "group") {
        throw createError({ statusCode: 400, message: "仅支持群聊补录历史" });
      }

      if (!berry.gateway.configured) {
        throw createError({
          statusCode: 400,
          message: "message-gateway 未配置，无法拉取历史记录",
        });
      }

      const body = await readBody<{ count?: number }>(event);
      const rawMessages = await berry.gateway.getGroupMsgHistory(
        parsed.chatId,
        body?.count ?? 40,
      );

      return berry.webhook.ingestHistoryBatch(parsed.chatId, rawMessages);
    }),
  );

  router.post(
    "/api/admin/chats/:chatKey/digest",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);
      const chatKey = decodeParam(getRouterParam(event, "chatKey"));
      const parsed = parseChatKey(chatKey);

      if (parsed.kind !== "group") {
        throw createError({
          statusCode: 400,
          message: "仅支持对群聊生成讨论摘要",
        });
      }

      const body = await readBody<{ lookbackHours?: number }>(event);

      await berry.scheduler.enqueueDigestNow(
        parsed.chatId,
        body?.lookbackHours ?? 24,
      );

      return { queued: true };
    }),
  );

  router.post(
    "/api/admin/chats/:chatKey/inject",
    defineEventHandler(async (event) => {
      const session = await berry.auth.requireAdmin(event);
      const chatKey = decodeParam(getRouterParam(event, "chatKey"));
      const parsed = parseChatKey(chatKey);
      const body = await readBody<{ content?: string }>(event);

      if (!body?.content?.trim()) {
        throw createError({ statusCode: 400, message: "请输入指令内容" });
      }

      await berry.store.jobs.enqueue(
        "invoke",
        `admin:${chatKey}:${Date.now()}`,
        `${parsed.kind}:${parsed.chatId}`,
        {
          source: "admin_inject",
          chatKey: `${parsed.kind}:${parsed.chatId}`,
          kind: parsed.kind,
          chatId: parsed.chatId,
          triggerMessageIds: [],
          senderName: session.name,
          content: body.content.trim(),
        },
      );
      berry.worker.wake();

      return { queued: true };
    }),
  );

  router.get(
    "/api/admin/memories",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);
      const query = getQuery(event);
      const scope =
        query.scope === "global" ||
        query.scope === "chat" ||
        query.scope === "user"
          ? query.scope
          : undefined;

      return {
        items: await berry.store.memories.list({
          scope,
          ownerId:
            typeof query.ownerId === "string" && query.ownerId
              ? query.ownerId
              : undefined,
        }),
      };
    }),
  );

  router.put(
    "/api/admin/memories",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);
      const body = await readBody<{
        scope: MemoryScope;
        ownerId: string;
        key: string;
        summary: string;
        content: string;
      }>(event);

      if (
        body?.scope !== "global" &&
        body?.scope !== "chat" &&
        body?.scope !== "user"
      ) {
        throw createError({
          statusCode: 400,
          statusMessage: "Invalid memory scope",
        });
      }

      return berry.store.memories.upsert({
        ...body,
        ownerId: body.scope === "global" ? "global" : body.ownerId,
      });
    }),
  );

  router.delete(
    "/api/admin/memories",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);
      const query = getQuery(event);
      const scope =
        query.scope === "global" ||
        query.scope === "chat" ||
        query.scope === "user"
          ? query.scope
          : null;

      if (!scope) {
        throw createError({
          statusCode: 400,
          statusMessage: "Invalid memory scope",
        });
      }

      return {
        deleted: await berry.store.memories.remove(
          scope,
          scope === "global" ? "global" : String(query.ownerId ?? ""),
          String(query.key ?? ""),
        ),
      };
    }),
  );

  router.get(
    "/api/admin/guild/status",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);

      return {
        apiConfigured: berry.guild.enabled,
        databaseConfigured: berry.guildAutomation.databaseConfigured,
        publicUrl: berry.env.guildPublicUrl,
        cursors: await berry.store.cursors.list(),
      };
    }),
  );

  router.post(
    "/api/admin/guild/trigger/:task",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);
      const task = getRouterParam(event, "task");

      switch (task) {
        case "due": {
          return berry.guildAutomation.runDueReminders();
        }

        case "assignments": {
          return berry.guildAutomation.runAssignments();
        }

        case "weekly": {
          return berry.guildAutomation.runWeeklyReport();
        }

        default: {
          throw createError({ statusCode: 400, message: "未知公会任务类型" });
        }
      }
    }),
  );

  router.get(
    "/api/admin/guild/audit-logs",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);

      return { items: await berry.store.guildAudit.list(100) };
    }),
  );

  router.get(
    "/api/admin/identity/lookup",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);
      const query = getQuery(event);
      const q = typeof query.q === "string" ? query.q.trim() : "";

      if (!berry.directory.enabled) {
        return { enabled: false, items: [] };
      }

      return {
        enabled: true,
        items: q ? await berry.directory.searchMembers(q) : [],
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
      const body = await readBody<{
        title: string;
        kind?: ChatKind | "";
        chatId?: string;
        content: string;
        schedule: ScheduleSpec;
        enabled?: boolean;
      }>(event);

      return berry.store.schedules.create(body, berry.settings.bot.timezone);
    }),
  );

  router.patch(
    "/api/admin/schedules/:id",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);
      const id = decodeParam(getRouterParam(event, "id"));
      const body = await readBody<Record<string, unknown>>(event);
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
      const id = decodeParam(getRouterParam(event, "id"));

      return { deleted: await berry.store.schedules.remove(id) };
    }),
  );

  router.post(
    "/api/admin/schedules/:id/run",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);
      const id = decodeParam(getRouterParam(event, "id"));
      const ok = await berry.scheduler.triggerScheduleNow(id);

      if (!ok) {
        throw createError({ statusCode: 404, message: "定时任务不存在" });
      }

      return { queued: true };
    }),
  );

  router.get(
    "/api/admin/docs",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);

      return { items: await berry.knowledge.listFiles("all") };
    }),
  );

  router.get(
    "/api/admin/docs/content",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);
      const query = getQuery(event);
      const scope = query.scope === "knowledge" ? "knowledge" : "notebook";
      const path = typeof query.path === "string" ? query.path : "";

      return {
        scope,
        path,
        content: await berry.knowledge.readRaw(scope, path),
      };
    }),
  );

  router.put(
    "/api/admin/docs/content",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);
      const body = await readBody<{ path: string; content: string }>(event);

      return berry.knowledge.writeNotebook(body.path, body.content, "replace");
    }),
  );

  router.delete(
    "/api/admin/docs/content",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);
      const query = getQuery(event);

      return berry.knowledge.deleteNotebook(String(query.path ?? ""));
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
        settings: maskSettings(berry.settings),
        envSummary: {
          gatewayUrl: berry.env.gatewayUrl,
          gatewayAccount: berry.env.gatewayAccount,
          oidcIssuer: berry.env.oidcIssuer,
          guildApiUrl: berry.env.guildApiUrl,
          guildPublicUrl: berry.env.guildPublicUrl,
          webhookConfigured: Boolean(berry.env.webhookToken),
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
        const merged = mergeMaskedSettings(body, berry.settings);
        const saved = await berry.updateSettings(merged);

        return { settings: maskSettings(saved) };
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
        todayCalls: todayUsage.calls,
        todayUsage,
        buckets: await berry.store.usage.dailySummary(30),
      };
    }),
  );

  router.get(
    "/api/admin/jobs",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);

      return { items: await berry.store.jobs.list(100) };
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
      const id = Number(getRouterParam(event, "id"));
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
      const id = Number(getRouterParam(event, "id"));

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
      const body = await readBody<{ olderThanDays?: number }>(event);
      const days = Number(body?.olderThanDays ?? 30);

      if (!Number.isFinite(days) || days < 1) {
        throw createError({
          statusCode: 400,
          message: "保留天数须为大于或等于 1 的整数",
        });
      }

      return berry.store.maintenance.purgeOldData(days);
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
      if (event.method !== "GET" && event.method !== "HEAD") {
        throw createError({ statusCode: 404, message: "Not Found" });
      }

      const rawPath = (event.path || "/").split("?")[0]!;
      const rel = normalize(rawPath)
        .replace(/^(\.\.[/\\])+/, "")
        .replace(/^\/+/, "");
      const candidate = rel
        ? join(resolvedDist, rel)
        : join(resolvedDist, "index.html");

      try {
        const info = await stat(candidate);

        if (info.isFile()) {
          const ext = extname(candidate);

          setHeader(
            event,
            "Content-Type",
            MIME_BY_EXT[ext] ?? "application/octet-stream",
          );
          if (rel.startsWith("assets/")) {
            setHeader(
              event,
              "Cache-Control",
              "public, max-age=31536000, immutable",
            );
          }

          return await readFile(candidate);
        }
      } catch {
        // Fall back to index.html for SPA routes.
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
