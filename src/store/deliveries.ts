import type { Selectable } from "kysely";

import type {
  ChatKey,
  DeliveryRecord,
  DeliveryStatus,
  OutputUnit,
} from "../types.ts";
import type { EventBus } from "../utils/logger.ts";
import type { BerryDatabase } from "./database.ts";
import type { BerryTables } from "./schema.ts";

const decodeDelivery = (
  row: Selectable<BerryTables["deliveries"]>,
): DeliveryRecord => ({
  id: row.id,
  chatKey: row.chat_key as ChatKey,
  kind: row.kind as OutputUnit["kind"],
  payload: JSON.parse(row.payload_json) as OutputUnit,
  gatewayDeliveryId: row.gateway_delivery_id,
  status: row.status as DeliveryStatus,
  attempts: row.attempts,
  error: row.error,
  onebotMessageId: row.onebot_message_id,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export class DeliveriesStore {
  #database: BerryDatabase;
  #events: EventBus;

  constructor(database: BerryDatabase, events: EventBus) {
    this.#database = database;
    this.#events = events;
  }

  public async create(
    chatKey: ChatKey,
    unit: OutputUnit,
  ): Promise<DeliveryRecord> {
    const now = Date.now();
    const row = await this.#database.writeTx((trx) =>
      trx
        .insertInto("deliveries")
        .values({
          chat_key: chatKey,
          kind: unit.kind,
          payload_json: JSON.stringify(unit),
          gateway_delivery_id: null,
          status: "queued",
          attempts: 0,
          error: null,
          onebot_message_id: null,
          created_at: now,
          updated_at: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow(),
    );

    const record = decodeDelivery(row);

    this.#events.emit({ type: "delivery_update", data: record });

    return record;
  }

  public async updateStatus(
    id: number,
    patch: {
      gatewayDeliveryId?: string | null;
      status: DeliveryStatus;
      attempts?: number;
      error?: string | null;
      onebotMessageId?: string | null;
    },
  ): Promise<DeliveryRecord | null> {
    const now = Date.now();
    const row = await this.#database.writeTx((trx) =>
      trx
        .updateTable("deliveries")
        .set({
          ...(patch.gatewayDeliveryId === undefined
            ? {}
            : { gateway_delivery_id: patch.gatewayDeliveryId }),
          status: patch.status,
          ...(patch.attempts === undefined ? {} : { attempts: patch.attempts }),
          ...(patch.error === undefined ? {} : { error: patch.error }),
          ...(patch.onebotMessageId === undefined
            ? {}
            : { onebot_message_id: patch.onebotMessageId }),
          updated_at: now,
        })
        .where("id", "=", id)
        .returningAll()
        .executeTakeFirst(),
    );

    if (!row) {
      return null;
    }

    const record = decodeDelivery(row);

    this.#events.emit({ type: "delivery_update", data: record });

    return record;
  }

  public async list(limit = 100): Promise<DeliveryRecord[]> {
    const rows = await this.#database.db
      .selectFrom("deliveries")
      .selectAll()
      .orderBy("id", "desc")
      .limit(limit)
      .execute();

    return rows.map(decodeDelivery);
  }

  public async listFailed(
    filter: { chatKey?: string; limit?: number } = {},
  ): Promise<DeliveryRecord[]> {
    const limit = Math.min(200, Math.max(1, filter.limit ?? 60));
    let query = this.#database.db
      .selectFrom("deliveries")
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

    return rows.map(decodeDelivery);
  }
}
