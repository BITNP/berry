import { jsonrepair } from "jsonrepair";
import { Type } from "typebox";
import * as Value from "typebox/value";

import type { RuntimeSettings } from "../config/settings.ts";
import type { MessageGatewayClient } from "../gateway/client.ts";
import type { GuildInternalClient } from "../guild/client.ts";
import type { IdentityDirectory } from "../identity/keycloak.ts";
import type { KnowledgeBase } from "../knowledge/files.ts";
import type { McpHub } from "../mcp/hub.ts";
import type { MediaProcessor } from "../media/processor.ts";
import type { Store } from "../store/index.ts";
import { buildMainTools } from "../tools/index.ts";
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

const COMPACTION_MAX_MESSAGES = 100;
const COMPACTION_KEEP_RECENT_TURNS = 12;

export class BerryAgent {
  #store: Store;
  #gateway: MessageGatewayClient;
  #media: MediaProcessor;
  #knowledge: KnowledgeBase;
  #directory: IdentityDirectory;
  #guild: GuildInternalClient;
  #mcp: McpHub;
  #getSettings: () => RuntimeSettings;
  #logger = new Logger("agent");
  #compacting = false;

  constructor(options: {
    store: Store;
    gateway: MessageGatewayClient;
    media: MediaProcessor;
    knowledge: KnowledgeBase;
    directory: IdentityDirectory;
    guild: GuildInternalClient;
    mcp: McpHub;
    getSettings: () => RuntimeSettings;
  }) {
    this.#store = options.store;
    this.#gateway = options.gateway;
    this.#media = options.media;
    this.#knowledge = options.knowledge;
    this.#directory = options.directory;
    this.#guild = options.guild;
    this.#mcp = options.mcp;
    this.#getSettings = options.getSettings;
  }

  public async invoke(input: UnifiedInput): Promise<{
    units: OutputUnit[];
    mutated: boolean;
  }> {
    const settings = this.#getSettings();
    const allChats = await this.#store.chats.list();
    const chat = allChats.find((c) => c.chatKey === input.chatKey) ?? null;
    const conversation = await this.#store.conversations.open();
    const drainedResults =
      await this.#store.conversations.drainPendingResults();
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
      await this.#store.messages.getByIds(input.triggerMessageIds)
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

      const quoted = await this.#store.messages.findByOnebotId(
        input.chatKey,
        reqMsg.replyToMessageId,
      );

      if (quoted?.recalledAt === null) {
        quotedMessages.push(quoted);
      }
    }

    const firstId = requestMessages[0]?.id;
    const recentContext =
      firstId === undefined
        ? await this.#store.messages.recent(input.chatKey, 12, {
            afterId: conversation.afterMessageId,
          })
        : await this.#store.messages.recent(input.chatKey, 20, {
            beforeId: firstId,
            afterId: conversation.afterMessageId,
          });

    const speakerQQ = input.senderId ?? requestMessages.at(-1)?.userId ?? null;
    const speakerName =
      input.senderName ?? requestMessages.at(-1)?.senderName ?? null;
    const identityUser = speakerQQ
      ? await this.#directory.byQQ(speakerQQ).catch(() => null)
      : null;

    const memoryIndex = await this.#store.memories.index(
      input.chatKey,
      speakerQQ ?? undefined,
    );

    await this.#media.waitForMessages([
      ...requestMessages.map((m) => m.id),
      ...quotedMessages.map((m) => m.id),
    ]);
    const enrichedText = await this.#media.enrichMessagesText(input.chatKey, [
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
      mcpTools: this.#mcp.tools,
      guildEnabled: this.#guild.enabled,
    });

    const tools = buildMainTools({
      chatKey: input.chatKey,
      senderQQ: speakerQQ,
      actorSubject: identityUser?.subject ?? null,
      actorName: identityUser?.name ?? speakerName,
      actorIsAdmin,
      triggerMessageId: requestMessages.at(-1)?.id ?? null,
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

    const result = await runChatToolLoop<{ units: OutputUnit[] }>({
      purpose: "dialog",
      chatKey: input.chatKey,
      settings,
      store: this.#store,
      systemPrompt,
      history: conversation.messages,
      userContent,
      tools,
      maxRounds: 12,
      validateFinal: (text) => {
        try {
          let parsed: unknown;

          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = JSON.parse(jsonrepair(text));
          }

          if (!Value.Check(agentOutputSchema, parsed)) {
            const errs = [...Value.Errors(agentOutputSchema, parsed)]
              .map((err) => `${err.instancePath || "/"} ${err.message}`)
              .join("; ");

            return { ok: false, issue: errs };
          }

          return { ok: true, value: parsed };
        } catch (error) {
          return {
            ok: false,
            issue: `JSON 解析失败: ${errorMessage(error)}`,
          };
        }
      },
    });

    // Resolve opaque quote, reaction, and optional targetRef handles back to real OneBot IDs.
    const isTargetAuthorized = (targetChatKey: ChatKey): boolean => {
      if (
        targetChatKey === input.chatKey ||
        !targetChatKey.startsWith("private:") ||
        input.source === "schedule" ||
        actorIsAdmin
      ) {
        return true;
      }

      return parseChatKey(targetChatKey).chatId === speakerQQ;
    };

    const logger = this.#logger;

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

        if (!isTargetAuthorized(targetChatKey)) {
          return null;
        }

        return { rawId: meta.rawId, chatKey: targetChatKey };
      } catch {
        if (requestMessages.some((m) => m.onebotMessageId === ref)) {
          return { rawId: ref, chatKey: input.chatKey };
        }

        return null;
      }
    }

    const resolvedUnits: OutputUnit[] = [];
    const plannedDispatches: { targetChatKey: ChatKey; unit: OutputUnit }[] =
      [];

    for (const unit of result.structured.units) {
      if (unit.kind === "qq_forward") {
        const targetChatKey = resolveUnitTarget(unit.targetRef);

        if (!targetChatKey) {
          continue;
        }

        const cleanUnit: OutputUnit = {
          kind: "qq_forward",
          title: unit.title,
          items: unit.items,
        };

        plannedDispatches.push({ targetChatKey, unit: cleanUnit });
        resolvedUnits.push(cleanUnit);

        continue;
      }

      if (unit.kind === "qq_reaction") {
        const resolvedMsg = resolveMsgHandle(unit.messageId);

        if (!resolvedMsg) {
          continue;
        }

        const cleanUnit: OutputUnit = {
          kind: "qq_reaction",
          messageId: resolvedMsg.rawId,
          emojiId: unit.emojiId,
        };

        plannedDispatches.push({
          targetChatKey: resolvedMsg.chatKey,
          unit: cleanUnit,
        });
        resolvedUnits.push(cleanUnit);

        continue;
      }

      const targetChatKey = resolveUnitTarget(unit.targetRef);

      if (!targetChatKey) {
        continue;
      }

      let rawQuote: string | undefined;

      if (unit.quoteMessageId) {
        const resolvedQuote = resolveMsgHandle(unit.quoteMessageId);

        if (resolvedQuote?.chatKey === targetChatKey) {
          rawQuote = resolvedQuote.rawId;
        }
      }

      const cleanUnit: OutputUnit = {
        kind: "qq_reply",
        text: unit.text,
        ...(rawQuote ? { quoteMessageId: rawQuote } : {}),
      };

      plannedDispatches.push({ targetChatKey, unit: cleanUnit });
      resolvedUnits.push(cleanUnit);
    }

    for (const dispatch of plannedDispatches) {
      await this.#gateway.dispatchUnit(
        dispatch.targetChatKey,
        dispatch.unit,
        settings.bot.botQQ,
      );
    }

    // Persist clean turn ONLY when we spoke or changed state (anti-pollution).
    if (resolvedUnits.length > 0 || result.mutated) {
      const persistedUser: TurnMessage = {
        role: "user",
        content: cleanUserContent,
        timestamp: Date.now(),
      };
      const updated = await this.#store.conversations.appendTurn(
        conversation.sessionId,
        [persistedUser, ...result.turnMessages],
      );

      if (updated) {
        await this.#maybeCompact(settings);
      }
    }

    this.#logger.info("Invocation finished", {
      chatKey: input.chatKey,
      units: resolvedUnits.length,
      mutated: result.mutated,
    });

    return { units: resolvedUnits, mutated: result.mutated };
  }

  public async updateMemoryFromMessage(
    chatKey: ChatKey,
    messageId: number,
  ): Promise<void> {
    const settings = this.#getSettings();
    const message = await this.#store.messages.get(messageId);

    if (message?.recalledAt !== null) {
      return;
    }

    const conversation = await this.#store.conversations.open();

    if (message.id <= conversation.afterMessageId) {
      return;
    }

    const context = await this.#store.messages.recent(chatKey, 12, {
      beforeId: message.id,
      afterId: conversation.afterMessageId,
    });
    const memoryIndex = await this.#store.memories.index(
      chatKey,
      message.userId,
    );
    const ids = new ModelIds();
    const userRef = ids.userRef(message.userId);
    const actorIsAdmin = settings.policy.adminQQs.includes(message.userId);

    const tools = buildMainTools({
      chatKey,
      senderQQ: message.userId,
      actorSubject: null,
      actorName: message.senderName,
      actorIsAdmin,
      triggerMessageId: message.id,
      settings,
      store: this.#store,
      gateway: this.#gateway,
      media: this.#media,
      knowledge: this.#knowledge,
      directory: this.#directory,
      guild: this.#guild,
      mcp: this.#mcp,
      ids,
    }).filter((tool) => tool.name === "memory_manage");

    await runChatToolLoop({
      purpose: "memory_update",
      chatKey,
      settings,
      store: this.#store,
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
      tools,
      maxRounds: 4,
      validateFinal: () => ({ ok: true, value: true }),
    });
  }

  async #maybeCompact(settings: RuntimeSettings): Promise<void> {
    if (this.#compacting) {
      return;
    }

    const conversation = await this.#store.conversations.get();

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

    const keepFromTurn = Math.max(
      1,
      userIndices.length - COMPACTION_KEEP_RECENT_TURNS,
    );
    let splitIndex = userIndices[keepFromTurn] ?? userIndices.at(-1)!;

    while (splitIndex > userIndices[1]!) {
      const keptTokens = conversation.messages
        .slice(splitIndex)
        .reduce((sum, m) => sum + estimateTokens(JSON.stringify(m)), 0);

      if (keptTokens <= budget * 0.3) {
        break;
      }

      const nextIdx = userIndices.find((idx) => idx > splitIndex);

      if (!nextIdx) {
        break;
      }

      splitIndex = nextIdx;
    }

    if (splitIndex <= 0) {
      return;
    }

    this.#compacting = true;

    try {
      const res = await runChatToolLoop<{ summary: string }>({
        purpose: "compaction",
        chatKey: null,
        settings,
        store: this.#store,
        systemPrompt:
          '你是会话历史压缩器。将已有摘要和即将归档的历史对话合并为一份紧凑中文摘要，保留已确认结论、任务 ID、成员偏好和未决事项；丢弃冗余过程细节。只输出 JSON：{"summary":"..."}',
        history: [],
        userContent: JSON.stringify({
          previousSummary: conversation.summary,
          archivedMessages: conversation.messages.slice(0, splitIndex),
        }),
        tools: [],
        maxRounds: 2,
        validateFinal: (text) => {
          try {
            let parsed: unknown;

            try {
              parsed = JSON.parse(text);
            } catch {
              parsed = JSON.parse(jsonrepair(text));
            }

            if (
              !parsed ||
              typeof parsed !== "object" ||
              typeof (parsed as { summary?: unknown }).summary !== "string" ||
              !(parsed as { summary: string }).summary.trim()
            ) {
              return { ok: false, issue: "必须返回非空字符串 summary" };
            }

            return {
              ok: true,
              value: {
                summary: (parsed as { summary: string }).summary.trim(),
              },
            };
          } catch (error) {
            return { ok: false, issue: errorMessage(error) };
          }
        },
      });

      const saved = await this.#store.conversations.compact(
        conversation.sessionId,
        conversation.summary,
        splitIndex,
        res.structured.summary,
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
}
