import type { Router } from "h3";
import { createError, defineEventHandler } from "h3";
import { Type } from "typebox";

import type { BerryApp } from "../../app.ts";
import { idParamSchema, parseBody, parseParams, parseQuery } from "../http.ts";
import { buildAiTraces, buildMessageTrace } from "../traces.ts";

const nonBlankString = Type.String({ minLength: 1, pattern: "\\S" });

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

const deliveriesQuerySchema = Type.Object({
  limit: Type.Integer({ minimum: 1, maximum: 200, default: 100 }),
});

const aiTracesQuerySchema = Type.Object({
  chatKey: Type.Optional(Type.String()),
  status: Type.Optional(
    Type.Union([Type.Literal("ok"), Type.Literal("error")]),
  ),
  scope: Type.Optional(
    Type.Union([
      Type.Literal("all"),
      Type.Literal("active"),
      Type.Literal("error"),
    ]),
  ),
  purpose: Type.Optional(Type.String()),
  search: Type.Optional(Type.String()),
  limit: Type.Integer({ minimum: 1, maximum: 120, default: 60 }),
});

const tapeQuerySchema = Type.Object({
  tapeId: Type.String({ default: "global" }),
  limit: Type.Integer({ minimum: 1, maximum: 500, default: 200 }),
  beforeId: Type.Optional(Type.Integer({ minimum: 1 })),
  afterId: Type.Optional(Type.Integer({ minimum: 1 })),
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

export function registerAiRoutes(router: Router, berry: BerryApp): void {
  router.get(
    "/api/admin/gate-decisions",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);
      const query = await parseQuery(event, gateQuerySchema);

      return berry.store.gate.list(query);
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
    "/api/admin/llm-calls",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);
      const query = await parseQuery(event, llmCallsQuerySchema);

      return berry.store.usage.listRecent(query);
    }),
  );

  router.get(
    "/api/admin/ai/traces",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);
      const query = await parseQuery(event, aiTracesQuerySchema);

      return buildAiTraces(berry, query);
    }),
  );

  router.get(
    "/api/admin/messages/:id/trace",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);
      const { id } = await parseParams(event, idParamSchema, "无效的消息编号");
      const trace = await buildMessageTrace(berry, id);

      if (!trace) {
        throw createError({ statusCode: 404, message: "消息不存在" });
      }

      return trace;
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
    "/api/admin/deliveries",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);
      const query = await parseQuery(event, deliveriesQuerySchema);

      return { items: await berry.store.deliveries.list(query.limit) };
    }),
  );
}
