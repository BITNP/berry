import { randomUUID } from "node:crypto";

import type { Selectable } from "kysely";

import type {
  ChatKey,
  JobKind,
  JobPayload,
  JobPayloads,
  JobRecord,
  UnifiedInput,
} from "../types.ts";
import type { EventBus } from "../utils/logger.ts";
import type { BerryDatabase } from "./database.ts";
import type { BerryTables } from "./schema.ts";

export interface JobListFilter {
  limit?: number;
  kind?: string;
  kinds?: readonly string[];
  state?: JobRecord["state"];
  chatKey?: string;
}

export interface JobCountsSummary {
  pending: number;
  running: number;
  failed: number;
  backgroundActive: number;
}

const decodeJob = <K extends JobKind>(
  row: Selectable<BerryTables["jobs"]>,
): JobRecord<K> => ({
  id: row.id,
  kind: row.kind as K,
  dedupeKey: row.dedupe_key,
  chatKey: row.chat_key,
  payload: JSON.parse(row.payload_json) as JobPayload<K>,
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
    payload: JobPayload<K>,
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

  public async enqueueUniqueActive<K extends JobKind>(
    kind: K,
    chatKey: string,
    payload: JobPayload<K>,
    options: { runAfter?: number } = {},
  ): Promise<{
    job: JobRecord<K>;
    alreadyActive: boolean;
  }> {
    const now = Date.now();
    const runAfter = options.runAfter ?? now;

    const result = await this.#database.writeTx(async (trx) => {
      const existing = await trx
        .selectFrom("jobs")
        .selectAll()
        .where("kind", "=", kind)
        .where("chat_key", "=", chatKey)
        .where("state", "in", ["pending", "running"])
        .orderBy("id", "desc")
        .limit(1)
        .executeTakeFirst();

      if (existing) {
        return {
          job: decodeJob<K>(existing),
          alreadyActive: true,
        };
      }

      const created = await trx
        .insertInto("jobs")
        .values({
          kind,
          dedupe_key: `${kind}:${chatKey}:${now}:${randomUUID().slice(0, 6)}`,
          chat_key: chatKey,
          payload_json: JSON.stringify(payload),
          state: "pending",
          attempts: 0,
          run_after: runAfter,
          last_error: null,
          created_at: now,
          updated_at: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      return {
        job: decodeJob<K>(created),
        alreadyActive: false,
      };
    });

    if (!result.alreadyActive) {
      this.#emitJobUpdate(
        result.job.id,
        result.job.kind,
        result.job.chatKey,
        result.job.state,
      );
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
        const nextRunAfter = Math.min(pending.run_after, runAfter);
        const added = !payload.messageIds.includes(messageId);

        if (added) {
          payload.messageIds.push(messageId);
        }

        if (added || nextRunAfter < pending.run_after) {
          await trx
            .updateTable("jobs")
            .set({
              payload_json: JSON.stringify(payload),
              run_after: nextRunAfter,
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

  // Merge pending qq_batch invoke jobs for the same chat so rapid bursts run as one turn.
  public async coalesceInvoke(payload: UnifiedInput): Promise<void> {
    if (payload.source !== "qq_batch") {
      await this.enqueue(
        "invoke",
        `invoke:${payload.chatKey}:${payload.source}:${Date.now()}:${randomUUID().slice(0, 6)}`,
        payload.chatKey,
        payload,
      );

      return;
    }

    const now = Date.now();

    await this.#database.writeTx(async (trx) => {
      const pendingRows = await trx
        .selectFrom("jobs")
        .selectAll()
        .where("kind", "=", "invoke")
        .where("state", "=", "pending")
        .where("chat_key", "=", payload.chatKey)
        .orderBy("id", "asc")
        .execute();

      for (const row of pendingRows) {
        const existing = JSON.parse(row.payload_json) as UnifiedInput;

        if (existing.source !== "qq_batch") {
          continue;
        }

        const mergedIds = [
          ...new Set([
            ...existing.triggerMessageIds,
            ...payload.triggerMessageIds,
          ]),
        ].sort((a, b) => a - b);

        await trx
          .updateTable("jobs")
          .set({
            payload_json: JSON.stringify({
              ...existing,
              triggerMessageIds: mergedIds,
              senderId: payload.senderId ?? existing.senderId,
              senderName: payload.senderName ?? existing.senderName,
            } satisfies UnifiedInput),
            updated_at: now,
          })
          .where("id", "=", row.id)
          .execute();

        return;
      }

      const firstId = payload.triggerMessageIds[0] ?? 0;
      const lastId = payload.triggerMessageIds.at(-1) ?? 0;

      await trx
        .insertInto("jobs")
        .values({
          kind: "invoke",
          dedupe_key: `invoke:${payload.chatKey}:${firstId}-${lastId}:${now}:${randomUUID().slice(0, 6)}`,
          chat_key: payload.chatKey,
          payload_json: JSON.stringify(payload),
          state: "pending",
          attempts: 0,
          run_after: now,
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
    options: { serializeByChatKey?: boolean } = {},
  ): Promise<JobRecord | null> {
    if (kinds.length === 0) {
      return null;
    }

    const job = await this.#database.writeTx(async (trx) => {
      let query = trx
        .selectFrom("jobs")
        .selectAll()
        .where("state", "=", "pending")
        .where("kind", "in", kinds)
        .where("run_after", "<=", now);

      if (options.serializeByChatKey) {
        query = query.where("chat_key", "not in", (eb) =>
          eb
            .selectFrom("jobs")
            .select("chat_key")
            .where("state", "=", "running")
            .where("kind", "in", kinds),
        );
      }

      const next = await query
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
      this.#emitJobUpdate(row.id, row.kind, row.chat_key, "done");
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
      this.#emitJobUpdate(row.id, row.kind, row.chat_key, "pending");
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
      this.#emitJobUpdate(row.id, row.kind, row.chat_key, "pending");
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
      this.#emitJobUpdate(row.id, row.kind, row.chat_key, "failed");
    }

    return Boolean(row);
  }

  public async list(
    filter: number | JobListFilter = 100,
  ): Promise<JobRecord[]> {
    const opts: JobListFilter =
      typeof filter === "number" ? { limit: filter } : filter;
    const limit = Math.min(200, Math.max(1, opts.limit ?? 100));

    let query = this.#database.db.selectFrom("jobs").selectAll();

    if (opts.kind) {
      query = query.where("kind", "=", opts.kind);
    } else if (opts.kinds) {
      if (opts.kinds.length === 0) {
        return [];
      }

      query = query.where("kind", "in", [...opts.kinds]);
    }

    if (opts.state) {
      query = query.where("state", "=", opts.state);
    }

    if (opts.chatKey) {
      query = query.where("chat_key", "=", opts.chatKey);
    }

    const rows = await query.orderBy("id", "desc").limit(limit).execute();

    return rows.map(decodeJob);
  }

  public async counts(
    backgroundKinds: readonly string[] = [],
  ): Promise<JobCountsSummary> {
    const rows = await this.#database.db
      .selectFrom("jobs")
      .select(["kind", "state"])
      .where("state", "in", ["pending", "running", "failed"])
      .execute();

    const bgSet = new Set(backgroundKinds);
    let pending = 0;
    let running = 0;
    let failed = 0;
    let backgroundActive = 0;

    for (const row of rows) {
      if (row.state === "pending") {
        pending++;
      } else if (row.state === "running") {
        running++;
      } else if (row.state === "failed") {
        failed++;
      }

      if (
        (row.state === "pending" || row.state === "running") &&
        bgSet.has(row.kind)
      ) {
        backgroundActive++;
      }
    }

    return { pending, running, failed, backgroundActive };
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
