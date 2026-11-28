import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";

import type { Router } from "h3";
import {
  createError,
  createEventStream,
  defineEventHandler,
  readBody,
  setHeader,
} from "h3";
import { Type } from "typebox";

import type { BerryApp } from "../../app.ts";
import {
  DEFAULT_TASK_MAX_OUTPUT_TOKENS,
  parseSettings,
} from "../../config/settings.ts";
import { errorMessage } from "../../utils/time.ts";
import { idParamSchema, parseBody, parseParams, parseQuery } from "../http.ts";

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

const botStateBodySchema = Type.Object({
  paused: Type.Boolean({ default: false }),
});

const purgeScopeSchema = Type.Union([
  Type.Literal("llm_traces"),
  Type.Literal("archived_tape"),
  Type.Literal("runtime_logs"),
  Type.Literal("messages"),
]);

const purgeBodySchema = Type.Object({
  olderThanDays: Type.Integer({ minimum: 1, maximum: 3650, default: 7 }),
  scopes: Type.Array(purgeScopeSchema, {
    minItems: 1,
    default: ["llm_traces", "archived_tape", "runtime_logs"],
  }),
});

export function registerSystemRoutes(router: Router, berry: BerryApp): void {
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
        bot: { ...berry.settings.bot, paused },
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
          {
            key: "gate",
            label: "分流小模型",
            supportsThinking: false,
            defaultMaxOutputTokens: DEFAULT_TASK_MAX_OUTPUT_TOKENS.gate,
          },
          {
            key: "vision",
            label: "图像识别",
            supportsThinking: false,
            defaultMaxOutputTokens: DEFAULT_TASK_MAX_OUTPUT_TOKENS.vision,
          },
          { key: "report", label: "公会周报" },
          { key: "memory_update", label: "记忆提炼" },
          { key: "compaction", label: "摘要压缩" },
          { key: "style_distill", label: "群风提炼" },
          { key: "jargon_distill", label: "黑话提炼" },
          { key: "impression_update", label: "成员印象" },
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
      const { olderThanDays, scopes } = await parseBody(
        event,
        purgeBodySchema,
        "请指定有效的清理范围及大于等于 1 的保留天数",
      );

      return berry.store.maintenance.purgeData({ olderThanDays, scopes });
    }),
  );

  router.post(
    "/api/admin/storage/compact",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);

      return berry.store.maintenance.compactDatabase();
    }),
  );
}
