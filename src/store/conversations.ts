import { randomUUID } from "node:crypto";

import type { Selectable } from "kysely";
import type { ChatCompletionMessageFunctionToolCall } from "openai/resources/chat/completions";

import type {
  ConversationRecord,
  OutputResult,
  TurnMessage,
} from "../types.ts";
import { GLOBAL_CONVERSATION_KEY } from "../types.ts";
import type { EventBus } from "../utils/logger.ts";
import type { BerryDatabase } from "./database.ts";
import type { BerryDb, BerryTables } from "./schema.ts";

function decodeTurnMessages(rawJson: string): TurnMessage[] {
  const raw = JSON.parse(rawJson) as unknown[];
  const out: TurnMessage[] = [];

  for (const entry of raw) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    const item = entry as Record<string, unknown>;

    switch (item.role) {
      case "user": {
        out.push({ role: "user", content: String(item.content ?? "") });

        break;
      }

      case "assistant": {
        const toolCalls = Array.isArray(item.tool_calls)
          ? (item.tool_calls as ChatCompletionMessageFunctionToolCall[])
          : undefined;

        out.push({
          role: "assistant",
          content: typeof item.content === "string" ? item.content : null,
          ...(toolCalls?.length ? { tool_calls: toolCalls } : {}),
        });

        break;
      }

      case "tool": {
        out.push({
          role: "tool",
          tool_call_id: String(item.tool_call_id ?? ""),
          content: String(item.content ?? ""),
        });

        break;
      }
    }
  }

  return out;
}

const decodeConversation = (
  row: Selectable<BerryTables["conversations"]>,
): ConversationRecord => ({
  chatKey: row.chat_key,
  sessionId: row.session_id,
  summary: row.summary,
  messages: decodeTurnMessages(row.messages_json),
  pendingResults: JSON.parse(row.pending_results_json) as OutputResult[],
  afterMessageId: row.after_message_id,
  updatedAt: row.updated_at,
});

export class ConversationsStore {
  #database: BerryDatabase;
  #events?: EventBus;

  constructor(database: BerryDatabase, events?: EventBus) {
    this.#database = database;
    this.#events = events;
  }

  public async open(): Promise<ConversationRecord> {
    const now = Date.now();

    return this.#database.writeTx(async (trx) => {
      await this.#ensureRow(trx, now);

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
      await this.#ensureRow(trx, now);

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

    const updated = await this.#database.writeTx(async (trx) => {
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
        ...decodeTurnMessages(row.messages_json),
        ...turnMessages,
      ];

      const saved = await trx
        .updateTable("conversations")
        .set({
          messages_json: JSON.stringify(nextMessages),
          updated_at: now,
        })
        .where("chat_key", "=", GLOBAL_CONVERSATION_KEY)
        .where("session_id", "=", sessionId)
        .returningAll()
        .executeTakeFirstOrThrow();

      return decodeConversation(saved);
    });

    if (updated) {
      this.#events?.emit({
        type: "conversation_update",
        data: { sessionId: updated.sessionId },
      });
    }

    return updated;
  }

  public async compact(
    sessionId: string,
    expectedSummary: string,
    consumedCount: number,
    newSummary: string,
  ): Promise<boolean> {
    const now = Date.now();

    const compacted = await this.#database.writeTx(async (trx) => {
      const row = await trx
        .selectFrom("conversations")
        .selectAll()
        .where("chat_key", "=", GLOBAL_CONVERSATION_KEY)
        .where("session_id", "=", sessionId)
        .executeTakeFirst();

      if (row?.summary !== expectedSummary) {
        return false;
      }

      const current = decodeTurnMessages(row.messages_json);

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

    if (compacted) {
      this.#events?.emit({
        type: "conversation_update",
        data: { sessionId },
      });
    }

    return compacted;
  }

  public async reset(afterMessageId = 0): Promise<ConversationRecord> {
    const now = Date.now();

    const record = await this.#database.writeTx(async (trx) => {
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

    this.#events?.emit({
      type: "conversation_update",
      data: { sessionId: record.sessionId },
    });

    return record;
  }

  async #ensureRow(trx: BerryDb, now: number): Promise<void> {
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
  }
}
