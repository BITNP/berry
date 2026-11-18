import { ModelIds } from "../agent/model-ids.ts";
import { runSubagent } from "../agent/subagents.ts";
import type { RuntimeSettings } from "../config/settings.ts";
import type { MessageGatewayClient } from "../gateway/client.ts";
import type { GuildInternalClient } from "../guild/client.ts";
import type { IdentityDirectory } from "../identity/keycloak.ts";
import type { KnowledgeBase } from "../knowledge/files.ts";
import type { McpHub } from "../mcp/hub.ts";
import type { MediaProcessor } from "../media/processor.ts";
import type { Store } from "../store/index.ts";
import type { ChatKey, JobRecord } from "../types.ts";
import { makeChatKey } from "../types.ts";
import { Logger } from "../utils/logger.ts";
import { errorMessage, formatDateTime, formatDay } from "../utils/time.ts";

export class ScheduleRunner {
  #store: Store;
  #gateway: MessageGatewayClient;
  #media: MediaProcessor;
  #knowledge: KnowledgeBase;
  #directory: IdentityDirectory;
  #guild: GuildInternalClient;
  #mcp: McpHub;
  #getSettings: () => RuntimeSettings;
  #wake: () => void;
  #logger = new Logger("scheduler");
  #timer: ReturnType<typeof setInterval> | null = null;
  #ticking = false;
  #lastDigestCheck = 0;

  constructor(options: {
    store: Store;
    gateway: MessageGatewayClient;
    media: MediaProcessor;
    knowledge: KnowledgeBase;
    directory: IdentityDirectory;
    guild: GuildInternalClient;
    mcp: McpHub;
    getSettings: () => RuntimeSettings;
    wake: () => void;
  }) {
    this.#store = options.store;
    this.#gateway = options.gateway;
    this.#media = options.media;
    this.#knowledge = options.knowledge;
    this.#directory = options.directory;
    this.#guild = options.guild;
    this.#mcp = options.mcp;
    this.#getSettings = options.getSettings;
    this.#wake = options.wake;
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
      const settings = this.#getSettings();
      const due = await this.#store.schedules.due(now);

      for (const task of due) {
        await this.#store.schedules.markFired(task, now, settings.bot.timezone);

        const hasTarget = Boolean(task.kind && task.chatId);
        const chatKey: ChatKey = hasTarget
          ? makeChatKey(task.kind as "group" | "private", task.chatId)
          : "private:0";

        await this.#store.jobs.enqueue(
          "invoke",
          `schedule:${task.id}:${now}`,
          chatKey,
          {
            source: "schedule",
            chatKey,
            kind: hasTarget ? (task.kind as "group" | "private") : "private",
            chatId: hasTarget ? task.chatId : "0",
            triggerMessageIds: [],
            content: hasTarget
              ? `定时任务触发「${task.title}」：${task.content}`
              : `无目标聊天的后台定时任务触发「${task.title}」：${task.content}（请通过工具完成并将 units 返回为空数组 []）`,
            metadata: { scheduleId: task.id },
          },
          now,
        );
        this.#wake();
      }

      if (
        settings.groupDigest.enabled &&
        now - this.#lastDigestCheck >= 30_000
      ) {
        this.#lastDigestCheck = now;
        await this.#checkDigests(settings, now);
      }
    } catch (error) {
      this.#logger.warn("Scheduler tick failed", {
        error: errorMessage(error),
      });
    } finally {
      this.#ticking = false;
    }
  }

  async #checkDigests(settings: RuntimeSettings, now: number): Promise<void> {
    const intervalMs = settings.groupDigest.intervalMinutes * 60 * 1000;

    for (const groupId of settings.groupDigest.groups) {
      const cursorKey = `digest_cursor:${groupId}`;
      const saved = await this.#store.cursors.get(cursorKey);
      const startMs = saved ? Number(saved) : now - intervalMs;

      if (!saved) {
        await this.#store.cursors.set(cursorKey, String(startMs));
      }

      if (now - startMs < intervalMs) {
        continue;
      }

      const chatKey = makeChatKey("group", groupId);

      await this.#store.jobs.enqueue(
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
      await this.#store.cursors.set(cursorKey, String(now));
      this.#wake();
    }
  }

  public async runGroupDigest(job: JobRecord<"group_digest">): Promise<void> {
    const settings = this.#getSettings();
    const { chatKey, groupId, startTimeMs, endTimeMs, prompt, uploadTool } =
      job.payload;

    const messages = await this.#store.messages.search(chatKey, {
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

    const chat = await this.#store.chats.get(chatKey);
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

    const subagentResult = await runSubagent({
      kind: "chat_analyst",
      task,
      chatKey,
      senderQQ: null,
      actorSubject: null,
      actorName: null,
      actorIsAdmin: true,
      settings,
      store: this.#store,
      gateway: this.#gateway,
      media: this.#media,
      knowledge: this.#knowledge,
      directory: this.#directory,
      guild: this.#guild,
      mcp: this.#mcp,
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

    await this.#knowledge.writeNotebook(path, `# ${title}\n\n${markdown}\n`);

    if (uploadTool) {
      await this.#mcp.call(uploadTool, {
        title,
        markdown,
        metadata: { groupId, startTimeMs, endTimeMs },
      });
    }
  }

  public async triggerScheduleNow(scheduleId: string): Promise<boolean> {
    const task = await this.#store.schedules.get(scheduleId);

    if (!task) {
      return false;
    }

    const now = Date.now();
    const hasTarget = Boolean(task.kind && task.chatId);
    const chatKey: ChatKey = hasTarget
      ? makeChatKey(task.kind as "group" | "private", task.chatId)
      : "private:0";

    await this.#store.jobs.enqueue(
      "invoke",
      `schedule-manual:${task.id}:${now}`,
      chatKey,
      {
        source: "schedule",
        chatKey,
        kind: hasTarget ? (task.kind as "group" | "private") : "private",
        chatId: hasTarget ? task.chatId : "0",
        triggerMessageIds: [],
        content: hasTarget
          ? `定时任务立即执行「${task.title}」：${task.content}`
          : `无目标聊天的定时任务立即执行「${task.title}」：${task.content}（请通过工具完成并将 units 返回为空数组 []）`,
        metadata: { scheduleId: task.id },
      },
      now,
    );
    this.#wake();

    return true;
  }

  public async enqueueDigestNow(
    groupId: string,
    lookbackHours = 24,
  ): Promise<void> {
    const now = Date.now();
    const settings = this.#getSettings();
    const chatKey = makeChatKey("group", groupId);

    await this.#store.jobs.enqueue(
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
}
