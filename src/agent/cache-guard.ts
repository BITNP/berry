import { createHash } from "node:crypto";

import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";

import { Logger } from "../utils/logger.ts";

const MIN_TOKENS_FOR_HIT_CHECK = 2048;
const MAX_CACHE_WINDOW_MS = 5 * 60_000;
const MIN_HIT_RATIO = 0.3;

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

interface BaselineSnapshot {
  sessionKey: string;
  toolsHash: string;
  systemHash: string;
  messageHashes: string[];
  transientUserIndex: number | null;
  lastRequestAt: number;
}

export interface CacheCheckHandle {
  readonly reasons: readonly string[];
  commit: (usage: {
    inputTokens: number;
    cachedInputTokens: number;
    now?: number;
  }) => string | null;
}

export const makeCacheSessionKey = (
  sessionId: string,
  summary: string,
  scopeTag = "global",
): string => `${sessionId}:${sha256(summary)}:${scopeTag}`;

export class DialogCacheGuard {
  #baselines = new Map<string, BaselineSnapshot>();
  #logger = new Logger("cache-guard");

  public inspect(input: {
    purpose: string;
    sessionKey: string;
    chatKey?: string | null;
    messages: ChatCompletionMessageParam[];
    tools?: ChatCompletionTool[];
    transientUserIndex?: number | null;
  }): CacheCheckHandle | null {
    if (input.purpose !== "dialog") {
      return null;
    }

    const systemMsg =
      input.messages[0]?.role === "system" ? input.messages[0] : null;
    const nonSystem = systemMsg ? input.messages.slice(1) : input.messages;
    const toolsHash = sha256(JSON.stringify(input.tools ?? []));
    const systemHash = sha256(JSON.stringify(systemMsg));
    const messageHashes = nonSystem.map((msg) => sha256(JSON.stringify(msg)));

    const bucketKey = input.chatKey ?? "__global__";
    const prev = this.#baselines.get(bucketKey) ?? null;
    const baselineChanged = prev?.sessionKey !== input.sessionKey;
    const reasons: string[] = [];

    if (!baselineChanged && prev) {
      if (toolsHash !== prev.toolsHash) {
        reasons.push("tools 定义发生变化");
      }

      if (systemHash !== prev.systemHash) {
        reasons.push("system 提示词发生变化");
      }

      if (messageHashes.length < prev.messageHashes.length) {
        reasons.push("历史消息长度意外缩短");
      } else {
        for (let i = 0; i < prev.messageHashes.length; i++) {
          if (messageHashes[i] === prev.messageHashes[i]) {
            continue;
          }

          // Allow the single expected cross-turn strip of the prior turn's transient user envelope.
          if (i === prev.transientUserIndex && nonSystem[i]?.role === "user") {
            continue;
          }

          reasons.push(`历史消息 #${i} 发生非追加修改`);

          break;
        }
      }
    }

    const prevRequestAt = prev?.lastRequestAt ?? 0;

    return {
      reasons,
      commit: ({ inputTokens, cachedInputTokens, now = Date.now() }) => {
        if (!this.#baselines.has(bucketKey) && this.#baselines.size >= 64) {
          const oldestKey = this.#baselines.keys().next().value;

          if (oldestKey !== undefined) {
            this.#baselines.delete(oldestKey);
          }
        }

        this.#baselines.set(bucketKey, {
          sessionKey: input.sessionKey,
          toolsHash,
          systemHash,
          messageHashes,
          transientUserIndex: input.transientUserIndex ?? null,
          lastRequestAt: now,
        });

        const lowHit =
          !baselineChanged &&
          prevRequestAt > 0 &&
          inputTokens >= MIN_TOKENS_FOR_HIT_CHECK &&
          now - prevRequestAt <= MAX_CACHE_WINDOW_MS &&
          cachedInputTokens / inputTokens < MIN_HIT_RATIO;

        let warning: string | null = null;

        if (lowHit) {
          const pct = Math.round((cachedInputTokens / inputTokens) * 100);

          warning =
            reasons.length > 0
              ? `${reasons.join("；")}；缓存命中率偏低（${pct}%）`
              : `前缀未变但缓存命中率偏低（${pct}%）`;
        } else if (reasons.length > 0) {
          warning = reasons.join("；");
        }

        if (warning) {
          this.#logger.warn("Dialog prefix cache warning", {
            chatKey: input.chatKey ?? null,
            warning,
            inputTokens,
            cachedInputTokens,
          });
        }

        return warning;
      },
    };
  }
}
