import { randomUUID } from "node:crypto";

import type { Selectable } from "kysely";

import type {
  ConversationRecord,
  OutputResult,
  TurnMessage,
} from "../types.ts";
import { GLOBAL_CONVERSATION_KEY } from "../types.ts";
import type { BerryDatabase } from "./database.ts";
import type { BerryTables } from "./schema.ts";

const decodeConversation = (
  row: Selectable<BerryTables["conversations"]>,
): ConversationRecord => ({
  chatKey: row.chat_key,
  sessionId: row.session_id,
  summary: row.summary,
  messages: JSON.parse(row.messages_json) as TurnMessage[],
  pendingResults: JSON.parse(row.pending_results_json) as OutputResult[],
  afterMessageId: row.after_message_id,
  updatedAt: row.updated_at,
});

export class ConversationsStore {
  #database: BerryDatabase;

  constructor(database: BerryDatabase) {
    this.#database = database;
  }

  public async open(): Promise<ConversationRecord> {
    const now = Date.now();

    return this.#database.writeTx(async (trx) => {
      await trx
        .insertInto("conversations")
        .values({
          chat_key: GLOBAL_CONVERSATION_KEY,
          session_id: randomUUID(),
          summary: "",
          messages_json: "[]",
          pending_results_json: "[]",
          after_message_id: 0,
          updated_at: now,
        })
        .onConflict((oc) => oc.column("chat_key").doNothing())
        .execute();

      const row = await trx
        .selectFrom("conversations")
        .selectAll()
        .where("chat_key", "=", GLOBAL_CONVERSATION_KEY)
        .executeTakeFirstOrThrow();

      return decodeConversation(row);
    });
  }

  public async get(): Promise<ConversationRecord | null> {
    const row = await this.#database.db
      .selectFrom("conversations")
      .selectAll()
      .where("chat_key", "=", GLOBAL_CONVERSATION_KEY)
      .executeTakeFirst();

    return row ? decodeConversation(row) : null;
  }

  public async pushOutputResult(result: OutputResult): Promise<void> {
    const now = Date.now();

    await this.#database.writeTx(async (trx) => {
      await trx
        .insertInto("conversations")
        .values({
          chat_key: GLOBAL_CONVERSATION_KEY,
          session_id: randomUUID(),
          summary: "",
          messages_json: "[]",
          pending_results_json: "[]",
          after_message_id: 0,
          updated_at: now,
        })
        .onConflict((oc) => oc.column("chat_key").doNothing())
        .execute();

      const row = await trx
        .selectFrom("conversations")
        .select(["pending_results_json"])
        .where("chat_key", "=", GLOBAL_CONVERSATION_KEY)
        .executeTakeFirstOrThrow();

      const pending = JSON.parse(row.pending_results_json) as OutputResult[];

      pending.push(result);

      await trx
        .updateTable("conversations")
        .set({
          pending_results_json: JSON.stringify(pending.slice(-200)),
          updated_at: now,
        })
        .where("chat_key", "=", GLOBAL_CONVERSATION_KEY)
        .execute();
    });
  }

  // One-shot drain at the start of an invocation (ADR-0002 / ADR-0014).
  public async drainPendingResults(): Promise<OutputResult[]> {
    const now = Date.now();

    return this.#database.writeTx(async (trx) => {
      const row = await trx
        .selectFrom("conversations")
        .select(["pending_results_json"])
        .where("chat_key", "=", GLOBAL_CONVERSATION_KEY)
        .executeTakeFirst();

      if (!row) {
        return [];
      }

      const pending = JSON.parse(row.pending_results_json) as OutputResult[];

      if (pending.length === 0) {
        return [];
      }

      await trx
        .updateTable("conversations")
        .set({ pending_results_json: "[]", updated_at: now })
        .where("chat_key", "=", GLOBAL_CONVERSATION_KEY)
        .execute();

      return pending;
    });
  }

  public async appendTurn(
    sessionId: string,
    turnMessages: TurnMessage[],
  ): Promise<ConversationRecord | null> {
    if (turnMessages.length === 0) {
      return this.get();
    }

    const now = Date.now();

    return this.#database.writeTx(async (trx) => {
      const row = await trx
        .selectFrom("conversations")
        .selectAll()
        .where("chat_key", "=", GLOBAL_CONVERSATION_KEY)
        .where("session_id", "=", sessionId)
        .executeTakeFirst();

      if (!row) {
        return null;
      }

      const nextMessages = [
        ...(JSON.parse(row.messages_json) as TurnMessage[]),
        ...turnMessages,
      ];

      const updated = await trx
        .updateTable("conversations")
        .set({
          messages_json: JSON.stringify(nextMessages),
          updated_at: now,
        })
        .where("chat_key", "=", GLOBAL_CONVERSATION_KEY)
        .where("session_id", "=", sessionId)
        .returningAll()
        .executeTakeFirstOrThrow();

      return decodeConversation(updated);
    });
  }

  public async compact(
    sessionId: string,
    expectedSummary: string,
    consumedCount: number,
    newSummary: string,
  ): Promise<boolean> {
    const now = Date.now();

    return this.#database.writeTx(async (trx) => {
      const row = await trx
        .selectFrom("conversations")
        .selectAll()
        .where("chat_key", "=", GLOBAL_CONVERSATION_KEY)
        .where("session_id", "=", sessionId)
        .executeTakeFirst();

      if (row?.summary !== expectedSummary) {
        return false;
      }

      const current = JSON.parse(row.messages_json) as TurnMessage[];

      if (consumedCount <= 0 || consumedCount > current.length) {
        return false;
      }

      const retained = current.slice(consumedCount);

      await trx
        .updateTable("conversations")
        .set({
          summary: newSummary,
          messages_json: JSON.stringify(retained),
          updated_at: now,
        })
        .where("chat_key", "=", GLOBAL_CONVERSATION_KEY)
        .where("session_id", "=", sessionId)
        .execute();

      return true;
    });
  }

  public async reset(afterMessageId = 0): Promise<ConversationRecord> {
    const now = Date.now();

    return this.#database.writeTx(async (trx) => {
      const values = {
        chat_key: GLOBAL_CONVERSATION_KEY,
        session_id: randomUUID(),
        summary: "",
        messages_json: "[]",
        pending_results_json: "[]",
        after_message_id: afterMessageId,
        updated_at: now,
      };

      const row = await trx
        .insertInto("conversations")
        .values(values)
        .onConflict((oc) => oc.column("chat_key").doUpdateSet(values))
        .returningAll()
        .executeTakeFirstOrThrow();

      return decodeConversation(row);
    });
  }
}
