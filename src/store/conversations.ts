import { randomUUID } from "node:crypto";

import type { Selectable } from "kysely";

import type { AccessRole } from "../identity/permissions.ts";
import type {
  ConversationRecord,
  OutputResult,
  TapeAnchorPayload,
  TapeEntryRecord,
  TapeHandoff,
  TurnMessage,
} from "../types.ts";
import type { EventBus } from "../utils/logger.ts";
import type { BerryDatabase } from "./database.ts";
import type { BerryDb, BerryTables } from "./schema.ts";

const GLOBAL_CONVERSATION_KEY = "global";

function decodeTapeEntry(
  row: Selectable<BerryTables["tape_entries"]>,
): TapeEntryRecord {
  if (row.kind === "anchor") {
    return {
      id: row.id,
      tapeId: row.tape_id,
      kind: "anchor",
      turnId: row.turn_id,
      chatKey: row.chat_key,
      role: "anchor",
      anchor: JSON.parse(row.payload_json) as TapeAnchorPayload,
      sidecarId: null,
      createdAt: row.created_at,
    };
  }

  const message = JSON.parse(row.payload_json) as TurnMessage;

  return {
    id: row.id,
    tapeId: row.tape_id,
    kind: "message",
    turnId: row.turn_id,
    chatKey: row.chat_key,
    role: message.role,
    message,
    sidecarId: row.sidecar_id ?? null,
    createdAt: row.created_at,
  };
}

function extractSidecarId(msg: TurnMessage): string | null {
  if (msg.role !== "tool") {
    return null;
  }

  try {
    const parsed = JSON.parse(msg.content) as {
      result?: { sidecarId?: unknown };
    };

    return typeof parsed.result?.sidecarId === "string" &&
      parsed.result.sidecarId.trim()
      ? parsed.result.sidecarId.trim()
      : null;
  } catch {
    return null;
  }
}

export class ConversationsStore {
  #database: BerryDatabase;
  #events: EventBus;

  constructor(database: BerryDatabase, events: EventBus) {
    this.#database = database;
    this.#events = events;
  }

  public async open(): Promise<ConversationRecord> {
    const now = Date.now();

    await this.#database.writeTx((trx) => this.#ensureRow(trx, now));

    return this.buildView();
  }

  public async get(): Promise<ConversationRecord | null> {
    const head = await this.#database.db
      .selectFrom("conversations")
      .selectAll()
      .where("chat_key", "=", GLOBAL_CONVERSATION_KEY)
      .executeTakeFirst();

    if (!head) {
      return null;
    }

    return this.#assembleView(this.#database.db, head);
  }

  public async buildView(options?: {
    role?: AccessRole;
    chatKey?: string;
  }): Promise<ConversationRecord & { scopedToChat: boolean }> {
    const now = Date.now();
    const head = await this.#database.writeTx(async (trx) => {
      await this.#ensureRow(trx, now);

      return trx
        .selectFrom("conversations")
        .selectAll()
        .where("chat_key", "=", GLOBAL_CONVERSATION_KEY)
        .executeTakeFirstOrThrow();
    });

    return this.#assembleView(this.#database.db, head, options);
  }

  public async pushOutputResult(result: OutputResult): Promise<void> {
    const now = Date.now();

    await this.#database.writeTx(async (trx) => {
      await this.#ensureRow(trx, now);

      const row = await trx
        .selectFrom("conversations")
        .select(["pending_results_json"])
        .where("chat_key", "=", GLOBAL_CONVERSATION_KEY)
        .executeTakeFirstOrThrow();

      const pending = JSON.parse(row.pending_results_json) as OutputResult[];

      pending.push(result);

      await trx
        .updateTable("conversations")
        .set({
          pending_results_json: JSON.stringify(pending.slice(-200)),
          updated_at: now,
        })
        .where("chat_key", "=", GLOBAL_CONVERSATION_KEY)
        .execute();
    });
  }

  // One-shot drain at the start of an invocation (ADR-0002 / ADR-0014).
  public async drainPendingResults(): Promise<OutputResult[]> {
    const now = Date.now();

    return this.#database.writeTx(async (trx) => {
      const row = await trx
        .selectFrom("conversations")
        .select(["pending_results_json"])
        .where("chat_key", "=", GLOBAL_CONVERSATION_KEY)
        .executeTakeFirst();

      if (!row) {
        return [];
      }

      const pending = JSON.parse(row.pending_results_json) as OutputResult[];

      if (pending.length === 0) {
        return [];
      }

      await trx
        .updateTable("conversations")
        .set({ pending_results_json: "[]", updated_at: now })
        .where("chat_key", "=", GLOBAL_CONVERSATION_KEY)
        .execute();

      return pending;
    });
  }

  public async appendTurn(
    sessionId: string,
    turnMessages: TurnMessage[],
    meta?: { chatKey?: string; turnId?: string },
  ): Promise<ConversationRecord | null> {
    if (turnMessages.length === 0) {
      return this.get();
    }

    const now = Date.now();
    const chatKey = meta?.chatKey ?? "";
    const turnId = meta?.turnId ?? randomUUID();

    const updated = await this.#database.writeTx(async (trx) => {
      const head = await trx
        .selectFrom("conversations")
        .selectAll()
        .where("chat_key", "=", GLOBAL_CONVERSATION_KEY)
        .where("session_id", "=", sessionId)
        .executeTakeFirst();

      if (!head) {
        return null;
      }

      for (const msg of turnMessages) {
        await trx
          .insertInto("tape_entries")
          .values({
            tape_id: GLOBAL_CONVERSATION_KEY,
            kind: "message",
            turn_id: turnId,
            chat_key: chatKey,
            role: msg.role,
            payload_json: JSON.stringify(msg),
            sidecar_id: extractSidecarId(msg),
            created_at: now,
          })
          .execute();
      }

      const saved = await trx
        .updateTable("conversations")
        .set({ updated_at: now })
        .where("chat_key", "=", GLOBAL_CONVERSATION_KEY)
        .where("session_id", "=", sessionId)
        .returningAll()
        .executeTakeFirstOrThrow();

      return this.#assembleView(trx, saved);
    });

    if (updated) {
      this.#events.emit({
        type: "conversation_update",
        data: { sessionId: updated.sessionId },
      });
    }

    return updated;
  }

  public async appendCompactAnchor(
    sessionId: string,
    cutoffEntryId: number,
    handoff: TapeHandoff,
  ): Promise<TapeEntryRecord | null> {
    const now = Date.now();

    const anchor = await this.#database.writeTx(async (trx) => {
      const head = await trx
        .selectFrom("conversations")
        .select(["session_id"])
        .where("chat_key", "=", GLOBAL_CONVERSATION_KEY)
        .where("session_id", "=", sessionId)
        .executeTakeFirst();

      if (!head) {
        return null;
      }

      const payload: TapeAnchorPayload = {
        reason: "compact",
        sessionId,
        cutoffEntryId,
        handoff,
      };
      const row = await trx
        .insertInto("tape_entries")
        .values({
          tape_id: GLOBAL_CONVERSATION_KEY,
          kind: "anchor",
          turn_id: "",
          chat_key: "",
          role: "anchor",
          payload_json: JSON.stringify(payload),
          sidecar_id: null,
          created_at: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      await trx
        .updateTable("conversations")
        .set({ summary: handoff.summary, updated_at: now })
        .where("chat_key", "=", GLOBAL_CONVERSATION_KEY)
        .where("session_id", "=", sessionId)
        .execute();

      return decodeTapeEntry(row);
    });

    if (anchor) {
      this.#events.emit({
        type: "conversation_update",
        data: { sessionId },
      });
    }

    return anchor;
  }

  public async reset(afterMessageId = 0): Promise<ConversationRecord> {
    const now = Date.now();
    const nextSessionId = randomUUID();

    const record = await this.#database.writeTx(async (trx) => {
      const values = {
        chat_key: GLOBAL_CONVERSATION_KEY,
        session_id: nextSessionId,
        summary: "",
        messages_json: "[]",
        pending_results_json: "[]",
        after_message_id: afterMessageId,
        updated_at: now,
      };

      const head = await trx
        .insertInto("conversations")
        .values(values)
        .onConflict((oc) => oc.column("chat_key").doUpdateSet(values))
        .returningAll()
        .executeTakeFirstOrThrow();

      const payload: TapeAnchorPayload = {
        reason: "reset",
        sessionId: nextSessionId,
        afterMessageId,
        cutoffEntryId: 0,
      };

      await trx
        .insertInto("tape_entries")
        .values({
          tape_id: GLOBAL_CONVERSATION_KEY,
          kind: "anchor",
          turn_id: "",
          chat_key: "",
          role: "anchor",
          payload_json: JSON.stringify(payload),
          sidecar_id: null,
          created_at: now,
        })
        .execute();

      return this.#assembleView(trx, head);
    });

    this.#events.emit({
      type: "conversation_update",
      data: { sessionId: record.sessionId },
    });

    return record;
  }

  public async appendSidecar(
    sidecarId: string,
    meta: { chatKey: string; kind: string; task: string; forked: boolean },
    turnMessages: TurnMessage[],
  ): Promise<void> {
    const now = Date.now();
    const tapeId = `sidecar:${sidecarId}`;
    const userMsg: TurnMessage = {
      role: "user",
      content: JSON.stringify({
        kind: meta.kind,
        task: meta.task,
        forked: meta.forked,
      }),
    };

    await this.#database.writeTx(async (trx) => {
      for (const msg of [userMsg, ...turnMessages]) {
        await trx
          .insertInto("tape_entries")
          .values({
            tape_id: tapeId,
            kind: "message",
            turn_id: sidecarId,
            chat_key: meta.chatKey,
            role: msg.role,
            payload_json: JSON.stringify(msg),
            sidecar_id: null,
            created_at: now,
          })
          .execute();
      }
    });
  }

  public async listEntries(options?: {
    tapeId?: string;
    limit?: number;
    beforeId?: number;
    afterId?: number;
  }): Promise<TapeEntryRecord[]> {
    const tapeId = options?.tapeId?.trim() || GLOBAL_CONVERSATION_KEY;
    const limit = Math.min(500, Math.max(1, options?.limit ?? 200));

    let query = this.#database.db
      .selectFrom("tape_entries")
      .selectAll()
      .where("tape_id", "=", tapeId);

    if (options?.beforeId !== undefined) {
      query = query.where("id", "<", options.beforeId);
    }

    if (options?.afterId !== undefined) {
      query = query.where("id", ">", options.afterId);
    }

    const rows = await query.orderBy("id", "desc").limit(limit).execute();

    return rows.reverse().map(decodeTapeEntry);
  }

  public async getEntriesByIds(
    ids: number[],
    tapeId = GLOBAL_CONVERSATION_KEY,
  ): Promise<TapeEntryRecord[]> {
    const cleanIds = [
      ...new Set(ids.filter((id) => Number.isInteger(id) && id > 0)),
    ];

    if (cleanIds.length === 0) {
      return [];
    }

    const rows = await this.#database.db
      .selectFrom("tape_entries")
      .selectAll()
      .where("tape_id", "=", tapeId)
      .where("id", "in", cleanIds)
      .orderBy("id", "asc")
      .execute();

    return rows.map(decodeTapeEntry);
  }

  async #assembleView(
    db: BerryDb,
    head: Selectable<BerryTables["conversations"]>,
    options?: { role?: AccessRole; chatKey?: string },
  ): Promise<ConversationRecord & { scopedToChat: boolean }> {
    const latestAnchorRow = await db
      .selectFrom("tape_entries")
      .selectAll()
      .where("tape_id", "=", GLOBAL_CONVERSATION_KEY)
      .where("kind", "=", "anchor")
      .orderBy("id", "desc")
      .limit(1)
      .executeTakeFirst();

    const latestAnchor = latestAnchorRow
      ? decodeTapeEntry(latestAnchorRow)
      : null;
    const anchorPayload =
      latestAnchor?.kind === "anchor" ? latestAnchor.anchor : null;
    const startAfterId =
      anchorPayload?.reason === "compact"
        ? anchorPayload.cutoffEntryId
        : (latestAnchor?.id ?? 0);

    const scopedToChat = Boolean(
      options?.role && options.role !== "admin" && options.chatKey,
    );

    let msgQuery = db
      .selectFrom("tape_entries")
      .selectAll()
      .where("tape_id", "=", GLOBAL_CONVERSATION_KEY)
      .where("kind", "=", "message")
      .where("id", ">", startAfterId);

    if (scopedToChat && options?.chatKey) {
      msgQuery = msgQuery.where("chat_key", "=", options.chatKey);
    }

    const msgRows = await msgQuery.orderBy("id", "asc").execute();
    const entries = msgRows.map(decodeTapeEntry);
    const messages = entries
      .filter(
        (entry): entry is Extract<TapeEntryRecord, { kind: "message" }> =>
          entry.kind === "message",
      )
      .map((entry) => entry.message);
    const handoff = scopedToChat ? null : (anchorPayload?.handoff ?? null);

    return {
      chatKey: head.chat_key,
      sessionId: head.session_id,
      summary: handoff?.summary ?? "",
      handoff,
      anchorEntryId: latestAnchor?.id ?? null,
      messages,
      entries,
      pendingResults: JSON.parse(head.pending_results_json) as OutputResult[],
      afterMessageId: head.after_message_id,
      updatedAt: head.updated_at,
      scopedToChat,
    };
  }

  async #ensureRow(trx: BerryDb, now: number): Promise<void> {
    await trx
      .insertInto("conversations")
      .values({
        chat_key: GLOBAL_CONVERSATION_KEY,
        session_id: randomUUID(),
        summary: "",
        messages_json: "[]",
        pending_results_json: "[]",
        after_message_id: 0,
        updated_at: now,
      })
      .onConflict((oc) => oc.column("chat_key").doNothing())
      .execute();
  }
}
