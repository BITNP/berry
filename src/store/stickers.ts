import type { Selectable } from "kysely";

import type { StickerRecord, StickerStatus } from "../types.ts";
import type { BerryDatabase } from "./database.ts";
import type { BerryTables } from "./schema.ts";

function decodeSticker(
  row: Selectable<BerryTables["stickers"]>,
): StickerRecord {
  let tags: string[] = [];

  try {
    const parsed = JSON.parse(row.tags_json) as unknown;

    if (Array.isArray(parsed)) {
      tags = parsed
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean);
    }
  } catch {
    tags = [];
  }

  return {
    id: row.id,
    sha256: row.sha256,
    filePath: row.file_path,
    mimeType: row.mime_type,
    meaning: row.meaning,
    tags,
    sourceChatKey: row.source_chat_key,
    status: row.status as StickerStatus,
    enabled: Boolean(row.enabled),
    useCount: row.use_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeTags(tags?: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const raw of tags ?? []) {
    const clean = raw.trim().slice(0, 24);

    if (clean && !seen.has(clean.toLowerCase())) {
      seen.add(clean.toLowerCase());
      out.push(clean);
    }
  }

  return out.slice(0, 12);
}

export class StickersStore {
  #database: BerryDatabase;

  constructor(database: BerryDatabase) {
    this.#database = database;
  }

  public async count(): Promise<number> {
    const row = await this.#database.db
      .selectFrom("stickers")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .executeTakeFirst();

    return Number(row?.count ?? 0);
  }

  public async get(id: number): Promise<StickerRecord | null> {
    const row = await this.#database.db
      .selectFrom("stickers")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();

    return row ? decodeSticker(row) : null;
  }

  public async getBySha256(sha256: string): Promise<StickerRecord | null> {
    const row = await this.#database.db
      .selectFrom("stickers")
      .selectAll()
      .where("sha256", "=", sha256)
      .executeTakeFirst();

    return row ? decodeSticker(row) : null;
  }

  public async list(filters?: {
    status?: StickerStatus;
    enabled?: boolean;
    search?: string;
  }): Promise<StickerRecord[]> {
    let query = this.#database.db.selectFrom("stickers").selectAll();

    if (filters?.status) {
      query = query.where("status", "=", filters.status);
    }

    if (filters?.enabled !== undefined) {
      query = query.where("enabled", "=", Number(filters.enabled));
    }

    const rows = await query
      .orderBy("status", "desc")
      .orderBy("updated_at", "desc")
      .execute();
    const decoded = rows.map(decodeSticker);
    const kw = filters?.search?.trim().toLowerCase() ?? "";

    if (!kw) {
      return decoded;
    }

    return decoded.filter(
      (item) =>
        item.meaning.toLowerCase().includes(kw) ||
        item.tags.some((t) => t.toLowerCase().includes(kw)),
    );
  }

  public async collectIfAbsent(input: {
    sha256: string;
    filePath: string;
    mimeType: string;
    meaning: string;
    tags: string[];
    sourceChatKey: string;
    status: StickerStatus;
    enabled?: boolean;
  }): Promise<{ record: StickerRecord; created: boolean }> {
    const existing = await this.getBySha256(input.sha256);

    if (existing) {
      return { record: existing, created: false };
    }

    const now = Date.now();
    const record = await this.#database.writeTx(async (trx) => {
      const row = await trx
        .insertInto("stickers")
        .values({
          sha256: input.sha256,
          file_path: input.filePath,
          mime_type: input.mimeType,
          meaning: input.meaning.trim().slice(0, 200),
          tags_json: JSON.stringify(normalizeTags(input.tags)),
          source_chat_key: input.sourceChatKey,
          status: input.status,
          enabled: Number(input.enabled ?? true),
          use_count: 0,
          created_at: now,
          updated_at: now,
        })
        .onConflict((oc) => oc.column("sha256").doNothing())
        .returningAll()
        .executeTakeFirst();

      if (row) {
        return decodeSticker(row);
      }

      const fallback = await trx
        .selectFrom("stickers")
        .selectAll()
        .where("sha256", "=", input.sha256)
        .executeTakeFirstOrThrow();

      return decodeSticker(fallback);
    });

    return { record, created: true };
  }

  public async update(
    id: number,
    patch: {
      meaning?: string;
      tags?: string[];
      status?: StickerStatus;
      enabled?: boolean;
    },
  ): Promise<StickerRecord | null> {
    const existing = await this.get(id);

    if (!existing) {
      return null;
    }

    const now = Date.now();

    return this.#database.writeTx(async (trx) => {
      const row = await trx
        .updateTable("stickers")
        .set({
          ...(patch.meaning === undefined
            ? {}
            : { meaning: patch.meaning.trim().slice(0, 200) }),
          ...(patch.tags === undefined
            ? {}
            : { tags_json: JSON.stringify(normalizeTags(patch.tags)) }),
          ...(patch.status === undefined ? {} : { status: patch.status }),
          ...(patch.enabled === undefined
            ? {}
            : { enabled: Number(patch.enabled) }),
          updated_at: now,
        })
        .where("id", "=", id)
        .returningAll()
        .executeTakeFirst();

      return row ? decodeSticker(row) : null;
    });
  }

  public async recordUsage(id: number): Promise<void> {
    const now = Date.now();

    await this.#database.writeTx(async (trx) => {
      await trx
        .updateTable("stickers")
        .set((eb) => ({
          use_count: eb("use_count", "+", 1),
          updated_at: now,
        }))
        .where("id", "=", id)
        .execute();
    });
  }

  public async remove(id: number): Promise<boolean> {
    return this.#database.writeTx(async (trx) => {
      const res = await trx
        .deleteFrom("stickers")
        .where("id", "=", id)
        .executeTakeFirst();

      return Number(res.numDeletedRows) > 0;
    });
  }

  public async searchApproved(
    query = "",
    limit = 6,
  ): Promise<{ total: number; items: StickerRecord[] }> {
    const rows = await this.#database.db
      .selectFrom("stickers")
      .selectAll()
      .where("status", "=", "approved")
      .where("enabled", "=", 1)
      .orderBy("use_count", "asc")
      .orderBy("updated_at", "desc")
      .execute();
    const all = rows.map(decodeSticker);
    const tokens = query
      .trim()
      .toLowerCase()
      .split(/[\s,，、/|]+/)
      .filter(Boolean);

    if (tokens.length === 0) {
      return {
        total: all.length,
        items: all.slice(0, Math.min(12, Math.max(1, limit))),
      };
    }

    const scored = all
      .map((item) => {
        const tagText = item.tags.join(" ").toLowerCase();
        const meaningText = item.meaning.toLowerCase();
        let score = 0;

        for (const token of tokens) {
          if (item.tags.some((t) => t.toLowerCase() === token)) {
            score += 4;
          } else if (tagText.includes(token)) {
            score += 2;
          }

          if (meaningText.includes(token)) {
            score += 2;
          }
        }

        return { item, score };
      })
      .filter((entry) => entry.score > 0)
      .sort(
        (a, b) =>
          b.score - a.score ||
          a.item.useCount - b.item.useCount ||
          b.item.updatedAt - a.item.updatedAt,
      );

    return {
      total: scored.length,
      items: scored
        .slice(0, Math.min(12, Math.max(1, limit)))
        .map((e) => e.item),
    };
  }
}
