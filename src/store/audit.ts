import type { Selectable } from "kysely";

import type { GuildAuditRecord } from "../types.ts";
import type { EventBus } from "../utils/logger.ts";
import type { BerryDatabase } from "./database.ts";
import type { BerryTables } from "./schema.ts";

const decodeAudit = (
  row: Selectable<BerryTables["guild_audit_logs"]>,
): GuildAuditRecord => ({
  id: row.id,
  chatKey: row.chat_key,
  qqUserId: row.qq_user_id,
  actorSubject: row.actor_subject,
  actorName: row.actor_name,
  action: row.action as GuildAuditRecord["action"],
  nodeId: row.node_id,
  targetTitle: row.target_title,
  requestJson: row.request_json,
  responseJson: row.response_json,
  error: row.error,
  createdAt: row.created_at,
});

export class GuildAuditStore {
  #database: BerryDatabase;
  #events: EventBus;

  constructor(database: BerryDatabase, events: EventBus) {
    this.#database = database;
    this.#events = events;
  }

  public async record(input: {
    chatKey: string;
    qqUserId: string;
    actorSubject: string;
    actorName: string;
    action: GuildAuditRecord["action"];
    nodeId: number | null;
    targetTitle: string;
    requestJson: string;
    responseJson: string;
    error?: string | null;
  }): Promise<GuildAuditRecord> {
    const now = Date.now();
    const row = await this.#database.writeTx((trx) =>
      trx
        .insertInto("guild_audit_logs")
        .values({
          chat_key: input.chatKey,
          qq_user_id: input.qqUserId,
          actor_subject: input.actorSubject,
          actor_name: input.actorName,
          action: input.action,
          node_id: input.nodeId,
          target_title: input.targetTitle,
          request_json: input.requestJson,
          response_json: input.responseJson,
          error: input.error ?? null,
          created_at: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow(),
    );

    const record = decodeAudit(row);

    this.#events.emit({ type: "guild_audit", data: record });

    return record;
  }

  public async list(limit = 100): Promise<GuildAuditRecord[]> {
    const rows = await this.#database.db
      .selectFrom("guild_audit_logs")
      .selectAll()
      .orderBy("id", "desc")
      .limit(limit)
      .execute();

    return rows.map(decodeAudit);
  }
}
