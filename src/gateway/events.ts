import { setTimeout as delay } from "node:timers/promises";

import type { RawData } from "ws";
import WebSocket from "ws";

import type { EnvConfig } from "../config/env.ts";
import type { RuntimeSettings } from "../config/settings.ts";
import type { MessageGate } from "../gate/gate.ts";
import type { MediaProcessor } from "../media/processor.ts";
import type { Store } from "../store/index.ts";
import type { ChatKind } from "../types.ts";
import { makeChatKey } from "../types.ts";
import { Logger } from "../utils/logger.ts";
import { errorMessage } from "../utils/time.ts";
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

function rawDataToText(data: RawData): string {
  if (typeof data === "string") {
    return data;
  }

  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }

  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }

  return Buffer.from(data).toString("utf8");
}

function buildEventWsUrl(baseUrl: string, account: string): string {
  const url = new URL(
    `${baseUrl.replace(/\/+$/, "")}/api/v1/accounts/${encodeURIComponent(account || "qq")}/ws/event`,
  );

  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

  return url.toString();
}

export class GatewayEventSubscriber {
  #baseUrl: string;
  #account: string;
  #token: string;
  #store: Store;
  #gate: MessageGate;
  #media: MediaProcessor;
  #getSettings: () => RuntimeSettings;
  #logger = new Logger("gateway:events");
  #started = false;
  #connected = false;
  #stopController: AbortController | null = null;
  #activeWs: WebSocket | null = null;
  #loopPromise: Promise<void> | null = null;
  #eventQueue: Promise<unknown> = Promise.resolve();

  constructor(
    env: Pick<EnvConfig, "gatewayUrl" | "gatewayAccount" | "gatewayToken">,
    store: Store,
    gate: MessageGate,
    media: MediaProcessor,
    getSettings: () => RuntimeSettings,
  ) {
    this.#baseUrl = env.gatewayUrl.replace(/\/+$/, "");
    this.#account = env.gatewayAccount || "qq";
    this.#token = env.gatewayToken;
    this.#store = store;
    this.#gate = gate;
    this.#media = media;
    this.#getSettings = getSettings;
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
    this.#stopController?.abort();
    this.#stopController = new AbortController();
    this.#loopPromise = this.#runLoop().finally(() => {
      this.#loopPromise = null;
    });
  }

  public async stop(): Promise<void> {
    this.#started = false;
    this.#connected = false;
    this.#stopController?.abort();
    this.#stopController = null;

    const ws = this.#activeWs;

    if (ws) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(1000, "shutdown");
        const forceTimer = setTimeout(() => {
          ws.terminate();
        }, 500);

        forceTimer.unref();
      } else {
        ws.terminate();
      }
    }

    await this.#loopPromise?.catch(() => undefined);
    await this.#eventQueue.catch(() => undefined);
  }

  public async handleEvent(
    payload: OneBotEvent,
    options: { historical?: boolean } = {},
  ): Promise<{
    accepted: boolean;
    reason?: string;
    messageId?: number;
  }> {
    if (payload.post_type === "meta_event") {
      return { accepted: true, reason: "meta_event" };
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
    );
    const senderName =
      payload.sender?.card?.trim() ||
      payload.sender?.nickname?.trim() ||
      userId;
    const sentAt =
      typeof payload.time === "number" && payload.time > 0
        ? payload.time * 1000
        : Date.now();
    const isBot = Boolean(botQQ && userId === botQQ);

    await this.#store.chats.ensure(kind, chatId, {
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
      text: parsed.text,
      segments: parsed.segments,
      replyToMessageId: parsed.replyToMessageId,
      isBot,
      mentionedBot: parsed.mentionedBot,
      sentAt,
    });

    if (!created) {
      return { accepted: true, reason: "duplicate", messageId: message.id };
    }

    if (parsed.attachments.length > 0 && !options.historical) {
      await this.#media.enqueueMessageAssets(message, parsed.attachments);
    }

    if (!isBot && !options.historical) {
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

  public async ingestHistoryBatch(
    groupId: string,
    rawMessages: Record<string, unknown>[],
  ): Promise<{ total: number; imported: number }> {
    let imported = 0;

    for (const raw of rawMessages) {
      const res = await this.handleEvent(
        {
          post_type: "message",
          message_type: "group",
          group_id: groupId,
          user_id: raw.user_id as string | number | undefined,
          message_id: raw.message_id as string | number | undefined,
          time: raw.time as number | undefined,
          message: raw.message,
          raw_message: raw.raw_message as string | undefined,
          sender: raw.sender as
            { nickname?: string; card?: string } | undefined,
        },
        { historical: true },
      );

      if (res.accepted && res.reason !== "duplicate") {
        imported++;
      }
    }

    return { total: rawMessages.length, imported };
  }

  async #runLoop(): Promise<void> {
    let backoffMs = RECONNECT_MIN_MS;
    const wsUrl = buildEventWsUrl(this.#baseUrl, this.#account);

    while (this.#started) {
      const openedAt = await this.#connectOnce(wsUrl);

      if (!this.#started) {
        break;
      }

      if (openedAt > 0 && Date.now() - openedAt >= RECONNECT_MAX_MS) {
        backoffMs = RECONNECT_MIN_MS;
      }

      await delay(backoffMs, undefined, {
        ref: false,
        signal: this.#stopController?.signal,
      }).catch(() => undefined);
      backoffMs = Math.min(backoffMs * 2, RECONNECT_MAX_MS);
    }
  }

  #connectOnce(wsUrl: string): Promise<number> {
    return new Promise((resolve) => {
      const ws = new WebSocket(wsUrl, {
        headers: {
          Authorization: `Bearer ${this.#token}`,
        },
        handshakeTimeout: 10_000,
      });

      this.#activeWs = ws;

      let settled = false;
      let pingTimer: ReturnType<typeof setInterval> | null = null;
      let alive = true;
      let openedAt = 0;

      const settle = () => {
        if (pingTimer) {
          clearInterval(pingTimer);
          pingTimer = null;
        }

        if (this.#activeWs === ws) {
          this.#activeWs = null;
        }

        this.#connected = false;

        if (!settled) {
          settled = true;
          resolve(openedAt);
        }
      };

      ws.on("open", () => {
        if (!this.#started) {
          ws.close(1000, "shutdown");

          return;
        }

        openedAt = Date.now();
        this.#connected = true;
        this.#logger.info("Connected to gateway event stream", {
          account: this.#account,
        });

        pingTimer = setInterval(() => {
          if (!alive) {
            this.#logger.warn("Gateway event stream ping timeout");
            ws.terminate();

            return;
          }

          alive = false;
          ws.ping();
        }, PING_INTERVAL_MS);
        pingTimer.unref();
      });

      ws.on("pong", () => {
        alive = true;
      });

      ws.on("message", (data, isBinary) => {
        if (isBinary || !this.#started) {
          return;
        }

        const raw = rawDataToText(data);
        let parsed: unknown;

        try {
          parsed = JSON.parse(raw);
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

      ws.on("unexpected-response", (_req, res) => {
        res.resume();
        const status = res.statusCode ?? 0;

        if (status === 401 || status === 403) {
          this.#logger.error("Gateway event stream authentication failed", {
            status,
            account: this.#account,
          });
        } else if (status === 503) {
          this.#logger.warn("Gateway event stream unavailable; retrying", {
            status,
            account: this.#account,
          });
        } else {
          this.#logger.warn("Unexpected gateway WebSocket handshake response", {
            status,
            account: this.#account,
          });
        }

        ws.terminate();
        settle();
      });

      ws.on("error", (error) => {
        this.#logger.warn("Gateway event stream error", {
          error: errorMessage(error),
        });
      });

      ws.on("close", (code, reason) => {
        if (openedAt > 0) {
          this.#logger.info("Gateway event stream closed", {
            code,
            reason: reason.toString("utf8") || undefined,
          });
        }

        settle();
      });
    });
  }

  #enqueueEvent(event: OneBotEvent): void {
    const task = this.#eventQueue.then(async () => {
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

    this.#eventQueue = task.then(
      () => undefined,
      () => undefined,
    );
  }
}
