import type { Selectable } from "kysely";

import type {
  ChatConfig,
  ChatKey,
  ChatKind,
  GroupTriggerMode,
} from "../types.ts";
import { makeChatKey, parseChatKey } from "../utils/chat-key.ts";
import type { BerryDatabase } from "./database.ts";
import type { BerryTables } from "./schema.ts";

const decodeChat = (row: Selectable<BerryTables["chats"]>): ChatConfig => ({
  chatKey: row.chat_key as ChatKey,
  kind: row.kind as ChatKind,
  chatId: row.chat_id,
  title: row.title,
  enabled: Boolean(row.enabled),
  triggerMode: row.trigger_mode as GroupTriggerMode,
  stylePrompt: row.style_prompt ?? "",
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export class ChatsStore {
  #database: BerryDatabase;

  constructor(database: BerryDatabase) {
    this.#database = database;
  }

  public async ensure(
    kind: ChatKind,
    chatId: string,
    defaults: {
      title?: string;
      enabled: boolean;
      triggerMode: GroupTriggerMode;
    },
  ): Promise<ChatConfig> {
    const chatKey = makeChatKey(kind, chatId);
    const now = Date.now();

    await this.#database.writeTx(async (trx) => {
      await trx
        .insertInto("chats")
        .values({
          chat_key: chatKey,
          kind,
          chat_id: chatId,
          title: defaults.title ?? "",
          enabled: Number(defaults.enabled),
          trigger_mode: defaults.triggerMode,
          style_prompt: "",
          internal: 0,
          created_at: now,
          updated_at: now,
        })
        .onConflict((oc) => oc.column("chat_key").doNothing())
        .execute();

      if (defaults.title) {
        await trx
          .updateTable("chats")
          .set({ title: defaults.title, updated_at: now })
          .where("chat_key", "=", chatKey)
          .where("title", "=", "")
          .execute();
      }
    });

    return (await this.get(chatKey))!;
  }

  public async get(chatKey: string): Promise<ChatConfig | null> {
    const row = await this.#database.db
      .selectFrom("chats")
      .selectAll()
      .where("chat_key", "=", chatKey)
      .executeTakeFirst();

    return row ? decodeChat(row) : null;
  }

  public async list(): Promise<ChatConfig[]> {
    const rows = await this.#database.db
      .selectFrom("chats")
      .selectAll()
      .orderBy("updated_at", "desc")
      .execute();

    return rows.map(decodeChat);
  }

  public async upsert(input: {
    kind: ChatKind;
    chatId: string;
    title?: string;
    enabled: boolean;
    triggerMode: GroupTriggerMode;
    stylePrompt?: string;
  }): Promise<ChatConfig> {
    const chatKey = makeChatKey(input.kind, input.chatId);
    const now = Date.now();

    await this.#database.writeTx(async (trx) => {
      await trx
        .insertInto("chats")
        .values({
          chat_key: chatKey,
          kind: input.kind,
          chat_id: input.chatId,
          title: input.title ?? "",
          enabled: Number(input.enabled),
          trigger_mode: input.triggerMode,
          style_prompt: input.stylePrompt ?? "",
          internal: 0,
          created_at: now,
          updated_at: now,
        })
        .onConflict((oc) =>
          oc.column("chat_key").doUpdateSet({
            ...(input.title === undefined ? {} : { title: input.title }),
            enabled: Number(input.enabled),
            trigger_mode: input.triggerMode,
            ...(input.stylePrompt === undefined
              ? {}
              : { style_prompt: input.stylePrompt }),
            updated_at: now,
          }),
        )
        .execute();
    });

    return (await this.get(chatKey))!;
  }

  public async update(
    chatKey: string,
    patch: {
      title?: string;
      enabled?: boolean;
      triggerMode?: GroupTriggerMode;
      stylePrompt?: string;
    },
  ): Promise<ChatConfig> {
    const existing = await this.get(chatKey);

    if (!existing) {
      const parsed = parseChatKey(chatKey);

      return this.upsert({
        kind: parsed.kind,
        chatId: parsed.chatId,
        title: patch.title ?? "",
        enabled: patch.enabled ?? true,
        triggerMode: patch.triggerMode ?? "mention_only",
        stylePrompt: patch.stylePrompt ?? "",
      });
    }

    const now = Date.now();

    await this.#database.writeTx(async (trx) => {
      await trx
        .updateTable("chats")
        .set({
          ...(patch.title === undefined ? {} : { title: patch.title }),
          ...(patch.enabled === undefined
            ? {}
            : { enabled: Number(patch.enabled) }),
          ...(patch.triggerMode === undefined
            ? {}
            : { trigger_mode: patch.triggerMode }),
          ...(patch.stylePrompt === undefined
            ? {}
            : { style_prompt: patch.stylePrompt.trim().slice(0, 600) }),
          updated_at: now,
        })
        .where("chat_key", "=", chatKey)
        .execute();
    });

    return (await this.get(chatKey))!;
  }
}
