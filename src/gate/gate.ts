import type { RuntimeSettings } from "../config/settings.ts";
import type { MessageGatewayClient } from "../gateway/client.ts";
import type { IdentityDirectory } from "../identity/keycloak.ts";
import type { AccessRole } from "../identity/permissions.ts";
import { resolveAccessRole } from "../identity/permissions.ts";
import type { MediaProcessor } from "../media/processor.ts";
import type { Store } from "../store/index.ts";
import type { JobRecord, MessageRecord } from "../types.ts";
import { Logger } from "../utils/logger.ts";
import type { SmallModelClassifier } from "./classifier.ts";

export class MessageGate {
  #store: Store;
  #classifier: SmallModelClassifier;
  #gateway: MessageGatewayClient;
  #media: MediaProcessor;
  #directory: IdentityDirectory;
  #getSettings: () => RuntimeSettings;
  #wake: () => void;
  #logger = new Logger("gate");

  constructor(
    store: Store,
    classifier: SmallModelClassifier,
    gateway: MessageGatewayClient,
    media: MediaProcessor,
    directory: IdentityDirectory,
    getSettings: () => RuntimeSettings,
    wake: () => void,
  ) {
    this.#store = store;
    this.#classifier = classifier;
    this.#gateway = gateway;
    this.#media = media;
    this.#directory = directory;
    this.#getSettings = getSettings;
    this.#wake = wake;
  }

  async #resolveSenderRole(
    userId: string,
    settings: RuntimeSettings,
  ): Promise<AccessRole> {
    if (settings.policy.adminQQs.includes(userId)) {
      return "admin";
    }

    if (!this.#directory.enabled) {
      return "guest";
    }

    const identity = await this.#directory.byQQ(userId).catch(() => null);

    return resolveAccessRole({
      userId,
      adminQQs: settings.policy.adminQQs,
      permissions: identity?.permissions,
    });
  }

  public async ingest(message: MessageRecord): Promise<void> {
    if (message.isBot) {
      return;
    }

    const settings = this.#getSettings();
    const chat = await this.#store.chats.ensure(message.kind, message.chatId, {
      enabled:
        message.kind === "group"
          ? settings.policy.groupDefaultMode !== "off"
          : settings.policy.privateDefaultEnabled,
      triggerMode:
        message.kind === "group"
          ? settings.policy.groupDefaultMode
          : "smart_observe",
    });

    const isDirectInvocation =
      message.kind === "private" || message.mentionedBot || message.quotedBot;

    if (
      !chat.enabled ||
      (message.kind === "group" && chat.triggerMode === "off")
    ) {
      if (isDirectInvocation) {
        await this.#store.gate.record({
          chatKey: message.chatKey,
          messageId: message.id,
          action: "ignore",
          stage: "l0_rule",
          confidence: 1,
          reason: "该会话或群触发模式当前已关闭",
          model: "l0-rule",
          durationMs: 0,
        });
      }

      return;
    }

    let cachedRole: AccessRole | null = null;
    const getSenderRole = async (): Promise<AccessRole> => {
      cachedRole ??= await this.#resolveSenderRole(message.userId, settings);

      return cachedRole;
    };

    if (
      message.kind === "private" &&
      settings.policy.privateAccessMode !== "all"
    ) {
      const role = await getSenderRole();
      const allowed =
        settings.policy.privateAccessMode === "admins_only"
          ? role === "admin"
          : role !== "guest";

      if (!allowed) {
        await this.#store.gate.record({
          chatKey: message.chatKey,
          messageId: message.id,
          action: "ignore",
          stage: "l0_rule",
          confidence: 1,
          reason:
            settings.policy.privateAccessMode === "admins_only"
              ? "私聊门禁已设为仅管理员或网协管理层开放，已忽略私聊"
              : "私聊门禁已设为仅管理员及网协在籍成员开放，已忽略外部人员私聊",
          model: "l0-rule",
          durationMs: 0,
        });

        return;
      }
    }

    if (
      message.kind === "group" &&
      chat.triggerMode === "mention_only" &&
      !message.mentionedBot &&
      !message.quotedBot
    ) {
      return;
    }

    if (isDirectInvocation && message.text.trim() === "#NEW#") {
      const role = await getSenderRole();

      if (role !== "admin") {
        await this.#store.gate.record({
          chatKey: message.chatKey,
          messageId: message.id,
          action: "ignore",
          stage: "l0_rule",
          confidence: 1,
          reason: "非管理员尝试执行 #NEW#，已拒绝重置全局上下文",
          model: "l0-rule",
          durationMs: 0,
        });
        await this.#gateway.dispatchUnit(
          message.chatKey,
          {
            kind: "qq_reply",
            text: "树莓娘当前使用全局统一上下文，仅管理员或网协管理层可执行 #NEW# 重置。",
            quoteMessageId: message.onebotMessageId,
          },
          settings.bot.botQQ,
        );

        return;
      }

      const maxId = await this.#store.messages.maxId();

      await this.#store.conversations.reset(Math.max(message.id, maxId));
      await this.#store.gate.record({
        chatKey: message.chatKey,
        messageId: message.id,
        action: "ignore",
        stage: "l0_rule",
        confidence: 1,
        reason: "管理员执行 #NEW# 全局上下文重置指令",
        model: "l0-rule",
        durationMs: 0,
      });
      await this.#gateway.dispatchUnit(
        message.chatKey,
        {
          kind: "qq_reply",
          text: "全局上下文已重置，新的对话开始啦。",
          quoteMessageId: message.onebotMessageId,
        },
        settings.bot.botQQ,
      );

      return;
    }

    const isPokeNotice = message.onebotMessageId.startsWith("poke:");

    if (
      settings.policy.adminBypassGate &&
      isDirectInvocation &&
      !isPokeNotice
    ) {
      const role = await getSenderRole();

      if (role === "admin") {
        await this.#store.gate.record({
          chatKey: message.chatKey,
          messageId: message.id,
          action: "reply",
          stage: "l0_rule",
          confidence: 1,
          reason: "管理员/管理层直连指令，跳过小模型分类",
          model: "l0-rule",
          durationMs: 0,
        });
        await this.#enqueueInvoke([message], { [message.userId]: role });
        this.#wake();

        return;
      }
    }

    await this.#store.jobs.coalesceGateBatch(
      message.chatKey,
      message.id,
      isDirectInvocation
        ? message.receivedAt
        : message.receivedAt + settings.gateModel.batchWindowMs,
    );
    this.#wake();
  }

  public async processBatch(job: JobRecord<"gate_batch">): Promise<void> {
    const settings = this.#getSettings();
    const chat = await this.#store.chats.get(job.payload.chatKey);

    if (!chat?.enabled) {
      return;
    }

    const candidates = (
      await this.#store.messages.getByIds(job.payload.messageIds)
    ).filter((item) => item.recalledAt === null && !item.isBot);

    if (candidates.length === 0) {
      return;
    }

    const conversation = await this.#store.conversations.open();
    const activeCandidates = candidates.filter(
      (item) => item.id > conversation.afterMessageId,
    );

    if (activeCandidates.length === 0) {
      return;
    }

    const activeCandidateIds = new Set(activeCandidates.map((m) => m.id));

    if (settings.gateModel.contextMessages > 0) {
      await this.#gateway.warmChatHistory(
        chat.kind,
        chat.chatId,
        Math.max(50, settings.gateModel.contextMessages * 4),
      );
    }

    const recentContext =
      settings.gateModel.contextMessages > 0
        ? (
            await this.#store.messages.recent(
              chat.chatKey,
              settings.gateModel.contextMessages + activeCandidateIds.size,
              {
                afterId: conversation.afterMessageId,
              },
            )
          )
            .filter((item) => !activeCandidateIds.has(item.id))
            .slice(-settings.gateModel.contextMessages)
        : [];

    const memIndex = await this.#store.memories.index(chat.chatKey);
    const userMems: Record<string, { key: string; summary: string }[]> = {};
    const senderRoles: Record<string, AccessRole> = {};

    for (const userId of new Set(activeCandidates.map((m) => m.userId))) {
      userMems[userId] = (
        await this.#store.memories.index(chat.chatKey, userId)
      ).user;
      senderRoles[userId] = await this.#resolveSenderRole(userId, settings);
    }

    const botActivity =
      chat.kind === "group"
        ? await (async () => {
            const windowMinutes = settings.gateModel.cooldownWindowMinutes;
            const softLimit = settings.gateModel.proactiveSoftLimit;
            const stats = await this.#store.gate.recentReplyStats(
              chat.chatKey,
              windowMinutes * 60_000,
            );

            return {
              windowMinutes,
              proactiveReplies: stats.proactiveReplies,
              totalReplies: stats.totalReplies,
              softLimit,
              cooldownActive:
                softLimit > 0 && stats.proactiveReplies >= softLimit,
              secondsSinceLastReply:
                stats.lastReplyAt === null
                  ? null
                  : Math.max(
                      0,
                      Math.round((Date.now() - stats.lastReplyAt) / 1000),
                    ),
            };
          })()
        : undefined;

    const { results, model, durationMs } = await this.#classifier.classifyBatch(
      settings,
      chat,
      await this.#enrichCandidates(chat.chatKey, activeCandidates),
      await this.#enrichContextLines(chat.chatKey, recentContext),
      { global: memIndex.global, chat: memIndex.chat, users: userMems },
      senderRoles,
      { jobId: job.id, botActivity },
    );

    const replyMessages: MessageRecord[] = [];
    const byId = new Map(activeCandidates.map((m) => [m.id, m]));

    for (const decision of results) {
      const msg = byId.get(decision.messageId)!;
      const effectiveAction =
        decision.action === "memory" && senderRoles[msg.userId] !== "admin"
          ? "ignore"
          : decision.action;

      await this.#store.gate.record({
        chatKey: chat.chatKey,
        messageId: decision.messageId,
        action: effectiveAction,
        stage: "l1_classifier",
        confidence: decision.confidence,
        reason:
          effectiveAction === decision.action
            ? decision.reason
            : `${decision.reason}（非管理员不触发静默记忆写入，已忽略）`,
        model,
        durationMs,
      });

      if (effectiveAction === "reply") {
        replyMessages.push(msg);
      } else if (effectiveAction === "memory") {
        await this.#store.jobs.enqueue(
          "memory_update",
          `memory:${chat.chatKey}:${msg.id}`,
          chat.chatKey,
          { chatKey: chat.chatKey, messageId: msg.id },
        );
      }
    }

    if (replyMessages.length > 0) {
      await this.#enqueueInvoke(replyMessages, senderRoles);
      this.#wake();
    }

    this.#logger.info("Gate batch processed", {
      chatKey: chat.chatKey,
      candidates: activeCandidates.length,
      replies: replyMessages.length,
      durationMs,
    });
  }

  async #enqueueInvoke(
    messages: MessageRecord[],
    senderRoles: Record<string, AccessRole>,
  ): Promise<void> {
    // Coalesce rapid replies by privilege tier (admin / member / guest) so alternating
    // multi-speaker chatter batches into one LLM turn without privilege or Tape leakage.
    const byRole = new Map<AccessRole, MessageRecord[]>();

    for (const msg of messages) {
      const role = senderRoles[msg.userId] ?? "guest";
      const bucket = byRole.get(role);

      if (bucket) {
        bucket.push(msg);
      } else {
        byRole.set(role, [msg]);
      }
    }

    for (const [accessRole, group] of byRole.entries()) {
      const first = group[0]!;
      const last = group.at(-1)!;
      const distinctSenders = new Set(group.map((m) => m.userId));
      const singleSender = distinctSenders.size === 1;

      await this.#store.jobs.coalesceInvoke({
        source: "qq_batch",
        chatKey: first.chatKey,
        kind: first.kind,
        chatId: first.chatId,
        triggerMessageIds: group.map((m) => m.id),
        accessRole,
        ...(singleSender
          ? { senderId: last.userId, senderName: last.senderName }
          : {}),
      });
    }
  }

  async #enrichCandidates(
    chatKey: MessageRecord["chatKey"],
    candidates: MessageRecord[],
  ): Promise<MessageRecord[]> {
    await this.#media.waitForMessages(candidates.map((m) => m.id));
    const textMap = await this.#media.enrichMessagesText(chatKey, candidates);

    return candidates.map((m) => ({
      ...m,
      text: textMap.get(m.id) ?? m.text,
    }));
  }

  async #enrichContextLines(
    chatKey: MessageRecord["chatKey"],
    recentContext: MessageRecord[],
  ) {
    const textMap = await this.#media.enrichMessagesText(
      chatKey,
      recentContext,
    );

    return recentContext.map((m) => ({
      id: m.id,
      userId: m.userId,
      senderName: m.senderName,
      text: textMap.get(m.id) ?? m.text,
      isBot: m.isBot,
      sentAt: m.sentAt,
    }));
  }
}
