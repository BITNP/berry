import type { Selectable } from "kysely";

import type { MemoryRecord, MemoryScope } from "../types.ts";
import type { EventBus } from "../utils/logger.ts";
import type { BerryDatabase } from "./database.ts";
import type { BerryTables } from "./schema.ts";

const decodeMemory = (
  row: Selectable<BerryTables["memories"]>,
): MemoryRecord => ({
  id: row.id,
  scope: row.scope as MemoryScope,
  ownerId: row.owner_id,
  key: row.key,
  summary: row.summary,
  content: row.content,
  sourceMessageId: row.source_message_id,
  updatedAt: row.updated_at,
});

const normalizeOwner = (scope: MemoryScope, ownerId: string): string =>
  scope === "global" ? "global" : ownerId;

export class MemoriesStore {
  #database: BerryDatabase;
  #events?: EventBus;

  constructor(database: BerryDatabase, events?: EventBus) {
    this.#database = database;
    this.#events = events;
  }

  public async index(
    chatKey: string,
    userId?: string,
  ): Promise<{
    global: { key: string; summary: string }[];
    chat: { key: string; summary: string }[];
    user: { key: string; summary: string }[];
  }> {
    const db = this.#database.db;
    const [global, chat, user] = await Promise.all([
      db
        .selectFrom("memories")
        .select(["key", "summary"])
        .where("scope", "=", "global")
        .where("owner_id", "=", "global")
        .orderBy("updated_at", "desc")
        .execute(),
      db
        .selectFrom("memories")
        .select(["key", "summary"])
        .where("scope", "=", "chat")
        .where("owner_id", "=", chatKey)
        .orderBy("updated_at", "desc")
        .execute(),
      userId
        ? db
            .selectFrom("memories")
            .select(["key", "summary"])
            .where("scope", "=", "user")
            .where("owner_id", "=", userId)
            .orderBy("updated_at", "desc")
            .execute()
        : Promise.resolve([]),
    ]);

    return { global, chat, user };
  }

  public async get(
    scope: MemoryScope,
    ownerId: string,
    key: string,
  ): Promise<MemoryRecord | null> {
    const normalizedOwner = normalizeOwner(scope, ownerId);
    const row = await this.#database.db
      .selectFrom("memories")
      .selectAll()
      .where("scope", "=", scope)
      .where("owner_id", "=", normalizedOwner)
      .where("key", "=", key)
      .executeTakeFirst();

    return row ? decodeMemory(row) : null;
  }

  public async list(filters?: {
    scope?: MemoryScope;
    ownerId?: string;
  }): Promise<MemoryRecord[]> {
    let query = this.#database.db.selectFrom("memories").selectAll();

    if (filters?.scope) {
      query = query.where("scope", "=", filters.scope);
    }

    if (filters?.ownerId) {
      query = query.where("owner_id", "=", filters.ownerId);
    }

    const rows = await query.orderBy("updated_at", "desc").execute();

    return rows.map(decodeMemory);
  }

  public async upsert(input: {
    scope: MemoryScope;
    ownerId: string;
    key: string;
    summary: string;
    content: string;
    sourceMessageId?: number | null;
  }): Promise<MemoryRecord> {
    const now = Date.now();
    const ownerId = normalizeOwner(input.scope, input.ownerId);

    const record = await this.#database.writeTx(async (trx) => {
      const row = await trx
        .insertInto("memories")
        .values({
          scope: input.scope,
          owner_id: ownerId,
          key: input.key,
          summary: input.summary,
          content: input.content,
          source_message_id: input.sourceMessageId ?? null,
          updated_at: now,
        })
        .onConflict((oc) =>
          oc.columns(["scope", "owner_id", "key"]).doUpdateSet({
            summary: input.summary,
            content: input.content,
            source_message_id: input.sourceMessageId ?? null,
            updated_at: now,
          }),
        )
        .returningAll()
        .executeTakeFirstOrThrow();

      return decodeMemory(row);
    });

    this.#events?.emit({
      type: "memory_update",
      data: { scope: record.scope, ownerId: record.ownerId, key: record.key },
    });

    return record;
  }

  public async remove(
    scope: MemoryScope,
    ownerId: string,
    key: string,
  ): Promise<boolean> {
    const normalizedOwner = normalizeOwner(scope, ownerId);

    const deleted = await this.#database.writeTx(async (trx) => {
      const res = await trx
        .deleteFrom("memories")
        .where("scope", "=", scope)
        .where("owner_id", "=", normalizedOwner)
        .where("key", "=", key)
        .executeTakeFirst();

      return Number(res.numDeletedRows) > 0;
    });

    if (deleted) {
      this.#events?.emit({
        type: "memory_update",
        data: { scope, ownerId: normalizedOwner, key },
      });
    }

    return deleted;
  }
}
