import { ModelIds } from "../agent/model-ids.ts";
import type { SubagentRegistry } from "../agent/subagents/index.ts";
import type { AgentServices } from "../tools/types.ts";
import type { ChatKey, JobRecord, ScheduleRecord } from "../types.ts";
import { makeChatKey } from "../types.ts";
import { Logger } from "../utils/logger.ts";
import { errorMessage, formatDateTime, formatDay } from "../utils/time.ts";

export class ScheduleRunner {
  #services: AgentServices;
  #subagents: SubagentRegistry;
  #wake: () => void;
  #logger = new Logger("scheduler");
  #timer: ReturnType<typeof setInterval> | null = null;
  #ticking = false;
  #lastDigestCheck = 0;

  constructor(
    services: AgentServices,
    subagents: SubagentRegistry,
    wake: () => void,
  ) {
    this.#services = services;
    this.#subagents = subagents;
    this.#wake = wake;
  }

  public start(): void {
    if (this.#timer) {
      return;
    }

    this.#timer = setInterval(() => {
      void this.tick();
    }, 1000);
    this.#timer.unref();
  }

  public stop(): void {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  public async tick(): Promise<void> {
    if (this.#ticking) {
      return;
    }

    this.#ticking = true;

    try {
      const now = Date.now();
      const settings = this.#services.getSettings();
      const due = await this.#services.store.schedules.due(now);

      for (const task of due) {
        await this.#services.store.schedules.markFired(
          task,
          now,
          settings.bot.timezone,
        );
        await this.#enqueueScheduleTask(task, now, "schedule", "触发");
      }

      if (
        settings.groupDigest.enabled &&
        now - this.#lastDigestCheck >= 30_000
      ) {
        this.#lastDigestCheck = now;
        await this.#checkDigests(now);
      }
    } catch (error) {
      this.#logger.warn("Scheduler tick failed", {
        error: errorMessage(error),
      });
    } finally {
      this.#ticking = false;
    }
  }

  public async runGroupDigest(job: JobRecord<"group_digest">): Promise<void> {
    const { store, gateway, knowledge, mcp } = this.#services;
    const settings = this.#services.getSettings();
    const { chatKey, groupId, startTimeMs, endTimeMs, prompt, uploadTool } =
      job.payload;

    await gateway.warmChatHistory("group", groupId, 200);
    const messages = await store.messages.search(chatKey, {
      startTimeMs,
      endTimeMs,
      limit: 400,
    });

    if (messages.length < settings.groupDigest.minMessages) {
      return;
    }

    if (!settings.mainModel.apiKey || !settings.mainModel.model) {
      return;
    }

    const chat = await store.chats.get(chatKey);
    const ids = new ModelIds();
    const gRef = ids.groupRef(groupId);
    const windowStartIso = new Date(startTimeMs).toISOString();
    const windowEndIso = new Date(endTimeMs).toISOString();
    const task = [
      `请整理 QQ 群「${chat?.title || groupId}」（targetRef=${gRef}）的阶段讨论摘要。`,
      `时间窗：${windowStartIso} ~ ${windowEndIso}（${formatDateTime(startTimeMs, settings.bot.timezone)} ~ ${formatDateTime(endTimeMs, settings.bot.timezone)}）。`,
      `请调用 search_chat_messages(targetRef="${gRef}", startTimeIso="${windowStartIso}", endTimeIso="${windowEndIso}", limit=120) 获取消息（需要更多上下文时配合 read_chat_window），`,
      "并在 brief 字段直接输出清晰简洁的中文 Markdown 摘要，保留关键技术结论与待办。",
      `总结重点：${prompt}`,
    ].join("\n");

    const subagentResult = await this.#subagents.run("chat_analyst", task, {
      services: this.#services,
      actor: {
        chatKey,
        senderQQ: null,
        actorSubject: null,
        actorName: null,
        actorIsAdmin: true,
        actorIsManager: true,
        actorAdmitted: true,
      },
      ids,
    });

    const markdown = subagentResult.brief.trim();

    if (!markdown) {
      return;
    }

    const day = formatDay(endTimeMs, settings.bot.timezone);
    const stamp = formatDateTime(endTimeMs, settings.bot.timezone)
      .replaceAll(":", "")
      .replace(" ", "-");
    const path = `group-digests/${groupId}/${day}-${stamp}.md`;
    const title = `群 ${groupId} 讨论摘要 (${day})`;

    await knowledge.writeNotebook(path, `# ${title}\n\n${markdown}\n`);

    if (uploadTool) {
      await mcp.call(uploadTool, {
        title,
        markdown,
        metadata: { groupId, startTimeMs, endTimeMs },
      });
    }
  }

  public async triggerScheduleNow(scheduleId: string): Promise<boolean> {
    const task = await this.#services.store.schedules.get(scheduleId);

    if (!task) {
      return false;
    }

    await this.#enqueueScheduleTask(
      task,
      Date.now(),
      "schedule-manual",
      "立即执行",
    );

    return true;
  }

  public async enqueueDigestNow(
    groupId: string,
    lookbackHours = 24,
  ): Promise<void> {
    const now = Date.now();
    const settings = this.#services.getSettings();
    const chatKey = makeChatKey("group", groupId);

    await this.#services.store.jobs.enqueue(
      "group_digest",
      `digest-manual:${groupId}:${now}`,
      chatKey,
      {
        chatKey,
        groupId,
        startTimeMs: now - Math.max(1, lookbackHours) * 3600 * 1000,
        endTimeMs: now,
        prompt: settings.groupDigest.prompt,
        uploadTool: settings.groupDigest.uploadTool,
      },
      now,
    );
    this.#wake();
  }

  async #checkDigests(now: number): Promise<void> {
    const { store } = this.#services;
    const settings = this.#services.getSettings();
    const intervalMs = settings.groupDigest.intervalMinutes * 60 * 1000;

    for (const groupId of settings.groupDigest.groups) {
      const cursorKey = `digest_cursor:${groupId}`;
      const saved = await store.cursors.get(cursorKey);
      const startMs = saved ? Number(saved) : now - intervalMs;

      if (!saved) {
        await store.cursors.set(cursorKey, String(startMs));
      }

      if (now - startMs < intervalMs) {
        continue;
      }

      const chatKey = makeChatKey("group", groupId);

      await store.jobs.enqueue(
        "group_digest",
        `digest:${groupId}:${startMs}-${now}`,
        chatKey,
        {
          chatKey,
          groupId,
          startTimeMs: startMs,
          endTimeMs: now,
          prompt: settings.groupDigest.prompt,
          uploadTool: settings.groupDigest.uploadTool,
        },
        now,
      );
      await store.cursors.set(cursorKey, String(now));
      this.#wake();
    }
  }

  async #enqueueScheduleTask(
    task: ScheduleRecord,
    now: number,
    dedupePrefix: string,
    actionLabel: string,
  ): Promise<void> {
    const hasTarget = Boolean(task.kind && task.chatId);
    const kind = hasTarget ? (task.kind as "group" | "private") : "private";
    const chatId = hasTarget ? task.chatId : "0";
    const chatKey: ChatKey = makeChatKey(kind, chatId);

    await this.#services.store.jobs.enqueue(
      "invoke",
      `${dedupePrefix}:${task.id}:${now}`,
      chatKey,
      {
        source: "schedule",
        chatKey,
        kind,
        chatId,
        triggerMessageIds: [],
        content: hasTarget
          ? `定时任务${actionLabel}「${task.title}」：${task.content}`
          : `无目标聊天的定时任务${actionLabel}「${task.title}」：${task.content}（请通过工具完成并将 units 返回为空数组 []）`,
      },
      now,
    );
    this.#wake();
  }
}
