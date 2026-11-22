import type { Selectable } from "kysely";
import { sql } from "kysely";

import type { LlmCallRecord, LlmToolCallSummary } from "../types.ts";
import type { EventBus } from "../utils/logger.ts";
import { formatDay } from "../utils/time.ts";
import type { BerryDatabase } from "./database.ts";
import type { BerryTables } from "./schema.ts";

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

const MAX_PREVIEW_CHARS = 12_000;

function clipText(
  value: string | null | undefined,
  max = MAX_PREVIEW_CHARS,
): string | null {
  if (!value) {
    return null;
  }

  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function decodeMessageIds(raw: string | null | undefined): number[] {
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as unknown;

    return Array.isArray(parsed)
      ? parsed.filter((id): id is number => typeof id === "number")
      : [];
  } catch {
    return [];
  }
}

const decodeLlmCall = (
  row: Selectable<BerryTables["llm_usage"]>,
): LlmCallRecord => ({
  id: row.id,
  day: row.day,
  purpose: row.purpose,
  model: row.model,
  chatKey: row.chat_key,
  status: row.status === "error" ? "error" : "ok",
  inputTokens: row.input_tokens,
  cachedInputTokens: row.cached_input_tokens,
  outputTokens: row.output_tokens,
  durationMs: row.duration_ms,
  requestPreview: row.request_preview,
  responseText: row.response_text,
  toolCalls: row.tool_calls_json
    ? (JSON.parse(row.tool_calls_json) as LlmToolCallSummary[])
    : [],
  error: row.error,
  cacheWarning: row.cache_warning ?? null,
  jobId: row.job_id ?? null,
  messageIds: decodeMessageIds(row.message_ids_json),
  createdAt: row.created_at,
});

export class UsageStore {
  #database: BerryDatabase;
  #events: EventBus;

  constructor(database: BerryDatabase, events: EventBus) {
    this.#database = database;
    this.#events = events;
  }

  public async record(input: {
    purpose: string;
    model: string;
    chatKey?: string | null;
    status?: "ok" | "error";
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    durationMs: number;
    requestPreview?: string | null;
    responseText?: string | null;
    toolCalls?: LlmToolCallSummary[];
    error?: string | null;
    cacheWarning?: string | null;
    jobId?: number | null;
    messageIds?: number[];
    timeZone?: string;
  }): Promise<LlmCallRecord> {
    const now = Date.now();
    const day = formatDay(now, input.timeZone ?? "Asia/Shanghai");
    const toolCalls = input.toolCalls ?? [];
    const status = input.status ?? (input.error ? "error" : "ok");
    const uniqueMessageIds = [
      ...new Set(
        (input.messageIds ?? []).filter((id) => Number.isInteger(id) && id > 0),
      ),
    ];

    const row = await this.#database.writeTx(async (trx) =>
      trx
        .insertInto("llm_usage")
        .values({
          day,
          purpose: input.purpose,
          model: input.model,
          chat_key: input.chatKey ?? null,
          status,
          input_tokens: input.inputTokens,
          cached_input_tokens: input.cachedInputTokens,
          output_tokens: input.outputTokens,
          duration_ms: input.durationMs,
          request_preview: clipText(input.requestPreview),
          response_text: clipText(input.responseText),
          tool_calls_json:
            toolCalls.length > 0 ? JSON.stringify(toolCalls) : null,
          error: clipText(input.error, 2000),
          cache_warning: clipText(input.cacheWarning, 500),
          job_id: input.jobId ?? null,
          message_ids_json:
            uniqueMessageIds.length > 0
              ? JSON.stringify(uniqueMessageIds)
              : null,
          created_at: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow(),
    );

    const record = decodeLlmCall(row);

    this.#events.emit({ type: "llm_call", data: record });

    return record;
  }

  public async updateToolCalls(
    id: number,
    toolCalls: LlmToolCallSummary[],
  ): Promise<LlmCallRecord | null> {
    const normalized: LlmToolCallSummary[] = toolCalls.map((call) => ({
      ...(call.id ? { id: call.id } : {}),
      name: call.name,
      arguments: clipText(call.arguments, 4000) ?? "",
      ...(call.ok === undefined ? {} : { ok: call.ok }),
      ...(call.result === undefined
        ? {}
        : { result: clipText(call.result, MAX_PREVIEW_CHARS) ?? "" }),
      ...(call.durationMs === undefined ? {} : { durationMs: call.durationMs }),
    }));

    const row = await this.#database.writeTx(async (trx) =>
      trx
        .updateTable("llm_usage")
        .set({
          tool_calls_json:
            normalized.length > 0 ? JSON.stringify(normalized) : null,
        })
        .where("id", "=", id)
        .returningAll()
        .executeTakeFirst(),
    );

    if (!row) {
      return null;
    }

    const record = decodeLlmCall(row);

    this.#events.emit({ type: "llm_call", data: record });

    return record;
  }

  public async listRecent(
    filter: {
      purpose?: string;
      excludePurpose?: string;
      status?: "ok" | "error";
      chatKey?: string;
      search?: string;
      limit?: number;
    } = {},
  ): Promise<{ items: LlmCallRecord[]; total: number }> {
    const limit = Math.min(200, Math.max(1, filter.limit ?? 80));

    let listQuery = this.#database.db.selectFrom("llm_usage").selectAll();
    let countQuery = this.#database.db
      .selectFrom("llm_usage")
      .select(sql<number>`count(*)`.as("count"));

    if (filter.purpose) {
      if (filter.purpose === "subagent") {
        listQuery = listQuery.where("purpose", "like", "subagent%");
        countQuery = countQuery.where("purpose", "like", "subagent%");
      } else {
        listQuery = listQuery.where("purpose", "=", filter.purpose);
        countQuery = countQuery.where("purpose", "=", filter.purpose);
      }
    } else if (filter.excludePurpose) {
      listQuery = listQuery.where("purpose", "!=", filter.excludePurpose);
      countQuery = countQuery.where("purpose", "!=", filter.excludePurpose);
    }

    if (filter.status) {
      listQuery = listQuery.where("status", "=", filter.status);
      countQuery = countQuery.where("status", "=", filter.status);
    }

    if (filter.chatKey) {
      listQuery = listQuery.where("chat_key", "=", filter.chatKey);
      countQuery = countQuery.where("chat_key", "=", filter.chatKey);
    }

    if (filter.search) {
      const needle = filter.search;

      listQuery = listQuery.where((eb) =>
        eb.or([
          eb(sql<number>`contains_text(model, ${needle})`, "=", 1),
          eb(
            sql<number>`contains_text(coalesce(chat_key, ''), ${needle})`,
            "=",
            1,
          ),
          eb(
            sql<number>`contains_text(coalesce(request_preview, ''), ${needle})`,
            "=",
            1,
          ),
          eb(
            sql<number>`contains_text(coalesce(response_text, ''), ${needle})`,
            "=",
            1,
          ),
          eb(
            sql<number>`contains_text(coalesce(tool_calls_json, ''), ${needle})`,
            "=",
            1,
          ),
          eb(
            sql<number>`contains_text(coalesce(error, ''), ${needle})`,
            "=",
            1,
          ),
        ]),
      );
      countQuery = countQuery.where((eb) =>
        eb.or([
          eb(sql<number>`contains_text(model, ${needle})`, "=", 1),
          eb(
            sql<number>`contains_text(coalesce(chat_key, ''), ${needle})`,
            "=",
            1,
          ),
          eb(
            sql<number>`contains_text(coalesce(request_preview, ''), ${needle})`,
            "=",
            1,
          ),
          eb(
            sql<number>`contains_text(coalesce(response_text, ''), ${needle})`,
            "=",
            1,
          ),
          eb(
            sql<number>`contains_text(coalesce(tool_calls_json, ''), ${needle})`,
            "=",
            1,
          ),
          eb(
            sql<number>`contains_text(coalesce(error, ''), ${needle})`,
            "=",
            1,
          ),
        ]),
      );
    }

    const [rows, countRow] = await Promise.all([
      listQuery.orderBy("id", "desc").limit(limit).execute(),
      countQuery.executeTakeFirstOrThrow(),
    ]);

    return {
      items: rows.map(decodeLlmCall),
      total: Number(countRow.count),
    };
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

  public async listForTrace(input: {
    jobIds?: number[];
    messageId?: number;
    limit?: number;
  }): Promise<LlmCallRecord[]> {
    const jobIds = [
      ...new Set((input.jobIds ?? []).filter((id) => Number.isInteger(id))),
    ];
    const messageId =
      input.messageId && Number.isInteger(input.messageId)
        ? input.messageId
        : null;
    const limit = Math.min(200, Math.max(1, input.limit ?? 100));

    if (jobIds.length === 0 && messageId === null) {
      return [];
    }

    const rows = await this.#database.db
      .selectFrom("llm_usage")
      .selectAll()
      .where((eb) => {
        const branches = [];

        if (jobIds.length > 0) {
          branches.push(eb("job_id", "in", jobIds));
        }

        if (messageId !== null) {
          branches.push(
            eb(
              sql<number>`exists (select 1 from json_each(coalesce(llm_usage.message_ids_json, '[]')) where value = ${messageId})`,
              "=",
              1,
            ),
          );
        }

        return eb.or(branches);
      })
      .orderBy("created_at", "asc")
      .orderBy("id", "asc")
      .limit(limit)
      .execute();

    return rows.map(decodeLlmCall);
  }

  public async listLinkedToMessages(
    messageIds: number[],
  ): Promise<LlmCallRecord[]> {
    const unique = [
      ...new Set(messageIds.filter((id) => Number.isInteger(id) && id > 0)),
    ];

    if (unique.length === 0) {
      return [];
    }

    const rows = await this.#database.db
      .selectFrom("llm_usage")
      .selectAll()
      .where("message_ids_json", "is not", null)
      .where(
        sql<boolean>`exists (select 1 from json_each(llm_usage.message_ids_json) where value in (${sql.join(unique)}))`,
      )
      .orderBy("created_at", "asc")
      .orderBy("id", "asc")
      .execute();

    return rows.map(decodeLlmCall);
  }
}
