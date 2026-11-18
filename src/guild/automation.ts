import OpenAI from "openai";
import postgres from "postgres";

import type { EnvConfig } from "../config/env.ts";
import type { RuntimeSettings } from "../config/settings.ts";
import type { MessageGatewayClient } from "../gateway/client.ts";
import type { IdentityDirectory } from "../identity/keycloak.ts";
import type { KnowledgeBase } from "../knowledge/files.ts";
import type { McpHub } from "../mcp/hub.ts";
import type { Store } from "../store/index.ts";
import { computeNextRunAt } from "../store/schedules.ts";
import { makeChatKey } from "../types.ts";
import { Logger } from "../utils/logger.ts";
import { errorMessage, formatDateTime, formatDay } from "../utils/time.ts";

const DUE_CURSOR = "guild_due_cursor";
const ASSIGN_CURSOR = "guild_assign_cursor";
const WEEKLY_CURSOR = "guild_weekly_last_period";

export function previousNaturalWeek(atMs = Date.now()): {
  start: Date;
  end: Date;
  label: string;
} {
  // Compute UTC+8 natural week [Mon 00:00, next Mon 00:00).
  const shanghaiOffsetMs = 8 * 3600 * 1000;
  const local = new Date(atMs + shanghaiOffsetMs);
  const weekdayMon0 = (local.getUTCDay() + 6) % 7;
  const endUtcMs =
    Date.UTC(
      local.getUTCFullYear(),
      local.getUTCMonth(),
      local.getUTCDate() - weekdayMon0,
      0,
      0,
      0,
    ) - shanghaiOffsetMs;
  const startUtcMs = endUtcMs - 7 * 86_400 * 1000;
  const start = new Date(startUtcMs);
  const end = new Date(endUtcMs);

  return {
    start,
    end,
    label: formatDay(startUtcMs, "Asia/Shanghai"),
  };
}

export class GuildAutomationRunner {
  #sql: ReturnType<typeof postgres> | null = null;
  #store: Store;
  #directory: IdentityDirectory;
  #gateway: MessageGatewayClient;
  #knowledge: KnowledgeBase;
  #mcp: McpHub;
  #env: EnvConfig;
  #getSettings: () => RuntimeSettings;
  #logger = new Logger("guild:auto");
  #timer: ReturnType<typeof setInterval> | null = null;
  #running = false;
  #lastPollAt = 0;

  constructor(
    env: EnvConfig,
    store: Store,
    directory: IdentityDirectory,
    gateway: MessageGatewayClient,
    knowledge: KnowledgeBase,
    mcp: McpHub,
    getSettings: () => RuntimeSettings,
  ) {
    this.#env = env;
    this.#store = store;
    this.#directory = directory;
    this.#gateway = gateway;
    this.#knowledge = knowledge;
    this.#mcp = mcp;
    this.#getSettings = getSettings;

    if (env.guildDatabaseUrl) {
      this.#sql = postgres(env.guildDatabaseUrl, {
        max: 2,
        idle_timeout: 30,
        connect_timeout: 10,
        connection: {
          default_transaction_read_only: true,
          statement_timeout: 10_000,
        },
      });
    }
  }

  public get databaseConfigured(): boolean {
    return this.#sql !== null;
  }

  public start(): void {
    if (this.#timer) {
      return;
    }

    this.#timer = setInterval(() => {
      void this.tick();
    }, 15_000);
    this.#timer.unref();
  }

  public async stop(): Promise<void> {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }

    if (this.#sql) {
      await this.#sql.end({ timeout: 5 });
      this.#sql = null;
    }
  }

  public async tick(): Promise<void> {
    if (this.#running || !this.#sql) {
      return;
    }

    const settings = this.#getSettings();

    if (!settings.guildAutomation.enabled) {
      return;
    }

    const now = Date.now();

    if (now - this.#lastPollAt < settings.guildAutomation.pollSeconds * 1000) {
      return;
    }

    this.#running = true;
    this.#lastPollAt = now;

    try {
      if (settings.guildAutomation.dueReminderEnabled) {
        await this.runDueReminders();
      }

      if (settings.guildAutomation.assignmentsEnabled) {
        await this.runAssignments();
      }

      await this.#maybeRunWeeklyReport(settings);
    } catch (error) {
      this.#logger.warn("Guild automation tick failed", {
        error: errorMessage(error),
      });
    } finally {
      this.#running = false;
    }
  }

  public async runDueReminders(): Promise<{ notified: number }> {
    if (!this.#sql) {
      throw new Error("BERRY_GUILD_DATABASE_URL 未配置");
    }

    const settings = this.#getSettings();
    const nowRow = await this.#sql<
      { now: Date }[]
    >`SELECT clock_timestamp() AS now`;
    const dbNow = nowRow[0]!.now;
    const saved = await this.#store.cursors.get(DUE_CURSOR);

    if (!saved) {
      await this.#store.cursors.set(DUE_CURSOR, dbNow.toISOString());

      return { notified: 0 };
    }

    const cursorDate = new Date(saved);

    if (dbNow <= cursorDate) {
      return { notified: 0 };
    }

    const advanceMs = settings.guildAutomation.dueAdvanceHours * 3600 * 1000;
    const windowStart = new Date(cursorDate.getTime() + advanceMs);
    const windowEnd = new Date(dbNow.getTime() + advanceMs);

    const rows = await this.#sql<
      { id: number; title: string; due_at: Date; subject: string }[]
    >`
      SELECT n.id, n.title, n.due_at, m.subject
      FROM nodes n
      JOIN node_members m ON m.node_id = n.id AND m.role = 'leader'
      WHERE n.completed_at IS NULL
        AND n.due_at >= ${windowStart}
        AND n.due_at < ${windowEnd}
        AND n.due_at > ${dbNow}
      ORDER BY n.due_at, n.id, m.subject
    `;

    let notified = 0;

    for (const row of rows) {
      const deadline = formatDateTime(
        row.due_at.getTime(),
        settings.bot.timezone,
      );
      const url = this.#env.guildPublicUrl
        ? `\n${this.#env.guildPublicUrl}/nodes/${row.id}`
        : "";
      const text = `任务即将到期：${row.title}\n截止时间：${deadline}${url}`;

      if (await this.#notifySubject(row.subject, text, settings.bot.botQQ)) {
        notified++;
      }
    }

    await this.#store.cursors.set(DUE_CURSOR, dbNow.toISOString());

    return { notified };
  }

  public async runAssignments(): Promise<{ notified: number }> {
    if (!this.#sql) {
      throw new Error("BERRY_GUILD_DATABASE_URL 未配置");
    }

    const settings = this.#getSettings();
    const nowRow = await this.#sql<
      { now: Date }[]
    >`SELECT clock_timestamp() AS now`;
    const dbNow = nowRow[0]!.now;
    const saved = await this.#store.cursors.get(ASSIGN_CURSOR);

    if (!saved) {
      await this.#store.cursors.set(ASSIGN_CURSOR, dbNow.toISOString());

      return { notified: 0 };
    }

    const cursorDate = new Date(saved);

    if (dbNow <= cursorDate) {
      return { notified: 0 };
    }

    const rows = await this.#sql<
      {
        id: number;
        title: string;
        subject: string;
        role: string;
        created_at: Date;
      }[]
    >`
      SELECT n.id, n.title, m.subject, m.role, m.created_at
      FROM node_members m
      JOIN nodes n ON n.id = m.node_id
      WHERE m.created_at >= ${cursorDate} AND m.created_at < ${dbNow}
      ORDER BY m.created_at, n.id, m.subject
    `;

    let notified = 0;

    for (const row of rows) {
      const roleLabel = row.role === "leader" ? "负责人" : "成员";
      const url = this.#env.guildPublicUrl
        ? `\n${this.#env.guildPublicUrl}/nodes/${row.id}`
        : "";
      const text = `你已被指定为公会任务的${roleLabel}：${row.title}${url}`;

      if (await this.#notifySubject(row.subject, text, settings.bot.botQQ)) {
        notified++;
      }
    }

    await this.#store.cursors.set(ASSIGN_CURSOR, dbNow.toISOString());

    return { notified };
  }

  public async runWeeklyReport(atMs = Date.now()): Promise<{
    path: string;
    periodStart: string;
  }> {
    if (!this.#sql) {
      throw new Error("BERRY_GUILD_DATABASE_URL 未配置");
    }

    const settings = this.#getSettings();
    const period = previousNaturalWeek(atMs);
    const snapshotAt = new Date();

    const [nodes, comments] = await Promise.all([
      this.#sql<
        {
          id: number;
          parent_id: number | null;
          title: string;
          created_at: Date;
          completed_at: Date | null;
          due_at: Date | null;
        }[]
      >`
        SELECT id, parent_id, title, created_at, completed_at, due_at
        FROM nodes
        ORDER BY id
      `,
      this.#sql<
        { id: number; node_id: number; body: string; created_at: Date }[]
      >`
        SELECT id, node_id, body, created_at
        FROM comments
        WHERE created_at >= ${period.start} AND created_at < ${period.end}
        ORDER BY created_at
      `,
    ]);

    const created = nodes.filter(
      (n) => n.created_at >= period.start && n.created_at < period.end,
    );
    const completed = nodes.filter(
      (n) =>
        n.completed_at !== null &&
        n.completed_at >= period.start &&
        n.completed_at < period.end,
    );
    const openNodes = nodes.filter((n) => n.completed_at === null);
    const overdue = openNodes.filter(
      (n) => n.due_at !== null && n.due_at < snapshotAt,
    );

    const endDisplay = formatDay(
      period.end.getTime() - 86_400 * 1000,
      "Asia/Shanghai",
    );
    const title = `看板周报 ${period.label} 至 ${endDisplay}`;

    let summary = "本周无新增自动化总结（主模型未配置）。";

    if (settings.mainModel.apiKey && settings.mainModel.model) {
      const started = performance.now();
      const client = new OpenAI({
        apiKey: settings.mainModel.apiKey,
        baseURL: settings.mainModel.baseURL,
        timeout: settings.mainModel.timeoutMs,
      });

      const res = await client.chat.completions.create({
        model: settings.mainModel.model,
        temperature: 0.2,
        max_tokens: 2048,
        messages: [
          {
            role: "system",
            content:
              "你是 BITNP 公会周报整理助手。统计区间为 UTC+8 上一自然周，当前未完成和逾期是生成时刻的实时状态，不是历史快照。只依据提供的数据总结进展、讨论、未完成事项与需要关注的问题，使用平实中文 Markdown。",
          },
          {
            role: "user",
            content: JSON.stringify({
              periodStart: period.start.toISOString(),
              periodEndExclusive: period.end.toISOString(),
              snapshotAt: snapshotAt.toISOString(),
              createdInPeriod: created.map((n) => ({
                id: n.id,
                title: n.title,
              })),
              completedInPeriod: completed.map((n) => ({
                id: n.id,
                title: n.title,
              })),
              commentsInPeriod: comments.slice(0, 100).map((c) => ({
                nodeId: c.node_id,
                body: c.body.slice(0, 200),
              })),
              currentlyOpenCount: openNodes.length,
              currentlyOverdue: overdue.map((n) => ({
                id: n.id,
                title: n.title,
                dueAt: n.due_at?.toISOString(),
              })),
            }),
          },
        ],
      });

      const usage = res.usage;

      await this.#store.usage.record({
        purpose: "report",
        model: settings.mainModel.model,
        inputTokens: usage?.prompt_tokens ?? 0,
        cachedInputTokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
        outputTokens: usage?.completion_tokens ?? 0,
        durationMs: Math.round(performance.now() - started),
        timeZone: settings.bot.timezone,
      });
      summary = res.choices[0]?.message?.content?.trim() || summary;
    }

    const markdown = `# ${title}

统计区间：[${period.start.toISOString()}, ${period.end.toISOString()})
状态采集时间：${formatDateTime(snapshotAt.getTime(), "Asia/Shanghai")} (UTC+8)

- 周内新增：${created.length}
- 周内完成：${completed.length}
- 周内评论：${comments.length}
- 当前未完成：${openNodes.length}
- 当前逾期：${overdue.length}

${summary}
`;

    const relPath = `guild-reports/${period.label}.md`;

    await this.#knowledge.writeNotebook(relPath, markdown, "replace");
    await this.#store.cursors.set(WEEKLY_CURSOR, period.label);

    if (settings.guildAutomation.weeklyUploadTool) {
      await this.#mcp.call(settings.guildAutomation.weeklyUploadTool, {
        title,
        markdown,
        metadata: { periodStart: period.label },
      });
    }

    return { path: relPath, periodStart: period.label };
  }

  async #maybeRunWeeklyReport(settings: RuntimeSettings): Promise<void> {
    if (
      !settings.guildAutomation.weeklyReportEnabled ||
      !settings.guildAutomation.weeklySchedule
    ) {
      return;
    }

    const nextKey = "guild_weekly_next_run";
    const storedNext = await this.#store.cursors.get(nextKey);
    const now = Date.now();

    if (!storedNext) {
      const next = computeNextRunAt(
        settings.guildAutomation.weeklySchedule,
        now,
        "Asia/Shanghai",
      );

      if (next !== null) {
        await this.#store.cursors.set(nextKey, String(next));
      }

      return;
    }

    const dueAt = Number(storedNext);

    if (!Number.isFinite(dueAt) || now < dueAt) {
      return;
    }

    await this.runWeeklyReport(now);
    const next = computeNextRunAt(
      settings.guildAutomation.weeklySchedule,
      now,
      "Asia/Shanghai",
    );

    if (next !== null) {
      await this.#store.cursors.set(nextKey, String(next));
    }
  }

  async #notifySubject(
    subject: string,
    text: string,
    botQQ: string,
  ): Promise<boolean> {
    try {
      const user = await this.#directory.bySubject(subject);

      if (!user?.qq) {
        this.#logger.warn("Skipped notification: no QQ binding", { subject });

        return false;
      }

      const chatKey = makeChatKey("private", user.qq);

      await this.#gateway.dispatchUnit(
        chatKey,
        { kind: "qq_reply", text },
        botQQ,
      );

      return true;
    } catch (error) {
      this.#logger.warn("Guild notification failed", {
        subject,
        error: errorMessage(error),
      });

      return false;
    }
  }
}
