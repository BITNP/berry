import { Type } from "typebox";

import type { RuntimeSettings } from "../config/settings.ts";
import { buildMainTools, createMemoryManageTool } from "../tools/index.ts";
import type {
  ChatKey,
  MessageRecord,
  OutputUnit,
  TurnMessage,
  UnifiedInput,
} from "../types.ts";
import { parseChatKey } from "../types.ts";
import { Logger } from "../utils/logger.ts";
import { errorMessage, estimateTokens, formatDateTime } from "../utils/time.ts";
import type { AgentServices } from "./loop.ts";
import { runChatToolLoop } from "./loop.ts";
import { ModelIds } from "./model-ids.ts";
import { buildStaticSystemPrompt, resultsAsText } from "./prompt.ts";

const outputUnitSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("qq_reply"),
      text: Type.String({ minLength: 1 }),
      quoteMessageId: Type.Optional(Type.String()),
      targetRef: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("qq_forward"),
      title: Type.String({ minLength: 1 }),
      items: Type.Array(
        Type.Object(
          { text: Type.String({ minLength: 1 }) },
          { additionalProperties: false },
        ),
        { minItems: 1 },
      ),
      targetRef: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("qq_reaction"),
      messageId: Type.String({ minLength: 1 }),
      emojiId: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
]);

const agentOutputSchema = Type.Object(
  {
    units: Type.Array(outputUnitSchema),
  },
  { additionalProperties: false },
);

const compactionOutputSchema = Type.Object(
  {
    summary: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

const COMPACTION_MAX_MESSAGES = 100;
const COMPACTION_KEEP_RECENT_TURNS = 12;

export class BerryAgent {
  #services: AgentServices;
  #logger = new Logger("agent");
  #compacting = false;

  constructor(services: AgentServices) {
    this.#services = services;
  }

  public async invoke(input: UnifiedInput): Promise<{
    units: OutputUnit[];
    mutated: boolean;
  }> {
    const { store, gateway, media, directory, guild, mcp } = this.#services;
    const settings = this.#services.getSettings();
    const allChats = await store.chats.list();
    const chat = allChats.find((c) => c.chatKey === input.chatKey) ?? null;
    const conversation = await store.conversations.open();
    const drainedResults = await store.conversations.drainPendingResults();
    const feedText = resultsAsText(drainedResults);

    const ids = new ModelIds();

    for (const entry of allChats) {
      if (entry.kind === "group") {
        ids.groupRef(entry.chatId);
      } else {
        ids.userRef(entry.chatId);
      }
    }

    const chatRef =
      input.kind === "group"
        ? ids.groupRef(input.chatId)
        : ids.userRef(input.chatId);

    const requestMessages = (
      await store.messages.getByIds(input.triggerMessageIds)
    ).filter(
      (m) => m.recalledAt === null && m.id > conversation.afterMessageId,
    );

    if (input.source === "qq_batch" && requestMessages.length === 0) {
      return { units: [], mutated: false };
    }

    const quotedMessages: MessageRecord[] = [];

    for (const reqMsg of requestMessages) {
      if (!reqMsg.replyToMessageId) {
        continue;
      }

      const quoted = await store.messages.findByOnebotId(
        input.chatKey,
        reqMsg.replyToMessageId,
      );

      if (quoted?.recalledAt === null) {
        quotedMessages.push(quoted);
      }
    }

    const firstId = requestMessages[0]?.id;

    if (input.kind === "group" || input.kind === "private") {
      await gateway.warmChatHistory(input.kind, input.chatId, 100);
    }

    const recentContext =
      firstId === undefined
        ? await store.messages.recent(input.chatKey, 12, {
            afterId: conversation.afterMessageId,
          })
        : await store.messages.recent(input.chatKey, 20, {
            beforeId: firstId,
            afterId: conversation.afterMessageId,
          });

    const speakerQQ = input.senderId ?? requestMessages.at(-1)?.userId ?? null;
    const speakerName =
      input.senderName ?? requestMessages.at(-1)?.senderName ?? null;
    const identityUser = speakerQQ
      ? await directory.byQQ(speakerQQ).catch(() => null)
      : null;

    const memoryIndex = await store.memories.index(
      input.chatKey,
      speakerQQ ?? undefined,
    );

    await media.waitForMessages([
      ...requestMessages.map((m) => m.id),
      ...quotedMessages.map((m) => m.id),
    ]);
    const enrichedText = await media.enrichMessagesText(input.chatKey, [
      ...requestMessages,
      ...quotedMessages,
      ...recentContext,
    ]);

    const mapMessage = (msg: MessageRecord) => ({
      id: msg.id,
      quoteRef: ids.messageRef(msg.onebotMessageId, msg.chatKey),
      userRef: ids.userRef(msg.userId),
      senderName: msg.isBot ? "树莓娘(bot)" : msg.senderName,
      mentionedBot: msg.mentionedBot,
      text: enrichedText.get(msg.id) ?? msg.text,
      time: formatDateTime(msg.sentAt, settings.bot.timezone),
    });

    const actorIsAdmin = Boolean(
      speakerQQ &&
      (settings.policy.adminQQs.includes(speakerQQ) ||
        identityUser?.permissions.systemAdmin),
    );

    const knownGroups = allChats
      .filter((c) => c.kind === "group")
      .map((c) => ({
        targetRef: ids.groupRef(c.chatId),
        title: c.title,
      }));

    const coreEnvelope = {
      now: formatDateTime(Date.now(), settings.bot.timezone),
      source: input.source,
      chat: {
        kind: input.kind,
        targetRef: chatRef,
        title: chat?.title ?? "",
      },
      speaker: speakerQQ
        ? {
            userRef: ids.userRef(speakerQQ),
            displayName: speakerName,
            keycloak: identityUser
              ? {
                  bound: true,
                  subject: identityUser.subject,
                  name: identityUser.name,
                  manager: identityUser.permissions.manager,
                  systemAdmin: identityUser.permissions.systemAdmin,
                  departments: identityUser.permissions.accessDepartments,
                  positions: identityUser.permissions.positions.map(
                    (p) => p.label,
                  ),
                }
              : { bound: false },
          }
        : null,
      requestMessages: requestMessages.map(mapMessage),
      ...(quotedMessages.length > 0
        ? { quotedMessages: quotedMessages.map(mapMessage) }
        : {}),
      ...(input.content ? { instruction: input.content } : {}),
    };

    // Transient water-chat context + memory index are sent in this invocation only.
    const fullTurnPayload = {
      ...coreEnvelope,
      ...(conversation.summary
        ? { conversationSummary: conversation.summary }
        : {}),
      recentContext: recentContext.map(mapMessage),
      ...(knownGroups.length > 0 ? { knownGroups } : {}),
      memoryIndex,
    };

    const userContent = feedText
      ? `${feedText}\n\n${JSON.stringify(fullTurnPayload)}`
      : JSON.stringify(fullTurnPayload);

    const cleanUserContent = feedText
      ? `${feedText}\n\n${JSON.stringify(coreEnvelope)}`
      : JSON.stringify(coreEnvelope);

    const systemPrompt = buildStaticSystemPrompt({
      personaPrompt: settings.bot.personaPrompt,
      mcpTools: mcp.tools,
      guildEnabled: guild.enabled,
    });

    const tools = buildMainTools(
      this.#services,
      {
        chatKey: input.chatKey,
        senderQQ: speakerQQ,
        actorSubject: identityUser?.subject ?? null,
        actorName: identityUser?.name ?? speakerName,
        actorIsAdmin,
        triggerMessageId: requestMessages.at(-1)?.id ?? null,
      },
      ids,
    );

    const result = await runChatToolLoop({
      purpose: "dialog",
      chatKey: input.chatKey,
      settings,
      store,
      systemPrompt,
      history: conversation.messages,
      userContent,
      tools,
      maxRounds: 12,
      outputSchema: agentOutputSchema,
    });

    // Resolve opaque quote, reaction, and optional targetRef handles back to real OneBot IDs.
    const plannedDispatches = this.#resolveDispatches(result.structured.units, {
      ids,
      input,
      requestMessages,
      speakerQQ,
      actorIsAdmin,
    });

    for (const dispatch of plannedDispatches) {
      await gateway.dispatchUnit(
        dispatch.targetChatKey,
        dispatch.unit,
        settings.bot.botQQ,
      );
    }

    const units = plannedDispatches.map((d) => d.unit);

    // Persist clean turn ONLY when we spoke or changed state (anti-pollution).
    if (units.length > 0 || result.mutated) {
      const persistedUser: TurnMessage = {
        role: "user",
        content: cleanUserContent,
      };
      const updated = await store.conversations.appendTurn(
        conversation.sessionId,
        [persistedUser, ...result.turnMessages],
      );

      if (updated) {
        await this.#maybeCompact(settings);
      }
    }

    this.#logger.info("Invocation finished", {
      chatKey: input.chatKey,
      units: units.length,
      mutated: result.mutated,
    });

    return { units, mutated: result.mutated };
  }

  public async updateMemoryFromMessage(
    chatKey: ChatKey,
    messageId: number,
  ): Promise<void> {
    const { store } = this.#services;
    const settings = this.#services.getSettings();
    const message = await store.messages.get(messageId);

    if (message?.recalledAt !== null) {
      return;
    }

    const conversation = await store.conversations.open();

    if (message.id <= conversation.afterMessageId) {
      return;
    }

    const context = await store.messages.recent(chatKey, 12, {
      beforeId: message.id,
      afterId: conversation.afterMessageId,
    });
    const memoryIndex = await store.memories.index(chatKey, message.userId);
    const ids = new ModelIds();
    const userRef = ids.userRef(message.userId);
    const memoryTool = createMemoryManageTool(
      this.#services,
      {
        chatKey,
        senderQQ: message.userId,
        actorSubject: null,
        actorName: message.senderName,
        actorIsAdmin: settings.policy.adminQQs.includes(message.userId),
        triggerMessageId: message.id,
      },
      ids,
    );

    await runChatToolLoop({
      purpose: "memory_update",
      chatKey,
      settings,
      store,
      systemPrompt:
        '你是树莓娘的静默记忆助手。结合上下文和已有记忆索引，如需要则调用 memory_manage 写入或更新长期事实（群排期、项目决策或成员稳定偏好），不向群聊发言。结束后输出 {"done":true}。',
      history: [],
      userContent: JSON.stringify({
        now: formatDateTime(Date.now(), settings.bot.timezone),
        sourceMessage: {
          userRef,
          senderName: message.senderName,
          text: message.text,
        },
        recentContext: context.map((m) => ({
          senderName: m.senderName,
          text: m.text.slice(0, 400),
        })),
        memoryIndex,
      }),
      tools: [memoryTool],
      maxRounds: 4,
    });
  }

  async #maybeCompact(settings: RuntimeSettings): Promise<void> {
    if (this.#compacting) {
      return;
    }

    const { store } = this.#services;
    const conversation = await store.conversations.get();

    if (!conversation || conversation.messages.length === 0) {
      return;
    }

    const budget =
      settings.mainModel.contextTokens -
      settings.mainModel.maxOutputTokens -
      4096;
    const totalTokens =
      estimateTokens(conversation.summary) +
      conversation.messages.reduce(
        (sum, msg) => sum + estimateTokens(JSON.stringify(msg)),
        0,
      );

    if (
      totalTokens < budget * 0.75 &&
      conversation.messages.length < COMPACTION_MAX_MESSAGES
    ) {
      return;
    }

    // Keep the most recent turns within 30% budget intact along clean user-turn boundaries.
    const userIndices: number[] = [];

    for (let i = 0; i < conversation.messages.length; i++) {
      if (conversation.messages[i]!.role === "user") {
        userIndices.push(i);
      }
    }

    if (userIndices.length <= 1) {
      return;
    }

    let turnCursor = Math.max(
      1,
      userIndices.length - COMPACTION_KEEP_RECENT_TURNS,
    );

    while (turnCursor < userIndices.length - 1) {
      const splitAt = userIndices[turnCursor]!;
      const keptTokens = conversation.messages
        .slice(splitAt)
        .reduce((sum, m) => sum + estimateTokens(JSON.stringify(m)), 0);

      if (keptTokens <= budget * 0.3) {
        break;
      }

      turnCursor++;
    }

    const splitIndex = userIndices[turnCursor]!;

    if (splitIndex <= 0) {
      return;
    }

    this.#compacting = true;

    try {
      const res = await runChatToolLoop({
        purpose: "compaction",
        chatKey: null,
        settings,
        store,
        systemPrompt:
          '你是会话历史压缩器。将已有摘要和即将归档的历史对话合并为一份紧凑中文摘要，保留已确认结论、任务 ID、成员偏好和未决事项；丢弃冗余过程细节。只输出 JSON：{"summary":"..."}',
        history: [],
        userContent: JSON.stringify({
          previousSummary: conversation.summary,
          archivedMessages: conversation.messages.slice(0, splitIndex),
        }),
        tools: [],
        maxRounds: 2,
        outputSchema: compactionOutputSchema,
      });

      const summary = res.structured.summary.trim();

      if (!summary) {
        throw new Error("必须返回非空字符串 summary");
      }

      const saved = await store.conversations.compact(
        conversation.sessionId,
        conversation.summary,
        splitIndex,
        summary,
      );

      if (saved) {
        this.#logger.info("Conversation compacted", {
          consumedMessages: splitIndex,
          estimatedTokens: totalTokens,
        });
      }
    } catch (error) {
      this.#logger.warn("Conversation compaction failed", {
        error: errorMessage(error),
      });
    } finally {
      this.#compacting = false;
    }
  }

  #resolveDispatches(
    rawUnits: OutputUnit[],
    ctx: {
      ids: ModelIds;
      input: UnifiedInput;
      requestMessages: MessageRecord[];
      speakerQQ: string | null;
      actorIsAdmin: boolean;
    },
  ): { targetChatKey: ChatKey; unit: OutputUnit }[] {
    const logger = this.#logger;
    const { ids, input, requestMessages, speakerQQ, actorIsAdmin } = ctx;

    function isTargetAuthorized(targetChatKey: ChatKey): boolean {
      if (
        targetChatKey === input.chatKey ||
        !targetChatKey.startsWith("private:") ||
        input.source === "schedule" ||
        actorIsAdmin
      ) {
        return true;
      }

      return parseChatKey(targetChatKey).chatId === speakerQQ;
    }

    function resolveUnitTarget(targetRef?: string): ChatKey | null {
      if (!targetRef?.trim()) {
        return input.chatKey;
      }

      try {
        const targetChatKey = ids.resolveTargetChatKey(targetRef);

        if (!isTargetAuthorized(targetChatKey)) {
          logger.warn("Blocked unauthorized cross-private dispatch", {
            fromChatKey: input.chatKey,
            targetChatKey,
            speakerQQ,
          });

          return null;
        }

        return targetChatKey;
      } catch {
        logger.warn("Dropped unit with unresolvable targetRef", {
          fromChatKey: input.chatKey,
          targetRef,
        });

        return null;
      }
    }

    function resolveMsgHandle(
      ref: string,
    ): { rawId: string; chatKey: ChatKey } | null {
      try {
        const meta = ids.resolveMessageMeta(ref);
        const targetChatKey = meta.chatKey ?? input.chatKey;

        return isTargetAuthorized(targetChatKey)
          ? { rawId: meta.rawId, chatKey: targetChatKey }
          : null;
      } catch {
        return requestMessages.some((m) => m.onebotMessageId === ref)
          ? { rawId: ref, chatKey: input.chatKey }
          : null;
      }
    }

    const dispatches: { targetChatKey: ChatKey; unit: OutputUnit }[] = [];

    for (const unit of rawUnits) {
      if (unit.kind === "qq_forward") {
        const targetChatKey = resolveUnitTarget(unit.targetRef);

        if (targetChatKey) {
          dispatches.push({
            targetChatKey,
            unit: {
              kind: "qq_forward",
              title: unit.title,
              items: unit.items,
            },
          });
        }

        continue;
      }

      if (unit.kind === "qq_reaction") {
        const resolvedMsg = resolveMsgHandle(unit.messageId);

        if (resolvedMsg) {
          dispatches.push({
            targetChatKey: resolvedMsg.chatKey,
            unit: {
              kind: "qq_reaction",
              messageId: resolvedMsg.rawId,
              emojiId: unit.emojiId,
            },
          });
        }

        continue;
      }

      const targetChatKey = resolveUnitTarget(unit.targetRef);

      if (!targetChatKey) {
        continue;
      }

      const resolvedQuote = unit.quoteMessageId
        ? resolveMsgHandle(unit.quoteMessageId)
        : null;
      const rawQuote =
        resolvedQuote?.chatKey === targetChatKey
          ? resolvedQuote.rawId
          : undefined;

      dispatches.push({
        targetChatKey,
        unit: {
          kind: "qq_reply",
          text: unit.text,
          ...(rawQuote ? { quoteMessageId: rawQuote } : {}),
        },
      });
    }

    return dispatches;
  }
}
