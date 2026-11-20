import { setTimeout as delay } from "node:timers/promises";

import type { EnvConfig } from "../config/env.ts";
import type { Store } from "../store/index.ts";
import type {
  ChatKey,
  DeliveryRecord,
  OneBotSegment,
  OutputUnit,
} from "../types.ts";
import { parseChatKey } from "../types.ts";
import { Logger } from "../utils/logger.ts";
import { errorMessage } from "../utils/time.ts";

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

export interface GatewayClientOptions {
  pollDelaysMs?: number[];
  maxTrackMs?: number;
}

export class MessageGatewayClient {
  #baseUrl: string;
  #account: string;
  #token: string;
  #store: Store;
  #logger = new Logger("gateway");
  #pendingTracks = new Set<Promise<void>>();
  #abort = new AbortController();
  #pollDelaysMs: number[];
  #maxTrackMs: number;

  constructor(
    env: Pick<EnvConfig, "gatewayUrl" | "gatewayAccount" | "gatewayToken">,
    store: Store,
    options: GatewayClientOptions = {},
  ) {
    this.#baseUrl = env.gatewayUrl.replace(/\/+$/, "");
    this.#account = env.gatewayAccount || "qq";
    this.#token = env.gatewayToken;
    this.#store = store;
    this.#pollDelaysMs = options.pollDelaysMs?.length
      ? options.pollDelaysMs
      : DEFAULT_POLL_DELAYS_MS;
    this.#maxTrackMs = options.maxTrackMs ?? DEFAULT_MAX_TRACK_MS;
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
      const res = await fetch(`${this.#baseUrl}/healthz`, {
        signal: AbortSignal.timeout(4000),
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

    const url = `${this.#baseUrl}/api/v1/accounts/${encodeURIComponent(this.#account)}/${action}`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.#token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(30_000),
    });

    const body = (await res.json().catch(() => ({}))) as GatewayEnvelope<T>;

    if (res.status >= 400) {
      throw new Error(
        `Gateway ${action} failed (HTTP ${res.status}): ${body.message ?? res.statusText}`,
      );
    }

    return { httpStatus: res.status, body };
  }

  public async getLoginInfo(): Promise<{
    user_id: number;
    nickname: string;
  } | null> {
    if (!this.configured) {
      return null;
    }

    const { body } = await this.callAction<{
      user_id: number;
      nickname: string;
    }>("get_login_info");

    return body.data ?? null;
  }

  public async getGroupList(): Promise<GroupInfo[]> {
    if (!this.configured) {
      return [];
    }

    const { body } = await this.callAction<GroupInfo[]>("get_group_list");

    return Array.isArray(body.data) ? body.data : [];
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

    return Array.isArray(body.data) ? body.data : [];
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

    return Array.isArray(body.data) ? body.data : [];
  }

  public async getForwardMsg(forwardId: string): Promise<unknown[]> {
    if (!this.configured) {
      return [];
    }

    const { body } = await this.callAction<
      { messages?: unknown[] } | unknown[]
    >("get_forward_msg", { id: forwardId, message_id: forwardId });
    const data = body.data;

    if (Array.isArray(data)) {
      return data;
    }

    if (data && typeof data === "object" && Array.isArray(data.messages)) {
      return data.messages;
    }

    return [];
  }

  public async getGroupMsgHistory(
    groupId: string,
    count = 40,
  ): Promise<Record<string, unknown>[]> {
    if (!this.configured) {
      return [];
    }

    const { body } = await this.callAction<{
      messages?: Record<string, unknown>[];
    }>("get_group_msg_history", {
      group_id: Number(groupId),
      count: Math.min(200, Math.max(1, count)),
    });

    return Array.isArray(body.data?.messages) ? body.data.messages : [];
  }

  public async dispatchUnit(
    chatKey: ChatKey,
    unit: OutputUnit,
    botQQ: string,
  ): Promise<DeliveryRecord> {
    const delivery = await this.#store.deliveries.create(chatKey, unit);
    const { kind, chatId } = parseChatKey(chatKey);

    try {
      if (!this.configured) {
        throw new Error("message-gateway 未配置，无法投递消息");
      }

      if (unit.kind === "qq_reaction") {
        await this.callAction("set_msg_emoji_like", {
          message_id: Number.isFinite(Number(unit.messageId))
            ? Number(unit.messageId)
            : unit.messageId,
          emoji_id: String(unit.emojiId),
          set: true,
        });

        return (
          (await this.#store.deliveries.updateStatus(delivery.id, {
            status: "sent",
            onebotMessageId: unit.messageId,
          })) ?? delivery
        );
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

      await this.#store.deliveries.updateStatus(delivery.id, {
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

      return delivery;
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
    const url = `${this.#baseUrl}/api/v1/accounts/${encodeURIComponent(this.#account)}/message-status/${encodeURIComponent(gatewayDeliveryId)}`;
    const startedAt = Date.now();
    const deadline = startedAt + this.#maxTrackMs;
    let attempt = 0;

    while (!this.#abort.signal.aborted) {
      const remainingMs = deadline - Date.now();

      if (remainingMs <= 0) {
        break;
      }

      const nextDelayMs =
        this.#pollDelaysMs[Math.min(attempt, this.#pollDelaysMs.length - 1)] ??
        5000;
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

      let res: Response;
      let state: GatewayStatusResponse | null = null;

      try {
        res = await fetch(url, {
          headers: { Authorization: `Bearer ${this.#token}` },
          signal: AbortSignal.any([
            AbortSignal.timeout(10_000),
            this.#abort.signal,
          ]),
        });

        if (res.ok) {
          state = (await res.json()) as GatewayStatusResponse;
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

    await this.#store.messages.capture({
      kind,
      chatId,
      onebotMessageId,
      userId: ctx.botQQ || "bot",
      senderName: "树莓娘",
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
