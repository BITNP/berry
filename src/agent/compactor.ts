import { Type } from "typebox";

import type { RuntimeSettings } from "../config/settings.ts";
import { resolveThinkingEffort } from "../config/settings.ts";
import type { Store } from "../store/index.ts";
import { Logger } from "../utils/logger.ts";
import { errorMessage } from "../utils/time.ts";
import { runChatToolLoop } from "./loop.ts";

const COMPACTION_MAX_MESSAGES = 100;
const COMPACTION_KEEP_RECENT_TURNS = 12;

const compactionOutputSchema = Type.Object(
  {
    summary: Type.String({ minLength: 1 }),
    confirmedFacts: Type.Optional(Type.Array(Type.String())),
    openTasks: Type.Optional(Type.Array(Type.String())),
    pendingFollowups: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: false },
);

export class ConversationCompactor {
  #store: Store;
  #logger = new Logger("agent:compactor");
  #compacting = false;

  constructor(store: Store) {
    this.#store = store;
  }

  public async maybeCompact(
    settings: RuntimeSettings,
    lastPromptTokens: number,
  ): Promise<void> {
    if (this.#compacting) {
      return;
    }

    this.#compacting = true;

    try {
      const conversation = await this.#store.conversations.get();

      if (!conversation || conversation.entries.length === 0) {
        return;
      }

      const msgEntries = conversation.entries.filter(
        (entry) => entry.kind === "message",
      );
      const budget =
        settings.mainModel.contextTokens -
        settings.mainModel.maxOutputTokens -
        4096;
      const overTokenBudget = lastPromptTokens >= budget * 0.75;
      const overMessageLimit = msgEntries.length >= COMPACTION_MAX_MESSAGES;

      if (!overTokenBudget && !overMessageLimit) {
        return;
      }

      // Split along clean user-turn boundaries without heuristic token estimation.
      const userIndices: number[] = [];

      for (const [i, msgEntry] of msgEntries.entries()) {
        if (msgEntry.role === "user") {
          userIndices.push(i);
        }
      }

      if (userIndices.length <= 1) {
        return;
      }

      const keepTurns = overTokenBudget
        ? Math.max(
            1,
            Math.min(
              COMPACTION_KEEP_RECENT_TURNS,
              Math.floor(
                (userIndices.length * 0.3 * budget) / lastPromptTokens,
              ),
            ),
          )
        : Math.min(COMPACTION_KEEP_RECENT_TURNS, userIndices.length - 1);
      const turnCursor = Math.max(1, userIndices.length - keepTurns);
      const splitIndex = userIndices[turnCursor]!;
      const archivedEntries = msgEntries.slice(0, splitIndex);
      const cutoffEntryId = archivedEntries.at(-1)?.id;

      if (!cutoffEntryId) {
        return;
      }

      const res = await runChatToolLoop({
        purpose: "compaction",
        chatKey: null,
        settings,
        store: this.#store,
        systemPrompt:
          '你是会话历史压缩器。将已有结构化交接摘要（previousHandoff）和即将归档的 Tape 条目整理为紧凑中文结构化交接契约（Handoff），作为后续推理的索引提示（原始条目永久保留在 Tape 中可按 ID 回查）。只输出 JSON：{"summary":"一句话或几句总览","confirmedFacts":["已确认事实或结论"],"openTasks":["未完成任务或编号"],"pendingFollowups":["待跟进事项"]}',
        history: [],
        userContent: JSON.stringify({
          previousHandoff: conversation.handoff,
          archivedEntries: archivedEntries.map((entry) => ({
            entryId: entry.id,
            chatKey: entry.chatKey,
            role: entry.role,
            message: entry.message,
          })),
        }),
        tools: [],
        maxRounds: 3,
        outputSchema: compactionOutputSchema,
        thinkingEffort: resolveThinkingEffort(settings, "compaction"),
      });

      const summary = res.structured.summary.trim();

      if (!summary) {
        throw new Error("必须返回非空字符串 summary");
      }

      const handoff = {
        summary,
        confirmedFacts: (res.structured.confirmedFacts ?? []).filter(Boolean),
        openTasks: (res.structured.openTasks ?? []).filter(Boolean),
        pendingFollowups: (res.structured.pendingFollowups ?? []).filter(
          Boolean,
        ),
        sourceEntryIds: archivedEntries.map((entry) => entry.id),
      };
      const anchor = await this.#store.conversations.appendCompactAnchor(
        conversation.sessionId,
        cutoffEntryId,
        handoff,
      );

      if (anchor) {
        this.#logger.info("Conversation compacted via append-only anchor", {
          anchorEntryId: anchor.id,
          cutoffEntryId,
          consumedEntries: archivedEntries.length,
          lastPromptTokens,
        });
      }
    } catch (error) {
      this.#logger.warn("Conversation compaction failed", {
        error: errorMessage(error),
      });
    } finally {
      this.#compacting = false;
    }
  }
}
