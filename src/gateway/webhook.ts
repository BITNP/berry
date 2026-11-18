import { createHmac, timingSafeEqual } from "node:crypto";

import type { RuntimeSettings } from "../config/settings.ts";
import type { MessageGate } from "../gate/gate.ts";
import type { MediaProcessor } from "../media/processor.ts";
import type { Store } from "../store/index.ts";
import type { ChatKind } from "../types.ts";
import { makeChatKey } from "../types.ts";
import { Logger } from "../utils/logger.ts";
import { qfaceName } from "./qface.ts";
import { parseOneBotSegments } from "./segments.ts";

export interface OneBotWebhookEvent {
  post_type?: string;
  meta_event_type?: string;
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

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);

  if (bufA.length !== bufB.length) {
    return false;
  }

  return timingSafeEqual(bufA, bufB);
}

export function verifyWebhookSignature(
  token: string,
  rawBody: string,
  authHeader: string | undefined,
  signatureHeader: string | undefined,
): boolean {
  if (!token) {
    return true;
  }

  if (authHeader) {
    const match = /^Bearer\s+(\S+)$/i.exec(authHeader.trim());

    if (match?.[1] && constantTimeEquals(match[1], token)) {
      return true;
    }
  }

  if (signatureHeader) {
    const clean = signatureHeader.trim().replace(/^sha1=/i, "");
    const expected = createHmac("sha1", token).update(rawBody).digest("hex");

    if (clean && constantTimeEquals(clean.toLowerCase(), expected)) {
      return true;
    }
  }

  return false;
}

export class OneBotWebhookHandler {
  #store: Store;
  #gate: MessageGate;
  #media: MediaProcessor;
  #getSettings: () => RuntimeSettings;
  #logger = new Logger("webhook");

  constructor(
    store: Store,
    gate: MessageGate,
    media: MediaProcessor,
    getSettings: () => RuntimeSettings,
  ) {
    this.#store = store;
    this.#gate = gate;
    this.#media = media;
    this.#getSettings = getSettings;
  }

  public async handle(
    payload: OneBotWebhookEvent,
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
      const res = await this.handle(
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
}
