import type { Selectable } from "kysely";

import type { MemberImpressionRecord } from "../types.ts";
import type { BerryDatabase } from "./database.ts";
import type { BerryTables } from "./schema.ts";

const decodeImpression = (
  row: Selectable<BerryTables["member_impressions"]>,
): MemberImpressionRecord => ({
  userId: row.user_id,
  displayName: row.display_name,
  impression: row.impression,
  source: row.source === "auto" ? "auto" : "manual",
  locked: Boolean(row.locked),
  updatedAt: row.updated_at,
});

export class ImpressionsStore {
  #database: BerryDatabase;

  constructor(database: BerryDatabase) {
    this.#database = database;
  }

  public async list(filters?: {
    search?: string;
  }): Promise<MemberImpressionRecord[]> {
    const rows = await this.#database.db
      .selectFrom("member_impressions")
      .selectAll()
      .orderBy("updated_at", "desc")
      .execute();
    const decoded = rows.map(decodeImpression);
    const kw = filters?.search?.trim().toLowerCase() ?? "";

    if (!kw) {
      return decoded;
    }

    return decoded.filter(
      (item) =>
        item.userId.includes(kw) ||
        item.displayName.toLowerCase().includes(kw) ||
        item.impression.toLowerCase().includes(kw),
    );
  }

  public async get(userId: string): Promise<MemberImpressionRecord | null> {
    const clean = userId.trim();

    if (!clean) {
      return null;
    }

    const row = await this.#database.db
      .selectFrom("member_impressions")
      .selectAll()
      .where("user_id", "=", clean)
      .executeTakeFirst();

    return row ? decodeImpression(row) : null;
  }

  public async getMany(
    userIds: readonly string[],
  ): Promise<Map<string, MemberImpressionRecord>> {
    const unique = [...new Set(userIds.map((id) => id.trim()).filter(Boolean))];
    const map = new Map<string, MemberImpressionRecord>();

    if (unique.length === 0) {
      return map;
    }

    const rows = await this.#database.db
      .selectFrom("member_impressions")
      .selectAll()
      .where("user_id", "in", unique)
      .execute();

    for (const row of rows) {
      const decoded = decodeImpression(row);

      map.set(decoded.userId, decoded);
    }

    return map;
  }

  public async upsert(input: {
    userId: string;
    displayName?: string;
    impression: string;
    source?: "manual" | "auto";
    locked?: boolean;
  }): Promise<MemberImpressionRecord> {
    const userId = input.userId.trim();
    const impression = input.impression.trim().slice(0, 120);

    if (!userId || !impression) {
      throw new Error("成员 QQ 号和印象内容均不能为空");
    }

    const displayName = input.displayName?.trim().slice(0, 64) ?? "";
    const source = input.source ?? "manual";
    const locked = input.locked ?? source === "manual";
    const now = Date.now();

    return this.#database.writeTx(async (trx) => {
      const row = await trx
        .insertInto("member_impressions")
        .values({
          user_id: userId,
          display_name: displayName,
          impression,
          source,
          locked: Number(locked),
          updated_at: now,
        })
        .onConflict((oc) =>
          oc.column("user_id").doUpdateSet({
            ...(input.displayName === undefined
              ? {}
              : { display_name: displayName }),
            impression,
            source,
            locked: Number(locked),
            updated_at: now,
          }),
        )
        .returningAll()
        .executeTakeFirstOrThrow();

      return decodeImpression(row);
    });
  }

  public async remove(userId: string): Promise<boolean> {
    const clean = userId.trim();

    if (!clean) {
      return false;
    }

    return this.#database.writeTx(async (trx) => {
      const res = await trx
        .deleteFrom("member_impressions")
        .where("user_id", "=", clean)
        .executeTakeFirst();

      return Number(res.numDeletedRows) > 0;
    });
  }
}
