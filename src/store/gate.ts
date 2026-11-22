import { sql } from "kysely";

import type { GateAction, GateDecisionRecord, GateStage } from "../types.ts";
import type { EventBus } from "../utils/logger.ts";
import type { BerryDatabase } from "./database.ts";
import type { BerryDb } from "./schema.ts";

const baseGateQuery = (db: BerryDb) =>
  db
    .selectFrom("gate_decisions")
    .leftJoin("messages", "messages.id", "gate_decisions.message_id");

export interface GateDecisionView extends GateDecisionRecord {
  senderName: string | null;
  userId: string | null;
  messageText: string | null;
}

export class GateDecisionsStore {
  #database: BerryDatabase;
  #events: EventBus;

  constructor(database: BerryDatabase, events: EventBus) {
    this.#database = database;
    this.#events = events;
  }

  public async record(input: {
    chatKey: string;
    messageId: number | null;
    action: GateAction;
    stage: GateStage;
    confidence: number;
    reason: string;
    model: string;
    durationMs: number;
    createdAt?: number;
  }): Promise<GateDecisionRecord> {
    const createdAt = input.createdAt ?? Date.now();
    const row = await this.#database.writeTx((trx) =>
      trx
        .insertInto("gate_decisions")
        .values({
          chat_key: input.chatKey,
          message_id: input.messageId,
          action: input.action,
          stage: input.stage,
          confidence: input.confidence,
          reason: input.reason,
          model: input.model,
          duration_ms: input.durationMs,
          created_at: createdAt,
        })
        .returningAll()
        .executeTakeFirstOrThrow(),
    );

    const decision: GateDecisionRecord = {
      id: row.id,
      chatKey: row.chat_key,
      messageId: row.message_id,
      action: row.action as GateAction,
      stage: row.stage as GateStage,
      confidence: row.confidence,
      reason: row.reason,
      model: row.model,
      durationMs: row.duration_ms,
      createdAt: row.created_at,
    };

    this.#events.emit({ type: "gate_decision", data: decision });

    return decision;
  }

  public async list(
    filters: {
      action?: GateAction;
      stage?: GateStage;
      chatKey?: string;
      search?: string;
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<{ items: GateDecisionView[]; total: number }> {
    function applyFilters<T extends ReturnType<typeof baseGateQuery>>(q: T) {
      let query = q;

      if (filters.action) {
        query = query.where("gate_decisions.action", "=", filters.action) as T;
      }

      if (filters.stage) {
        query = query.where("gate_decisions.stage", "=", filters.stage) as T;
      }

      if (filters.chatKey) {
        query = query.where(
          "gate_decisions.chat_key",
          "=",
          filters.chatKey,
        ) as T;
      }

      if (filters.search) {
        const needle = filters.search;

        query = query.where((eb) =>
          eb.or([
            eb(
              sql<number>`contains_text(gate_decisions.reason, ${needle})`,
              "=",
              1,
            ),
            eb(
              sql<number>`contains_text(coalesce(messages.text, ''), ${needle})`,
              "=",
              1,
            ),
            eb(
              sql<number>`contains_text(coalesce(messages.sender_name, ''), ${needle})`,
              "=",
              1,
            ),
          ]),
        ) as T;
      }

      return query;
    }

    const limit = Math.min(200, Math.max(1, filters.limit ?? 50));
    const offset = Math.max(0, filters.offset ?? 0);

    const [rows, countRow] = await Promise.all([
      applyFilters(baseGateQuery(this.#database.db))
        .select([
          "gate_decisions.id",
          "gate_decisions.chat_key",
          "gate_decisions.message_id",
          "gate_decisions.action",
          "gate_decisions.stage",
          "gate_decisions.confidence",
          "gate_decisions.reason",
          "gate_decisions.model",
          "gate_decisions.duration_ms",
          "gate_decisions.created_at",
          "messages.sender_name",
          "messages.user_id",
          "messages.text as message_text",
        ])
        .orderBy("gate_decisions.id", "desc")
        .limit(limit)
        .offset(offset)
        .execute(),
      applyFilters(baseGateQuery(this.#database.db))
        .select(sql<number>`count(*)`.as("total"))
        .executeTakeFirstOrThrow(),
    ]);

    return {
      items: rows.map((row) => ({
        id: row.id,
        chatKey: row.chat_key,
        messageId: row.message_id,
        action: row.action as GateAction,
        stage: row.stage as GateStage,
        confidence: row.confidence,
        reason: row.reason,
        model: row.model,
        durationMs: row.duration_ms,
        createdAt: row.created_at,
        senderName: row.sender_name ?? null,
        userId: row.user_id ?? null,
        messageText: row.message_text ?? null,
      })),
      total: Number(countRow.total),
    };
  }

  public async summarySince(sinceMs: number): Promise<{
    reply: number;
    memory: number;
    ignore: number;
  }> {
    const rows = await this.#database.db
      .selectFrom("gate_decisions")
      .select(["action", sql<number>`count(*)`.as("count")])
      .where("created_at", ">=", sinceMs)
      .where("stage", "!=", "dry_run")
      .groupBy("action")
      .execute();

    const summary = { reply: 0, memory: 0, ignore: 0 };

    for (const row of rows) {
      if (
        row.action === "reply" ||
        row.action === "memory" ||
        row.action === "ignore"
      ) {
        summary[row.action] = Number(row.count);
      }
    }

    return summary;
  }

  public async listByMessageIds(
    messageIds: number[],
  ): Promise<Map<number, GateDecisionRecord[]>> {
    const unique = [
      ...new Set(messageIds.filter((id) => Number.isInteger(id) && id > 0)),
    ];
    const map = new Map<number, GateDecisionRecord[]>();

    if (unique.length === 0) {
      return map;
    }

    const rows = await this.#database.db
      .selectFrom("gate_decisions")
      .selectAll()
      .where("message_id", "in", unique)
      .orderBy("created_at", "asc")
      .orderBy("id", "asc")
      .execute();

    for (const row of rows) {
      if (row.message_id === null) {
        continue;
      }

      const item: GateDecisionRecord = {
        id: row.id,
        chatKey: row.chat_key,
        messageId: row.message_id,
        action: row.action as GateAction,
        stage: row.stage as GateStage,
        confidence: row.confidence,
        reason: row.reason,
        model: row.model,
        durationMs: row.duration_ms,
        createdAt: row.created_at,
      };
      const list = map.get(row.message_id);

      if (list) {
        list.push(item);
      } else {
        map.set(row.message_id, [item]);
      }
    }

    return map;
  }
}
