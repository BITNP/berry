import { sql } from "kysely";

import { formatDay } from "../utils/time.ts";
import type { BerryDatabase } from "./database.ts";

export interface UsageDailyBucket {
  day: string;
  purpose: string;
  model: string;
  calls: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  avgDurationMs: number;
}

export interface UsageTotals {
  calls: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export class UsageStore {
  #database: BerryDatabase;

  constructor(database: BerryDatabase) {
    this.#database = database;
  }

  public async record(input: {
    purpose: string;
    model: string;
    chatKey?: string | null;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    durationMs: number;
    timeZone?: string;
  }): Promise<void> {
    const now = Date.now();
    const day = formatDay(now, input.timeZone ?? "Asia/Shanghai");

    await this.#database.writeTx(async (trx) => {
      await trx
        .insertInto("llm_usage")
        .values({
          day,
          purpose: input.purpose,
          model: input.model,
          chat_key: input.chatKey ?? null,
          input_tokens: input.inputTokens,
          cached_input_tokens: input.cachedInputTokens,
          output_tokens: input.outputTokens,
          duration_ms: input.durationMs,
          created_at: now,
        })
        .execute();
    });
  }

  public async todaySummary(timeZone = "Asia/Shanghai"): Promise<UsageTotals> {
    const today = formatDay(Date.now(), timeZone);
    const row = await this.#database.db
      .selectFrom("llm_usage")
      .select([
        sql<number>`count(*)`.as("calls"),
        sql<number>`coalesce(sum(input_tokens), 0)`.as("input_tokens"),
        sql<number>`coalesce(sum(cached_input_tokens), 0)`.as(
          "cached_input_tokens",
        ),
        sql<number>`coalesce(sum(output_tokens), 0)`.as("output_tokens"),
      ])
      .where("day", "=", today)
      .executeTakeFirstOrThrow();

    const inputTokens = Number(row.input_tokens);
    const outputTokens = Number(row.output_tokens);

    return {
      calls: Number(row.calls),
      inputTokens,
      cachedInputTokens: Number(row.cached_input_tokens),
      outputTokens,
      totalTokens: inputTokens + outputTokens,
    };
  }

  public async todayCallCount(timeZone = "Asia/Shanghai"): Promise<number> {
    return (await this.todaySummary(timeZone)).calls;
  }

  public async dailySummary(days = 14): Promise<UsageDailyBucket[]> {
    const rows = await this.#database.db
      .selectFrom("llm_usage")
      .select([
        "day",
        "purpose",
        "model",
        sql<number>`count(*)`.as("calls"),
        sql<number>`coalesce(sum(input_tokens), 0)`.as("input_tokens"),
        sql<number>`coalesce(sum(cached_input_tokens), 0)`.as(
          "cached_input_tokens",
        ),
        sql<number>`coalesce(sum(output_tokens), 0)`.as("output_tokens"),
        sql<number>`coalesce(round(avg(duration_ms)), 0)`.as("avg_duration_ms"),
      ])
      .groupBy(["day", "purpose", "model"])
      .orderBy("day", "desc")
      .orderBy("calls", "desc")
      .limit(days * 20)
      .execute();

    return rows.map((row) => ({
      day: row.day,
      purpose: row.purpose,
      model: row.model,
      calls: Number(row.calls),
      inputTokens: Number(row.input_tokens),
      cachedInputTokens: Number(row.cached_input_tokens),
      outputTokens: Number(row.output_tokens),
      avgDurationMs: Number(row.avg_duration_ms),
    }));
  }
}
