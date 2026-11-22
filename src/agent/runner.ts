import { setTimeout as delay } from "node:timers/promises";

import { resolveThinkingEffort } from "../config/settings.ts";
import type { DirectoryUser } from "../identity/keycloak.ts";
import type { AccessRole } from "../identity/permissions.ts";
import { resolveAccessRole } from "../identity/permissions.ts";
import type { ToolRegistry } from "../tools/index.ts";
import { createDefaultMainToolRegistry } from "../tools/index.ts";
import type { AgentServices, ToolContext } from "../tools/types.ts";
import type {
  MessageRecord,
  OutputUnit,
  TurnMessage,
  UnifiedInput,
} from "../types.ts";
import { Logger } from "../utils/logger.ts";
import { formatDateTime } from "../utils/time.ts";
import { DialogCacheGuard, makeCacheSessionKey } from "./cache-guard.ts";
import { ConversationCompactor } from "./compactor.ts";
import {
  agentOutputSchema,
  computeReplyPaceDelayMs,
  resolveOutputDispatches,
} from "./dispatch.ts";
import { runChatToolLoop } from "./loop.ts";
import { ModelIds } from "./model-ids.ts";
import { buildStaticSystemPrompt, resultsAsText } from "./prompt.ts";
import type { SubagentRegistry } from "./subagents/index.ts";
import { createDefaultSubagentRegistry } from "./subagents/index.ts";

const MAX_REQUEST_MESSAGE_CHARS = 3000;
const MAX_CONTEXT_MESSAGE_CHARS = 600;

function truncateForModel(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }

  return `${text.slice(0, limit)}…[消息过长，原长 ${text.length} 字，已截断前 ${limit} 字]`;
}

export class BerryAgent {
  #services: AgentServices;
  #mainTools: ToolRegistry;
  #compactor: ConversationCompactor;
  #logger = new Logger("agent");
  #cacheGuard = new DialogCacheGuard();

  constructor(
    services: AgentServices,
    options: {
      subagents?: SubagentRegistry;
      mainTools?: ToolRegistry;
    } = {},
  ) {
    this.#services = services;
    const subagents = options.subagents ?? createDefaultSubagentRegistry();

    this.#mainTools =
      options.mainTools ?? createDefaultMainToolRegistry(subagents);
    this.#compactor = new ConversationCompactor(services.store);
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
    const [allChats, head, drainedResults, recentSenders] = await Promise.all([
      store.chats.list(),
      store.conversations.open(),
      store.conversations.drainPendingResults(),
      store.messages.recentSenderIds(500),
    ]);
    const chat = allChats.find((c) => c.chatKey === input.chatKey) ?? null;
    const feedText = resultsAsText(drainedResults);
    const ids = new ModelIds().seedChats(allChats).seedUsers(recentSenders);
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

    await gateway.warmChatHistory(input.kind, input.chatId, 100);

    const recentContext =
      requestIdSet.size === 0
        ? await store.messages.recent(input.chatKey, 12, {
            afterId: head.afterMessageId,
          })
        : (
            await store.messages.recent(input.chatKey, 20 + requestIdSet.size, {
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
    }[] = await Promise.all(
      [...speakerMap.entries()].map(async ([userId, displayName]) => {
        const identity = await directory.byQQ(userId).catch(() => null);
        const speakerRole = resolveAccessRole({
          userId,
          adminQQs: settings.policy.adminQQs,
          permissions: identity?.permissions,
          isSystemSource,
        });

        return { userId, displayName, identity, role: speakerRole };
      }),
    );

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

    // Permission-filtered Tape view: admin sees global Tape, others see current chat only.
    const [conversation, baseMemoryIndex] = await Promise.all([
      store.conversations.buildView({ role, chatKey: input.chatKey }),
      store.memories.index(input.chatKey, speakerQQ ?? undefined),
    ]);
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
      opts: { includeRole?: boolean; maxChars?: number } = {},
    ) => {
      const rawText = enrichedText.get(msg.id) ?? msg.text;
      const limit = opts.maxChars ?? MAX_REQUEST_MESSAGE_CHARS;

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
        ...(opts.includeRole && speakerRoleByUserId.has(msg.userId)
          ? { role: speakerRoleByUserId.get(msg.userId) }
          : {}),
        mentionedBot: msg.mentionedBot,
        text: truncateForModel(rawText, limit),
        time: formatDateTime(msg.sentAt, settings.bot.timezone),
      };
    };

    const knownGroups = allChats
      .filter(
        (c) =>
          c.kind === "group" &&
          (role === "admin" || c.chatKey === input.chatKey),
      )
      .map((c) => ({ targetRef: ids.groupRef(c.chatId), title: c.title }));

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
    const [matchedJargon, impressionsByUser] = await Promise.all([
      store.jargon.matchInText(input.chatKey, jargonHaystack, 8),
      store.impressions.getMany(resolvedSpeakers.map((item) => item.userId)),
    ]);
    const withImpression = <T extends Record<string, unknown>>(
      profile: T,
      userId: string,
    ) => {
      const imp = impressionsByUser.get(userId)?.impression;

      return imp ? { ...profile, impression: imp } : profile;
    };

    // Transient context + memory index + structured handoff are sent for this turn only.
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
      tools: this.#mainTools.resolve(toolContext),
      maxRounds: 12,
      outputSchema: agentOutputSchema,
      validateOutput: async (output) => {
        const missingIds: number[] = [];

        for (const unit of output.units) {
          if (unit.kind !== "qq_image") {
            continue;
          }

          const sticker = await store.stickers.get(unit.stickerId);

          if (sticker?.status !== "approved" || !sticker.enabled) {
            missingIds.push(unit.stickerId);
          }
        }

        if (missingIds.length === 0) {
          return null;
        }

        const uniqueIds = [...new Set(missingIds)]
          .map((id) => `#${id}`)
          .join("、");

        return `表情包 ${uniqueIds} 不存在、已删除或未启用（不要直接复用历史对话中的旧 stickerId），请先调用 search_stickers 查询当前可用表情包`;
      },
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

    const { dispatches: plannedDispatches, errors: dispatchErrors } =
      await resolveOutputDispatches(result.structured.units, {
        store,
        ids,
        input,
        requestMessages,
        speakerQQ,
        role,
        botQQ: settings.bot.botQQ,
      });

    for (const detail of dispatchErrors) {
      this.#logger.warn("Dropped output unit during dispatch", {
        chatKey: input.chatKey,
        detail,
      });
      await store.conversations.pushOutputResult({
        module: "qq_gateway",
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
        await this.#compactor.maybeCompact(settings, result.lastPromptTokens);
      }
    }

    this.#logger.info("Invocation finished", {
      chatKey: input.chatKey,
      units: units.length,
      mutated: result.mutated,
    });

    return { units, mutated: result.mutated };
  }
}
