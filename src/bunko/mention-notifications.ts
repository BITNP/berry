import { setTimeout as delay } from "node:timers/promises";

import { EventSourceParserStream } from "eventsource-parser/stream";
import { ofetch } from "ofetch";

import type { EnvConfig } from "../config/env.ts";
import type { RuntimeSettings } from "../config/settings.ts";
import type { MessageGatewayClient } from "../gateway/client.ts";
import type { IdentityDirectory } from "../identity/keycloak.ts";
import type { Store } from "../store/index.ts";
import { makeChatKey } from "../utils/chat-key.ts";
import { Logger } from "../utils/logger.ts";
import { errorMessage } from "../utils/time.ts";
import type { BunkoClient } from "./client.ts";

const EVENT_CURSOR = "bunko_mention_event_cursor";

interface MentionEvent {
  id: number;
  notificationId: string;
  recipientSubject: string;
  documentId: string;
  documentTitle: string;
  senderName: string;
}

export class BunkoMentionNotifications {
  #apiUrl: string;
  #token: string;
  #bunko: BunkoClient;
  #store: Store;
  #directory: IdentityDirectory;
  #gateway: MessageGatewayClient;
  #getSettings: () => RuntimeSettings;
  #logger = new Logger("bunko:mentions");
  #controller: AbortController | null = null;
  #running: Promise<void> | null = null;

  constructor(
    env: Pick<EnvConfig, "bunkoApiUrl" | "bunkoNotificationToken">,
    bunko: BunkoClient,
    store: Store,
    directory: IdentityDirectory,
    gateway: MessageGatewayClient,
    getSettings: () => RuntimeSettings,
  ) {
    this.#apiUrl = env.bunkoApiUrl.replace(/\/+$/, "");
    this.#token = env.bunkoNotificationToken.trim();
    this.#bunko = bunko;
    this.#store = store;
    this.#directory = directory;
    this.#gateway = gateway;
    this.#getSettings = getSettings;
  }

  public start(): void {
    if (this.#running || !this.#apiUrl || !this.#token) {
      return;
    }

    if (!this.#directory.enabled || !this.#gateway.configured) {
      this.#logger.warn(
        "Bunko mention notifications require Keycloak directory and message gateway",
      );

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
      let streamError: unknown = null;

      try {
        await this.#consume(signal);
      } catch (error) {
        streamError = error;
      }

      if (signal.aborted) {
        break;
      }

      if (Date.now() - openedAt > 60_000) {
        backoffMs = 2000;
      }

      this.#logger.warn("Bunko SSE stream disconnected", {
        ...(streamError ? { error: errorMessage(streamError) } : {}),
        retryInMs: backoffMs,
      });

      await delay(backoffMs, undefined, { signal, ref: false }).catch(
        () => undefined,
      );
      backoffMs = Math.min(backoffMs * 2, 60_000);
    }
  }

  async #consume(signal: AbortSignal): Promise<void> {
    const saved = await this.#store.cursors.get(EVENT_CURSOR);
    let after = saved ? Number(saved) : 0;
    const response = await ofetch.raw(
      `${this.#apiUrl}/api/v1/internal/mention-notifications/stream`,
      {
        query: { after },
        headers: {
          "Authorization": `Bearer ${this.#token}`,
          "Accept": "text/event-stream",
          "Last-Event-ID": String(after),
        },
        responseType: "stream",
        retry: 0,
        signal,
      },
    );

    if (!response.body) {
      throw new Error("Bunko SSE response body is empty");
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

      let event: MentionEvent;

      try {
        event = JSON.parse(frame.data) as MentionEvent;
      } catch {
        this.#logger.warn("Ignored malformed Bunko SSE event", {
          event: frame.event,
        });

        continue;
      }

      if (event.id <= after) {
        continue;
      }

      await this.#notify(event);
      await this.#store.cursors.set(EVENT_CURSOR, String(event.id));
      after = event.id;
    }
  }

  async #notify(event: MentionEvent): Promise<void> {
    const user = await this.#directory.bySubject(event.recipientSubject);

    if (!user?.qq) {
      this.#logger.info("Skipped Bunko mention notification: no QQ binding", {
        notificationId: event.notificationId,
        subject: event.recipientSubject,
      });

      return;
    }

    const url = this.#bunko.docUrl(event.documentId);
    const sender = event.senderName.trim() || "有成员";
    const text = `${sender} 在《${event.documentTitle}》中提及了你。\n${url}`;

    await this.#gateway.dispatchUnit(
      makeChatKey("private", user.qq),
      { kind: "qq_reply", text },
      this.#getSettings().bot.botQQ,
    );
  }
}
