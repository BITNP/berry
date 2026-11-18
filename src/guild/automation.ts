import { completeChat } from "../agent/llm.ts";
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
import type { GuildEvent, GuildInternalClient } from "./client.ts";

const DUE_CURSOR = "guild_due_cursor";
const EVENT_CURSOR = "guild_event_cursor";
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
  #env: EnvConfig;
  #guild: GuildInternalClient;
  #store: Store;
  #directory: IdentityDirectory;
  #gateway: MessageGatewayClient;
  #knowledge: KnowledgeBase;
  #mcp: McpHub;
  #getSettings: () => RuntimeSettings;
  #logger = new Logger("guild:auto");
  #timer: ReturnType<typeof setInterval> | null = null;
  #started = false;
  #running = false;
  #lastPollAt = 0;
  #streamConnected = false;
  #streamAbort: AbortController | null = null;
  #streamPromise: Promise<void> | null = null;
  #eventQueue: Promise<unknown> = Promise.resolve();

  constructor(
    env: EnvConfig,
    guild: GuildInternalClient,
    store: Store,
    directory: IdentityDirectory,
    gateway: MessageGatewayClient,
    knowledge: KnowledgeBase,
    mcp: McpHub,
    getSettings: () => RuntimeSettings,
  ) {
    this.#env = env;
    this.#guild = guild;
    this.#store = store;
    this.#directory = directory;
    this.#gateway = gateway;
    this.#knowledge = knowledge;
    this.#mcp = mcp;
    this.#getSettings = getSettings;
  }

  public get streamConnected(): boolean {
    return this.#streamConnected;
  }

  public start(): void {
    this.#started = true;

    if (!this.#timer) {
      this.#timer = setInterval(() => {
        void this.tick();
      }, 15_000);
      this.#timer.unref();
    }

    this.syncState();
  }

  public async stop(): Promise<void> {
    this.#started = false;

    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }

    await this.#stopStream();
    await this.#eventQueue.catch(() => undefined);
  }

  public syncState(): void {
    if (!this.#started) {
      return;
    }

    if (this.#shouldStream()) {
      if (!this.#streamPromise) {
        const promise = this.#runStreamLoop().finally(() => {
          if (this.#streamPromise === promise) {
            this.#streamPromise = null;
          }
        });

        this.#streamPromise = promise;
      }
    } else {
      void this.#stopStream();
    }
  }

  public async tick(): Promise<void> {
    if (this.#running || !this.#guild.enabled) {
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

      if (
        settings.guildAutomation.assignmentsEnabled &&
        !this.#streamConnected
      ) {
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
    if (!this.#guild.enabled) {
      throw new Error(
        "Guild 内部服务接口未配置（BERRY_GUILD_API_URL / BERRY_GUILD_INTERNAL_TOKEN）",
      );
    }

    const settings = this.#getSettings();
    const saved = await this.#store.cursors.get(DUE_CURSOR);

    if (!saved) {
      const seed = await this.#guild.listDueNodes({
        dueBefore: "1970-01-01T00:00:00Z",
        includeOverdue: false,
        limit: 1,
      });

      await this.#store.cursors.set(DUE_CURSOR, seed.serverTime);

      return { notified: 0 };
    }

    const res = await this.#guild.listDueNodes({
      since: saved,
      advanceHours: settings.guildAutomation.dueAdvanceHours,
      includeOverdue: false,
    });

    let notified = 0;

    for (const item of res.items) {
      const dueMs = Date.parse(item.dueAt);
      const deadline = formatDateTime(dueMs, settings.bot.timezone);
      const url = this.#env.guildPublicUrl
        ? `\n${this.#env.guildPublicUrl}/nodes/${item.id}`
        : "";
      const text = `任务即将到期：${item.title}\n截止时间：${deadline}${url}`;

      for (const subject of item.leaders) {
        if (await this.#notifySubject(subject, text, settings.bot.botQQ)) {
          notified++;
        }
      }
    }

    await this.#store.cursors.set(DUE_CURSOR, res.serverTime);

    return { notified };
  }

  public runAssignments(): Promise<{ notified: number }> {
    if (!this.#guild.enabled) {
      return Promise.reject(
        new Error(
          "Guild 内部服务接口未配置（BERRY_GUILD_API_URL / BERRY_GUILD_INTERNAL_TOKEN）",
        ),
      );
    }

    return this.#enqueueEventWork(async () => {
      const settings = this.#getSettings();
      const saved = await this.#store.cursors.get(EVENT_CURSOR);

      if (!saved) {
        const seed = await this.#guild.listEvents(0, 1);

        await this.#store.cursors.set(EVENT_CURSOR, String(seed.latestId));

        return { notified: 0 };
      }

      let cursor = this.#parseCursor(saved);
      let notified = 0;

      while (true) {
        const batch = await this.#guild.listEvents(cursor, 100);

        for (const ev of batch.items) {
          if (ev.id <= cursor) {
            continue;
          }

          if (await this.#processEvent(ev, settings)) {
            notified++;
          }

          cursor = ev.id;
        }

        await this.#store.cursors.set(EVENT_CURSOR, String(cursor));

        if (!batch.hasMore || batch.items.length === 0) {
          break;
        }
      }

      return { notified };
    });
  }

  public async runWeeklyReport(atMs = Date.now()): Promise<{
    path: string;
    periodStart: string;
  }> {
    if (!this.#guild.enabled) {
      throw new Error(
        "Guild 内部服务接口未配置（BERRY_GUILD_API_URL / BERRY_GUILD_INTERNAL_TOKEN）",
      );
    }

    const settings = this.#getSettings();
    const period = previousNaturalWeek(atMs);
    const data = await this.#guild.getActivitySummary(
      period.start.toISOString(),
      period.end.toISOString(),
    );
    const snapshotMs = Date.parse(data.snapshotAt);

    const endDisplay = formatDay(
      period.end.getTime() - 86_400 * 1000,
      "Asia/Shanghai",
    );
    const title = `看板周报 ${period.label} 至 ${endDisplay}`;

    let summary = "本周无新增自动化总结（主模型未配置）。";

    if (settings.mainModel.apiKey && settings.mainModel.model) {
      const res = await completeChat({
        apiKey: settings.mainModel.apiKey,
        baseURL: settings.mainModel.baseURL,
        model: settings.mainModel.model,
        timeoutMs: settings.mainModel.timeoutMs,
        maxRetries: 2,
        store: this.#store,
        timeZone: settings.bot.timezone,
        purpose: "report",
        params: {
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
                periodStart: data.start,
                periodEndExclusive: data.end,
                snapshotAt: data.snapshotAt,
                createdInPeriod: data.createdNodes.map((n) => ({
                  id: n.id,
                  title: n.title,
                })),
                completedInPeriod: data.completedNodes.map((n) => ({
                  id: n.id,
                  title: n.title,
                })),
                commentsInPeriod: data.recentComments
                  .slice(0, 100)
                  .map((c) => ({
                    nodeId: c.nodeId,
                    nodeTitle: c.nodeTitle,
                    body: c.bodyPreview,
                  })),
                currentlyOpenCount: data.openCount,
                currentlyOverdue: data.overdueNodes.map((n) => ({
                  id: n.id,
                  title: n.title,
                  dueAt: n.dueAt,
                })),
              }),
            },
          ],
        },
      });

      summary = res.choices[0]?.message?.content?.trim() || summary;
    }

    const markdown = `# ${title}

统计区间：[${period.start.toISOString()}, ${period.end.toISOString()})
状态采集时间：${formatDateTime(Number.isFinite(snapshotMs) ? snapshotMs : Date.now(), "Asia/Shanghai")} (UTC+8)

- 周内新增：${data.createdCount}
- 周内完成：${data.completedCount}
- 周内评论：${data.commentCount}
- 当前未完成：${data.openCount}
- 当前逾期：${data.overdueCount}

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

  #shouldStream(): boolean {
    if (!this.#started || !this.#guild.enabled) {
      return false;
    }

    const settings = this.#getSettings();

    return (
      settings.guildAutomation.enabled &&
      settings.guildAutomation.assignmentsEnabled
    );
  }

  async #stopStream(): Promise<void> {
    this.#streamConnected = false;

    if (this.#streamAbort) {
      this.#streamAbort.abort();
      this.#streamAbort = null;
    }

    if (this.#streamPromise) {
      await this.#streamPromise.catch(() => undefined);
    }
  }

  async #runStreamLoop(): Promise<void> {
    let backoffMs = 2000;

    while (this.#shouldStream()) {
      const ctrl = new AbortController();
      let openedAt = 0;

      this.#streamAbort = ctrl;

      try {
        const after = await this.#ensureEventCursor();

        if (!this.#shouldStream() || ctrl.signal.aborted) {
          break;
        }

        openedAt = Date.now();

        for await (const frame of this.#guild.streamEvents(
          after,
          ctrl.signal,
          () => {
            this.#streamConnected = true;
            backoffMs = 2000;
          },
        )) {
          if (!this.#shouldStream() || ctrl.signal.aborted) {
            break;
          }

          if (!frame.data) {
            continue;
          }

          let parsed: GuildEvent;

          try {
            parsed = JSON.parse(frame.data) as GuildEvent;
          } catch {
            this.#logger.warn("Ignored malformed Guild SSE event", {
              event: frame.event,
            });

            continue;
          }

          await this.#enqueueEventWork(async () => {
            const currentCursor = this.#parseCursor(
              await this.#store.cursors.get(EVENT_CURSOR),
            );

            if (parsed.id <= currentCursor) {
              return;
            }

            await this.#processEvent(parsed, this.#getSettings());
            await this.#store.cursors.set(EVENT_CURSOR, String(parsed.id));
          });
        }
      } catch (error) {
        if (ctrl.signal.aborted || !this.#shouldStream()) {
          break;
        }

        this.#logger.warn("Guild SSE stream disconnected", {
          error: errorMessage(error),
          retryInMs: backoffMs,
        });
      } finally {
        this.#streamConnected = false;

        if (this.#streamAbort === ctrl) {
          this.#streamAbort = null;
        }
      }

      if (!this.#shouldStream()) {
        break;
      }

      if (openedAt > 0 && Date.now() - openedAt > 60_000) {
        backoffMs = 2000;
      }

      await this.#sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, 60_000);
    }
  }

  #ensureEventCursor(): Promise<number> {
    return this.#enqueueEventWork(async () => {
      const saved = await this.#store.cursors.get(EVENT_CURSOR);

      if (saved !== null) {
        return this.#parseCursor(saved);
      }

      const seed = await this.#guild.listEvents(0, 1);

      await this.#store.cursors.set(EVENT_CURSOR, String(seed.latestId));

      return seed.latestId;
    });
  }

  #enqueueEventWork<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#eventQueue.then(fn, fn);

    this.#eventQueue = run.then(
      () => undefined,
      () => undefined,
    );

    return run;
  }

  #parseCursor(raw: string | null): number {
    if (!raw) {
      return 0;
    }

    const parsed = Number.parseInt(raw, 10);

    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  }

  async #processEvent(
    ev: GuildEvent,
    settings: RuntimeSettings,
  ): Promise<boolean> {
    if (ev.kind !== "member.assigned") {
      return false;
    }

    const payload = ev.payload ?? {};
    const subject =
      typeof payload.subject === "string" ? payload.subject.trim() : "";

    if (!subject) {
      return false;
    }

    const onCreate = payload.onCreate === true;

    if (onCreate && subject === ev.actorSubject) {
      return false;
    }

    const role = payload.role === "leader" ? "leader" : "member";
    const roleLabel = role === "leader" ? "负责人" : "成员";
    const rawTitle =
      typeof payload.nodeTitle === "string" ? payload.nodeTitle.trim() : "";
    const title = rawTitle || (ev.nodeId ? `节点 #${ev.nodeId}` : "公会任务");
    const url =
      ev.nodeId && this.#env.guildPublicUrl
        ? `\n${this.#env.guildPublicUrl}/nodes/${ev.nodeId}`
        : "";
    const assignor = await this.#resolveActorName(ev.actorSubject, subject);
    const text = assignor
      ? `${assignor} 已将你指定为公会任务的${roleLabel}：${title}${url}`
      : `你已被指定为公会任务的${roleLabel}：${title}${url}`;

    return this.#notifySubject(subject, text, settings.bot.botQQ);
  }

  async #resolveActorName(
    actorSubject: string,
    targetSubject: string,
  ): Promise<string> {
    if (!actorSubject || actorSubject === targetSubject) {
      return "";
    }

    try {
      const actor = await this.#directory.bySubject(actorSubject);

      return actor?.name?.trim() || "";
    } catch {
      return "";
    }
  }

  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);

      timer.unref();
    });
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
