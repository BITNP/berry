import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

import type { $Fetch, FetchResponse } from "ofetch";

import { buildSignedStickerUrl } from "../media/sticker-url.ts";
import type { Store } from "../store/index.ts";
import type {
  ChatKey,
  DeliveryRecord,
  OneBotSegment,
  OutputUnit,
} from "../types.ts";
import { parseChatKey } from "../utils/chat-key.ts";
import { Logger } from "../utils/logger.ts";
import { errorMessage } from "../utils/time.ts";
import type { GatewayDirectory, GatewayTransport } from "./directory.ts";
import { qfaceName, resolveReactionEmojiId } from "./qface.ts";

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
const MAX_INLINE_IMAGE_BYTES = 512 * 1024;

export class GatewayDispatcher {
  #transport: GatewayTransport;
  #directory: GatewayDirectory;
  #store: Store;
  #api: $Fetch;
  #account: string;
  #publicUrl?: string;
  #mediaSignSecret?: string;
  #logger = new Logger("gateway");
  #pendingTracks = new Set<Promise<void>>();
  #abort = new AbortController();
  #pollDelaysMs: number[];
  #maxTrackMs: number;

  constructor(options: {
    transport: GatewayTransport;
    directory: GatewayDirectory;
    store: Store;
    api: $Fetch;
    account: string;
    publicUrl?: string;
    mediaSignSecret?: string;
    pollDelaysMs?: number[];
    maxTrackMs?: number;
  }) {
    this.#transport = options.transport;
    this.#directory = options.directory;
    this.#store = options.store;
    this.#api = options.api;
    this.#account = options.account;
    this.#publicUrl = options.publicUrl;
    this.#mediaSignSecret = options.mediaSignSecret;
    this.#pollDelaysMs = options.pollDelaysMs?.length
      ? options.pollDelaysMs
      : DEFAULT_POLL_DELAYS_MS;
    this.#maxTrackMs = options.maxTrackMs ?? DEFAULT_MAX_TRACK_MS;
  }

  public async dispatchUnit(
    chatKey: ChatKey,
    unit: OutputUnit,
    botQQ: string,
  ): Promise<DeliveryRecord> {
    const delivery = await this.#store.deliveries.create(chatKey, unit);
    const { kind, chatId } = parseChatKey(chatKey);

    try {
      if (kind === "group" && !this.#transport.isGroupAllowed(chatId)) {
        throw new Error(`群聊 ${chatId} 不在允许群聊白名单内，已拦截发送`);
      }

      if (!this.#transport.configured) {
        throw new Error("message-gateway 未配置，无法投递消息");
      }

      if (unit.kind === "qq_reaction") {
        if (kind !== "group") {
          throw new Error("QQ 表情回应仅支持群聊消息，已拦截私聊贴表情");
        }

        const resolvedEmojiId = resolveReactionEmojiId(unit.emojiId);

        await this.#transport.callAction("set_msg_emoji_like", {
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

        await this.#transport.callAction("send_poke", {
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

      if (unit.kind === "qq_image") {
        const { stickerId, quoteMessageId, summary } = unit;
        const isSticker = unit.isSticker ?? stickerId !== undefined;
        const bytes = await readFile(unit.filePath);
        const signedUrl =
          stickerId === undefined
            ? null
            : buildSignedStickerUrl({
                publicUrl: this.#publicUrl,
                secret: this.#mediaSignSecret,
                stickerId,
              });
        const action =
          kind === "group" ? "send_group_msg_async" : "send_private_msg_async";

        function buildParams(fileRef: string) {
          const segments: OneBotSegment[] = [
            ...(quoteMessageId
              ? [{ type: "reply", data: { id: quoteMessageId } }]
              : []),
            {
              type: "image",
              data: {
                file: fileRef,
                sub_type: isSticker ? 1 : 0,
                ...(summary ? { summary: `[${summary}]` } : {}),
              },
            },
          ];

          return kind === "group"
            ? { group_id: Number(chatId), message: segments }
            : { user_id: Number(chatId), message: segments };
        }

        const fallbackLabel = isSticker ? "表情包" : "图片";
        const sentCtx: SentMessageContext = {
          delivery,
          chatKey,
          text: summary
            ? `[${fallbackLabel}: ${summary}]`
            : `[${fallbackLabel}]`,
          segments: [
            {
              type: "image",
              data: {
                ...(isSticker ? { sub_type: 1 } : {}),
                summary: summary ?? fallbackLabel,
              },
            },
          ],
          replyToMessageId: quoteMessageId ?? null,
          botQQ,
        };

        let sent: DeliveryRecord;

        if (bytes.length > MAX_INLINE_IMAGE_BYTES && signedUrl) {
          sent = await this.#sendAsyncMessage(
            action,
            buildParams(signedUrl),
            sentCtx,
          );
        } else {
          try {
            sent = await this.#sendAsyncMessage(
              action,
              buildParams(`base64://${bytes.toString("base64")}`),
              sentCtx,
            );
          } catch (error) {
            if (signedUrl && /\(HTTP 413\)/.test(errorMessage(error))) {
              this.#logger.warn(
                "Inline base64 sticker hit HTTP 413; retrying with signed media URL",
                {
                  deliveryId: delivery.id,
                  stickerId,
                  bytes: bytes.length,
                },
              );
              sent = await this.#sendAsyncMessage(
                action,
                buildParams(signedUrl),
                sentCtx,
              );
            } else {
              throw error;
            }
          }
        }

        if (stickerId !== undefined) {
          await this.#store.stickers.recordUsage(stickerId).catch(() => {});
        }

        return sent;
      }

      const bodySegments: OneBotSegment[] =
        unit.segments && unit.segments.length > 0
          ? unit.segments
          : [{ type: "text", data: { text: unit.text } }];
      const wireSegments: OneBotSegment[] = [
        ...(unit.quoteMessageId
          ? [{ type: "reply", data: { id: unit.quoteMessageId } }]
          : []),
        ...bodySegments.map((seg) =>
          seg.type === "at"
            ? { type: "at", data: { qq: String(seg.data.qq ?? "") } }
            : seg,
        ),
      ];
      const storedSegments: OneBotSegment[] = [
        ...(unit.quoteMessageId
          ? [{ type: "reply", data: { id: unit.quoteMessageId } }]
          : []),
        ...bodySegments,
      ];
      const action =
        kind === "group" ? "send_group_msg_async" : "send_private_msg_async";
      const params =
        kind === "group"
          ? { group_id: Number(chatId), message: wireSegments }
          : { user_id: Number(chatId), message: wireSegments };

      return await this.#sendAsyncMessage(action, params, {
        delivery,
        chatKey,
        text: unit.text,
        segments: storedSegments,
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

  public async waitForPendingTracks(): Promise<void> {
    await Promise.all(this.#pendingTracks);
  }

  public async close(): Promise<void> {
    this.#abort.abort();
    await this.waitForPendingTracks();
  }

  async #sendAsyncMessage(
    action: "send_group_msg_async" | "send_private_msg_async",
    params: Record<string, unknown>,
    ctx: SentMessageContext,
  ): Promise<DeliveryRecord> {
    const { body } = await this.#transport.callAction<{
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
        { user_id: Number(chatId), message: segments },
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

    const { body } = await this.#transport.callAction<{
      message_id?: string | number;
    }>("send_group_forward_msg", {
      group_id: Number(chatId),
      messages: nodes,
      source: unit.title,
      summary: `查看 ${unit.items.length} 条内容`,
      prompt: `[${unit.title}]`,
    });

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
    const settings = this.#transport.getSettings();

    await this.#directory.ensureChatWithTitle(kind, chatId, {
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
}
