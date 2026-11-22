import { setTimeout as delay } from "node:timers/promises";

import type { Static } from "typebox";
import { Type } from "typebox";

import type { RuntimeSettings } from "../config/settings.ts";
import { resolveThinkingEffort } from "../config/settings.ts";
import { resolveReactionEmojiId } from "../gateway/qface.ts";
import { renderMessageTextForModel } from "../gateway/segments.ts";
import type { DirectoryUser } from "../identity/keycloak.ts";
import type { AccessRole } from "../identity/permissions.ts";
import { resolveAccessRole } from "../identity/permissions.ts";
import type { ToolRegistry } from "../tools/index.ts";
import {
  createDefaultMainToolRegistry,
  memoryManageTool,
} from "../tools/index.ts";
import type { AgentServices, ToolContext } from "../tools/types.ts";
import type {
  ChatConfig,
  ChatKey,
  JobPayloads,
  MemberImpressionRecord,
  MessageRecord,
  OutputUnit,
  TurnMessage,
  UnifiedInput,
} from "../types.ts";
import { Logger } from "../utils/logger.ts";
import { errorMessage, formatDateTime } from "../utils/time.ts";
import { DialogCacheGuard, makeCacheSessionKey } from "./cache-guard.ts";
import { completeChat, validateModelJson } from "./llm.ts";
import { runChatToolLoop } from "./loop.ts";
import { ModelIds } from "./model-ids.ts";
import { buildStaticSystemPrompt, resultsAsText } from "./prompt.ts";
import type { SubagentRegistry } from "./subagents/index.ts";
import {
  ASYNC_SUBAGENT_MAX_DURATION_MS,
  createDefaultSubagentRegistry,
} from "./subagents/index.ts";

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
  Type.Object(
    {
      kind: Type.Literal("qq_poke"),
      userRef: Type.Optional(Type.String({ minLength: 1 })),
      targetRef: Type.Optional(Type.String({ minLength: 1 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("qq_image"),
      stickerId: Type.Integer({ minimum: 1 }),
      quoteMessageId: Type.Optional(Type.String({ minLength: 1 })),
      targetRef: Type.Optional(Type.String({ minLength: 1 })),
    },
    { additionalProperties: false },
  ),
]);

type RawOutputUnit = Static<typeof outputUnitSchema>;

const agentOutputSchema = Type.Object(
  {
    units: Type.Array(outputUnitSchema),
  },
  { additionalProperties: false },
);

const compactionOutputSchema = Type.Object(
  {
    summary: Type.String({ minLength: 1 }),
    confirmedFacts: Type.Optional(Type.Array(Type.String())),
    openTasks: Type.Optional(Type.Array(Type.String())),
    pendingFollowups: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: false },
);

const COMPACTION_MAX_MESSAGES = 100;
const COMPACTION_KEEP_RECENT_TURNS = 12;
const MAX_REQUEST_MESSAGE_CHARS = 3000;
const MAX_CONTEXT_MESSAGE_CHARS = 600;

function truncateForModel(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }

  return `${text.slice(0, limit)}…[消息过长，原长 ${text.length} 字，已截断前 ${limit} 字]`;
}

export function computeReplyPaceDelayMs(
  text: string,
  minMs: number,
  maxMs: number,
  randomValue = Math.random(),
): number {
  const low = Math.max(0, Math.round(minMs));
  const high = Math.max(low, Math.round(maxMs));

  if (high === 0) {
    return 0;
  }

  const lengthFactor = Math.min(1, text.trim().length / 45);
  const base = low + (high - low) * lengthFactor;
  const jitter = (randomValue - 0.5) * 0.3 * (high - low);

  return Math.max(low, Math.min(high, Math.round(base + jitter)));
}

export class BerryAgent {
  #services: AgentServices;
  #subagents: SubagentRegistry;
  #mainTools: ToolRegistry;
  #logger = new Logger("agent");
  #cacheGuard = new DialogCacheGuard();
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

  public async invoke(
    input: UnifiedInput,
    options?: { jobId?: number | null },
  ): Promise<{
    units: OutputUnit[];
    mutated: boolean;
  }> {
    const { store, gateway, media, directory } = this.#services;
    const settings = this.#services.getSettings();
    const allChats = await store.chats.list();
    const chat = allChats.find((c) => c.chatKey === input.chatKey) ?? null;
    const head = await store.conversations.open();
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

    for (const senderId of await store.messages.recentSenderIds(500)) {
      ids.userRef(senderId);
    }

    const chatRef =
      input.kind === "group"
        ? ids.groupRef(input.chatId)
        : ids.userRef(input.chatId);

    const requestMessages = (
      await store.messages.getByIds(input.triggerMessageIds)
    ).filter((m) => m.recalledAt === null && m.id > head.afterMessageId);

    if (input.source === "qq_batch" && requestMessages.length === 0) {
      return { units: [], mutated: false };
    }

    const quotedMessages: MessageRecord[] = [];
    const seenQuotedIds = new Set<number>(requestMessages.map((m) => m.id));

    for (const reqMsg of requestMessages) {
      let currentReplyId = reqMsg.replyToMessageId;

      for (let hop = 0; hop < 2 && currentReplyId; hop++) {
        const quoted = await store.messages.findByOnebotId(
          input.chatKey,
          currentReplyId,
        );

        if (quoted?.recalledAt !== null) {
          break;
        }

        if (!seenQuotedIds.has(quoted.id)) {
          seenQuotedIds.add(quoted.id);
          quotedMessages.push(quoted);
        }

        currentReplyId = quoted.replyToMessageId;
      }
    }

    const requestIdSet = new Set(requestMessages.map((m) => m.id));
    const lastId = requestMessages.at(-1)?.id;

    await gateway.warmChatHistory(input.kind, input.chatId, 100);

    const recentContext =
      lastId === undefined
        ? await store.messages.recent(input.chatKey, 12, {
            afterId: head.afterMessageId,
          })
        : (
            await store.messages.recent(input.chatKey, 20 + requestIdSet.size, {
              beforeId: lastId,
              afterId: head.afterMessageId,
            })
          )
            .filter((m) => !requestIdSet.has(m.id))
            .slice(-20);

    const isSystemSource =
      input.source === "admin_inject" || input.source === "schedule";

    const speakerMap = new Map<string, string>();

    for (const msg of requestMessages) {
      if (!speakerMap.has(msg.userId)) {
        speakerMap.set(msg.userId, msg.senderName);
      }
    }

    if (speakerMap.size === 0 && input.senderId) {
      speakerMap.set(input.senderId, input.senderName ?? input.senderId);
    }

    const resolvedSpeakers: {
      userId: string;
      displayName: string;
      identity: DirectoryUser | null;
      role: AccessRole;
    }[] = [];

    for (const [userId, displayName] of speakerMap.entries()) {
      const identity = await directory.byQQ(userId).catch(() => null);
      const speakerRole = resolveAccessRole({
        userId,
        adminQQs: settings.policy.adminQQs,
        permissions: identity?.permissions,
        isSystemSource,
      });

      resolvedSpeakers.push({
        userId,
        displayName,
        identity,
        role: speakerRole,
      });
    }

    const roleRank: Record<AccessRole, number> = {
      guest: 0,
      member: 1,
      admin: 2,
    };
    const role: AccessRole =
      resolvedSpeakers.length === 0
        ? resolveAccessRole({
            userId: null,
            adminQQs: settings.policy.adminQQs,
            permissions: undefined,
            isSystemSource,
          })
        : resolvedSpeakers.reduce<AccessRole>(
            (lowest, item) =>
              roleRank[item.role] < roleRank[lowest] ? item.role : lowest,
            resolvedSpeakers[0]!.role,
          );

    const multiSpeaker = resolvedSpeakers.length > 1;
    const singleSpeaker = multiSpeaker ? null : (resolvedSpeakers[0] ?? null);
    const speakerQQ = singleSpeaker?.userId ?? null;
    const speakerName = singleSpeaker?.displayName ?? null;
    const identityUser = singleSpeaker?.identity ?? null;
    const speakerRoleByUserId = new Map(
      resolvedSpeakers.map((item) => [item.userId, item.role]),
    );

    const speakerGroupProfiles = new Map<
      string,
      { role: "owner" | "admin" | "member"; title: string | null }
    >();
    let botGroupRole: "owner" | "admin" | "member" | null = null;

    if (input.kind === "group" && gateway.configured) {
      const [botProfile, ...memberProfiles] = await Promise.all([
        settings.bot.botQQ
          ? gateway
              .getGroupMemberProfile(input.chatId, settings.bot.botQQ)
              .catch(() => null)
          : Promise.resolve(null),
        ...resolvedSpeakers.map((item) =>
          gateway
            .getGroupMemberProfile(input.chatId, item.userId)
            .catch(() => null),
        ),
      ]);

      botGroupRole = botProfile?.role ?? null;
      for (const [index, item] of resolvedSpeakers.entries()) {
        const profile = memberProfiles[index];

        if (profile) {
          speakerGroupProfiles.set(item.userId, {
            role: profile.role,
            title: profile.title,
          });
        }
      }
    }

    const formatSpeakerProfile = (item: (typeof resolvedSpeakers)[number]) => {
      const groupProfile = speakerGroupProfiles.get(item.userId);

      return {
        userRef: ids.userRef(item.userId),
        displayName: item.displayName,
        role: item.role,
        ...(groupProfile ? { qqGroupRole: groupProfile.role } : {}),
        ...(groupProfile?.title ? { qqGroupTitle: groupProfile.title } : {}),
        keycloak: item.identity
          ? {
              bound: true,
              admitted: item.identity.permissions.admitted,
              subject: item.identity.subject,
              name: item.identity.name,
              departments: item.identity.permissions.accessDepartments,
              positions: item.identity.permissions.positions.map(
                (p) => p.label,
              ),
            }
          : { bound: false, admitted: false },
      };
    };

    // Assemble a permission-filtered Tape View:
    // admin sees the full global cross-chat Tape + structured handoff;
    // member/guest see only Tape entries from the current chatKey to prevent cross-chat leakage.
    const conversation = await store.conversations.buildView({
      role,
      chatKey: input.chatKey,
    });

    const baseMemoryIndex = await store.memories.index(
      input.chatKey,
      speakerQQ ?? undefined,
    );
    const memoryIndex = multiSpeaker
      ? {
          global: baseMemoryIndex.global,
          chat: baseMemoryIndex.chat,
          user: (
            await Promise.all(
              resolvedSpeakers.map(async (item) => {
                const idx = await store.memories.index(
                  input.chatKey,
                  item.userId,
                );

                return idx.user.map((entry) => ({
                  userRef: ids.userRef(item.userId),
                  ...entry,
                }));
              }),
            )
          ).flat(),
        }
      : baseMemoryIndex;

    await media.waitForMessages([
      ...requestMessages.map((m) => m.id),
      ...quotedMessages.map((m) => m.id),
    ]);
    const enrichedText = await media.enrichMessagesText(
      input.chatKey,
      [...requestMessages, ...quotedMessages, ...recentContext],
      ids,
    );

    const mapMessage = (
      msg: MessageRecord,
      options: { includeRole?: boolean; maxChars?: number } = {},
    ) => {
      const rawText = enrichedText.get(msg.id) ?? msg.text;
      const limit = options.maxChars ?? MAX_REQUEST_MESSAGE_CHARS;

      return {
        id: msg.id,
        quoteRef: ids.messageRef(msg.onebotMessageId, msg.chatKey),
        ...(msg.replyToMessageId
          ? {
              replyToQuoteRef: ids.messageRef(
                msg.replyToMessageId,
                msg.chatKey,
              ),
            }
          : {}),
        userRef: ids.userRef(msg.userId),
        senderName: msg.isBot ? "树莓娘(bot)" : msg.senderName,
        ...(options.includeRole && speakerRoleByUserId.has(msg.userId)
          ? { role: speakerRoleByUserId.get(msg.userId) }
          : {}),
        mentionedBot: msg.mentionedBot,
        text: truncateForModel(rawText, limit),
        time: formatDateTime(msg.sentAt, settings.bot.timezone),
      };
    };

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
        ...(botGroupRole ? { botQqGroupRole: botGroupRole } : {}),
      },
      speaker: singleSpeaker ? formatSpeakerProfile(singleSpeaker) : null,
      ...(multiSpeaker
        ? { speakers: resolvedSpeakers.map(formatSpeakerProfile) }
        : {}),
      requestMessages: requestMessages.map((msg) =>
        mapMessage(msg, { includeRole: multiSpeaker }),
      ),
      ...(quotedMessages.length > 0
        ? { quotedMessages: quotedMessages.map((msg) => mapMessage(msg)) }
        : {}),
      ...(input.content ? { instruction: input.content } : {}),
    };

    const jargonHaystack = [
      ...requestMessages,
      ...quotedMessages,
      ...recentContext,
    ]
      .map((m) => enrichedText.get(m.id) ?? m.text)
      .join("\n");
    const matchedJargon = await store.jargon.matchInText(
      input.chatKey,
      jargonHaystack,
      8,
    );
    const impressionsByUser = await store.impressions.getMany(
      resolvedSpeakers.map((item) => item.userId),
    );
    const withImpression = <T extends Record<string, unknown>>(
      profile: T,
      userId: string,
    ) => {
      const imp = impressionsByUser.get(userId)?.impression;

      return imp ? { ...profile, impression: imp } : profile;
    };

    // Transient water-chat context + memory index + structured handoff hint are sent in this invocation only.
    const fullTurnPayload = {
      ...coreEnvelope,
      chat: {
        ...coreEnvelope.chat,
        ...(chat?.stylePrompt.trim()
          ? { styleHint: chat.stylePrompt.trim() }
          : {}),
      },
      speaker:
        coreEnvelope.speaker && singleSpeaker
          ? withImpression(coreEnvelope.speaker, singleSpeaker.userId)
          : coreEnvelope.speaker,
      ...(multiSpeaker && coreEnvelope.speakers
        ? {
            speakers: resolvedSpeakers.map((item, idx) =>
              withImpression(coreEnvelope.speakers![idx]!, item.userId),
            ),
          }
        : {}),
      ...(matchedJargon.length > 0 ? { jargonHints: matchedJargon } : {}),
      ...(conversation.handoff
        ? {
            conversationHandoff: {
              anchorEntryId: conversation.anchorEntryId,
              ...conversation.handoff,
            },
          }
        : {}),
      recentContext: recentContext.map((msg) =>
        mapMessage(msg, { maxChars: MAX_CONTEXT_MESSAGE_CHARS }),
      ),
      ...(knownGroups.length > 0 ? { knownGroups } : {}),
      memoryIndex,
    };

    const userContent = feedText
      ? `${feedText}\n\n${JSON.stringify(fullTurnPayload)}`
      : JSON.stringify(fullTurnPayload);

    const cleanUserContent = feedText
      ? `${feedText}\n\n${JSON.stringify(coreEnvelope)}`
      : JSON.stringify(coreEnvelope);

    let forkSnapshot: TurnMessage[] = [...conversation.messages];
    const toolContext: ToolContext = {
      services: this.#services,
      actor: {
        chatKey: input.chatKey,
        senderQQ: speakerQQ,
        actorSubject: identityUser?.subject ?? null,
        actorName: multiSpeaker
          ? resolvedSpeakers.map((item) => item.displayName).join(" / ")
          : (identityUser?.name ?? speakerName),
        role,
        ...(multiSpeaker ? { multiSpeaker: true } : {}),
        triggerMessageId: requestMessages.at(-1)?.id ?? null,
      },
      ids,
      getForkHistory: () => forkSnapshot,
      trace: {
        jobId: options?.jobId ?? null,
        messageIds: requestMessages.map((m) => m.id),
      },
    };

    const systemPrompt = buildStaticSystemPrompt({
      personaPrompt: settings.bot.personaPrompt,
      capabilities: this.#mainTools.describeCapabilities(this.#services),
    });

    const tools = this.#mainTools.resolve(toolContext);

    const result = await runChatToolLoop({
      purpose: "dialog",
      chatKey: input.chatKey,
      jobId: options?.jobId ?? null,
      messageIds: requestMessages.map((m) => m.id),
      settings,
      store,
      systemPrompt,
      history: conversation.messages,
      userContent,
      tools,
      maxRounds: 12,
      outputSchema: agentOutputSchema,
      thinkingEffort: resolveThinkingEffort(settings, "dialog"),
      cacheGuard: this.#cacheGuard,
      cacheSessionKey: makeCacheSessionKey(
        conversation.sessionId,
        conversation.summary,
        conversation.scopedToChat ? input.chatKey : "global",
      ),
      onBeforeToolBatch: (completedHistory) => {
        forkSnapshot = completedHistory;
      },
    });

    // Resolve opaque quote, reaction, poke, sticker, and optional targetRef handles back to real OneBot IDs.
    const { dispatches: plannedDispatches, errors: dispatchErrors } =
      await this.#resolveDispatches(result.structured.units, {
        ids,
        input,
        requestMessages,
        speakerQQ,
        role,
        botQQ: settings.bot.botQQ,
      });

    for (const detail of dispatchErrors) {
      await store.conversations.pushOutputResult({
        module: "qq_reaction",
        status: "error",
        detail,
        createdAt: Date.now(),
      });
    }

    const pacedChats = new Set<string>();

    for (const dispatch of plannedDispatches) {
      if (
        (dispatch.unit.kind === "qq_reply" ||
          dispatch.unit.kind === "qq_image") &&
        pacedChats.has(dispatch.targetChatKey)
      ) {
        const paceText =
          dispatch.unit.kind === "qq_reply"
            ? dispatch.unit.text
            : (dispatch.unit.summary ?? "");
        const waitMs = computeReplyPaceDelayMs(
          paceText,
          settings.bot.replyPaceMinMs,
          settings.bot.replyPaceMaxMs,
        );

        if (waitMs > 0) {
          await delay(waitMs);
        }
      }

      await gateway.dispatchUnit(
        dispatch.targetChatKey,
        dispatch.unit,
        settings.bot.botQQ,
      );

      if (
        dispatch.unit.kind === "qq_reply" ||
        dispatch.unit.kind === "qq_image"
      ) {
        pacedChats.add(dispatch.targetChatKey);
      }
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
        { chatKey: input.chatKey },
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

  public async runBackgroundSubagent(
    payload: JobPayloads["subagent_task"],
    options?: { jobId?: number | null },
  ): Promise<void> {
    const { store, directory } = this.#services;
    const settings = this.#services.getSettings();
    const allChats = await store.chats.list();
    const ids = new ModelIds();

    for (const entry of allChats) {
      if (entry.kind === "group") {
        ids.groupRef(entry.chatId);
      } else {
        ids.userRef(entry.chatId);
      }
    }

    for (const senderId of await store.messages.recentSenderIds(500)) {
      ids.userRef(senderId);
    }

    const identityUser = payload.senderId
      ? await directory.byQQ(payload.senderId).catch(() => null)
      : null;
    const role = resolveAccessRole({
      userId: payload.senderId,
      adminQQs: settings.policy.adminQQs,
      permissions: identityUser?.permissions,
    });

    const toolContext: ToolContext = {
      services: this.#services,
      actor: {
        chatKey: payload.chatKey,
        senderQQ: payload.senderId,
        actorSubject: identityUser?.subject ?? null,
        actorName: identityUser?.name ?? payload.senderName,
        role,
        triggerMessageId: payload.triggerMessageId,
      },
      ids,
      ...(payload.forkHistory?.length
        ? { getForkHistory: () => payload.forkHistory! }
        : {}),
      trace: {
        jobId: options?.jobId ?? null,
        messageIds: payload.triggerMessageId ? [payload.triggerMessageId] : [],
      },
    };

    let resultEnvelope: Record<string, unknown>;

    try {
      const result = await this.#subagents.run(
        payload.kind,
        payload.task,
        toolContext,
        {
          fork: payload.fork,
          maxDurationMs: ASYNC_SUBAGENT_MAX_DURATION_MS,
        },
      );

      resultEnvelope = {
        ok: true,
        kind: payload.kind,
        task: payload.task,
        brief: result.brief,
        references: result.references,
        ...(result.sidecarId ? { sidecarId: result.sidecarId } : {}),
      };
    } catch (error) {
      const message = errorMessage(error);

      this.#logger.warn("Background subagent failed", {
        kind: payload.kind,
        chatKey: payload.chatKey,
        error: message,
      });
      resultEnvelope = {
        ok: false,
        kind: payload.kind,
        task: payload.task,
        error: message,
      };
    }

    await store.jobs.coalesceInvoke({
      source: "subagent_result",
      chatKey: payload.chatKey,
      kind: payload.chatKind,
      chatId: payload.chatId,
      triggerMessageIds: payload.triggerMessageId
        ? [payload.triggerMessageId]
        : [],
      senderId: payload.senderId ?? undefined,
      senderName: payload.senderName ?? undefined,
      content: `后台子代理 ${payload.kind} 已执行完毕，请结合以下结果直接回复原发言人（不要重复派发同一任务）：\n${JSON.stringify(resultEnvelope)}`,
    });
    this.#services.wakeWorker?.();
  }

  public async distillChatStyle(
    chatKey: ChatKey,
    options?: { sampleLimit?: number; jobId?: number | null },
  ): Promise<ChatConfig> {
    const { store } = this.#services;
    const settings = this.#services.getSettings();
    const chat = await store.chats.get(chatKey);

    if (!chat) {
      throw new Error(`未找到会话：${chatKey}`);
    }

    const recent = await store.messages.recent(
      chatKey,
      Math.max(40, Math.min(200, options?.sampleLimit ?? 80)),
    );
    const samples = recent.filter((m) => !m.isBot && m.text.trim().length > 0);

    if (samples.length < 10) {
      throw new Error(
        `近期有效群聊样本不足（当前 ${samples.length} 条，至少需要 10 条非机器人消息）`,
      );
    }

    const cfg = settings.mainModel;
    const modelName = cfg.model;
    const apiKey = cfg.apiKey;
    const baseURL = cfg.baseURL;

    if (!apiKey || !modelName) {
      throw new Error("主模型未配置，无法提炼群聊表达风格");
    }

    const transcript = samples
      .slice(-80)
      .map(
        (m) => `${m.senderName}: ${m.text.replace(/\s+/g, " ").slice(0, 140)}`,
      )
      .join("\n");
    const thinkingEffort = resolveThinkingEffort(settings, "style_distill");
    const response = await completeChat({
      apiKey,
      baseURL,
      model: modelName,
      timeoutMs: cfg.timeoutMs,
      maxRetries: 1,
      store,
      timeZone: settings.bot.timezone,
      purpose: "style_distill",
      chatKey,
      jobId: options?.jobId ?? null,
      params: {
        temperature: 0.2,
        max_tokens: 400,
        ...(thinkingEffort === "none"
          ? {}
          : { reasoning_effort: thinkingEffort }),
        messages: [
          {
            role: "system",
            content:
              "你是 QQ 群聊风格提炼助手。请根据近期群聊抽样，用 2～4 句精炼中文（总长不超过 260 字）总结该群的聊天氛围、说话节奏、常用口头禅或表达习惯，以及树莓娘在此群发言应注意的分寸。只输出可直接作为风格提示的纯文本，不要加标题、编号或 Markdown 围栏，不要照抄具体隐私信息。",
          },
          {
            role: "user",
            content: JSON.stringify({
              chatTitle: chat.title || chat.chatKey,
              existingStyle: chat.stylePrompt || null,
              sampleCount: samples.length,
              transcript,
            }),
          },
        ],
      },
    });

    const distilled = (response.choices[0]?.message?.content ?? "")
      .trim()
      .replace(/^```[\s\S]*?\n|```$/g, "")
      .trim()
      .slice(0, 600);

    if (!distilled) {
      throw new Error("模型未返回有效的群风格摘要");
    }

    return store.chats.update(chatKey, { stylePrompt: distilled });
  }

  public async distillChatJargon(
    chatKey: ChatKey,
    options?: { sampleLimit?: number; jobId?: number | null },
  ): Promise<{ inserted: number; totalExtracted: number }> {
    const { store } = this.#services;
    const settings = this.#services.getSettings();
    const chat = await store.chats.get(chatKey);

    if (!chat) {
      throw new Error(`未找到会话：${chatKey}`);
    }

    const recent = await store.messages.recent(
      chatKey,
      Math.max(40, Math.min(200, options?.sampleLimit ?? 100)),
    );
    const samples = recent.filter((m) => !m.isBot && m.text.trim().length > 0);

    if (samples.length < 10) {
      throw new Error(
        `近期有效群聊样本不足（当前 ${samples.length} 条，至少需要 10 条非机器人消息）`,
      );
    }

    const cfg = settings.mainModel;

    if (!cfg.apiKey || !cfg.model) {
      throw new Error("主模型未配置，无法提炼群内黑话词条");
    }

    const existingTerms = (await store.jargon.list({ chatKey })).map(
      (item) => item.term,
    );
    const transcript = samples
      .slice(-100)
      .map(
        (m) => `${m.senderName}: ${m.text.replace(/\s+/g, " ").slice(0, 140)}`,
      )
      .join("\n");
    const thinkingEffort = resolveThinkingEffort(settings, "jargon_distill");
    const jargonExtractSchema = Type.Object(
      {
        entries: Type.Array(
          Type.Object(
            {
              term: Type.String({ minLength: 2, maxLength: 48 }),
              aliases: Type.Optional(Type.Array(Type.String())),
              meaning: Type.String({ minLength: 2, maxLength: 240 }),
            },
            { additionalProperties: false },
          ),
        ),
      },
      { additionalProperties: false },
    );

    const response = await completeChat({
      apiKey: cfg.apiKey,
      baseURL: cfg.baseURL,
      model: cfg.model,
      timeoutMs: cfg.timeoutMs,
      maxRetries: 1,
      store,
      timeZone: settings.bot.timezone,
      purpose: "jargon_distill",
      chatKey,
      jobId: options?.jobId ?? null,
      params: {
        temperature: 0.2,
        max_tokens: 900,
        response_format: { type: "json_object" },
        ...(thinkingEffort === "none"
          ? {}
          : { reasoning_effort: thinkingEffort }),
        messages: [
          {
            role: "system",
            content:
              '你是群内黑话与圈内梗词典提炼助手。请从群聊样本中挑出真正具有圈内特定含义的梗、黑话、外号或简称（最多 8 条；忽略普通日常词汇、单字词和已收录词条；若没有明显黑话则返回空数组）。严格输出 JSON：{"entries":[{"term":"词条","aliases":["同义写法"],"meaning":"一句简明解释"}]}。',
          },
          {
            role: "user",
            content: JSON.stringify({
              chatTitle: chat.title || chat.chatKey,
              existingTerms,
              transcript,
            }),
          },
        ],
      },
    });

    const parsed = validateModelJson(
      jargonExtractSchema,
      response.choices[0]?.message?.content ?? "{}",
    );

    if (!parsed.ok) {
      throw new Error(`黑话提炼返回格式无效：${parsed.issue}`);
    }

    const status = settings.social.jargonAutoApprove ? "approved" : "pending";
    let inserted = 0;

    for (const entry of parsed.value.entries.slice(0, 8)) {
      const added = await store.jargon.insertIfAbsent({
        chatKey,
        term: entry.term,
        aliases: entry.aliases ?? [],
        meaning: entry.meaning,
        status,
        source: "auto",
      });

      if (added) {
        inserted += 1;
      }
    }

    return { inserted, totalExtracted: parsed.value.entries.length };
  }

  public async refreshMemberImpression(
    userId: string,
    options?: {
      displayName?: string;
      force?: boolean;
      jobId?: number | null;
    },
  ): Promise<MemberImpressionRecord | null> {
    const cleanUserId = userId.trim();

    if (!cleanUserId) {
      throw new Error("缺少成员 QQ 号");
    }

    const { store } = this.#services;
    const settings = this.#services.getSettings();
    const existing = await store.impressions.get(cleanUserId);

    if (existing?.locked && !options?.force) {
      return existing;
    }

    const samples = (await store.messages.recentByUser(cleanUserId, 40)).filter(
      (m) => m.text.trim().length > 0,
    );

    if (samples.length < 5) {
      throw new Error(
        `该成员近期发言样本不足（当前 ${samples.length} 条，至少需要 5 条）`,
      );
    }

    const cfg = settings.mainModel;

    if (!cfg.apiKey || !cfg.model) {
      throw new Error("主模型未配置，无法提炼成员印象");
    }

    const displayName =
      options?.displayName?.trim() ||
      samples.at(-1)?.senderName.trim() ||
      existing?.displayName ||
      cleanUserId;
    const transcript = samples
      .map((m) => m.text.replace(/\s+/g, " ").slice(0, 120))
      .join("\n");
    const thinkingEffort = resolveThinkingEffort(settings, "impression_update");
    const response = await completeChat({
      apiKey: cfg.apiKey,
      baseURL: cfg.baseURL,
      model: cfg.model,
      timeoutMs: cfg.timeoutMs,
      maxRetries: 1,
      store,
      timeZone: settings.bot.timezone,
      purpose: "impression_update",
      chatKey: null,
      jobId: options?.jobId ?? null,
      params: {
        temperature: 0.2,
        max_tokens: 140,
        ...(thinkingEffort === "none"
          ? {}
          : { reasoning_effort: thinkingEffort }),
        messages: [
          {
            role: "system",
            content:
              "你是树莓娘的轻量成员印象提炼助手。请根据该成员的近期聊天样本，提炼**一句极简中文印象**（不超过 45 字，例如“爱开玩笑测试我，偶尔问正经技术问题”或“提问认真克制，偏关注系统运维”）。不要打分、不要做道德评判、不要提敏感隐私，只输出这一句纯文本。",
          },
          {
            role: "user",
            content: JSON.stringify({
              displayName,
              existingImpression: existing?.impression ?? null,
              recentLines: transcript,
            }),
          },
        ],
      },
    });

    const impression = (response.choices[0]?.message?.content ?? "")
      .trim()
      .replace(/^["“”'`]+|["“”'`]+$/g, "")
      .replace(/\s+/g, " ")
      .slice(0, 120);

    if (!impression) {
      throw new Error("模型未返回有效的成员印象");
    }

    return store.impressions.upsert({
      userId: cleanUserId,
      displayName,
      impression,
      source: "auto",
      locked: false,
    });
  }

  public async updateMemoryFromMessage(
    chatKey: ChatKey,
    messageId: number,
    options?: { jobId?: number | null },
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
    const allChats = await store.chats.list();
    const currentChat = allChats.find((c) => c.chatKey === chatKey) ?? null;
    const ids = new ModelIds();

    for (const entry of allChats) {
      if (entry.kind === "group") {
        ids.groupRef(entry.chatId);
      } else {
        ids.userRef(entry.chatId);
      }
    }

    for (const item of context) {
      ids.userRef(item.userId);
    }

    const userRef = ids.userRef(message.userId);
    const chatRef = currentChat
      ? currentChat.kind === "group"
        ? ids.groupRef(currentChat.chatId)
        : ids.userRef(currentChat.chatId)
      : undefined;
    const knownGroups = allChats
      .filter((c) => c.kind === "group")
      .map((c) => ({
        targetRef: ids.groupRef(c.chatId),
        title: c.title,
      }));
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
      jobId: options?.jobId ?? null,
      messageIds: [messageId],
      settings,
      store,
      systemPrompt: [
        "你是树莓娘的静默记忆助手，只负责维护每轮自动注入上下文的轻量长期记忆（不是知识库），不向群聊发言。",
        "【允许写入的 4 类轻量记忆】：1) 树莓娘行为/发言/群活跃度或互动规则；2) 成员称呼/外号/QQ身份映射、群别称（如“网协大群”对应哪个群）；3) 成员或管理员稳定个人偏好；4) 极简且有时效的短期提醒/排期（必须设置 ttlDays 或 expiresAt）。",
        '【严禁写入的知识库内容】：项目架构设计、技术方案讨论、功能脑暴/优化待办、工作流程规范（SOP）、漏洞或故障跟进、会议纪要、协作空间说明等长篇参考资料属于 Bunko 知识库或公会看板，宁缺毋滥，遇到此类内容直接跳过不写并输出 {"done":true}。',
        '【精准归属与去重】：针对某一个群的规则必须写 scope="chat" 并传 knownGroups 中对应群的 targetRef（禁止误写成 scope="global"）；针对特定人的称呼或偏好用 scope="user" 并传 userRef；已有同类主题时复用原 key 覆盖更新；summary 一句话说清核心，content 保持精炼不堆砌流水账。结束后输出 {"done":true}。',
      ].join("\n"),
      history: [],
      userContent: JSON.stringify({
        now: formatDateTime(Date.now(), settings.bot.timezone),
        chat: {
          kind:
            currentChat?.kind ??
            (chatKey.startsWith("group:") ? "group" : "private"),
          ...(chatRef ? { targetRef: chatRef } : {}),
          title: currentChat?.title ?? "",
        },
        ...(knownGroups.length > 0 ? { knownGroups } : {}),
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
          userRef: ids.userRef(m.userId),
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
      maxRounds: 6,
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

    this.#compacting = true;

    try {
      const { store } = this.#services;
      const conversation = await store.conversations.get();

      if (!conversation || conversation.entries.length === 0) {
        return;
      }

      const msgEntries = conversation.entries.filter(
        (entry) => entry.kind === "message",
      );

      const budget =
        settings.mainModel.contextTokens -
        settings.mainModel.maxOutputTokens -
        4096;
      const overTokenBudget = lastPromptTokens >= budget * 0.75;
      const overMessageLimit = msgEntries.length >= COMPACTION_MAX_MESSAGES;

      if (!overTokenBudget && !overMessageLimit) {
        return;
      }

      // Split along clean user-turn boundaries without heuristic token estimation.
      const userIndices: number[] = [];

      for (const [i, msgEntry] of msgEntries.entries()) {
        if (msgEntry.role === "user") {
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
              Math.floor(
                (userIndices.length * 0.3 * budget) / lastPromptTokens,
              ),
            ),
          )
        : Math.min(COMPACTION_KEEP_RECENT_TURNS, userIndices.length - 1);
      const turnCursor = Math.max(1, userIndices.length - keepTurns);
      const splitIndex = userIndices[turnCursor]!;
      const archivedEntries = msgEntries.slice(0, splitIndex);
      const cutoffEntryId = archivedEntries.at(-1)?.id;

      if (!cutoffEntryId) {
        return;
      }

      const res = await runChatToolLoop({
        purpose: "compaction",
        chatKey: null,
        settings,
        store,
        systemPrompt:
          '你是会话历史压缩器。将已有结构化交接摘要（previousHandoff）和即将归档的 Tape 条目整理为紧凑中文结构化交接契约（Handoff），作为后续推理的索引提示（原始条目永久保留在 Tape 中可按 ID 回查）。只输出 JSON：{"summary":"一句话或几句总览","confirmedFacts":["已确认事实或结论"],"openTasks":["未完成任务或编号"],"pendingFollowups":["待跟进事项"]}',
        history: [],
        userContent: JSON.stringify({
          previousHandoff: conversation.handoff,
          archivedEntries: archivedEntries.map((entry) => ({
            entryId: entry.id,
            chatKey: entry.chatKey,
            role: entry.role,
            message: entry.message,
          })),
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

      const handoff = {
        summary,
        confirmedFacts: (res.structured.confirmedFacts ?? []).filter(Boolean),
        openTasks: (res.structured.openTasks ?? []).filter(Boolean),
        pendingFollowups: (res.structured.pendingFollowups ?? []).filter(
          Boolean,
        ),
        sourceEntryIds: archivedEntries.map((entry) => entry.id),
      };
      const anchor = await store.conversations.appendCompactAnchor(
        conversation.sessionId,
        cutoffEntryId,
        handoff,
      );

      if (anchor) {
        this.#logger.info("Conversation compacted via append-only anchor", {
          anchorEntryId: anchor.id,
          cutoffEntryId,
          consumedEntries: archivedEntries.length,
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

  async #resolveDispatches(
    rawUnits: RawOutputUnit[],
    ctx: {
      ids: ModelIds;
      input: UnifiedInput;
      requestMessages: MessageRecord[];
      speakerQQ: string | null;
      role: AccessRole;
      botQQ: string;
    },
  ): Promise<{
    dispatches: { targetChatKey: ChatKey; unit: OutputUnit }[];
    errors: string[];
  }> {
    const logger = this.#logger;
    const { ids, input, requestMessages, speakerQQ, role, botQQ } = ctx;

    function isTargetAuthorized(targetChatKey: ChatKey): boolean {
      return targetChatKey === input.chatKey || role === "admin";
    }

    const dispatches: { targetChatKey: ChatKey; unit: OutputUnit }[] = [];
    const errors: string[] = [];

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
          errors.push("仅管理员或网协管理层可跨会话发送消息，已拦截该目标投递");

          return null;
        }

        return targetChatKey;
      } catch {
        logger.warn("Dropped unit with unresolvable targetRef", {
          fromChatKey: input.chatKey,
          targetRef,
        });
        errors.push(
          `无法解析投递目标句柄 ${targetRef}，请先通过 qq_directory 或 guild_resolve_member 获取有效句柄`,
        );

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

      if (unit.kind === "qq_poke") {
        const targetChatKey = resolveUnitTarget(unit.targetRef);

        if (!targetChatKey) {
          continue;
        }

        let resolvedUserId: string | null = null;

        if (unit.userRef?.trim()) {
          try {
            resolvedUserId = ids.resolveUser(unit.userRef);
          } catch {
            logger.warn("Dropped qq_poke with unresolvable userRef", {
              fromChatKey: input.chatKey,
              userRef: unit.userRef,
            });
            errors.push(
              `无法解析戳一戳目标句柄 ${unit.userRef}，请使用上下文或 qq_directory 返回的 u_* 句柄`,
            );

            continue;
          }
        } else if (targetChatKey.startsWith("private:")) {
          resolvedUserId = targetChatKey.slice("private:".length);
        } else if (speakerQQ) {
          resolvedUserId = speakerQQ;
        } else {
          errors.push("群聊多人批次发送 qq_poke 时必须明确指定 userRef");

          continue;
        }

        if (botQQ && resolvedUserId === botQQ) {
          errors.push("不能对自己发送戳一戳，已忽略");

          continue;
        }

        dispatches.push({
          targetChatKey,
          unit: {
            kind: "qq_poke",
            userId: resolvedUserId,
          },
        });

        continue;
      }

      if (unit.kind === "qq_image") {
        const targetChatKey = resolveUnitTarget(unit.targetRef);

        if (!targetChatKey) {
          continue;
        }

        const sticker = await this.#services.store.stickers.get(unit.stickerId);

        if (sticker?.status !== "approved" || !sticker.enabled) {
          errors.push(
            `表情包 #${unit.stickerId} 不存在或未启用，请先调用 search_stickers 获取可用 stickerId`,
          );

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
            kind: "qq_image",
            stickerId: sticker.id,
            filePath: sticker.filePath,
            summary:
              sticker.tags[0] || sticker.meaning.slice(0, 12) || "表情包",
            ...(rawQuote ? { quoteMessageId: rawQuote } : {}),
          },
        });

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
