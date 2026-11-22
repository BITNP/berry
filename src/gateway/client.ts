import { setTimeout as delay } from "node:timers/promises";

import type { $Fetch, FetchResponse } from "ofetch";
import { ofetch } from "ofetch";

import type { EnvConfig } from "../config/env.ts";
import type { RuntimeSettings } from "../config/settings.ts";
import { isGroupAllowed } from "../config/settings.ts";
import type { Store } from "../store/index.ts";
import type {
  ChatConfig,
  ChatKey,
  ChatKind,
  DeliveryRecord,
  GroupTriggerMode,
  OneBotSegment,
  OutputUnit,
} from "../types.ts";
import { makeChatKey, parseChatKey } from "../utils/chat-key.ts";
import { Logger } from "../utils/logger.ts";
import { errorMessage } from "../utils/time.ts";
import { qfaceName, resolveReactionEmojiId } from "./qface.ts";
import { parseOneBotSegments } from "./segments.ts";

interface GatewayEnvelope<T = unknown> {
  status?: string;
  retcode?: number;
  data?: T;
  message?: string;
}

interface GatewayStatusResponse {
  id: string;
  status: "queued" | "retrying" | "sent" | "failed";
  attempts?: number;
  error?: string;
  reason?: string;
  retry_in_ms?: number;
  receipt?: {
    message_id: string;
    sent_at?: string;
  };
}

export interface GroupInfo {
  group_id: number;
  group_name: string;
  member_count?: number;
}

export interface SyncHistoryOptions {
  count?: number;
  maxPages?: number;
  mode?: "latest" | "older";
  targetStartTimeMs?: number;
  stepBackIfLatestCached?: boolean;
}

export interface SyncHistoryResult {
  fetched: number;
  imported: number;
  pages: number;
  oldestSentAt: number | null;
  newestSentAt: number | null;
  reachedStart: boolean;
}

interface SentMessageContext {
  delivery: DeliveryRecord;
  chatKey: ChatKey;
  text: string;
  segments: OneBotSegment[];
  replyToMessageId: string | null;
  botQQ: string;
}

const DEFAULT_POLL_DELAYS_MS = [350, 700, 1200, 2000, 3000, 4000, 5000];
const DEFAULT_MAX_TRACK_MS = 10 * 60 * 1000;
const LOGIN_INFO_FAILURE_COOLDOWN_MS = 10_000;
const NAME_CACHE_TTL_MS = 10 * 60 * 1000;
const NAME_FAILURE_COOLDOWN_MS = 30_000;
const PLACEHOLDER_SENDER_NAMES = new Set(["临时会话"]);

export interface StrangerInfo {
  user_id: number;
  nickname?: string;
  nick?: string;
  remark?: string;
}

export function cleanOneBotName(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim() ?? "";

  if (!trimmed || PLACEHOLDER_SENDER_NAMES.has(trimmed)) {
    return null;
  }

  return trimmed;
}

export interface GatewayClientOptions {
  pollDelaysMs?: number[];
  maxTrackMs?: number;
  getSettings?: () => RuntimeSettings;
}

export class MessageGatewayClient {
  #baseUrl: string;
  #account: string;
  #token: string;
  #api: $Fetch;
  #store: Store;
  #logger = new Logger("gateway");
  #pendingTracks = new Set<Promise<void>>();
  #abort = new AbortController();
  #pollDelaysMs: number[];
  #maxTrackMs: number;
  #getSettings?: () => RuntimeSettings;
  #warmedChats = new Set<string>();
  #inFlightWarms = new Map<string, Promise<void>>();
  #loginInfo: { user_id: number; nickname: string } | null = null;
  #loginInfoRetryAfter = 0;
  #groupNameCache = new Map<
    string,
    { value: string | null; expiresAt: number }
  >();

  #userNameCache = new Map<
    string,
    { value: string | null; expiresAt: number }
  >();

  #groupMemberNamesCache = new Map<
    string,
    { members: Map<string, string>; ok: boolean; expiresAt: number }
  >();

  constructor(
    env: Pick<EnvConfig, "gatewayUrl" | "gatewayAccount" | "gatewayToken">,
    store: Store,
    options: GatewayClientOptions = {},
  ) {
    this.#baseUrl = env.gatewayUrl.replace(/\/+$/, "");
    this.#account = env.gatewayAccount || "qq";
    this.#token = env.gatewayToken;
    this.#api = ofetch.create({
      baseURL: this.#baseUrl,
      retry: 0,
      headers: { Authorization: `Bearer ${this.#token}` },
    });
    this.#store = store;
    this.#pollDelaysMs = options.pollDelaysMs?.length
      ? options.pollDelaysMs
      : DEFAULT_POLL_DELAYS_MS;
    this.#maxTrackMs = options.maxTrackMs ?? DEFAULT_MAX_TRACK_MS;
    this.#getSettings = options.getSettings;
  }

  public get configured(): boolean {
    return Boolean(this.#baseUrl && this.#account && this.#token);
  }

  public async checkHealth(): Promise<{
    configured: boolean;
    reachable: boolean;
    error?: string;
  }> {
    if (!this.configured) {
      return { configured: false, reachable: false, error: "网关未配置" };
    }

    try {
      const res = await ofetch.raw(`${this.#baseUrl}/healthz`, {
        timeout: 4000,
        retry: 0,
        ignoreResponseError: true,
      });

      if (!res.ok) {
        return {
          configured: true,
          reachable: false,
          error: `HTTP ${res.status}`,
        };
      }

      return { configured: true, reachable: true };
    } catch (error) {
      return {
        configured: true,
        reachable: false,
        error: errorMessage(error),
      };
    }
  }

  public async callAction<T = unknown>(
    action: string,
    params: Record<string, unknown> = {},
  ): Promise<{ httpStatus: number; body: GatewayEnvelope<T> }> {
    if (!this.configured) {
      throw new Error("message-gateway is not configured");
    }

    const res = await this.#api.raw<GatewayEnvelope<T>>(
      `/api/v1/accounts/${encodeURIComponent(this.#account)}/${action}`,
      {
        method: "POST",
        body: params,
        timeout: 30_000,
        ignoreResponseError: true,
      },
    );

    const body =
      res._data && typeof res._data === "object"
        ? res._data
        : ({} as GatewayEnvelope<T>);

    if (res.status >= 400) {
      throw new Error(
        `Gateway ${action} failed (HTTP ${res.status}): ${body.message ?? res.statusText}`,
      );
    }

    return { httpStatus: res.status, body };
  }

  public clearLoginInfoCache(): void {
    this.#loginInfo = null;
    this.#loginInfoRetryAfter = 0;

    for (const [key, entry] of this.#groupNameCache) {
      if (entry.value === null) {
        this.#groupNameCache.delete(key);
      }
    }

    for (const [key, entry] of this.#userNameCache) {
      if (entry.value === null) {
        this.#userNameCache.delete(key);
      }
    }

    for (const [key, entry] of this.#groupMemberNamesCache) {
      if (!entry.ok) {
        this.#groupMemberNamesCache.delete(key);
      }
    }
  }

  public async getLoginInfo(): Promise<{
    user_id: number;
    nickname: string;
  } | null> {
    if (!this.configured) {
      return null;
    }

    if (this.#loginInfo) {
      return this.#loginInfo;
    }

    if (Date.now() < this.#loginInfoRetryAfter) {
      return null;
    }

    try {
      const { body } = await this.callAction<{
        user_id: number;
        nickname: string;
      }>("get_login_info");

      if (body.data) {
        this.#loginInfo = body.data;
        this.#loginInfoRetryAfter = 0;

        return body.data;
      }
    } catch {
      // Fall through to short negative cooldown.
    }

    this.#loginInfoRetryAfter = Date.now() + LOGIN_INFO_FAILURE_COOLDOWN_MS;

    return null;
  }

  public async getGroupList(): Promise<GroupInfo[]> {
    if (!this.configured) {
      return [];
    }

    const { body } = await this.callAction<GroupInfo[]>("get_group_list");
    const groups = (body.data ?? []).filter((group) =>
      this.#isGroupAllowed(String(group.group_id)),
    );
    const expiresAt = Date.now() + NAME_CACHE_TTL_MS;

    for (const group of groups) {
      const name = cleanOneBotName(group.group_name);

      if (name) {
        this.#groupNameCache.set(String(group.group_id), {
          value: name,
          expiresAt,
        });
      }
    }

    return groups;
  }

  public async getGroupInfo(groupId: string): Promise<GroupInfo | null> {
    if (!this.configured || !this.#isGroupAllowed(groupId)) {
      return null;
    }

    const numericId = Number(groupId);

    if (!Number.isFinite(numericId)) {
      return null;
    }

    try {
      const { body } = await this.callAction<GroupInfo>("get_group_info", {
        group_id: numericId,
      });

      return body.status === "failed" ? null : (body.data ?? null);
    } catch {
      return null;
    }
  }

  public async getGroupName(groupId: string): Promise<string | null> {
    if (!this.configured || !this.#isGroupAllowed(groupId)) {
      return null;
    }

    const now = Date.now();
    const cached = this.#groupNameCache.get(groupId);

    if (cached && cached.expiresAt > now) {
      return cached.value;
    }

    const info = await this.getGroupInfo(groupId);
    const name = cleanOneBotName(info?.group_name);

    this.#groupNameCache.set(groupId, {
      value: name,
      expiresAt: now + (name ? NAME_CACHE_TTL_MS : NAME_FAILURE_COOLDOWN_MS),
    });

    return name;
  }

  #isGroupAllowed(groupId: string): boolean {
    return !this.#getSettings || isGroupAllowed(this.#getSettings(), groupId);
  }

  public async getGroupMemberList(
    groupId: string,
  ): Promise<
    { user_id: number; nickname: string; card?: string; role?: string }[]
  > {
    if (!this.configured) {
      return [];
    }

    const { body } = await this.callAction<
      { user_id: number; nickname: string; card?: string; role?: string }[]
    >("get_group_member_list", { group_id: Number(groupId) });
    const members = body.data ?? [];
    const nameMap = new Map<string, string>();

    for (const member of members) {
      const name =
        cleanOneBotName(member.card) ?? cleanOneBotName(member.nickname);

      if (name) {
        nameMap.set(String(member.user_id), name);
      }
    }

    this.#groupMemberNamesCache.set(groupId, {
      members: nameMap,
      ok: true,
      expiresAt: Date.now() + NAME_CACHE_TTL_MS,
    });

    return members;
  }

  public async getGroupMemberName(
    groupId: string,
    userId: string,
  ): Promise<string | null> {
    if (!this.configured) {
      return null;
    }

    const now = Date.now();
    let cached = this.#groupMemberNamesCache.get(groupId);

    if (!cached || cached.expiresAt <= now) {
      try {
        await this.getGroupMemberList(groupId);
        cached = this.#groupMemberNamesCache.get(groupId);
      } catch {
        cached = {
          members: new Map(),
          ok: false,
          expiresAt: now + NAME_FAILURE_COOLDOWN_MS,
        };
        this.#groupMemberNamesCache.set(groupId, cached);
      }
    }

    return (
      cached?.members.get(userId) ?? (await this.getUserDisplayName(userId))
    );
  }

  public async enrichMentionNames(
    kind: ChatKind,
    chatId: string,
    segments: OneBotSegment[],
    botQQ: string,
  ): Promise<boolean> {
    if (!this.configured) {
      return false;
    }

    let changed = false;

    for (const seg of segments) {
      if (seg.type !== "at") {
        continue;
      }

      const qq = String(seg.data.qq ?? "").trim();

      if (!qq || qq === "all" || qq === botQQ || !/^\d+$/.test(qq)) {
        continue;
      }

      if (
        cleanOneBotName(
          typeof seg.data.name === "string" ? seg.data.name : undefined,
        )
      ) {
        continue;
      }

      const name =
        kind === "group"
          ? await this.getGroupMemberName(chatId, qq)
          : await this.getUserDisplayName(qq);

      if (name) {
        seg.data.name = name;
        changed = true;
      }
    }

    return changed;
  }

  public async getFriendList(): Promise<
    { user_id: number; nickname: string; remark?: string }[]
  > {
    if (!this.configured) {
      return [];
    }

    const { body } =
      await this.callAction<
        { user_id: number; nickname: string; remark?: string }[]
      >("get_friend_list");
    const friends = body.data ?? [];
    const expiresAt = Date.now() + NAME_CACHE_TTL_MS;

    for (const friend of friends) {
      const name =
        cleanOneBotName(friend.remark) ?? cleanOneBotName(friend.nickname);

      if (name) {
        this.#userNameCache.set(String(friend.user_id), {
          value: name,
          expiresAt,
        });
      }
    }

    return friends;
  }

  public async getStrangerInfo(userId: string): Promise<StrangerInfo | null> {
    if (!this.configured) {
      return null;
    }

    const numericId = Number(userId);

    if (!Number.isFinite(numericId)) {
      return null;
    }

    try {
      const { body } = await this.callAction<StrangerInfo>(
        "get_stranger_info",
        { user_id: numericId },
      );

      return body.status === "failed" ? null : (body.data ?? null);
    } catch {
      return null;
    }
  }

  public async getUserDisplayName(userId: string): Promise<string | null> {
    if (!this.configured) {
      return null;
    }

    const now = Date.now();
    const cached = this.#userNameCache.get(userId);

    if (cached && cached.expiresAt > now) {
      return cached.value;
    }

    const info = await this.getStrangerInfo(userId);
    const name =
      cleanOneBotName(info?.remark) ??
      cleanOneBotName(info?.nickname) ??
      cleanOneBotName(info?.nick);

    this.#userNameCache.set(userId, {
      value: name,
      expiresAt: now + (name ? NAME_CACHE_TTL_MS : NAME_FAILURE_COOLDOWN_MS),
    });

    return name;
  }

  public async resolveChatTitle(
    kind: ChatKind,
    chatId: string,
  ): Promise<string | null> {
    return kind === "group"
      ? this.getGroupName(chatId)
      : this.getUserDisplayName(chatId);
  }

  public async resolveSenderName(input: {
    userId: string;
    isBot: boolean;
    card?: string | null;
    nickname?: string | null;
  }): Promise<string> {
    if (input.isBot) {
      return this.#getSettings?.().bot.names[0]?.trim() || "树莓娘";
    }

    const direct =
      cleanOneBotName(input.card) ?? cleanOneBotName(input.nickname);

    if (direct) {
      return direct;
    }

    return (await this.getUserDisplayName(input.userId)) ?? input.userId;
  }

  public async ensureChatWithTitle(
    kind: ChatKind,
    chatId: string,
    options: {
      titleHint?: string | null;
      enabled: boolean;
      triggerMode: GroupTriggerMode;
    },
  ): Promise<ChatConfig> {
    const hint = cleanOneBotName(options.titleHint);
    const chat = await this.#store.chats.ensure(kind, chatId, {
      ...(hint ? { title: hint } : {}),
      enabled: options.enabled,
      triggerMode: options.triggerMode,
    });

    if (chat.title.trim()) {
      return chat;
    }

    const resolved = await this.resolveChatTitle(kind, chatId);

    if (!resolved) {
      return chat;
    }

    return this.#store.chats.ensure(kind, chatId, {
      title: resolved,
      enabled: chat.enabled,
      triggerMode: chat.triggerMode,
    });
  }

  public async backfillEmptyChatTitles(): Promise<number> {
    if (!this.configured) {
      return 0;
    }

    const chats = (await this.#store.chats.list()).filter(
      (chat) => !chat.title.trim(),
    );

    if (chats.length === 0) {
      return 0;
    }

    if (chats.some((chat) => chat.kind === "group")) {
      await this.getGroupList().catch(() => []);
    }

    if (chats.some((chat) => chat.kind === "private")) {
      await this.getFriendList().catch(() => []);
    }

    let updated = 0;

    for (const chat of chats) {
      const resolved = await this.resolveChatTitle(chat.kind, chat.chatId);

      if (resolved) {
        await this.#store.chats.ensure(chat.kind, chat.chatId, {
          title: resolved,
          enabled: chat.enabled,
          triggerMode: chat.triggerMode,
        });
        updated++;
      }
    }

    return updated;
  }

  public async getForwardMsg(forwardId: string): Promise<unknown[]> {
    if (!this.configured) {
      return [];
    }

    const { body } = await this.callAction<
      { messages?: unknown[] } | unknown[]
    >("get_forward_msg", { id: forwardId, message_id: forwardId });
    const data = body.data;

    return Array.isArray(data) ? data : (data?.messages ?? []);
  }

  public async syncChatHistory(
    kind: ChatKind,
    chatId: string,
    options: SyncHistoryOptions = {},
  ): Promise<SyncHistoryResult> {
    if (
      !this.configured ||
      (kind === "group" && !this.#isGroupAllowed(chatId))
    ) {
      return {
        fetched: 0,
        imported: 0,
        pages: 0,
        oldestSentAt: null,
        newestSentAt: null,
        reachedStart: true,
      };
    }

    const chatKey = makeChatKey(kind, chatId);
    const count = Math.min(500, Math.max(1, options.count ?? 200));
    const maxPages = Math.min(5, Math.max(1, options.maxPages ?? 1));
    const mode = options.mode ?? "latest";

    let cursorSeq: string | undefined;

    if (mode === "older") {
      const oldest = await this.#store.messages.oldest(chatKey);

      if (oldest) {
        cursorSeq = oldest.onebotMessageId;
      }
    }

    let fetched = 0;
    let imported = 0;
    let pages = 0;
    let oldestSentAt: number | null = null;
    let newestSentAt: number | null = null;
    let reachedStart = false;

    function recordRange(pageOldest: number | null, pageNewest: number | null) {
      if (
        pageOldest !== null &&
        (oldestSentAt === null || pageOldest < oldestSentAt)
      ) {
        oldestSentAt = pageOldest;
      }

      if (
        pageNewest !== null &&
        (newestSentAt === null || pageNewest > newestSentAt)
      ) {
        newestSentAt = pageNewest;
      }
    }

    for (let page = 0; page < maxPages; page++) {
      const rawMessages = await this.#fetchHistoryPage(
        kind,
        chatId,
        count,
        cursorSeq,
      );

      if (rawMessages.length === 0) {
        reachedStart = true;

        break;
      }

      const batch = await this.#ingestHistoricalMessages(
        kind,
        chatId,
        rawMessages,
      );

      fetched += rawMessages.length;
      imported += batch.imported;
      pages++;
      recordRange(batch.oldestSentAt, batch.newestSentAt);

      if (
        options.targetStartTimeMs !== undefined &&
        oldestSentAt !== null &&
        oldestSentAt <= options.targetStartTimeMs
      ) {
        break;
      }

      if (
        page === 0 &&
        mode === "latest" &&
        batch.imported === 0 &&
        options.stepBackIfLatestCached &&
        maxPages === 1
      ) {
        const oldest = await this.#store.messages.oldest(chatKey);
        const stepCursor = oldest?.onebotMessageId;

        if (stepCursor && stepCursor !== cursorSeq) {
          const olderRaw = await this.#fetchHistoryPage(
            kind,
            chatId,
            count,
            stepCursor,
          );

          if (olderRaw.length === 0) {
            reachedStart = true;
          } else {
            const olderBatch = await this.#ingestHistoricalMessages(
              kind,
              chatId,
              olderRaw,
            );

            fetched += olderRaw.length;
            imported += olderBatch.imported;
            pages++;
            recordRange(olderBatch.oldestSentAt, olderBatch.newestSentAt);

            if (olderBatch.imported === 0) {
              reachedStart = true;
            }
          }
        }

        break;
      }

      const nextCursor = batch.oldestCursor;

      if (
        !nextCursor ||
        nextCursor === cursorSeq ||
        (cursorSeq !== undefined && batch.imported === 0)
      ) {
        reachedStart = true;

        break;
      }

      cursorSeq = nextCursor;
    }

    return {
      fetched,
      imported,
      pages,
      oldestSentAt,
      newestSentAt,
      reachedStart,
    };
  }

  public async warmChatHistory(
    kind: ChatKind,
    chatId: string,
    count = 100,
  ): Promise<void> {
    if (
      !this.configured ||
      (kind === "group" && !this.#isGroupAllowed(chatId))
    ) {
      return;
    }

    const chatKey = makeChatKey(kind, chatId);

    if (this.#warmedChats.has(chatKey)) {
      return;
    }

    const existing = this.#inFlightWarms.get(chatKey);

    if (existing) {
      await existing;

      return;
    }

    const task = (async () => {
      try {
        await this.syncChatHistory(kind, chatId, {
          count,
          mode: "latest",
          maxPages: 1,
        });
        this.#warmedChats.add(chatKey);
      } catch (error) {
        this.#logger.warn("Warm chat history sync failed", {
          chatKey,
          error: errorMessage(error),
        });
      } finally {
        this.#inFlightWarms.delete(chatKey);
      }
    })();

    this.#inFlightWarms.set(chatKey, task);
    await task;
  }

  async #fetchHistoryPage(
    kind: ChatKind,
    chatId: string,
    count: number,
    cursorSeq?: string,
  ): Promise<Record<string, unknown>[]> {
    const params: Record<string, unknown> = {
      [kind === "group" ? "group_id" : "user_id"]: Number(chatId),
      count: Math.min(500, Math.max(1, count)),
    };

    if (cursorSeq !== undefined && cursorSeq !== "") {
      const numericSeq = Number(cursorSeq);

      params.message_seq = Number.isFinite(numericSeq) ? numericSeq : cursorSeq;
      params.reverseOrder = true;
    }

    const { body } = await this.callAction<
      { messages?: Record<string, unknown>[] } | Record<string, unknown>[]
    >(
      kind === "group" ? "get_group_msg_history" : "get_friend_msg_history",
      params,
    );

    return Array.isArray(body.data) ? body.data : (body.data?.messages ?? []);
  }

  async #ingestHistoricalMessages(
    kind: ChatKind,
    chatId: string,
    rawMessages: Record<string, unknown>[],
  ): Promise<{
    imported: number;
    oldestSentAt: number | null;
    newestSentAt: number | null;
    oldestCursor: string | null;
  }> {
    const settings = this.#getSettings?.();
    const sorted = [...rawMessages].sort(
      (a, b) => Number(a.time ?? 0) - Number(b.time ?? 0),
    );

    await this.ensureChatWithTitle(kind, chatId, {
      enabled:
        kind === "group"
          ? (settings?.policy.groupDefaultMode ?? "mention_only") !== "off"
          : (settings?.policy.privateDefaultEnabled ?? true),
      triggerMode:
        kind === "group"
          ? (settings?.policy.groupDefaultMode ?? "mention_only")
          : "smart_observe",
    });

    let imported = 0;
    let oldestSentAt: number | null = null;
    let newestSentAt: number | null = null;
    let oldestCursor: string | null = null;

    for (const raw of sorted) {
      const userId = String(raw.user_id ?? "");
      const onebotMessageId = String(raw.message_id ?? "");

      if (!userId || !onebotMessageId) {
        continue;
      }

      const botQQ = settings?.bot.botQQ || String(raw.self_id ?? "");
      const parsed = parseOneBotSegments(
        raw.message ?? raw.raw_message ?? "",
        botQQ,
        settings?.bot.names[0],
      );
      const mentionEnriched = await this.enrichMentionNames(
        kind,
        chatId,
        parsed.segments,
        botQQ,
      );
      const messageText = mentionEnriched
        ? parseOneBotSegments(parsed.segments, botQQ, settings?.bot.names[0])
            .text
        : parsed.text;
      const sender = raw.sender as
        { nickname?: string; card?: string } | undefined;
      const isBot = Boolean(botQQ && userId === botQQ);
      const senderName = await this.resolveSenderName({
        userId,
        isBot,
        card: sender?.card,
        nickname: sender?.nickname,
      });
      const sentAt =
        typeof raw.time === "number" && raw.time > 0
          ? raw.time * 1000
          : Date.now();

      const { created } = await this.#store.messages.capture({
        kind,
        chatId,
        onebotMessageId,
        userId,
        senderName,
        text: messageText,
        segments: parsed.segments,
        replyToMessageId: parsed.replyToMessageId,
        isBot,
        mentionedBot: parsed.mentionedBot,
        sentAt,
      });

      if (created) {
        imported++;
      }

      if (oldestSentAt === null || sentAt < oldestSentAt) {
        oldestSentAt = sentAt;
        oldestCursor = String(raw.message_seq ?? raw.message_id);
      }

      if (newestSentAt === null || sentAt > newestSentAt) {
        newestSentAt = sentAt;
      }
    }

    return { imported, oldestSentAt, newestSentAt, oldestCursor };
  }

  public async dispatchUnit(
    chatKey: ChatKey,
    unit: OutputUnit,
    botQQ: string,
  ): Promise<DeliveryRecord> {
    const delivery = await this.#store.deliveries.create(chatKey, unit);
    const { kind, chatId } = parseChatKey(chatKey);

    try {
      if (kind === "group" && !this.#isGroupAllowed(chatId)) {
        throw new Error(`群聊 ${chatId} 不在允许群聊白名单内，已拦截发送`);
      }

      if (!this.configured) {
        throw new Error("message-gateway 未配置，无法投递消息");
      }

      if (unit.kind === "qq_reaction") {
        if (kind !== "group") {
          throw new Error("QQ 表情回应仅支持群聊消息，已拦截私聊贴表情");
        }

        const resolvedEmojiId = resolveReactionEmojiId(unit.emojiId);

        await this.callAction("set_msg_emoji_like", {
          message_id: Number.isFinite(Number(unit.messageId))
            ? Number(unit.messageId)
            : unit.messageId,
          emoji_id: resolvedEmojiId,
          set: !unit.remove,
        });

        await this.#store.reactions.apply({
          chatKey,
          onebotMessageId: unit.messageId,
          emojiId: resolvedEmojiId,
          emojiName: qfaceName(resolvedEmojiId),
          userId: botQQ || "bot",
          set: !unit.remove,
        });

        const updated = await this.#store.deliveries.updateStatus(delivery.id, {
          status: "sent",
          onebotMessageId: unit.messageId,
        });

        await this.#store.conversations.pushOutputResult({
          module: "qq_gateway",
          status: "ok",
          detail: unit.remove ? "qq_reaction removed" : "qq_reaction sent",
          createdAt: Date.now(),
        });

        return updated ?? delivery;
      }

      if (unit.kind === "qq_poke") {
        const targetUserId = Number(unit.userId);

        if (!Number.isFinite(targetUserId) || targetUserId <= 0) {
          throw new Error(`无效的戳一戳目标用户: ${unit.userId}`);
        }

        await this.callAction("send_poke", {
          user_id: targetUserId,
          ...(kind === "group" ? { group_id: Number(chatId) } : {}),
        });

        const updated = await this.#store.deliveries.updateStatus(delivery.id, {
          status: "sent",
          onebotMessageId: `poke-${delivery.id}`,
        });

        await this.#store.conversations.pushOutputResult({
          module: "qq_gateway",
          status: "ok",
          detail: "qq_poke sent",
          createdAt: Date.now(),
        });

        return updated ?? delivery;
      }

      if (unit.kind === "qq_forward") {
        return await this.#dispatchForward(
          delivery,
          chatKey,
          kind,
          chatId,
          unit,
          botQQ,
        );
      }

      const segments: OneBotSegment[] = [
        ...(unit.quoteMessageId
          ? [{ type: "reply", data: { id: unit.quoteMessageId } }]
          : []),
        { type: "text", data: { text: unit.text } },
      ];
      const action =
        kind === "group" ? "send_group_msg_async" : "send_private_msg_async";
      const params =
        kind === "group"
          ? { group_id: Number(chatId), message: segments }
          : { user_id: Number(chatId), message: segments };

      return await this.#sendAsyncMessage(action, params, {
        delivery,
        chatKey,
        text: unit.text,
        segments,
        replyToMessageId: unit.quoteMessageId ?? null,
        botQQ,
      });
    } catch (error) {
      const detail = errorMessage(error);
      const updated = await this.#store.deliveries.updateStatus(delivery.id, {
        status: "failed",
        error: detail,
      });

      await this.#store.conversations.pushOutputResult({
        module: "qq_gateway",
        status: "error",
        detail: `[${chatKey}] ${detail}`,
        createdAt: Date.now(),
      });
      this.#logger.warn("Delivery failed", {
        deliveryId: delivery.id,
        chatKey,
        error: detail,
      });

      return updated ?? delivery;
    }
  }

  async #sendAsyncMessage(
    action: "send_group_msg_async" | "send_private_msg_async",
    params: Record<string, unknown>,
    ctx: SentMessageContext,
  ): Promise<DeliveryRecord> {
    const { body } = await this.callAction<{
      delivery_id?: string;
      message_id?: string | number;
    }>(action, params);

    const gatewayDeliveryId = body.data?.delivery_id ?? null;

    if (gatewayDeliveryId) {
      const updated = await this.#store.deliveries.updateStatus(
        ctx.delivery.id,
        {
          status: "queued",
          gatewayDeliveryId,
        },
      );

      this.#spawnTracker(gatewayDeliveryId, ctx);

      return updated ?? ctx.delivery;
    }

    const msgId = body.data?.message_id
      ? String(body.data.message_id)
      : `sent-${ctx.delivery.id}`;

    return this.#markSent(msgId, ctx);
  }

  async #dispatchForward(
    delivery: DeliveryRecord,
    chatKey: ChatKey,
    kind: "group" | "private",
    chatId: string,
    unit: Extract<OutputUnit, { kind: "qq_forward" }>,
    botQQ: string,
  ): Promise<DeliveryRecord> {
    if (kind === "private") {
      const joined = `${unit.title}\n\n${unit.items.map((item) => item.text).join("\n\n")}`;
      const segments: OneBotSegment[] = [
        { type: "text", data: { text: joined } },
      ];

      return this.#sendAsyncMessage(
        "send_private_msg_async",
        {
          user_id: Number(chatId),
          message: segments,
        },
        {
          delivery,
          chatKey,
          text: joined,
          segments,
          replyToMessageId: null,
          botQQ,
        },
      );
    }

    const nodes = unit.items.map((item) => ({
      type: "node",
      data: {
        user_id: botQQ || "0",
        nickname: "树莓娘",
        content: [{ type: "text", data: { text: item.text } }],
      },
    }));

    const { body } = await this.callAction<{ message_id?: string | number }>(
      "send_group_forward_msg",
      {
        group_id: Number(chatId),
        messages: nodes,
        source: unit.title,
        summary: `查看 ${unit.items.length} 条内容`,
        prompt: `[${unit.title}]`,
      },
    );

    const summaryText = `[${unit.title}]\n${unit.items.map((item) => item.text).join("\n")}`;

    return this.#markSent(
      String(body.data?.message_id ?? `fwd-${delivery.id}`),
      {
        delivery,
        chatKey,
        text: summaryText,
        segments: [],
        replyToMessageId: null,
        botQQ,
      },
    );
  }

  #spawnTracker(gatewayDeliveryId: string, ctx: SentMessageContext): void {
    const task = this.#trackDelivery(gatewayDeliveryId, ctx)
      .catch((error) => {
        this.#logger.warn("Delivery status tracking failed", {
          deliveryId: ctx.delivery.id,
          gatewayDeliveryId,
          error: errorMessage(error),
        });
      })
      .finally(() => {
        this.#pendingTracks.delete(task);
      });

    this.#pendingTracks.add(task);
  }

  async #trackDelivery(
    gatewayDeliveryId: string,
    ctx: SentMessageContext,
  ): Promise<void> {
    const statusPath = `/api/v1/accounts/${encodeURIComponent(this.#account)}/message-status/${encodeURIComponent(gatewayDeliveryId)}`;
    const startedAt = Date.now();
    const deadline = startedAt + this.#maxTrackMs;
    let attempt = 0;

    while (!this.#abort.signal.aborted) {
      const remainingMs = deadline - Date.now();

      if (remainingMs <= 0) {
        break;
      }

      const nextDelayMs =
        this.#pollDelaysMs[Math.min(attempt, this.#pollDelaysMs.length - 1)]!;
      const waitMs = Math.min(nextDelayMs, remainingMs);

      try {
        await delay(waitMs, undefined, { signal: this.#abort.signal });
      } catch (error) {
        if (this.#abort.signal.aborted) {
          return;
        }

        throw error;
      }

      attempt++;

      let res: FetchResponse<GatewayStatusResponse>;
      let state: GatewayStatusResponse | null = null;

      try {
        res = await this.#api.raw<GatewayStatusResponse>(statusPath, {
          signal: AbortSignal.any([
            AbortSignal.timeout(10_000),
            this.#abort.signal,
          ]),
          ignoreResponseError: true,
        });

        if (res.ok && res._data) {
          state = res._data;
        }
      } catch (error) {
        if (this.#abort.signal.aborted) {
          return;
        }

        this.#logger.debug("Delivery status poll request failed; retrying", {
          deliveryId: ctx.delivery.id,
          gatewayDeliveryId,
          attempt,
          error: errorMessage(error),
        });

        continue;
      }

      if (res.status === 404) {
        await this.#markFailed(
          ctx.delivery.id,
          ctx.chatKey,
          "Gateway delivery status not found (evicted or restarted)",
        );

        return;
      }

      if (!state) {
        continue;
      }

      if (state.status === "sent") {
        await this.#markSent(
          state.receipt?.message_id ?? `gw-${gatewayDeliveryId}`,
          ctx,
        );

        return;
      }

      if (state.status === "failed") {
        await this.#markFailed(
          ctx.delivery.id,
          ctx.chatKey,
          state.error || state.reason || "gateway delivery failed",
        );

        return;
      }

      await this.#store.deliveries.updateStatus(ctx.delivery.id, {
        status: state.status,
        ...(state.attempts === undefined ? {} : { attempts: state.attempts }),
        ...(state.error ? { error: state.error } : {}),
      });
    }

    if (this.#abort.signal.aborted) {
      return;
    }

    const elapsedMs = Date.now() - startedAt;

    this.#logger.warn("Delivery status tracking timed out", {
      deliveryId: ctx.delivery.id,
      gatewayDeliveryId,
      attempts: attempt,
      elapsedMs,
    });
    await this.#markFailed(
      ctx.delivery.id,
      ctx.chatKey,
      `Gateway delivery status tracking timed out after ${Math.round(elapsedMs / 1000)}s`,
    );
  }

  async #markSent(
    onebotMessageId: string,
    ctx: SentMessageContext,
  ): Promise<DeliveryRecord> {
    const updated = await this.#store.deliveries.updateStatus(ctx.delivery.id, {
      status: "sent",
      onebotMessageId,
    });
    const { kind, chatId } = parseChatKey(ctx.chatKey);
    const settings = this.#getSettings?.();

    await this.ensureChatWithTitle(kind, chatId, {
      enabled:
        kind === "group"
          ? (settings?.policy.groupDefaultMode ?? "mention_only") !== "off"
          : (settings?.policy.privateDefaultEnabled ?? true),
      triggerMode:
        kind === "group"
          ? (settings?.policy.groupDefaultMode ?? "mention_only")
          : "smart_observe",
    });

    await this.#store.messages.capture({
      kind,
      chatId,
      onebotMessageId,
      userId: ctx.botQQ || "bot",
      senderName: settings?.bot.names[0]?.trim() || "树莓娘",
      text: ctx.text,
      segments: ctx.segments,
      replyToMessageId: ctx.replyToMessageId,
      isBot: true,
      mentionedBot: false,
      sentAt: Date.now(),
    });
    await this.#store.conversations.pushOutputResult({
      module: "qq_gateway",
      status: "ok",
      detail: "sent",
      createdAt: Date.now(),
    });

    return updated!;
  }

  async #markFailed(
    deliveryId: number,
    chatKey: ChatKey,
    detail: string,
  ): Promise<void> {
    await this.#store.deliveries.updateStatus(deliveryId, {
      status: "failed",
      error: detail,
    });
    await this.#store.conversations.pushOutputResult({
      module: "qq_gateway",
      status: "error",
      detail: `[${chatKey}] ${detail}`,
      createdAt: Date.now(),
    });
  }

  public async waitForPendingTracks(): Promise<void> {
    await Promise.all(this.#pendingTracks);
  }

  public async close(): Promise<void> {
    this.#abort.abort();
    await this.waitForPendingTracks();
  }
}
