import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { sql } from "kysely";

import type { BerryDatabase } from "./database.ts";

export interface StorageSummary {
  dbBytes: number;
  dbMainBytes: number;
  dbWalBytes: number;
  assetsFiles: number;
  assetsBytes: number;
  avatarsFiles: number;
  avatarsBytes: number;
  tables: {
    messages: number;
    gateDecisions: number;
    conversations: number;
    tapeEntries: number;
    memories: number;
    messageAssets: number;
    jobs: number;
    deliveries: number;
    schedules: number;
    guildAuditLogs: number;
    llmUsage: number;
  };
  tableBytes: {
    messages: number;
    gateDecisions: number;
    tapeEntries: number;
    memories: number;
    messageAssets: number;
    jobs: number;
    deliveries: number;
    schedules: number;
    guildAuditLogs: number;
    llmUsage: number;
  };
}

export type PurgeScope =
  "llm_traces" | "archived_tape" | "runtime_logs" | "messages";

export interface PurgeOptions {
  olderThanDays: number;
  scopes: readonly PurgeScope[];
  compact?: boolean;
}

export interface PurgeResult {
  olderThanDays: number;
  scopes: PurgeScope[];
  deletedMessages: number;
  deletedDecisions: number;
  deletedJobs: number;
  deletedDeliveries: number;
  deletedAssetRows: number;
  deletedExpiredMemories: number;
  trimmedLlmUsage: number;
  deletedTapeEntries: number;
  dbFreedBytes: number;
  freedBytes: number;
}

async function folderStats(
  dir: string,
): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;

  try {
    const entries = await readdir(dir, {
      recursive: true,
      withFileTypes: true,
    });

    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }

      const info = await stat(join(entry.parentPath, entry.name));

      files++;
      bytes += info.size;
    }
  } catch {
    // Missing folder is fine.
  }

  return { files, bytes };
}

async function fileSize(path: string): Promise<number> {
  try {
    const info = await stat(path);

    return info.size;
  } catch {
    return 0;
  }
}

export class MaintenanceStore {
  #database: BerryDatabase;

  constructor(database: BerryDatabase) {
    this.#database = database;
  }

  public async inspectStorage(): Promise<StorageSummary> {
    const db = this.#database.db;

    const countTable = async (
      table:
        | "messages"
        | "gate_decisions"
        | "conversations"
        | "tape_entries"
        | "memories"
        | "message_assets"
        | "jobs"
        | "deliveries"
        | "schedules"
        | "guild_audit_logs"
        | "llm_usage",
    ) => {
      const row = await db
        .selectFrom(table)
        .select(sql<number>`count(*)`.as("count"))
        .executeTakeFirstOrThrow();

      return Number(row.count);
    };

    const [
      dbMain,
      dbWal,
      assetsStats,
      avatarsStats,
      sizeRows,
      messages,
      gateDecisions,
      conversations,
      tapeEntries,
      memories,
      messageAssets,
      jobs,
      deliveries,
      schedules,
      guildAuditLogs,
      llmUsage,
    ] = await Promise.all([
      fileSize(join(this.#database.dataDir, "berry.sqlite")),
      fileSize(join(this.#database.dataDir, "berry.sqlite-wal")),
      folderStats(this.#database.assetsDir),
      folderStats(this.#database.avatarsDir),
      sql<{ tbl: string; bytes: number }>`
        SELECT COALESCE(sm.tbl_name, d.name) AS tbl, SUM(d.pgsize) AS bytes
        FROM dbstat d
        LEFT JOIN sqlite_master sm ON sm.name = d.name
        GROUP BY tbl
      `
        .execute(db)
        .then((res) => res.rows)
        .catch(() => []),
      countTable("messages"),
      countTable("gate_decisions"),
      countTable("conversations"),
      countTable("tape_entries"),
      countTable("memories"),
      countTable("message_assets"),
      countTable("jobs"),
      countTable("deliveries"),
      countTable("schedules"),
      countTable("guild_audit_logs"),
      countTable("llm_usage"),
    ]);

    const bytesOf = (table: string) =>
      Number(sizeRows.find((r) => r.tbl === table)?.bytes ?? 0);

    return {
      dbBytes: dbMain + dbWal,
      dbMainBytes: dbMain,
      dbWalBytes: dbWal,
      assetsFiles: assetsStats.files,
      assetsBytes: assetsStats.bytes,
      avatarsFiles: avatarsStats.files,
      avatarsBytes: avatarsStats.bytes,
      tables: {
        messages,
        gateDecisions,
        conversations,
        tapeEntries,
        memories,
        messageAssets,
        jobs,
        deliveries,
        schedules,
        guildAuditLogs,
        llmUsage,
      },
      tableBytes: {
        messages: bytesOf("messages"),
        gateDecisions: bytesOf("gate_decisions"),
        tapeEntries: bytesOf("tape_entries"),
        memories: bytesOf("memories"),
        messageAssets: bytesOf("message_assets"),
        jobs: bytesOf("jobs"),
        deliveries: bytesOf("deliveries"),
        schedules: bytesOf("schedules"),
        guildAuditLogs: bytesOf("guild_audit_logs"),
        llmUsage: bytesOf("llm_usage"),
      },
    };
  }

  public async compactDatabase(): Promise<{
    beforeBytes: number;
    afterBytes: number;
    freedBytes: number;
  }> {
    const dbPath = join(this.#database.dataDir, "berry.sqlite");
    const walPath = join(this.#database.dataDir, "berry.sqlite-wal");
    const beforeBytes = (await fileSize(dbPath)) + (await fileSize(walPath));

    await this.#database.compact();
    const afterBytes = (await fileSize(dbPath)) + (await fileSize(walPath));

    return {
      beforeBytes,
      afterBytes,
      freedBytes: Math.max(0, beforeBytes - afterBytes),
    };
  }

  public async purgeData(options: PurgeOptions): Promise<PurgeResult> {
    const safeDays = Math.max(
      1,
      Math.min(3650, Math.floor(options.olderThanDays)),
    );
    const scopes = [...new Set(options.scopes)];
    const scopeSet = new Set<PurgeScope>(scopes);
    const shouldCompact = options.compact ?? true;
    const cutoff = Date.now() - safeDays * 86_400_000;
    const orphanPaths: string[] = [];
    const dbPath = join(this.#database.dataDir, "berry.sqlite");
    const walPath = join(this.#database.dataDir, "berry.sqlite-wal");
    const dbBefore = shouldCompact
      ? (await fileSize(dbPath)) + (await fileSize(walPath))
      : 0;

    const counts = await this.#database.writeTx(async (trx) => {
      let deletedMessages = 0;
      let deletedAssetRows = 0;
      let deletedDecisions = 0;
      let deletedJobs = 0;
      let deletedDeliveries = 0;
      let deletedExpiredMemories = 0;
      let trimmedLlmUsage = 0;
      let deletedTapeEntries = 0;

      if (scopeSet.has("messages")) {
        const protectedRows = await trx
          .selectFrom("memories")
          .select("source_message_id")
          .where("source_message_id", "is not", null)
          .execute();
        const protectedIds = new Set(
          protectedRows
            .map((r) => r.source_message_id)
            .filter((id): id is number => id !== null),
        );

        // Protect messages referenced by any pending or running job.
        const activeJobs = await trx
          .selectFrom("jobs")
          .select("payload_json")
          .where("state", "in", ["pending", "running"])
          .execute();

        for (const job of activeJobs) {
          const payload = JSON.parse(job.payload_json) as {
            messageId?: number;
            messageIds?: number[];
            triggerMessageIds?: number[];
          };

          if (payload.messageId !== undefined) {
            protectedIds.add(payload.messageId);
          }

          for (const id of [
            ...(payload.messageIds ?? []),
            ...(payload.triggerMessageIds ?? []),
          ]) {
            protectedIds.add(id);
          }
        }

        const oldMsgs = await trx
          .selectFrom("messages")
          .select("id")
          .where("sent_at", "<", cutoff)
          .execute();
        const deletableMsgIds = oldMsgs
          .map((m) => m.id)
          .filter((id) => !protectedIds.has(id));

        if (deletableMsgIds.length > 0) {
          const assetRows = await trx
            .selectFrom("message_assets")
            .select(["id", "file_path"])
            .where("message_id", "in", deletableMsgIds)
            .execute();

          const pathCandidates = [
            ...new Set(
              assetRows
                .map((a) => a.file_path)
                .filter((p): p is string => Boolean(p)),
            ),
          ];

          const assetRes = await trx
            .deleteFrom("message_assets")
            .where("message_id", "in", deletableMsgIds)
            .executeTakeFirst();

          deletedAssetRows = Number(assetRes.numDeletedRows);

          const msgRes = await trx
            .deleteFrom("messages")
            .where("id", "in", deletableMsgIds)
            .executeTakeFirst();

          deletedMessages = Number(msgRes.numDeletedRows);

          if (pathCandidates.length > 0) {
            const [stillUsedAssetRows, stickerRows] = await Promise.all([
              trx
                .selectFrom("message_assets")
                .select("file_path")
                .where("file_path", "in", pathCandidates)
                .execute(),
              trx
                .selectFrom("stickers")
                .select("file_path")
                .where("file_path", "in", pathCandidates)
                .execute(),
            ]);
            const stillUsed = new Set([
              ...stillUsedAssetRows.map((r) => r.file_path),
              ...stickerRows.map((r) => r.file_path),
            ]);

            for (const candidate of pathCandidates) {
              if (!stillUsed.has(candidate)) {
                orphanPaths.push(candidate);
              }
            }
          }
        }
      }

      if (scopeSet.has("runtime_logs")) {
        const expiredMemRes = await trx
          .deleteFrom("memories")
          .where("expires_at", "is not", null)
          .where("expires_at", "<=", Date.now())
          .executeTakeFirst();

        deletedExpiredMemories = Number(expiredMemRes.numDeletedRows);

        const gateRes = await trx
          .deleteFrom("gate_decisions")
          .where("created_at", "<", cutoff)
          .executeTakeFirst();

        deletedDecisions = Number(gateRes.numDeletedRows);

        const jobRes = await trx
          .deleteFrom("jobs")
          .where("state", "in", ["done", "failed"])
          .where("updated_at", "<", cutoff)
          .executeTakeFirst();

        deletedJobs = Number(jobRes.numDeletedRows);

        const delRes = await trx
          .deleteFrom("deliveries")
          .where("status", "in", ["sent", "failed"])
          .where("updated_at", "<", cutoff)
          .executeTakeFirst();

        deletedDeliveries = Number(delRes.numDeletedRows);
      }

      if (scopeSet.has("llm_traces")) {
        // Trim bulky LLM request/response/tool trace bodies while keeping token/call counters intact.
        const llmRes = await trx
          .updateTable("llm_usage")
          .set({
            request_preview: null,
            response_text: null,
            tool_calls_json: null,
          })
          .where("created_at", "<", cutoff)
          .where((eb) =>
            eb.or([
              eb("request_preview", "is not", null),
              eb("response_text", "is not", null),
              eb("tool_calls_json", "is not", null),
            ]),
          )
          .executeTakeFirst();

        trimmedLlmUsage = Number(llmRes.numUpdatedRows);
      }

      if (scopeSet.has("archived_tape")) {
        // Prune old subagent sidecars and archived global tape entries strictly before
        // the active window (matching ConversationsStore.#assembleView cutoff rules).
        const latestAnchor = await trx
          .selectFrom("tape_entries")
          .select(["id", "payload_json"])
          .where("tape_id", "=", "global")
          .where("kind", "=", "anchor")
          .orderBy("id", "desc")
          .limit(1)
          .executeTakeFirst();

        let activeStartAfterId = 0;
        let archivedGlobalMaxId: number | null = null;

        if (latestAnchor) {
          let cutoffEntryId: number | null = null;

          try {
            const payload = JSON.parse(latestAnchor.payload_json) as {
              reason?: string;
              cutoffEntryId?: number;
            };

            if (
              payload.reason === "compact" &&
              typeof payload.cutoffEntryId === "number"
            ) {
              cutoffEntryId = payload.cutoffEntryId;
            }
          } catch {
            // Fall back to latestAnchor.id boundary.
          }

          activeStartAfterId = cutoffEntryId ?? latestAnchor.id;
          archivedGlobalMaxId =
            cutoffEntryId === null
              ? latestAnchor.id - 1
              : Math.min(latestAnchor.id - 1, cutoffEntryId);
        }

        // Keep sidecars still referenced by any entry in the active global window.
        const activeSidecarRows = await trx
          .selectFrom("tape_entries")
          .select("sidecar_id")
          .where("tape_id", "=", "global")
          .where("id", ">", activeStartAfterId)
          .where("sidecar_id", "is not", null)
          .execute();
        const activeSidecarTapeIds = [
          ...new Set(
            activeSidecarRows
              .map((r) => r.sidecar_id)
              .filter((id): id is string => Boolean(id))
              .map((id) => `sidecar:${id}`),
          ),
        ];

        const tapeRes = await trx
          .deleteFrom("tape_entries")
          .where("created_at", "<", cutoff)
          .where((eb) => {
            const sidecarCond =
              activeSidecarTapeIds.length > 0
                ? eb.and([
                    eb("tape_id", "like", "sidecar:%"),
                    eb("tape_id", "not in", activeSidecarTapeIds),
                  ])
                : eb("tape_id", "like", "sidecar:%");

            if (archivedGlobalMaxId !== null && archivedGlobalMaxId > 0) {
              return eb.or([
                sidecarCond,
                eb.and([
                  eb("tape_id", "=", "global"),
                  eb("id", "<=", archivedGlobalMaxId),
                ]),
              ]);
            }

            return sidecarCond;
          })
          .executeTakeFirst();

        deletedTapeEntries = Number(tapeRes.numDeletedRows);
      }

      return {
        deletedMessages,
        deletedDecisions,
        deletedJobs,
        deletedDeliveries,
        deletedAssetRows,
        deletedExpiredMemories,
        trimmedLlmUsage,
        deletedTapeEntries,
      };
    });

    let assetFreedBytes = 0;

    for (const relOrAbs of orphanPaths) {
      const size = await fileSize(relOrAbs);

      await rm(relOrAbs, { force: true });
      assetFreedBytes += size;
    }

    let dbFreedBytes = 0;

    if (shouldCompact) {
      await this.#database.compact();
      const dbAfter = (await fileSize(dbPath)) + (await fileSize(walPath));

      dbFreedBytes = Math.max(0, dbBefore - dbAfter);
    }

    return {
      olderThanDays: safeDays,
      scopes,
      ...counts,
      dbFreedBytes,
      freedBytes: assetFreedBytes + dbFreedBytes,
    };
  }
}
