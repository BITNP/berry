import { setTimeout as delay } from "node:timers/promises";

import { EventSourceParserStream } from "eventsource-parser/stream";
import { ofetch } from "ofetch";

import type { EnvConfig } from "../config/env.ts";
import type { MessageGatewayClient } from "../gateway/client.ts";
import type { IdentityDirectory } from "../identity/keycloak.ts";
import type { Store } from "../store/index.ts";
import { makeChatKey } from "../utils/chat-key.ts";
import { Logger } from "../utils/logger.ts";
import { errorMessage } from "../utils/time.ts";

const EVENT_CURSOR = "bunko_mention_event_cursor";
const LAST_DISPATCH = "bunko_mention_last_dispatch";

interface MentionEvent {
  id: number;
  notificationId: string;
  recipientSubject: string;
  documentId: string;
  documentTitle: string;
  senderName: string;
}

type MentionConfig = Pick<
  EnvConfig,
  | "bunkoApiUrl"
  | "bunkoPublicUrl"
  | "bunkoWorkspaceSlug"
  | "bunkoNotificationToken"
>;
type Cursors = Pick<Store["cursors"], "get" | "set">;
type Directory = Pick<IdentityDirectory, "enabled" | "bySubject">;
type Gateway = Pick<MessageGatewayClient, "configured" | "dispatchUnit">;

export class BunkoMentionNotifications {
  #env: MentionConfig;
  #cursors: Cursors;
  #directory: Directory;
  #gateway: Gateway;
  #getBotQQ: () => string;
  #logger = new Logger("bunko:mentions");
  #controller: AbortController | null = null;
  #running: Promise<void> | null = null;

  constructor(
    env: MentionConfig,
    cursors: Cursors,
    directory: Directory,
    gateway: Gateway,
    getBotQQ: () => string,
  ) {
    this.#env = env;
    this.#cursors = cursors;
    this.#directory = directory;
    this.#gateway = gateway;
    this.#getBotQQ = getBotQQ;
  }

  public start(): void {
    if (
      this.#running ||
      !this.#env.bunkoApiUrl ||
      !this.#env.bunkoNotificationToken
    ) {
      return;
    }

    if (!this.#directory.enabled || !this.#gateway.configured) {
      this.#logger.warn("Bunko QQ 通知需要配置 Keycloak 目录和消息网关");

      return;
    }

    const controller = new AbortController();

    this.#controller = controller;
    this.#running = this.#run(controller.signal);
  }

  public async stop(): Promise<void> {
    this.#controller?.abort();
    await this.#running;
    this.#controller = null;
    this.#running = null;
  }

  async #run(signal: AbortSignal): Promise<void> {
    let backoffMs = 2000;

    while (!signal.aborted) {
      const openedAt = Date.now();

      try {
        await this.#consume(signal);

        if (!signal.aborted) {
          this.#logger.warn("Bunko 通知事件流已断开");
        }
      } catch (error) {
        if (!signal.aborted) {
          this.#logger.warn("Bunko 通知事件读取失败", {
            error: errorMessage(error),
          });
        }
      }

      if (signal.aborted) {
        break;
      }

      if (Date.now() - openedAt > 60_000) {
        backoffMs = 2000;
      }

      await delay(backoffMs, undefined, { signal, ref: false }).catch(
        () => undefined,
      );
      backoffMs = Math.min(backoffMs * 2, 60_000);
    }
  }

  async #consume(signal: AbortSignal): Promise<void> {
    let after = Number((await this.#cursors.get(EVENT_CURSOR)) ?? 0);
    const response = await ofetch.raw(
      `${this.#env.bunkoApiUrl}/api/v1/internal/mention-notifications/stream`,
      {
        query: { after },
        headers: {
          "Authorization": `Bearer ${this.#env.bunkoNotificationToken}`,
          "Accept": "text/event-stream",
          "Last-Event-ID": String(after),
        },
        responseType: "stream",
        retry: 0,
        signal,
      },
    );

    if (
      !response.body ||
      !response.headers.get("content-type")?.startsWith("text/event-stream")
    ) {
      throw new Error("Bunko 未返回通知事件流");
    }

    const stream = response.body
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(new EventSourceParserStream());

    for await (const frame of stream) {
      if (signal.aborted) {
        break;
      }

      if (frame.event !== "mention.requested") {
        continue;
      }

      const event = JSON.parse(frame.data) as MentionEvent;

      if (
        !Number.isSafeInteger(event.id) ||
        !event.notificationId ||
        !event.recipientSubject ||
        !event.documentId
      ) {
        throw new Error("Bunko 提及事件格式无效");
      }

      if (event.id <= after) {
        continue;
      }

      await this.#notify(event);
      await this.#cursors.set(EVENT_CURSOR, String(event.id));
      after = event.id;
    }
  }

  async #notify(event: MentionEvent): Promise<void> {
    if ((await this.#cursors.get(LAST_DISPATCH)) === event.notificationId) {
      this.#logger.warn("Bunko 通知的投递结果待确认", {
        notificationId: event.notificationId,
      });

      return;
    }

    const user = await this.#directory.bySubject(event.recipientSubject);

    if (!user?.qq) {
      this.#logger.info("跳过 Bunko 通知，收件人未绑定 QQ", {
        notificationId: event.notificationId,
      });

      return;
    }

    const base = (this.#env.bunkoPublicUrl || this.#env.bunkoApiUrl).replace(
      /\/+$/,
      "",
    );
    const workspace = this.#env.bunkoWorkspaceSlug.trim() || "bitnp";
    const url = `${base}/${workspace}/doc/${encodeURIComponent(event.documentId)}`;
    const sender = event.senderName.trim() || "有成员";
    const text = `${sender} 在《${event.documentTitle}》中提及了你。\n${url}`;

    // A crash before the cursor is saved must not submit the same DM again.
    await this.#cursors.set(LAST_DISPATCH, event.notificationId);
    const delivery = await this.#gateway.dispatchUnit(
      makeChatKey("private", user.qq),
      { kind: "qq_reply", text },
      this.#getBotQQ(),
    );

    if (delivery.status === "failed") {
      this.#logger.warn("Bunko QQ 通知投递失败", {
        notificationId: event.notificationId,
        deliveryId: delivery.id,
      });
    }
  }
}
