import type { Selectable } from "kysely";
import { sql } from "kysely";

import type {
  ChatKey,
  ChatKind,
  MessageRecord,
  OneBotSegment,
} from "../types.ts";
import { makeChatKey } from "../types.ts";
import type { BerryDatabase } from "./database.ts";
import type { BerryTables } from "./schema.ts";

const decodeMessage = (
  row: Selectable<BerryTables["messages"]>,
): MessageRecord => ({
  id: row.id,
  chatKey: row.chat_key as ChatKey,
  kind: row.kind as ChatKind,
  chatId: row.chat_id,
  onebotMessageId: row.onebot_message_id,
  userId: row.user_id,
  senderName: row.sender_name,
  text: row.text,
  segments: JSON.parse(row.segments_json) as OneBotSegment[],
  replyToMessageId: row.reply_to_message_id,
  isBot: Boolean(row.is_bot),
  mentionedBot: Boolean(row.mentioned_bot),
  quotedBot: Boolean(row.quoted_bot),
  recalledAt: row.recalled_at,
  sentAt: row.sent_at,
  receivedAt: row.received_at,
});

export interface CaptureMessageInput {
  kind: ChatKind;
  chatId: string;
  onebotMessageId: string;
  userId: string;
  senderName: string;
  text: string;
  segments: OneBotSegment[];
  replyToMessageId: string | null;
  isBot: boolean;
  mentionedBot: boolean;
  sentAt: number;
  receivedAt?: number;
}

export class MessagesStore {
  #database: BerryDatabase;

  constructor(database: BerryDatabase) {
    this.#database = database;
  }

  public capture(
    input: CaptureMessageInput,
  ): Promise<{ message: MessageRecord; created: boolean }> {
    const chatKey = makeChatKey(input.kind, input.chatId);
    const receivedAt = input.receivedAt ?? Date.now();

    return this.#database.writeTx(async (trx) => {
      const existing = await trx
        .selectFrom("messages")
        .selectAll()
        .where("chat_key", "=", chatKey)
        .where("onebot_message_id", "=", input.onebotMessageId)
        .executeTakeFirst();

      if (existing) {
        return { message: decodeMessage(existing), created: false };
      }

      let quotedBot = false;

      if (input.replyToMessageId) {
        const quoted = await trx
          .selectFrom("messages")
          .select(["is_bot"])
          .where("chat_key", "=", chatKey)
          .where("onebot_message_id", "=", input.replyToMessageId)
          .executeTakeFirst();

        quotedBot = Boolean(quoted?.is_bot);
      }

      const row = await trx
        .insertInto("messages")
        .values({
          chat_key: chatKey,
          kind: input.kind,
          chat_id: input.chatId,
          onebot_message_id: input.onebotMessageId,
          user_id: input.userId,
          sender_name: input.senderName,
          text: input.text,
          segments_json: JSON.stringify(input.segments),
          reply_to_message_id: input.replyToMessageId,
          is_bot: Number(input.isBot),
          mentioned_bot: Number(input.mentionedBot),
          quoted_bot: Number(quotedBot),
          recalled_at: null,
          sent_at: input.sentAt,
          received_at: receivedAt,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      return { message: decodeMessage(row), created: true };
    });
  }

  public async get(id: number): Promise<MessageRecord | null> {
    const row = await this.#database.db
      .selectFrom("messages")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();

    return row ? decodeMessage(row) : null;
  }

  public async getByIds(ids: number[]): Promise<MessageRecord[]> {
    if (ids.length === 0) {
      return [];
    }

    const rows = await this.#database.db
      .selectFrom("messages")
      .selectAll()
      .where("id", "in", ids)
      .orderBy("sent_at", "asc")
      .orderBy("id", "asc")
      .execute();

    return rows.map(decodeMessage);
  }

  public async oldest(chatKey: string): Promise<MessageRecord | null> {
    const row = await this.#database.db
      .selectFrom("messages")
      .selectAll()
      .where("chat_key", "=", chatKey)
      .orderBy("sent_at", "asc")
      .orderBy("id", "asc")
      .limit(1)
      .executeTakeFirst();

    return row ? decodeMessage(row) : null;
  }

  public async findByOnebotId(
    chatKey: string,
    onebotMessageId: string,
  ): Promise<MessageRecord | null> {
    const row = await this.#database.db
      .selectFrom("messages")
      .selectAll()
      .where("chat_key", "=", chatKey)
      .where("onebot_message_id", "=", onebotMessageId)
      .executeTakeFirst();

    return row ? decodeMessage(row) : null;
  }

  public async markRecalled(
    chatKey: string,
    onebotMessageId: string,
    recalledAt: number,
  ): Promise<void> {
    await this.#database.writeTx(async (trx) => {
      await trx
        .updateTable("messages")
        .set({ recalled_at: recalledAt })
        .where("chat_key", "=", chatKey)
        .where("onebot_message_id", "=", onebotMessageId)
        .execute();
    });
  }

  public async recent(
    chatKey: string,
    limit: number,
    options: {
      beforeId?: number;
      afterId?: number;
      includeRecalled?: boolean;
    } = {},
  ): Promise<MessageRecord[]> {
    let query = this.#database.db
      .selectFrom("messages")
      .selectAll()
      .where("chat_key", "=", chatKey);

    if (!options.includeRecalled) {
      query = query.where("recalled_at", "is", null);
    }

    if (options.beforeId !== undefined) {
      const anchor = await this.get(options.beforeId);

      query = anchor
        ? query.where((eb) =>
            eb.or([
              eb("sent_at", "<", anchor.sentAt),
              eb.and([
                eb("sent_at", "=", anchor.sentAt),
                eb("id", "<", anchor.id),
              ]),
            ]),
          )
        : query.where("id", "<", options.beforeId);
    }

    if (options.afterId !== undefined && options.afterId > 0) {
      const anchor = await this.get(options.afterId);

      query = anchor
        ? query.where((eb) =>
            eb.or([
              eb("sent_at", ">", anchor.sentAt),
              eb.and([
                eb("sent_at", "=", anchor.sentAt),
                eb("id", ">", anchor.id),
              ]),
            ]),
          )
        : query.where("id", ">", options.afterId);
    }

    const rows = await query
      .orderBy("sent_at", "desc")
      .orderBy("id", "desc")
      .limit(Math.max(1, limit))
      .execute();

    return rows.reverse().map(decodeMessage);
  }

  public async maxId(): Promise<number> {
    const row = await this.#database.db
      .selectFrom("messages")
      .select(sql<number>`coalesce(max(id), 0)`.as("max_id"))
      .executeTakeFirstOrThrow();

    return Number(row.max_id);
  }

  public async search(
    chatKey: string,
    options: {
      query?: string;
      startTimeMs?: number;
      endTimeMs?: number;
      limit?: number;
      beforeId?: number;
    } = {},
  ): Promise<MessageRecord[]> {
    let q = this.#database.db
      .selectFrom("messages")
      .selectAll()
      .where("chat_key", "=", chatKey)
      .where("recalled_at", "is", null);

    if (options.beforeId !== undefined) {
      const anchor = await this.get(options.beforeId);

      q = anchor
        ? q.where((eb) =>
            eb.or([
              eb("sent_at", "<", anchor.sentAt),
              eb.and([
                eb("sent_at", "=", anchor.sentAt),
                eb("id", "<", anchor.id),
              ]),
            ]),
          )
        : q.where("id", "<", options.beforeId);
    }

    if (options.startTimeMs !== undefined) {
      q = q.where("sent_at", ">=", options.startTimeMs);
    }

    if (options.endTimeMs !== undefined) {
      q = q.where("sent_at", "<", options.endTimeMs);
    }

    if (options.query) {
      const needle = options.query;

      q = q.where((eb) =>
        eb.or([
          eb(sql<number>`contains_text(text, ${needle})`, "=", 1),
          eb(sql<number>`contains_text(sender_name, ${needle})`, "=", 1),
        ]),
      );
    }

    const rows = await q
      .orderBy("sent_at", "desc")
      .orderBy("id", "desc")
      .limit(Math.min(500, Math.max(1, options.limit ?? 80)))
      .execute();

    return rows.reverse().map(decodeMessage);
  }

  public async listKnownUsers(
    limit = 300,
  ): Promise<{ userId: string; name: string }[]> {
    const capped = Math.min(500, Math.max(1, limit));
    const res = await sql<{ user_id: string; sender_name: string }>`
      select m.user_id, m.sender_name
      from messages m
      inner join (
        select user_id, max(id) as max_id
        from messages
        where is_bot = 0 and user_id != ''
        group by user_id
      ) latest on m.id = latest.max_id
      order by m.sent_at desc, m.id desc
      limit ${capped}
    `.execute(this.#database.db);

    return res.rows.map((row) => ({
      userId: row.user_id,
      name: row.sender_name.trim(),
    }));
  }
}
