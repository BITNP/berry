import type { Selectable } from "kysely";

import type { ChatKey, MessageAssetRecord } from "../types.ts";
import type { BerryDatabase } from "./database.ts";
import type { BerryTables } from "./schema.ts";

const decodeAsset = (
  row: Selectable<BerryTables["message_assets"]>,
): MessageAssetRecord => ({
  id: row.id,
  messageId: row.message_id,
  chatKey: row.chat_key as ChatKey,
  kind: row.kind as MessageAssetRecord["kind"],
  rawUrl: row.raw_url,
  filePath: row.file_path,
  mimeType: row.mime_type,
  sha256: row.sha256,
  transcript: row.transcript,
  status: row.status as MessageAssetRecord["status"],
  error: row.error,
  updatedAt: row.updated_at,
});

export class AssetsStore {
  #database: BerryDatabase;

  constructor(database: BerryDatabase) {
    this.#database = database;
  }

  public async create(input: {
    messageId: number;
    chatKey: ChatKey;
    kind: MessageAssetRecord["kind"];
    rawUrl: string;
    filePath?: string | null;
    mimeType?: string;
    sha256?: string;
    transcript?: string | null;
    status?: MessageAssetRecord["status"];
  }): Promise<MessageAssetRecord> {
    const now = Date.now();
    const row = await this.#database.writeTx((trx) =>
      trx
        .insertInto("message_assets")
        .values({
          message_id: input.messageId,
          chat_key: input.chatKey,
          kind: input.kind,
          raw_url: input.rawUrl,
          file_path: input.filePath ?? null,
          mime_type: input.mimeType ?? "",
          sha256: input.sha256 ?? "",
          transcript: input.transcript ?? null,
          status: input.status ?? "pending",
          error: null,
          updated_at: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow(),
    );

    return decodeAsset(row);
  }

  public async get(id: number): Promise<MessageAssetRecord | null> {
    const row = await this.#database.db
      .selectFrom("message_assets")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();

    return row ? decodeAsset(row) : null;
  }

  public async listForMessage(
    messageId: number,
  ): Promise<MessageAssetRecord[]> {
    const rows = await this.#database.db
      .selectFrom("message_assets")
      .selectAll()
      .where("message_id", "=", messageId)
      .orderBy("id", "asc")
      .execute();

    return rows.map(decodeAsset);
  }

  public async listForMessages(
    messageIds: number[],
  ): Promise<Map<number, MessageAssetRecord[]>> {
    const map = new Map<number, MessageAssetRecord[]>();

    if (messageIds.length === 0) {
      return map;
    }

    const rows = await this.#database.db
      .selectFrom("message_assets")
      .selectAll()
      .where("message_id", "in", messageIds)
      .orderBy("id", "asc")
      .execute();

    for (const row of rows) {
      const list = map.get(row.message_id) ?? [];

      list.push(decodeAsset(row));
      map.set(row.message_id, list);
    }

    return map;
  }

  public async findReadyBySha256(
    sha256: string,
  ): Promise<MessageAssetRecord | null> {
    if (!sha256) {
      return null;
    }

    const row = await this.#database.db
      .selectFrom("message_assets")
      .selectAll()
      .where("sha256", "=", sha256)
      .where("status", "=", "ready")
      .where("transcript", "is not", null)
      .orderBy("id", "desc")
      .limit(1)
      .executeTakeFirst();

    return row ? decodeAsset(row) : null;
  }

  public async markReady(
    id: number,
    patch: {
      filePath?: string | null;
      mimeType?: string;
      sha256?: string;
      transcript: string;
    },
  ): Promise<MessageAssetRecord | null> {
    const now = Date.now();
    const row = await this.#database.writeTx((trx) =>
      trx
        .updateTable("message_assets")
        .set({
          ...(patch.filePath === undefined
            ? {}
            : { file_path: patch.filePath }),
          ...(patch.mimeType === undefined
            ? {}
            : { mime_type: patch.mimeType }),
          ...(patch.sha256 === undefined ? {} : { sha256: patch.sha256 }),
          transcript: patch.transcript,
          status: "ready",
          error: null,
          updated_at: now,
        })
        .where("id", "=", id)
        .returningAll()
        .executeTakeFirst(),
    );

    return row ? decodeAsset(row) : null;
  }

  public async markFailed(id: number, error: string): Promise<void> {
    await this.#database.writeTx(async (trx) => {
      await trx
        .updateTable("message_assets")
        .set({
          status: "failed",
          error,
          updated_at: Date.now(),
        })
        .where("id", "=", id)
        .execute();
    });
  }

  public async listFailed(
    filter: { chatKey?: string; limit?: number } = {},
  ): Promise<MessageAssetRecord[]> {
    const limit = Math.min(200, Math.max(1, filter.limit ?? 60));
    let query = this.#database.db
      .selectFrom("message_assets")
      .selectAll()
      .where("status", "=", "failed");

    if (filter.chatKey) {
      query = query.where("chat_key", "=", filter.chatKey);
    }

    const rows = await query
      .orderBy("updated_at", "desc")
      .orderBy("id", "desc")
      .limit(limit)
      .execute();

    return rows.map(decodeAsset);
  }
}
