import type { Selectable } from "kysely";

import type { ChatKey, MessageReactionRecord } from "../types.ts";
import type { BerryDatabase } from "./database.ts";
import type { BerryTables } from "./schema.ts";

const decodeReaction = (
  row: Selectable<BerryTables["message_reactions"]>,
): MessageReactionRecord => ({
  chatKey: row.chat_key as ChatKey,
  onebotMessageId: row.onebot_message_id,
  emojiId: row.emoji_id,
  emojiName: row.emoji_name,
  userId: row.user_id,
  updatedAt: row.updated_at,
});

export interface ReactionAggregate {
  emojiId: string;
  emojiName: string;
  count: number;
  userIds: string[];
}

export class ReactionsStore {
  #database: BerryDatabase;

  constructor(database: BerryDatabase) {
    this.#database = database;
  }

  public async apply(input: {
    chatKey: ChatKey;
    onebotMessageId: string;
    emojiId: string;
    emojiName: string;
    userId: string;
    set: boolean;
  }): Promise<void> {
    const now = Date.now();

    await this.#database.writeTx(async (trx) => {
      if (input.set) {
        await trx
          .insertInto("message_reactions")
          .values({
            chat_key: input.chatKey,
            onebot_message_id: input.onebotMessageId,
            emoji_id: input.emojiId,
            emoji_name: input.emojiName,
            user_id: input.userId,
            updated_at: now,
          })
          .onConflict((oc) =>
            oc
              .columns(["chat_key", "onebot_message_id", "emoji_id", "user_id"])
              .doUpdateSet({
                emoji_name: input.emojiName,
                updated_at: now,
              }),
          )
          .execute();
      } else {
        await trx
          .deleteFrom("message_reactions")
          .where("chat_key", "=", input.chatKey)
          .where("onebot_message_id", "=", input.onebotMessageId)
          .where("emoji_id", "=", input.emojiId)
          .where("user_id", "=", input.userId)
          .execute();
      }
    });
  }

  public async aggregateForMessages(
    chatKey: ChatKey,
    onebotMessageIds: string[],
  ): Promise<Map<string, ReactionAggregate[]>> {
    const result = new Map<string, ReactionAggregate[]>();

    if (onebotMessageIds.length === 0) {
      return result;
    }

    const rows = await this.#database.db
      .selectFrom("message_reactions")
      .selectAll()
      .where("chat_key", "=", chatKey)
      .where("onebot_message_id", "in", onebotMessageIds)
      .orderBy("updated_at", "asc")
      .execute();

    const perMsg = new Map<string, Map<string, ReactionAggregate>>();

    for (const row of rows.map(decodeReaction)) {
      let emojiMap = perMsg.get(row.onebotMessageId);

      if (!emojiMap) {
        emojiMap = new Map();
        perMsg.set(row.onebotMessageId, emojiMap);
      }

      const existing = emojiMap.get(row.emojiId);

      if (existing) {
        existing.count++;
        existing.userIds.push(row.userId);
      } else {
        emojiMap.set(row.emojiId, {
          emojiId: row.emojiId,
          emojiName: row.emojiName,
          count: 1,
          userIds: [row.userId],
        });
      }
    }

    for (const [msgId, emojiMap] of perMsg) {
      result.set(msgId, [...emojiMap.values()]);
    }

    return result;
  }
}
