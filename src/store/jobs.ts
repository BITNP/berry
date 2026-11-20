import { randomUUID } from "node:crypto";

import type { Selectable } from "kysely";

import type {
  ChatKey,
  GuildTaskKind,
  JobKind,
  JobPayloads,
  JobRecord,
} from "../types.ts";
import type { EventBus } from "../utils/logger.ts";
import type { BerryDatabase } from "./database.ts";
import type { BerryTables } from "./schema.ts";

const decodeJob = <K extends JobKind>(
  row: Selectable<BerryTables["jobs"]>,
): JobRecord<K> => ({
  id: row.id,
  kind: row.kind as K,
  dedupeKey: row.dedupe_key,
  chatKey: row.chat_key,
  payload: JSON.parse(row.payload_json) as JobPayloads[K],
  state: row.state as JobRecord["state"],
  attempts: row.attempts,
  runAfter: row.run_after,
  lastError: row.last_error,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export class JobsStore {
  #database: BerryDatabase;
  #events: EventBus;

  constructor(database: BerryDatabase, events: EventBus) {
    this.#database = database;
    this.#events = events;
  }

  public async recoverOnStartup(): Promise<number> {
    const now = Date.now();

    return this.#database.writeTx(async (trx) => {
      const res = await trx
        .updateTable("jobs")
        .set({ state: "pending", updated_at: now })
        .where("state", "=", "running")
        .executeTakeFirst();

      return Number(res.numUpdatedRows);
    });
  }

  public async enqueue<K extends JobKind>(
    kind: K,
    dedupeKey: string,
    chatKey: string,
    payload: JobPayloads[K],
    runAfter = Date.now(),
  ): Promise<void> {
    const now = Date.now();

    await this.#database.writeTx(async (trx) => {
      await trx
        .insertInto("jobs")
        .values({
          kind,
          dedupe_key: dedupeKey,
          chat_key: chatKey,
          payload_json: JSON.stringify(payload),
          state: "pending",
          attempts: 0,
          run_after: runAfter,
          last_error: null,
          created_at: now,
          updated_at: now,
        })
        .onConflict((oc) => oc.column("dedupe_key").doNothing())
        .execute();
    });
  }

  public async enqueueGuildTask(task: GuildTaskKind): Promise<{
    job: JobRecord<"guild_task">;
    alreadyActive: boolean;
  }> {
    const now = Date.now();
    const chatKey = `guild:${task}`;

    const result = await this.#database.writeTx(async (trx) => {
      const existing = await trx
        .selectFrom("jobs")
        .selectAll()
        .where("kind", "=", "guild_task")
        .where("chat_key", "=", chatKey)
        .where("state", "in", ["pending", "running"])
        .orderBy("id", "desc")
        .limit(1)
        .executeTakeFirst();

      if (existing) {
        return {
          job: decodeJob<"guild_task">(existing),
          alreadyActive: true,
        };
      }

      const created = await trx
        .insertInto("jobs")
        .values({
          kind: "guild_task",
          dedupe_key: `guild_task:${task}:${now}:${randomUUID().slice(0, 6)}`,
          chat_key: chatKey,
          payload_json: JSON.stringify({ task }),
          state: "pending",
          attempts: 0,
          run_after: now,
          last_error: null,
          created_at: now,
          updated_at: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      return {
        job: decodeJob<"guild_task">(created),
        alreadyActive: false,
      };
    });

    if (!result.alreadyActive) {
      this.#events.emit({
        type: "job_update",
        data: {
          id: result.job.id,
          kind: "guild_task",
          chatKey: result.job.chatKey,
          state: result.job.state,
        },
      });
    }

    return result;
  }

  // Coalesce messages for the same chat within the fixed 1s window from first message.
  public async coalesceGateBatch(
    chatKey: ChatKey,
    messageId: number,
    runAfter: number,
  ): Promise<void> {
    const now = Date.now();

    await this.#database.writeTx(async (trx) => {
      const pending = await trx
        .selectFrom("jobs")
        .selectAll()
        .where("kind", "=", "gate_batch")
        .where("state", "=", "pending")
        .where("chat_key", "=", chatKey)
        .executeTakeFirst();

      if (pending) {
        const payload = JSON.parse(
          pending.payload_json,
        ) as JobPayloads["gate_batch"];

        if (!payload.messageIds.includes(messageId)) {
          payload.messageIds.push(messageId);
          await trx
            .updateTable("jobs")
            .set({
              payload_json: JSON.stringify(payload),
              updated_at: now,
            })
            .where("id", "=", pending.id)
            .execute();
        }

        return;
      }

      await trx
        .insertInto("jobs")
        .values({
          kind: "gate_batch",
          dedupe_key: `gate_batch:${chatKey}:${messageId}:${now}`,
          chat_key: chatKey,
          payload_json: JSON.stringify({
            chatKey,
            messageIds: [messageId],
          } satisfies JobPayloads["gate_batch"]),
          state: "pending",
          attempts: 0,
          run_after: runAfter,
          last_error: null,
          created_at: now,
          updated_at: now,
        })
        .execute();
    });
  }

  public async claim(
    kinds: JobKind[],
    now = Date.now(),
  ): Promise<JobRecord | null> {
    if (kinds.length === 0) {
      return null;
    }

    const job = await this.#database.writeTx(async (trx) => {
      const next = await trx
        .selectFrom("jobs")
        .selectAll()
        .where("state", "=", "pending")
        .where("kind", "in", kinds)
        .where("run_after", "<=", now)
        .orderBy("run_after", "asc")
        .orderBy("id", "asc")
        .limit(1)
        .executeTakeFirst();

      if (!next) {
        return null;
      }

      const updated = await trx
        .updateTable("jobs")
        .set({
          state: "running",
          attempts: next.attempts + 1,
          updated_at: now,
        })
        .where("id", "=", next.id)
        .where("state", "=", "pending")
        .returningAll()
        .executeTakeFirst();

      return updated ? decodeJob(updated) : null;
    });

    if (job) {
      this.#emitJobUpdate(job.id, job.kind, job.chatKey, job.state);
    }

    return job;
  }

  public async done(id: number): Promise<void> {
    const now = Date.now();
    const row = await this.#database.writeTx((trx) =>
      trx
        .updateTable("jobs")
        .set({ state: "done", last_error: null, updated_at: now })
        .where("id", "=", id)
        .returningAll()
        .executeTakeFirst(),
    );

    if (row) {
      this.#emitJobUpdate(row.id, row.kind as JobKind, row.chat_key, "done");
    }
  }

  public async interrupt(id: number): Promise<void> {
    const now = Date.now();

    await this.#database.writeTx(async (trx) => {
      await trx
        .updateTable("jobs")
        .set({ state: "pending", updated_at: now })
        .where("id", "=", id)
        .where("state", "=", "running")
        .execute();
    });
  }

  public async retryOrFail(
    job: JobRecord,
    error: string,
    retryable: boolean,
  ): Promise<"pending" | "failed"> {
    const now = Date.now();
    const maxAttempts = 4;
    const state =
      retryable && job.attempts < maxAttempts ? "pending" : "failed";
    const backoffMs = Math.min(
      60_000,
      2000 * 2 ** Math.max(0, job.attempts - 1),
    );

    await this.#database.writeTx(async (trx) => {
      await trx
        .updateTable("jobs")
        .set({
          state,
          last_error: error,
          run_after: state === "pending" ? now + backoffMs : job.runAfter,
          updated_at: now,
        })
        .where("id", "=", job.id)
        .execute();
    });

    this.#emitJobUpdate(job.id, job.kind, job.chatKey, state);

    return state;
  }

  public async retry(id: number): Promise<boolean> {
    const now = Date.now();
    const row = await this.#database.writeTx((trx) =>
      trx
        .updateTable("jobs")
        .set({
          state: "pending",
          attempts: 0,
          run_after: now,
          last_error: null,
          updated_at: now,
        })
        .where("id", "=", id)
        .where("state", "in", ["failed", "done"])
        .returningAll()
        .executeTakeFirst(),
    );

    if (row) {
      this.#emitJobUpdate(row.id, row.kind as JobKind, row.chat_key, "pending");
    }

    return Boolean(row);
  }

  public async retryAllFailed(): Promise<number> {
    const now = Date.now();
    const rows = await this.#database.writeTx((trx) =>
      trx
        .updateTable("jobs")
        .set({
          state: "pending",
          attempts: 0,
          run_after: now,
          last_error: null,
          updated_at: now,
        })
        .where("state", "=", "failed")
        .returningAll()
        .execute(),
    );

    for (const row of rows) {
      this.#emitJobUpdate(row.id, row.kind as JobKind, row.chat_key, "pending");
    }

    return rows.length;
  }

  public async cancel(id: number): Promise<boolean> {
    const now = Date.now();
    const row = await this.#database.writeTx((trx) =>
      trx
        .updateTable("jobs")
        .set({
          state: "failed",
          last_error: "已人工取消",
          updated_at: now,
        })
        .where("id", "=", id)
        .where("state", "=", "pending")
        .returningAll()
        .executeTakeFirst(),
    );

    if (row) {
      this.#emitJobUpdate(row.id, row.kind as JobKind, row.chat_key, "failed");
    }

    return Boolean(row);
  }

  public async list(limit = 100): Promise<JobRecord[]> {
    const rows = await this.#database.db
      .selectFrom("jobs")
      .selectAll()
      .orderBy("id", "desc")
      .limit(limit)
      .execute();

    return rows.map(decodeJob);
  }

  public async countPending(): Promise<number> {
    const row = await this.#database.db
      .selectFrom("jobs")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .where("state", "in", ["pending", "running"])
      .executeTakeFirstOrThrow();

    return Number(row.count);
  }

  #emitJobUpdate(
    id: number,
    kind: JobKind,
    chatKey: string,
    state: JobRecord["state"],
  ): void {
    this.#events.emit({
      type: "job_update",
      data: { id, kind, chatKey, state },
    });
  }
}
