import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { sql } from "kysely";

import type { BerryDatabase } from "./database.ts";

export interface StorageSummary {
  dbBytes: number;
  assetsFiles: number;
  assetsBytes: number;
  avatarsFiles: number;
  avatarsBytes: number;
  tables: {
    messages: number;
    gateDecisions: number;
    conversations: number;
    memories: number;
    messageAssets: number;
    jobs: number;
    deliveries: number;
    schedules: number;
    guildAuditLogs: number;
    llmUsage: number;
  };
}

export interface PurgeResult {
  olderThanDays: number;
  deletedMessages: number;
  deletedDecisions: number;
  deletedJobs: number;
  deletedDeliveries: number;
  deletedAssetRows: number;
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
      messages,
      gateDecisions,
      conversations,
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
      countTable("messages"),
      countTable("gate_decisions"),
      countTable("conversations"),
      countTable("memories"),
      countTable("message_assets"),
      countTable("jobs"),
      countTable("deliveries"),
      countTable("schedules"),
      countTable("guild_audit_logs"),
      countTable("llm_usage"),
    ]);

    return {
      dbBytes: dbMain + dbWal,
      assetsFiles: assetsStats.files,
      assetsBytes: assetsStats.bytes,
      avatarsFiles: avatarsStats.files,
      avatarsBytes: avatarsStats.bytes,
      tables: {
        messages,
        gateDecisions,
        conversations,
        memories,
        messageAssets,
        jobs,
        deliveries,
        schedules,
        guildAuditLogs,
        llmUsage,
      },
    };
  }

  public async purgeOldData(olderThanDays: number): Promise<PurgeResult> {
    const safeDays = Math.max(1, Math.min(3650, Math.floor(olderThanDays)));
    const cutoff = Date.now() - safeDays * 86_400_000;
    const orphanPaths: string[] = [];

    const counts = await this.#database.writeTx(async (trx) => {
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
        try {
          const payload = JSON.parse(job.payload_json) as {
            messageId?: number;
            messageIds?: number[];
            triggerMessageIds?: number[];
          };

          if (typeof payload.messageId === "number") {
            protectedIds.add(payload.messageId);
          }

          for (const id of [
            ...(payload.messageIds ?? []),
            ...(payload.triggerMessageIds ?? []),
          ]) {
            protectedIds.add(id);
          }
        } catch {
          // Ignore malformed job payload.
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

      let deletedAssetRows = 0;
      let deletedMessages = 0;

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
          const stillUsedRows = await trx
            .selectFrom("message_assets")
            .select("file_path")
            .where("file_path", "in", pathCandidates)
            .execute();
          const stillUsed = new Set(stillUsedRows.map((r) => r.file_path));

          for (const candidate of pathCandidates) {
            if (!stillUsed.has(candidate)) {
              orphanPaths.push(candidate);
            }
          }
        }
      }

      const gateRes = await trx
        .deleteFrom("gate_decisions")
        .where("created_at", "<", cutoff)
        .executeTakeFirst();

      const jobRes = await trx
        .deleteFrom("jobs")
        .where("state", "in", ["done", "failed"])
        .where("updated_at", "<", cutoff)
        .executeTakeFirst();

      const delRes = await trx
        .deleteFrom("deliveries")
        .where("status", "in", ["sent", "failed"])
        .where("updated_at", "<", cutoff)
        .executeTakeFirst();

      return {
        deletedMessages,
        deletedDecisions: Number(gateRes.numDeletedRows),
        deletedJobs: Number(jobRes.numDeletedRows),
        deletedDeliveries: Number(delRes.numDeletedRows),
        deletedAssetRows,
      };
    });

    let freedBytes = 0;

    for (const relOrAbs of orphanPaths) {
      const size = await fileSize(relOrAbs);

      await rm(relOrAbs, { force: true });
      freedBytes += size;
    }

    return {
      olderThanDays: safeDays,
      ...counts,
      freedBytes,
    };
  }
}
