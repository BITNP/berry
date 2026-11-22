import type { Store } from "../store/index.ts";
import type { ChatKind } from "../types.ts";
import { makeChatKey } from "../utils/chat-key.ts";
import { Logger } from "../utils/logger.ts";
import { errorMessage } from "../utils/time.ts";
import type { GatewayDirectory, GatewayTransport } from "./directory.ts";
import { parseOneBotSegments } from "./segments.ts";

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

export class GatewayHistorySync {
  #transport: GatewayTransport;
  #directory: GatewayDirectory;
  #store: Store;
  #logger = new Logger("gateway:history");
  #warmedChats = new Set<string>();
  #inFlightWarms = new Map<string, Promise<void>>();

  constructor(
    transport: GatewayTransport,
    directory: GatewayDirectory,
    store: Store,
  ) {
    this.#transport = transport;
    this.#directory = directory;
    this.#store = store;
  }

  public async getForwardMsg(forwardId: string): Promise<unknown[]> {
    if (!this.#transport.configured) {
      return [];
    }

    const { body } = await this.#transport.callAction<
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
      !this.#transport.configured ||
      (kind === "group" && !this.#transport.isGroupAllowed(chatId))
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
      !this.#transport.configured ||
      (kind === "group" && !this.#transport.isGroupAllowed(chatId))
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

    const { body } = await this.#transport.callAction<
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
    const settings = this.#transport.getSettings();
    const sorted = [...rawMessages].sort(
      (a, b) => Number(a.time ?? 0) - Number(b.time ?? 0),
    );

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
      const mentionEnriched = await this.#directory.enrichMentionNames(
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
      const senderName = await this.#directory.resolveSenderName({
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
}
