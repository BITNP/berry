import ReconnectingWebSocket from "partysocket/ws";
import WebSocket from "ws";

import type { EnvConfig } from "../config/env.ts";
import type { RuntimeSettings } from "../config/settings.ts";
import { isGroupAllowed } from "../config/settings.ts";
import type { MessageGate } from "../gate/gate.ts";
import type { MediaProcessor } from "../media/processor.ts";
import type { Store } from "../store/index.ts";
import type { ChatKind } from "../types.ts";
import { makeChatKey } from "../utils/chat-key.ts";
import { Logger } from "../utils/logger.ts";
import { errorMessage } from "../utils/time.ts";
import type { MessageGatewayClient } from "./client.ts";
import { qfaceName } from "./qface.ts";
import { parseOneBotSegments } from "./segments.ts";

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
const PING_INTERVAL_MS = 30_000;

export interface OneBotEvent {
  post_type?: string;
  meta_event_type?: string;
  sub_type?: string;
  message_type?: string;
  notice_type?: string;
  message_id?: string | number;
  group_id?: string | number;
  user_id?: string | number;
  sender_id?: string | number;
  target_id?: string | number;
  self_id?: string | number;
  time?: number;
  message?: unknown;
  raw_message?: string;
  likes?: { emoji_id?: string | number; count?: number }[];
  is_add?: boolean;
  sender?: {
    nickname?: string;
    card?: string;
  };
}

function buildEventWsUrl(baseUrl: string, account: string): string {
  const url = new URL(
    `${baseUrl}/api/v1/accounts/${encodeURIComponent(account)}/ws/event`,
  );

  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

  return url.toString();
}

export class GatewayEventSubscriber {
  #baseUrl: string;
  #account: string;
  #token: string;
  #store: Store;
  #gateway: MessageGatewayClient;
  #gate: MessageGate;
  #media: MediaProcessor;
  #getSettings: () => RuntimeSettings;
  #onConnected?: () => void;
  #logger = new Logger("gateway:events");
  #started = false;
  #connected = false;
  #socket: ReconnectingWebSocket | null = null;
  #chatQueues = new Map<string, Promise<unknown>>();

  constructor(
    env: Pick<EnvConfig, "gatewayUrl" | "gatewayAccount" | "gatewayToken">,
    store: Store,
    gateway: MessageGatewayClient,
    gate: MessageGate,
    media: MediaProcessor,
    getSettings: () => RuntimeSettings,
    onConnected?: () => void,
  ) {
    this.#baseUrl = env.gatewayUrl.replace(/\/+$/, "");
    this.#account = env.gatewayAccount || "qq";
    this.#token = env.gatewayToken;
    this.#store = store;
    this.#gateway = gateway;
    this.#gate = gate;
    this.#media = media;
    this.#getSettings = getSettings;
    this.#onConnected = onConnected;
  }

  public get configured(): boolean {
    return Boolean(this.#baseUrl && this.#account && this.#token);
  }

  public get connected(): boolean {
    return this.#connected;
  }

  public start(): void {
    if (this.#started || !this.configured) {
      return;
    }

    this.#started = true;
    const wsUrl = buildEventWsUrl(this.#baseUrl, this.#account);
    const socket = new ReconnectingWebSocket(wsUrl, undefined, {
      WebSocket: this.#createSocketClass(),
      minReconnectionDelay: RECONNECT_MIN_MS,
      maxReconnectionDelay: RECONNECT_MAX_MS,
      reconnectionDelayGrowFactor: 2,
      minUptime: RECONNECT_MAX_MS,
      connectionTimeout: 10_000,
      startClosed: true,
    });

    socket.binaryType = "arraybuffer";
    socket.addEventListener("open", () => {
      if (!this.#started) {
        socket.close(1000, "shutdown");

        return;
      }

      this.#connected = true;
      this.#onConnected?.();
      this.#logger.info("Connected to gateway event stream", {
        account: this.#account,
      });
    });

    socket.addEventListener("message", (event) => {
      if (!this.#started || typeof event.data !== "string") {
        return;
      }

      let parsed: unknown;

      try {
        parsed = JSON.parse(event.data);
      } catch (error) {
        this.#logger.warn("Ignored malformed OneBot WS frame", {
          error: errorMessage(error),
        });

        return;
      }

      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return;
      }

      this.#enqueueEvent(parsed);
    });

    socket.addEventListener("error", (event) => {
      this.#logger.warn("Gateway event stream error", {
        error: event.message || errorMessage(event.error),
      });
    });

    socket.addEventListener("close", (event) => {
      const wasConnected = this.#connected;

      this.#connected = false;

      if (wasConnected) {
        this.#logger.info("Gateway event stream closed", {
          code: event.code,
          reason: event.reason || undefined,
        });
      }
    });

    this.#socket = socket;
    socket.reconnect();
  }

  public async stop(): Promise<void> {
    this.#started = false;
    this.#connected = false;

    const socket = this.#socket;

    this.#socket = null;
    socket?.close(1000, "shutdown");

    await Promise.allSettled(this.#chatQueues.values());
  }

  public async handleEvent(payload: OneBotEvent): Promise<{
    accepted: boolean;
    reason?: string;
    messageId?: number;
  }> {
    if (payload.post_type === "meta_event") {
      return { accepted: true, reason: "meta_event" };
    }

    const isGroupEvent =
      payload.message_type === "group" ||
      (payload.post_type === "notice" &&
        payload.notice_type !== "friend_recall" &&
        payload.group_id !== undefined);
    const eventGroupId =
      isGroupEvent && payload.group_id !== undefined
        ? String(payload.group_id)
        : "";

    if (eventGroupId && !isGroupAllowed(this.#getSettings(), eventGroupId)) {
      return { accepted: true, reason: "group_restricted" };
    }

    if (
      payload.post_type === "notice" &&
      (payload.notice_type === "group_recall" ||
        payload.notice_type === "friend_recall")
    ) {
      const kind: ChatKind =
        payload.notice_type === "group_recall" ? "group" : "private";
      const rawId = kind === "group" ? payload.group_id : payload.user_id;
      const msgId = payload.message_id;

      if (rawId !== undefined && msgId !== undefined) {
        const chatKey = makeChatKey(kind, String(rawId));
        const recalledAt =
          typeof payload.time === "number" ? payload.time * 1000 : Date.now();

        await this.#store.messages.markRecalled(
          chatKey,
          String(msgId),
          recalledAt,
        );
      }

      return { accepted: true, reason: "recall" };
    }

    if (
      payload.post_type === "notice" &&
      payload.notice_type === "group_msg_emoji_like"
    ) {
      const groupId = payload.group_id ? String(payload.group_id) : "";
      const msgId = payload.message_id ? String(payload.message_id) : "";
      const userId = String(payload.user_id ?? "");
      const botQQ = this.#getSettings().bot.botQQ;

      if (groupId && msgId && (!botQQ || userId !== botQQ)) {
        const chatKey = makeChatKey("group", groupId);
        const isAdd = payload.is_add !== false;

        for (const like of payload.likes ?? []) {
          const emojiId = String(like.emoji_id ?? "").trim();

          if (!emojiId) {
            continue;
          }

          await this.#store.reactions.apply({
            chatKey,
            onebotMessageId: msgId,
            emojiId,
            emojiName: qfaceName(emojiId),
            userId: userId || "unknown",
            set: isAdd,
          });
        }
      }

      return { accepted: true, reason: "emoji_like" };
    }

    if (
      payload.post_type === "notice" &&
      payload.notice_type === "notify" &&
      payload.sub_type === "poke"
    ) {
      const settings = this.#getSettings();
      const botQQ = settings.bot.botQQ || String(payload.self_id ?? "");
      const pokerId = String(payload.user_id ?? payload.sender_id ?? "").trim();
      const targetId = String(payload.target_id ?? "").trim();

      if (!pokerId || (botQQ && pokerId === botQQ)) {
        return { accepted: true, reason: "poke_ignored_self" };
      }

      if (targetId && botQQ && targetId !== botQQ) {
        return { accepted: true, reason: "poke_other_target" };
      }

      const rawGroupId =
        payload.group_id !== undefined && String(payload.group_id).trim()
          ? String(payload.group_id).trim()
          : "";
      const kind: ChatKind = rawGroupId ? "group" : "private";
      const chatId = kind === "group" ? rawGroupId : pokerId;
      const rawTimeSec =
        typeof payload.time === "number" && payload.time > 0
          ? payload.time
          : Math.floor(Date.now() / 1000);
      const sentAt = rawTimeSec * 1000;
      const resolvedName =
        kind === "group"
          ? await this.#gateway.getGroupMemberName(chatId, pokerId)
          : await this.#gateway.getUserDisplayName(pokerId);
      const senderName = await this.#gateway.resolveSenderName({
        userId: pokerId,
        isBot: false,
        nickname: resolvedName ?? undefined,
      });

      await this.#gateway.ensureChatWithTitle(kind, chatId, {
        titleHint:
          kind === "private" && senderName !== pokerId ? senderName : undefined,
        enabled:
          kind === "group"
            ? settings.policy.groupDefaultMode !== "off"
            : settings.policy.privateDefaultEnabled,
        triggerMode:
          kind === "group" ? settings.policy.groupDefaultMode : "smart_observe",
      });

      const { message, created } = await this.#store.messages.capture({
        kind,
        chatId,
        onebotMessageId: `poke:${kind}:${chatId}:${pokerId}:${rawTimeSec}`,
        userId: pokerId,
        senderName,
        text: "[戳了戳树莓娘]",
        segments: [
          {
            type: "poke",
            data: { user_id: pokerId, target_id: botQQ || targetId },
          },
        ],
        replyToMessageId: null,
        isBot: false,
        mentionedBot: true,
        sentAt,
      });

      if (!created) {
        return { accepted: true, reason: "duplicate", messageId: message.id };
      }

      if (!settings.bot.paused) {
        await this.#gate.ingest(message);
      }

      this.#logger.debug("Captured OneBot poke notice", {
        messageId: message.id,
        chatKey: message.chatKey,
        pokerId,
      });

      return { accepted: true, reason: "poke", messageId: message.id };
    }

    if (payload.post_type !== "message") {
      return {
        accepted: true,
        reason: `ignored:${payload.post_type ?? "none"}`,
      };
    }

    if (
      payload.message_type !== "group" &&
      payload.message_type !== "private"
    ) {
      return { accepted: false, reason: "unsupported_message_type" };
    }

    const kind: ChatKind = payload.message_type;
    const chatId =
      kind === "group"
        ? String(payload.group_id ?? "")
        : String(payload.user_id ?? "");
    const userId = String(payload.user_id ?? "");
    const onebotMessageId = String(payload.message_id ?? "");

    if (!chatId || !userId || !onebotMessageId) {
      return { accepted: false, reason: "missing_identifiers" };
    }

    const settings = this.#getSettings();
    const botQQ = settings.bot.botQQ || String(payload.self_id ?? "");
    const parsed = parseOneBotSegments(
      payload.message ?? payload.raw_message ?? "",
      botQQ,
      settings.bot.names[0],
    );
    const mentionEnriched = await this.#gateway.enrichMentionNames(
      kind,
      chatId,
      parsed.segments,
      botQQ,
    );
    const messageText = mentionEnriched
      ? parseOneBotSegments(parsed.segments, botQQ, settings.bot.names[0]).text
      : parsed.text;
    const isBot = Boolean(botQQ && userId === botQQ);
    const senderName = await this.#gateway.resolveSenderName({
      userId,
      isBot,
      card: payload.sender?.card,
      nickname: payload.sender?.nickname,
    });
    const sentAt =
      typeof payload.time === "number" && payload.time > 0
        ? payload.time * 1000
        : Date.now();

    await this.#gateway.ensureChatWithTitle(kind, chatId, {
      titleHint:
        kind === "private" && !isBot && senderName !== userId
          ? senderName
          : undefined,
      enabled:
        kind === "group"
          ? settings.policy.groupDefaultMode !== "off"
          : settings.policy.privateDefaultEnabled,
      triggerMode:
        kind === "group" ? settings.policy.groupDefaultMode : "smart_observe",
    });

    const { message, created } = await this.#store.messages.capture({
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

    if (!created) {
      return { accepted: true, reason: "duplicate", messageId: message.id };
    }

    if (parsed.attachments.length > 0) {
      await this.#media.enqueueMessageAssets(message, parsed.attachments);
    }

    if (!isBot) {
      if (settings.bot.paused) {
        this.#logger.debug("Bot paused; archived message without gating", {
          messageId: message.id,
          chatKey: message.chatKey,
        });
      } else {
        await this.#gate.ingest(message);
      }
    }

    this.#logger.debug("Captured OneBot message", {
      messageId: message.id,
      chatKey: message.chatKey,
      mentionedBot: message.mentionedBot,
    });

    return { accepted: true, messageId: message.id };
  }

  #createSocketClass() {
    const token = this.#token;
    const account = this.#account;
    const logger = this.#logger;

    return class AuthenticatedWebSocket extends WebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols, {
          headers: { Authorization: `Bearer ${token}` },
          handshakeTimeout: 10_000,
        });

        let alive = true;
        let pingTimer: ReturnType<typeof setInterval> | null = null;

        const clearPing = () => {
          if (pingTimer) {
            clearInterval(pingTimer);
            pingTimer = null;
          }
        };

        this.on("open", () => {
          alive = true;
          pingTimer = setInterval(() => {
            if (!alive) {
              logger.warn("Gateway event stream ping timeout");
              this.terminate();

              return;
            }

            alive = false;
            this.ping();
          }, PING_INTERVAL_MS);
          pingTimer.unref();
        });

        this.on("pong", () => {
          alive = true;
        });

        this.on("unexpected-response", (_req, res) => {
          res.resume();
          const status = res.statusCode ?? 0;

          if (status === 401 || status === 403) {
            logger.error("Gateway event stream authentication failed", {
              status,
              account,
            });
          } else if (status === 503) {
            logger.warn("Gateway event stream unavailable; retrying", {
              status,
              account,
            });
          } else {
            logger.warn("Unexpected gateway WebSocket handshake response", {
              status,
              account,
            });
          }

          clearPing();
          this.terminate();
        });

        this.on("close", clearPing);
      }
    };
  }

  #eventQueueKey(event: OneBotEvent): string {
    if (event.group_id !== undefined && String(event.group_id).trim()) {
      return `group:${String(event.group_id).trim()}`;
    }

    const userId = String(event.user_id ?? event.sender_id ?? "").trim();

    return userId ? `private:${userId}` : "__global__";
  }

  #enqueueEvent(event: OneBotEvent): void {
    const key = this.#eventQueueKey(event);
    const prev = this.#chatQueues.get(key) ?? Promise.resolve();
    const next = prev.then(async () => {
      if (!this.#started) {
        return;
      }

      try {
        await this.handleEvent(event);
      } catch (error) {
        this.#logger.warn("Failed to process OneBot WS event", {
          postType: event.post_type ?? "unknown",
          error: errorMessage(error),
        });
      }
    });

    this.#chatQueues.set(key, next);
    void next.finally(() => {
      if (this.#chatQueues.get(key) === next) {
        this.#chatQueues.delete(key);
      }
    });
  }
}
