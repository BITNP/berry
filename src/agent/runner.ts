import { Type } from "typebox";

import type { RuntimeSettings } from "../config/settings.ts";
import { resolveThinkingEffort } from "../config/settings.ts";
import { resolveReactionEmojiId } from "../gateway/qface.ts";
import { renderMessageTextForModel } from "../gateway/segments.ts";
import type { AccessRole } from "../identity/permissions.ts";
import { resolveAccessRole } from "../identity/permissions.ts";
import type { ToolRegistry } from "../tools/index.ts";
import {
  createDefaultMainToolRegistry,
  memoryManageTool,
} from "../tools/index.ts";
import type { AgentServices, ToolContext } from "../tools/types.ts";
import type {
  ChatKey,
  MessageRecord,
  OutputUnit,
  TurnMessage,
  UnifiedInput,
} from "../types.ts";
import { Logger } from "../utils/logger.ts";
import { errorMessage, formatDateTime } from "../utils/time.ts";
import { runChatToolLoop } from "./loop.ts";
import { ModelIds } from "./model-ids.ts";
import { buildStaticSystemPrompt, resultsAsText } from "./prompt.ts";
import type { SubagentRegistry } from "./subagents/index.ts";
import { createDefaultSubagentRegistry } from "./subagents/index.ts";

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
      remove: Type.Optional(Type.Boolean()),
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
  #subagents: SubagentRegistry;
  #mainTools: ToolRegistry;
  #logger = new Logger("agent");
  #compacting = false;

  constructor(
    services: AgentServices,
    options: {
      subagents?: SubagentRegistry;
      mainTools?: ToolRegistry;
    } = {},
  ) {
    this.#services = services;
    this.#subagents = options.subagents ?? createDefaultSubagentRegistry();
    this.#mainTools =
      options.mainTools ?? createDefaultMainToolRegistry(this.#subagents);
  }

  public async invoke(input: UnifiedInput): Promise<{
    units: OutputUnit[];
    mutated: boolean;
  }> {
    const { store, gateway, media, directory } = this.#services;
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

    await gateway.warmChatHistory(input.kind, input.chatId, 100);

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
    const enrichedText = await media.enrichMessagesText(
      input.chatKey,
      [...requestMessages, ...quotedMessages, ...recentContext],
      ids,
    );

    const mapMessage = (msg: MessageRecord) => ({
      id: msg.id,
      quoteRef: ids.messageRef(msg.onebotMessageId, msg.chatKey),
      userRef: ids.userRef(msg.userId),
      senderName: msg.isBot ? "树莓娘(bot)" : msg.senderName,
      mentionedBot: msg.mentionedBot,
      text: enrichedText.get(msg.id) ?? msg.text,
      time: formatDateTime(msg.sentAt, settings.bot.timezone),
    });

    const role = resolveAccessRole({
      userId: speakerQQ,
      adminQQs: settings.policy.adminQQs,
      permissions: identityUser?.permissions,
      isSystemSource:
        input.source === "admin_inject" || input.source === "schedule",
    });

    const knownGroups = allChats
      .filter((c) => {
        if (c.kind !== "group") {
          return false;
        }

        return role === "admin" || c.chatKey === input.chatKey;
      })
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
            role,
            keycloak: identityUser
              ? {
                  bound: true,
                  admitted: identityUser.permissions.admitted,
                  subject: identityUser.subject,
                  name: identityUser.name,
                  departments: identityUser.permissions.accessDepartments,
                  positions: identityUser.permissions.positions.map(
                    (p) => p.label,
                  ),
                }
              : { bound: false, admitted: false },
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

    const toolContext: ToolContext = {
      services: this.#services,
      actor: {
        chatKey: input.chatKey,
        senderQQ: speakerQQ,
        actorSubject: identityUser?.subject ?? null,
        actorName: identityUser?.name ?? speakerName,
        role,
        triggerMessageId: requestMessages.at(-1)?.id ?? null,
      },
      ids,
    };

    const systemPrompt = buildStaticSystemPrompt({
      personaPrompt: settings.bot.personaPrompt,
      capabilities: this.#mainTools.describeCapabilities(this.#services),
    });

    const tools = this.#mainTools.resolve(toolContext);

    const result = await runChatToolLoop({
      purpose: "dialog",
      chatKey: input.chatKey,
      settings,
      store,
      systemPrompt,
      history: conversation.messages,
      userContent,
      tools,
      maxRounds: 40,
      outputSchema: agentOutputSchema,
      thinkingEffort: resolveThinkingEffort(settings, "dialog"),
    });

    // Resolve opaque quote, reaction, and optional targetRef handles back to real OneBot IDs.
    const { dispatches: plannedDispatches, errors: dispatchErrors } =
      this.#resolveDispatches(result.structured.units, {
        ids,
        input,
        requestMessages,
        speakerQQ,
        role,
      });

    for (const detail of dispatchErrors) {
      await store.conversations.pushOutputResult({
        module: "qq_reaction",
        status: "error",
        detail,
        createdAt: Date.now(),
      });
    }

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
        await this.#maybeCompact(settings, result.lastPromptTokens);
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
    const identityUser = await this.#services.directory
      .byQQ(message.userId)
      .catch(() => null);
    const role = resolveAccessRole({
      userId: message.userId,
      adminQQs: settings.policy.adminQQs,
      permissions: identityUser?.permissions,
    });
    const ids = new ModelIds();
    const userRef = ids.userRef(message.userId);
    const memoryTool = memoryManageTool.bind({
      services: this.#services,
      actor: {
        chatKey,
        senderQQ: message.userId,
        actorSubject: identityUser?.subject ?? null,
        actorName: identityUser?.name ?? message.senderName,
        role,
        triggerMessageId: message.id,
      },
      ids,
    });

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
          text: renderMessageTextForModel(message, {
            botQQ: settings.bot.botQQ,
            botName: settings.bot.names[0],
            ids,
          }),
        },
        recentContext: context.map((m) => ({
          senderName: m.senderName,
          text: renderMessageTextForModel(m, {
            botQQ: settings.bot.botQQ,
            botName: settings.bot.names[0],
            ids,
          }).slice(0, 400),
        })),
        memoryIndex,
      }),
      tools: [memoryTool],
      maxRounds: 12,
      thinkingEffort: resolveThinkingEffort(settings, "memory_update"),
    });
  }

  async #maybeCompact(
    settings: RuntimeSettings,
    lastPromptTokens: number,
  ): Promise<void> {
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
    const overTokenBudget = lastPromptTokens >= budget * 0.75;
    const overMessageLimit =
      conversation.messages.length >= COMPACTION_MAX_MESSAGES;

    if (!overTokenBudget && !overMessageLimit) {
      return;
    }

    // Split along clean user-turn boundaries without heuristic token estimation.
    const userIndices: number[] = [];

    for (let i = 0; i < conversation.messages.length; i++) {
      if (conversation.messages[i]!.role === "user") {
        userIndices.push(i);
      }
    }

    if (userIndices.length <= 1) {
      return;
    }

    const keepTurns = overTokenBudget
      ? Math.max(
          1,
          Math.min(
            COMPACTION_KEEP_RECENT_TURNS,
            Math.floor((userIndices.length * 0.3 * budget) / lastPromptTokens),
          ),
        )
      : Math.min(COMPACTION_KEEP_RECENT_TURNS, userIndices.length - 1);
    const turnCursor = Math.max(1, userIndices.length - keepTurns);
    const splitIndex = userIndices[turnCursor]!;

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
        maxRounds: 3,
        outputSchema: compactionOutputSchema,
        thinkingEffort: resolveThinkingEffort(settings, "compaction"),
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
          lastPromptTokens,
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
      role: AccessRole;
    },
  ): {
    dispatches: { targetChatKey: ChatKey; unit: OutputUnit }[];
    errors: string[];
  } {
    const logger = this.#logger;
    const { ids, input, requestMessages, speakerQQ, role } = ctx;

    function isTargetAuthorized(targetChatKey: ChatKey): boolean {
      return targetChatKey === input.chatKey || role === "admin";
    }

    function resolveUnitTarget(targetRef?: string): ChatKey | null {
      if (!targetRef?.trim()) {
        return input.chatKey;
      }

      try {
        const targetChatKey = ids.resolveTargetChatKey(targetRef);

        if (!isTargetAuthorized(targetChatKey)) {
          logger.warn("Blocked unauthorized cross-chat dispatch", {
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
    const errors: string[] = [];

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
          if (resolvedMsg.chatKey.startsWith("private:")) {
            const msg = "QQ 表情回应仅支持群聊消息，已忽略私聊贴表情";

            logger.warn("Dropped qq_reaction for private chat", {
              fromChatKey: input.chatKey,
              targetChatKey: resolvedMsg.chatKey,
            });
            errors.push(msg);

            continue;
          }

          try {
            const resolvedEmojiId = resolveReactionEmojiId(unit.emojiId);

            dispatches.push({
              targetChatKey: resolvedMsg.chatKey,
              unit: {
                kind: "qq_reaction",
                messageId: resolvedMsg.rawId,
                emojiId: resolvedEmojiId,
                ...(unit.remove ? { remove: true } : {}),
              },
            });
          } catch (error) {
            const msg = errorMessage(error);

            logger.warn("Dropped qq_reaction with unrecognized emojiId", {
              fromChatKey: input.chatKey,
              emojiId: unit.emojiId,
              error: msg,
            });
            errors.push(msg);
          }
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

    return { dispatches, errors };
  }
}
