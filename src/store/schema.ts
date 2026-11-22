import type { Generated, Kysely } from "kysely";
import { sql } from "kysely";
import type { Migration, MigrationProvider } from "kysely/migration";
import { Migrator } from "kysely/migration";

export interface BerryTables {
  settings: {
    id: number;
    data_json: string;
    updated_at: number;
  };
  chats: {
    chat_key: string;
    kind: string;
    chat_id: string;
    title: string;
    enabled: number;
    trigger_mode: string;
    style_prompt: string;
    internal: number;
    created_at: number;
    updated_at: number;
  };
  messages: {
    id: Generated<number>;
    chat_key: string;
    kind: string;
    chat_id: string;
    onebot_message_id: string;
    user_id: string;
    sender_name: string;
    text: string;
    segments_json: string;
    reply_to_message_id: string | null;
    is_bot: number;
    mentioned_bot: number;
    quoted_bot: number;
    recalled_at: number | null;
    sent_at: number;
    received_at: number;
  };
  gate_decisions: {
    id: Generated<number>;
    chat_key: string;
    message_id: number | null;
    action: string;
    stage: string;
    confidence: number;
    reason: string;
    model: string;
    duration_ms: number;
    created_at: number;
  };
  conversations: {
    chat_key: string;
    session_id: string;
    summary: string;
    messages_json: string;
    pending_results_json: string;
    after_message_id: number;
    updated_at: number;
  };
  tape_entries: {
    id: Generated<number>;
    tape_id: string;
    kind: string;
    turn_id: string;
    chat_key: string;
    role: string;
    payload_json: string;
    sidecar_id: string | null;
    created_at: number;
  };
  memories: {
    id: Generated<number>;
    scope: string;
    owner_id: string;
    key: string;
    summary: string;
    content: string;
    source_message_id: number | null;
    expires_at: number | null;
    updated_at: number;
  };
  jobs: {
    id: Generated<number>;
    kind: string;
    dedupe_key: string;
    chat_key: string;
    payload_json: string;
    state: string;
    attempts: number;
    run_after: number;
    last_error: string | null;
    created_at: number;
    updated_at: number;
  };
  deliveries: {
    id: Generated<number>;
    chat_key: string;
    kind: string;
    payload_json: string;
    gateway_delivery_id: string | null;
    status: string;
    attempts: number;
    error: string | null;
    onebot_message_id: string | null;
    created_at: number;
    updated_at: number;
  };
  schedules: {
    id: string;
    title: string;
    chat_key: string;
    kind: string;
    chat_id: string;
    content: string;
    schedule_json: string;
    enabled: number;
    next_run_at: number | null;
    last_run_at: number | null;
    created_at: number;
    updated_at: number;
  };
  cursors: {
    name: string;
    value: string;
    updated_at: number;
  };
  guild_audit_logs: {
    id: Generated<number>;
    chat_key: string;
    qq_user_id: string;
    actor_subject: string;
    actor_name: string;
    action: string;
    node_id: number | null;
    target_title: string;
    request_json: string;
    response_json: string;
    error: string | null;
    created_at: number;
  };
  llm_usage: {
    id: Generated<number>;
    day: string;
    purpose: string;
    model: string;
    chat_key: string | null;
    status: string;
    input_tokens: number;
    cached_input_tokens: number;
    output_tokens: number;
    duration_ms: number;
    request_preview: string | null;
    response_text: string | null;
    tool_calls_json: string | null;
    error: string | null;
    cache_warning: string | null;
    job_id: number | null;
    message_ids_json: string | null;
    created_at: number;
  };
  admin_sessions: {
    id: string;
    subject: string;
    name: string;
    email: string;
    avatar: string;
    permissions_json: string;
    csrf_token: string;
    expires_at: number;
    created_at: number;
  };
  message_assets: {
    id: Generated<number>;
    message_id: number;
    chat_key: string;
    kind: string;
    raw_url: string;
    file_path: string | null;
    mime_type: string;
    sha256: string;
    transcript: string | null;
    status: string;
    error: string | null;
    updated_at: number;
  };
  message_reactions: {
    chat_key: string;
    onebot_message_id: string;
    emoji_id: string;
    emoji_name: string;
    user_id: string;
    updated_at: number;
  };
  jargon_entries: {
    id: Generated<number>;
    chat_key: string;
    term: string;
    aliases_json: string;
    meaning: string;
    status: string;
    source: string;
    created_at: number;
    updated_at: number;
  };
  member_impressions: {
    user_id: string;
    display_name: string;
    impression: string;
    source: string;
    locked: number;
    updated_at: number;
  };
  stickers: {
    id: Generated<number>;
    sha256: string;
    file_path: string;
    mime_type: string;
    meaning: string;
    tags_json: string;
    source_chat_key: string;
    status: string;
    enabled: number;
    use_count: number;
    created_at: number;
    updated_at: number;
  };
}

export type BerryDb = Kysely<BerryTables>;

const migrations: Record<string, Migration> = {
  "001_initial_schema": {
    async up(db) {
      await db.schema
        .createTable("settings")
        .ifNotExists()
        .addColumn("id", "integer", (c) => c.primaryKey())
        .addColumn("data_json", "text", (c) => c.notNull())
        .addColumn("updated_at", "integer", (c) => c.notNull())
        .execute();

      await db.schema
        .createTable("chats")
        .ifNotExists()
        .addColumn("chat_key", "text", (c) => c.primaryKey())
        .addColumn("kind", "text", (c) => c.notNull())
        .addColumn("chat_id", "text", (c) => c.notNull())
        .addColumn("title", "text", (c) => c.notNull().defaultTo(""))
        .addColumn("enabled", "integer", (c) => c.notNull().defaultTo(1))
        .addColumn("trigger_mode", "text", (c) =>
          c.notNull().defaultTo("mention_only"),
        )
        .addColumn("created_at", "integer", (c) => c.notNull())
        .addColumn("updated_at", "integer", (c) => c.notNull())
        .execute();

      await db.schema
        .createTable("messages")
        .ifNotExists()
        .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
        .addColumn("chat_key", "text", (c) => c.notNull())
        .addColumn("kind", "text", (c) => c.notNull())
        .addColumn("chat_id", "text", (c) => c.notNull())
        .addColumn("onebot_message_id", "text", (c) => c.notNull())
        .addColumn("user_id", "text", (c) => c.notNull())
        .addColumn("sender_name", "text", (c) => c.notNull())
        .addColumn("text", "text", (c) => c.notNull())
        .addColumn("segments_json", "text", (c) => c.notNull())
        .addColumn("reply_to_message_id", "text")
        .addColumn("is_bot", "integer", (c) => c.notNull().defaultTo(0))
        .addColumn("mentioned_bot", "integer", (c) => c.notNull().defaultTo(0))
        .addColumn("quoted_bot", "integer", (c) => c.notNull().defaultTo(0))
        .addColumn("recalled_at", "integer")
        .addColumn("sent_at", "integer", (c) => c.notNull())
        .addColumn("received_at", "integer", (c) => c.notNull())
        .addUniqueConstraint("uq_messages_chat_onebot", [
          "chat_key",
          "onebot_message_id",
        ])
        .execute();

      await db.schema
        .createIndex("idx_messages_chat_id")
        .ifNotExists()
        .on("messages")
        .columns(["chat_key", "id"])
        .execute();

      await db.schema
        .createIndex("idx_messages_chat_sent")
        .ifNotExists()
        .on("messages")
        .columns(["chat_key", "sent_at"])
        .execute();

      await db.schema
        .createTable("gate_decisions")
        .ifNotExists()
        .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
        .addColumn("chat_key", "text", (c) => c.notNull())
        .addColumn("message_id", "integer")
        .addColumn("action", "text", (c) => c.notNull())
        .addColumn("stage", "text", (c) => c.notNull())
        .addColumn("confidence", "real", (c) => c.notNull())
        .addColumn("reason", "text", (c) => c.notNull())
        .addColumn("model", "text", (c) => c.notNull())
        .addColumn("duration_ms", "integer", (c) => c.notNull())
        .addColumn("created_at", "integer", (c) => c.notNull())
        .execute();

      await db.schema
        .createIndex("idx_gate_created")
        .ifNotExists()
        .on("gate_decisions")
        .columns(["created_at"])
        .execute();

      await db.schema
        .createIndex("idx_gate_action_created")
        .ifNotExists()
        .on("gate_decisions")
        .columns(["action", "created_at"])
        .execute();

      await db.schema
        .createIndex("idx_gate_chat_created")
        .ifNotExists()
        .on("gate_decisions")
        .columns(["chat_key", "created_at"])
        .execute();

      await db.schema
        .createTable("conversations")
        .ifNotExists()
        .addColumn("chat_key", "text", (c) => c.primaryKey())
        .addColumn("session_id", "text", (c) => c.notNull())
        .addColumn("summary", "text", (c) => c.notNull())
        .addColumn("messages_json", "text", (c) => c.notNull())
        .addColumn("pending_results_json", "text", (c) => c.notNull())
        .addColumn("after_message_id", "integer", (c) =>
          c.notNull().defaultTo(0),
        )
        .addColumn("updated_at", "integer", (c) => c.notNull())
        .execute();

      await db.schema
        .createTable("memories")
        .ifNotExists()
        .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
        .addColumn("scope", "text", (c) => c.notNull())
        .addColumn("owner_id", "text", (c) => c.notNull())
        .addColumn("key", "text", (c) => c.notNull())
        .addColumn("summary", "text", (c) => c.notNull())
        .addColumn("content", "text", (c) => c.notNull())
        .addColumn("source_message_id", "integer")
        .addColumn("updated_at", "integer", (c) => c.notNull())
        .addUniqueConstraint("uq_memories_scope_owner_key", [
          "scope",
          "owner_id",
          "key",
        ])
        .execute();

      await db.schema
        .createTable("jobs")
        .ifNotExists()
        .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
        .addColumn("kind", "text", (c) => c.notNull())
        .addColumn("dedupe_key", "text", (c) => c.notNull().unique())
        .addColumn("chat_key", "text", (c) => c.notNull())
        .addColumn("payload_json", "text", (c) => c.notNull())
        .addColumn("state", "text", (c) => c.notNull().defaultTo("pending"))
        .addColumn("attempts", "integer", (c) => c.notNull().defaultTo(0))
        .addColumn("run_after", "integer", (c) => c.notNull())
        .addColumn("last_error", "text")
        .addColumn("created_at", "integer", (c) => c.notNull())
        .addColumn("updated_at", "integer", (c) => c.notNull())
        .execute();

      await db.schema
        .createIndex("idx_jobs_state_run")
        .ifNotExists()
        .on("jobs")
        .columns(["state", "run_after"])
        .execute();

      await db.schema
        .createTable("deliveries")
        .ifNotExists()
        .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
        .addColumn("chat_key", "text", (c) => c.notNull())
        .addColumn("kind", "text", (c) => c.notNull())
        .addColumn("payload_json", "text", (c) => c.notNull())
        .addColumn("gateway_delivery_id", "text")
        .addColumn("status", "text", (c) => c.notNull())
        .addColumn("attempts", "integer", (c) => c.notNull().defaultTo(0))
        .addColumn("error", "text")
        .addColumn("onebot_message_id", "text")
        .addColumn("created_at", "integer", (c) => c.notNull())
        .addColumn("updated_at", "integer", (c) => c.notNull())
        .execute();

      await db.schema
        .createIndex("idx_deliveries_created")
        .ifNotExists()
        .on("deliveries")
        .columns(["created_at"])
        .execute();

      await db.schema
        .createTable("schedules")
        .ifNotExists()
        .addColumn("id", "text", (c) => c.primaryKey())
        .addColumn("title", "text", (c) => c.notNull())
        .addColumn("chat_key", "text", (c) => c.notNull())
        .addColumn("kind", "text", (c) => c.notNull())
        .addColumn("chat_id", "text", (c) => c.notNull())
        .addColumn("content", "text", (c) => c.notNull())
        .addColumn("schedule_json", "text", (c) => c.notNull())
        .addColumn("enabled", "integer", (c) => c.notNull().defaultTo(1))
        .addColumn("next_run_at", "integer")
        .addColumn("last_run_at", "integer")
        .addColumn("created_at", "integer", (c) => c.notNull())
        .addColumn("updated_at", "integer", (c) => c.notNull())
        .execute();

      await db.schema
        .createTable("cursors")
        .ifNotExists()
        .addColumn("name", "text", (c) => c.primaryKey())
        .addColumn("value", "text", (c) => c.notNull())
        .addColumn("updated_at", "integer", (c) => c.notNull())
        .execute();

      await db.schema
        .createTable("guild_audit_logs")
        .ifNotExists()
        .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
        .addColumn("chat_key", "text", (c) => c.notNull())
        .addColumn("qq_user_id", "text", (c) => c.notNull())
        .addColumn("actor_subject", "text", (c) => c.notNull())
        .addColumn("actor_name", "text", (c) => c.notNull())
        .addColumn("action", "text", (c) => c.notNull())
        .addColumn("node_id", "integer")
        .addColumn("target_title", "text", (c) => c.notNull())
        .addColumn("request_json", "text", (c) => c.notNull())
        .addColumn("response_json", "text", (c) => c.notNull())
        .addColumn("error", "text")
        .addColumn("created_at", "integer", (c) => c.notNull())
        .execute();

      await db.schema
        .createTable("llm_usage")
        .ifNotExists()
        .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
        .addColumn("day", "text", (c) => c.notNull())
        .addColumn("purpose", "text", (c) => c.notNull())
        .addColumn("model", "text", (c) => c.notNull())
        .addColumn("chat_key", "text")
        .addColumn("status", "text", (c) => c.notNull().defaultTo("ok"))
        .addColumn("input_tokens", "integer", (c) => c.notNull())
        .addColumn("cached_input_tokens", "integer", (c) => c.notNull())
        .addColumn("output_tokens", "integer", (c) => c.notNull())
        .addColumn("duration_ms", "integer", (c) => c.notNull())
        .addColumn("request_preview", "text")
        .addColumn("response_text", "text")
        .addColumn("tool_calls_json", "text")
        .addColumn("error", "text")
        .addColumn("created_at", "integer", (c) => c.notNull())
        .execute();

      await db.schema
        .createIndex("idx_usage_day_purpose")
        .ifNotExists()
        .on("llm_usage")
        .columns(["day", "purpose"])
        .execute();

      await db.schema
        .createTable("admin_sessions")
        .ifNotExists()
        .addColumn("id", "text", (c) => c.primaryKey())
        .addColumn("subject", "text", (c) => c.notNull())
        .addColumn("name", "text", (c) => c.notNull())
        .addColumn("email", "text", (c) => c.notNull())
        .addColumn("avatar", "text", (c) => c.notNull())
        .addColumn("permissions_json", "text", (c) => c.notNull())
        .addColumn("csrf_token", "text", (c) => c.notNull())
        .addColumn("expires_at", "integer", (c) => c.notNull())
        .addColumn("created_at", "integer", (c) => c.notNull())
        .execute();

      await db.schema
        .createTable("message_assets")
        .ifNotExists()
        .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
        .addColumn("message_id", "integer", (c) => c.notNull())
        .addColumn("chat_key", "text", (c) => c.notNull())
        .addColumn("kind", "text", (c) => c.notNull())
        .addColumn("raw_url", "text", (c) => c.notNull())
        .addColumn("file_path", "text")
        .addColumn("mime_type", "text", (c) => c.notNull().defaultTo(""))
        .addColumn("sha256", "text", (c) => c.notNull().defaultTo(""))
        .addColumn("transcript", "text")
        .addColumn("status", "text", (c) => c.notNull().defaultTo("pending"))
        .addColumn("error", "text")
        .addColumn("updated_at", "integer", (c) => c.notNull())
        .execute();

      await db.schema
        .createIndex("idx_message_assets_message")
        .ifNotExists()
        .on("message_assets")
        .columns(["message_id"])
        .execute();

      await db.schema
        .createIndex("idx_message_assets_sha256")
        .ifNotExists()
        .on("message_assets")
        .columns(["sha256"])
        .execute();

      await db.schema
        .createTable("message_reactions")
        .ifNotExists()
        .addColumn("chat_key", "text", (c) => c.notNull())
        .addColumn("onebot_message_id", "text", (c) => c.notNull())
        .addColumn("emoji_id", "text", (c) => c.notNull())
        .addColumn("emoji_name", "text", (c) => c.notNull())
        .addColumn("user_id", "text", (c) => c.notNull())
        .addColumn("updated_at", "integer", (c) => c.notNull())
        .addPrimaryKeyConstraint("pk_message_reactions", [
          "chat_key",
          "onebot_message_id",
          "emoji_id",
          "user_id",
        ])
        .execute();
    },
  },
  "002_llm_usage_trace_columns": {
    async up(db) {
      // One-time bridge for databases created before Migrator existed.
      const existing = await sql<{ name: string }>`
        pragma table_info(llm_usage)
      `.execute(db);
      const colSet = new Set(existing.rows.map((r) => r.name));

      if (!colSet.has("status")) {
        await db.schema
          .alterTable("llm_usage")
          .addColumn("status", "text", (c) => c.notNull().defaultTo("ok"))
          .execute();
      }

      for (const col of [
        "request_preview",
        "response_text",
        "tool_calls_json",
        "error",
      ] as const) {
        if (!colSet.has(col)) {
          await db.schema
            .alterTable("llm_usage")
            .addColumn(col, "text")
            .execute();
        }
      }

      await db.schema
        .createIndex("idx_usage_created_at")
        .ifNotExists()
        .on("llm_usage")
        .columns(["created_at"])
        .execute();
    },
  },
  "003_chats_internal": {
    async up(db) {
      const existing = await sql<{ name: string }>`
        pragma table_info(chats)
      `.execute(db);
      const colSet = new Set(existing.rows.map((r) => r.name));

      if (!colSet.has("internal")) {
        await db.schema
          .alterTable("chats")
          .addColumn("internal", "integer", (c) => c.notNull().defaultTo(0))
          .execute();
      }
    },
  },
  "004_memories_expires_at": {
    async up(db) {
      const existing = await sql<{ name: string }>`
        pragma table_info(memories)
      `.execute(db);
      const colSet = new Set(existing.rows.map((r) => r.name));

      if (!colSet.has("expires_at")) {
        await db.schema
          .alterTable("memories")
          .addColumn("expires_at", "integer")
          .execute();
      }

      await db.schema
        .createIndex("idx_memories_expires_at")
        .ifNotExists()
        .on("memories")
        .columns(["expires_at"])
        .execute();
    },
  },
  "005_tape_entries": {
    async up(db) {
      await db.schema
        .createTable("tape_entries")
        .ifNotExists()
        .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
        .addColumn("tape_id", "text", (c) => c.notNull())
        .addColumn("kind", "text", (c) => c.notNull())
        .addColumn("turn_id", "text", (c) => c.notNull().defaultTo(""))
        .addColumn("chat_key", "text", (c) => c.notNull().defaultTo(""))
        .addColumn("role", "text", (c) => c.notNull().defaultTo(""))
        .addColumn("payload_json", "text", (c) => c.notNull())
        .addColumn("sidecar_id", "text")
        .addColumn("created_at", "integer", (c) => c.notNull())
        .execute();

      await db.schema
        .createIndex("idx_tape_entries_tape_id")
        .ifNotExists()
        .on("tape_entries")
        .columns(["tape_id", "id"])
        .execute();

      await db.schema
        .createIndex("idx_tape_entries_tape_kind")
        .ifNotExists()
        .on("tape_entries")
        .columns(["tape_id", "kind", "id"])
        .execute();

      // Migrate any legacy single-row conversation state into append-only tape entries.
      const existingCount = await sql<{ count: number }>`
        select count(*) as count from tape_entries where tape_id = 'global'
      `.execute(db);

      if (Number(existingCount.rows[0]?.count ?? 0) > 0) {
        return;
      }

      const legacy = await sql<{
        session_id: string;
        summary: string;
        messages_json: string;
        updated_at: number;
      }>`
        select session_id, summary, messages_json, updated_at
        from conversations
        where chat_key = 'global'
        limit 1
      `.execute(db);
      const row = legacy.rows[0];

      if (!row) {
        return;
      }

      const ts = Number(row.updated_at || Date.now());

      if (row.summary?.trim()) {
        await sql`
          insert into tape_entries (tape_id, kind, turn_id, chat_key, role, payload_json, sidecar_id, created_at)
          values (
            'global',
            'anchor',
            '',
            '',
            'anchor',
            ${JSON.stringify({
              reason: "compact",
              sessionId: row.session_id,
              cutoffEntryId: 0,
              handoff: {
                summary: row.summary,
                confirmedFacts: [],
                openTasks: [],
                pendingFollowups: [],
                sourceEntryIds: [],
              },
            })},
            null,
            ${ts}
          )
        `.execute(db);
      }

      const parsed = JSON.parse(row.messages_json || "[]") as {
        role?: string;
      }[];

      for (const msg of parsed) {
        if (!msg || typeof msg.role !== "string") {
          continue;
        }

        await sql`
          insert into tape_entries (tape_id, kind, turn_id, chat_key, role, payload_json, sidecar_id, created_at)
          values (
            'global',
            'message',
            'legacy',
            '',
            ${msg.role},
            ${JSON.stringify(msg)},
            null,
            ${ts}
          )
        `.execute(db);
      }
    },
  },
  "006_llm_usage_cache_warning": {
    async up(db) {
      const existing = await sql<{ name: string }>`
        pragma table_info(llm_usage)
      `.execute(db);
      const colSet = new Set(existing.rows.map((r) => r.name));

      if (!colSet.has("cache_warning")) {
        await db.schema
          .alterTable("llm_usage")
          .addColumn("cache_warning", "text")
          .execute();
      }
    },
  },
  "007_llm_usage_trace_links": {
    async up(db) {
      const existing = await sql<{ name: string }>`
        pragma table_info(llm_usage)
      `.execute(db);
      const colSet = new Set(existing.rows.map((r) => r.name));

      if (!colSet.has("job_id")) {
        await db.schema
          .alterTable("llm_usage")
          .addColumn("job_id", "integer")
          .execute();
      }

      if (!colSet.has("message_ids_json")) {
        await db.schema
          .alterTable("llm_usage")
          .addColumn("message_ids_json", "text")
          .execute();
      }

      await sql`
        create index if not exists idx_llm_usage_job_id
        on llm_usage (job_id)
      `.execute(db);
    },
  },
  "008_chats_style_prompt": {
    async up(db) {
      const existing = await sql<{ name: string }>`
        pragma table_info(chats)
      `.execute(db);
      const colSet = new Set(existing.rows.map((r) => r.name));

      if (!colSet.has("style_prompt")) {
        await db.schema
          .alterTable("chats")
          .addColumn("style_prompt", "text", (c) => c.notNull().defaultTo(""))
          .execute();
      }
    },
  },
  "009_jargon_entries": {
    async up(db) {
      await db.schema
        .createTable("jargon_entries")
        .ifNotExists()
        .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
        .addColumn("chat_key", "text", (c) => c.notNull().defaultTo("global"))
        .addColumn("term", "text", (c) => c.notNull())
        .addColumn("aliases_json", "text", (c) => c.notNull().defaultTo("[]"))
        .addColumn("meaning", "text", (c) => c.notNull())
        .addColumn("status", "text", (c) => c.notNull().defaultTo("approved"))
        .addColumn("source", "text", (c) => c.notNull().defaultTo("manual"))
        .addColumn("created_at", "integer", (c) => c.notNull())
        .addColumn("updated_at", "integer", (c) => c.notNull())
        .addUniqueConstraint("uq_jargon_chat_term", ["chat_key", "term"])
        .execute();

      await db.schema
        .createIndex("idx_jargon_status_chat")
        .ifNotExists()
        .on("jargon_entries")
        .columns(["status", "chat_key"])
        .execute();
    },
  },
  "010_member_impressions": {
    async up(db) {
      await db.schema
        .createTable("member_impressions")
        .ifNotExists()
        .addColumn("user_id", "text", (c) => c.primaryKey())
        .addColumn("display_name", "text", (c) => c.notNull().defaultTo(""))
        .addColumn("impression", "text", (c) => c.notNull())
        .addColumn("source", "text", (c) => c.notNull().defaultTo("manual"))
        .addColumn("locked", "integer", (c) => c.notNull().defaultTo(0))
        .addColumn("updated_at", "integer", (c) => c.notNull())
        .execute();
    },
  },
  "011_stickers": {
    async up(db) {
      await db.schema
        .createTable("stickers")
        .ifNotExists()
        .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
        .addColumn("sha256", "text", (c) => c.notNull().unique())
        .addColumn("file_path", "text", (c) => c.notNull())
        .addColumn("mime_type", "text", (c) => c.notNull())
        .addColumn("meaning", "text", (c) => c.notNull().defaultTo(""))
        .addColumn("tags_json", "text", (c) => c.notNull().defaultTo("[]"))
        .addColumn("source_chat_key", "text", (c) => c.notNull().defaultTo(""))
        .addColumn("status", "text", (c) => c.notNull().defaultTo("pending"))
        .addColumn("enabled", "integer", (c) => c.notNull().defaultTo(1))
        .addColumn("use_count", "integer", (c) => c.notNull().defaultTo(0))
        .addColumn("created_at", "integer", (c) => c.notNull())
        .addColumn("updated_at", "integer", (c) => c.notNull())
        .execute();

      await db.schema
        .createIndex("idx_stickers_status_enabled")
        .ifNotExists()
        .on("stickers")
        .columns(["status", "enabled"])
        .execute();
    },
  },
};

const migrationProvider: MigrationProvider = {
  getMigrations: () => Promise.resolve(migrations),
};

export async function migrateBerryDatabase(db: BerryDb): Promise<void> {
  const migrator = new Migrator({
    db,
    provider: migrationProvider,
  });

  const { error } = await migrator.migrateToLatest();

  if (error) {
    throw error instanceof Error
      ? error
      : new Error(`Database migration failed: ${String(error)}`);
  }
}
