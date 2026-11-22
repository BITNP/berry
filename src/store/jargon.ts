import type { Selectable } from "kysely";

import type { JargonRecord, JargonStatus } from "../types.ts";
import type { BerryDatabase } from "./database.ts";
import type { BerryTables } from "./schema.ts";

function decodeJargon(
  row: Selectable<BerryTables["jargon_entries"]>,
): JargonRecord {
  let aliases: string[] = [];

  try {
    const parsed = JSON.parse(row.aliases_json) as unknown;

    if (Array.isArray(parsed)) {
      aliases = parsed
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean);
    }
  } catch {
    aliases = [];
  }

  return {
    id: row.id,
    chatKey: row.chat_key,
    term: row.term,
    aliases,
    meaning: row.meaning,
    status: row.status as JargonStatus,
    source: row.source === "auto" ? "auto" : "manual",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeAliases(aliases?: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const raw of aliases ?? []) {
    const clean = raw.trim().slice(0, 40);

    if (clean && !seen.has(clean.toLowerCase())) {
      seen.add(clean.toLowerCase());
      out.push(clean);
    }
  }

  return out.slice(0, 12);
}

export class JargonStore {
  #database: BerryDatabase;

  constructor(database: BerryDatabase) {
    this.#database = database;
  }

  public async list(filters?: {
    chatKey?: string;
    status?: JargonStatus;
    search?: string;
  }): Promise<JargonRecord[]> {
    let query = this.#database.db.selectFrom("jargon_entries").selectAll();

    if (filters?.chatKey) {
      query = query.where("chat_key", "=", filters.chatKey);
    }

    if (filters?.status) {
      query = query.where("status", "=", filters.status);
    }

    const rows = await query
      .orderBy("status", "desc")
      .orderBy("updated_at", "desc")
      .execute();
    const decoded = rows.map(decodeJargon);
    const kw = filters?.search?.trim().toLowerCase() ?? "";

    if (!kw) {
      return decoded;
    }

    return decoded.filter(
      (item) =>
        item.term.toLowerCase().includes(kw) ||
        item.meaning.toLowerCase().includes(kw) ||
        item.aliases.some((alias) => alias.toLowerCase().includes(kw)),
    );
  }

  public async get(id: number): Promise<JargonRecord | null> {
    const row = await this.#database.db
      .selectFrom("jargon_entries")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();

    return row ? decodeJargon(row) : null;
  }

  public async upsert(input: {
    chatKey?: string;
    term: string;
    aliases?: string[];
    meaning: string;
    status?: JargonStatus;
    source?: "manual" | "auto";
  }): Promise<JargonRecord> {
    const chatKey = input.chatKey?.trim() || "global";
    const term = input.term.trim().slice(0, 48);
    const meaning = input.meaning.trim().slice(0, 240);

    if (!term || !meaning) {
      throw new Error("词条和释义均不能为空");
    }

    const aliases = normalizeAliases(input.aliases);
    const status: JargonStatus = input.status ?? "approved";
    const source = input.source ?? "manual";
    const now = Date.now();

    return this.#database.writeTx(async (trx) => {
      const row = await trx
        .insertInto("jargon_entries")
        .values({
          chat_key: chatKey,
          term,
          aliases_json: JSON.stringify(aliases),
          meaning,
          status,
          source,
          created_at: now,
          updated_at: now,
        })
        .onConflict((oc) =>
          oc.columns(["chat_key", "term"]).doUpdateSet({
            aliases_json: JSON.stringify(aliases),
            meaning,
            status,
            source,
            updated_at: now,
          }),
        )
        .returningAll()
        .executeTakeFirstOrThrow();

      return decodeJargon(row);
    });
  }

  public async insertIfAbsent(input: {
    chatKey?: string;
    term: string;
    aliases?: string[];
    meaning: string;
    status?: JargonStatus;
    source?: "manual" | "auto";
  }): Promise<boolean> {
    const chatKey = input.chatKey?.trim() || "global";
    const term = input.term.trim().slice(0, 48);
    const meaning = input.meaning.trim().slice(0, 240);

    if (!term || !meaning) {
      return false;
    }

    const aliases = normalizeAliases(input.aliases);
    const now = Date.now();

    return this.#database.writeTx(async (trx) => {
      const res = await trx
        .insertInto("jargon_entries")
        .values({
          chat_key: chatKey,
          term,
          aliases_json: JSON.stringify(aliases),
          meaning,
          status: input.status ?? "pending",
          source: input.source ?? "auto",
          created_at: now,
          updated_at: now,
        })
        .onConflict((oc) => oc.columns(["chat_key", "term"]).doNothing())
        .executeTakeFirst();

      return Number(res.numInsertedOrUpdatedRows ?? 0) > 0;
    });
  }

  public async update(
    id: number,
    patch: {
      chatKey?: string;
      term?: string;
      aliases?: string[];
      meaning?: string;
      status?: JargonStatus;
    },
  ): Promise<JargonRecord | null> {
    const existing = await this.get(id);

    if (!existing) {
      return null;
    }

    const now = Date.now();

    return this.#database.writeTx(async (trx) => {
      const row = await trx
        .updateTable("jargon_entries")
        .set({
          ...(patch.chatKey === undefined
            ? {}
            : { chat_key: patch.chatKey.trim() || "global" }),
          ...(patch.term === undefined
            ? {}
            : { term: patch.term.trim().slice(0, 48) }),
          ...(patch.aliases === undefined
            ? {}
            : {
                aliases_json: JSON.stringify(normalizeAliases(patch.aliases)),
              }),
          ...(patch.meaning === undefined
            ? {}
            : { meaning: patch.meaning.trim().slice(0, 240) }),
          ...(patch.status === undefined ? {} : { status: patch.status }),
          updated_at: now,
        })
        .where("id", "=", id)
        .returningAll()
        .executeTakeFirst();

      return row ? decodeJargon(row) : null;
    });
  }

  public async remove(id: number): Promise<boolean> {
    return this.#database.writeTx(async (trx) => {
      const res = await trx
        .deleteFrom("jargon_entries")
        .where("id", "=", id)
        .executeTakeFirst();

      return Number(res.numDeletedRows) > 0;
    });
  }

  public async matchInText(
    chatKey: string,
    text: string,
    limit = 8,
  ): Promise<{ term: string; meaning: string }[]> {
    const haystack = text.toLowerCase();

    if (!haystack.trim()) {
      return [];
    }

    const rows = await this.#database.db
      .selectFrom("jargon_entries")
      .selectAll()
      .where("status", "=", "approved")
      .where(
        "chat_key",
        "in",
        chatKey === "global" ? ["global"] : ["global", chatKey],
      )
      .orderBy("updated_at", "desc")
      .execute();

    // Prefer chat-specific entries over global entries when the same term exists.
    const sorted = rows.map(decodeJargon).sort((a, b) => {
      const aSpecific = a.chatKey === chatKey ? 0 : 1;
      const bSpecific = b.chatKey === chatKey ? 0 : 1;

      return aSpecific - bSpecific || b.updatedAt - a.updatedAt;
    });

    const seenTerms = new Set<string>();
    const matched: { term: string; meaning: string }[] = [];

    for (const item of sorted) {
      const termKey = item.term.toLowerCase();

      if (seenTerms.has(termKey)) {
        continue;
      }

      const candidates = [item.term, ...item.aliases]
        .map((word) => word.trim().toLowerCase())
        .filter((word) => word.length >= 2);

      if (candidates.some((word) => haystack.includes(word))) {
        seenTerms.add(termKey);
        matched.push({ term: item.term, meaning: item.meaning });
        if (matched.length >= limit) {
          break;
        }
      }
    }

    return matched;
  }
}
