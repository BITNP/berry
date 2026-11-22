import type { Static } from "typebox";
import { Type } from "typebox";

import { resolveReactionEmojiId } from "../gateway/qface.ts";
import type { AccessRole } from "../identity/permissions.ts";
import type { Store } from "../store/index.ts";
import type {
  ChatKey,
  MessageRecord,
  OutputUnit,
  UnifiedInput,
} from "../types.ts";
import { Logger } from "../utils/logger.ts";
import { errorMessage } from "../utils/time.ts";
import type { ModelIds } from "./model-ids.ts";

const logger = new Logger("agent:dispatch");

export const outputUnitSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("qq_reply"),
      text: Type.String({ minLength: 1 }),
      quoteMessageId: Type.Optional(Type.String()),
      targetRef: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("qq_forward"),
      title: Type.String({ minLength: 1 }),
      items: Type.Array(
        Type.Object(
          { text: Type.String({ minLength: 1 }) },
          { additionalProperties: false },
        ),
        { minItems: 1 },
      ),
      targetRef: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("qq_reaction"),
      messageId: Type.String({ minLength: 1 }),
      emojiId: Type.String({ minLength: 1 }),
      remove: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("qq_poke"),
      userRef: Type.Optional(Type.String({ minLength: 1 })),
      targetRef: Type.Optional(Type.String({ minLength: 1 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("qq_image"),
      stickerId: Type.Integer({ minimum: 1 }),
      quoteMessageId: Type.Optional(Type.String({ minLength: 1 })),
      targetRef: Type.Optional(Type.String({ minLength: 1 })),
    },
    { additionalProperties: false },
  ),
]);

export type RawOutputUnit = Static<typeof outputUnitSchema>;

export const agentOutputSchema = Type.Object(
  {
    units: Type.Array(outputUnitSchema),
  },
  { additionalProperties: false },
);

export function computeReplyPaceDelayMs(
  text: string,
  minMs: number,
  maxMs: number,
  randomValue = Math.random(),
): number {
  const low = Math.max(0, Math.round(minMs));
  const high = Math.max(low, Math.round(maxMs));

  if (high === 0) {
    return 0;
  }

  const lengthFactor = Math.min(1, text.trim().length / 45);
  const base = low + (high - low) * lengthFactor;
  const jitter = (randomValue - 0.5) * 0.3 * (high - low);

  return Math.max(low, Math.min(high, Math.round(base + jitter)));
}

export async function resolveOutputDispatches(
  rawUnits: readonly RawOutputUnit[],
  ctx: {
    store: Store;
    ids: ModelIds;
    input: UnifiedInput;
    requestMessages: readonly MessageRecord[];
    speakerQQ: string | null;
    role: AccessRole;
    botQQ: string;
  },
): Promise<{
  dispatches: { targetChatKey: ChatKey; unit: OutputUnit }[];
  errors: string[];
}> {
  const { store, ids, input, requestMessages, speakerQQ, role, botQQ } = ctx;
  const dispatches: { targetChatKey: ChatKey; unit: OutputUnit }[] = [];
  const errors: string[] = [];

  const isTargetAuthorized = (targetChatKey: ChatKey): boolean =>
    targetChatKey === input.chatKey || role === "admin";

  function resolveUnitTarget(targetRef?: string): ChatKey | null {
    if (!targetRef?.trim()) {
      return input.chatKey;
    }

    try {
      const targetChatKey = ids.resolveTargetChatKey(targetRef);

      if (!isTargetAuthorized(targetChatKey)) {
        logger.warn("Blocked unauthorized cross-chat dispatch", {
          fromChatKey: input.chatKey,
          targetChatKey,
          speakerQQ,
        });
        errors.push("仅管理员或网协管理层可跨会话发送消息，已拦截该目标投递");

        return null;
      }

      return targetChatKey;
    } catch {
      logger.warn("Dropped unit with unresolvable targetRef", {
        fromChatKey: input.chatKey,
        targetRef,
      });
      errors.push(
        `无法解析投递目标句柄 ${targetRef}，请先通过 qq_directory 或 guild_resolve_member 获取有效句柄`,
      );

      return null;
    }
  }

  function resolveMsgHandle(
    ref: string,
  ): { rawId: string; chatKey: ChatKey } | null {
    try {
      const meta = ids.resolveMessageMeta(ref);
      const targetChatKey = meta.chatKey ?? input.chatKey;

      return isTargetAuthorized(targetChatKey)
        ? { rawId: meta.rawId, chatKey: targetChatKey }
        : null;
    } catch {
      return requestMessages.some((m) => m.onebotMessageId === ref)
        ? { rawId: ref, chatKey: input.chatKey }
        : null;
    }
  }

  function resolveSameChatQuote(
    quoteRef: string | undefined,
    targetChatKey: ChatKey,
  ): string | undefined {
    if (!quoteRef) {
      return undefined;
    }

    const resolved = resolveMsgHandle(quoteRef);

    return resolved?.chatKey === targetChatKey ? resolved.rawId : undefined;
  }

  for (const unit of rawUnits) {
    if (unit.kind === "qq_forward") {
      const targetChatKey = resolveUnitTarget(unit.targetRef);

      if (targetChatKey) {
        dispatches.push({
          targetChatKey,
          unit: {
            kind: "qq_forward",
            title: unit.title,
            items: unit.items,
          },
        });
      }

      continue;
    }

    if (unit.kind === "qq_reaction") {
      const resolvedMsg = resolveMsgHandle(unit.messageId);

      if (!resolvedMsg) {
        continue;
      }

      if (resolvedMsg.chatKey.startsWith("private:")) {
        const msg = "QQ 表情回应仅支持群聊消息，已忽略私聊贴表情";

        logger.warn("Dropped qq_reaction for private chat", {
          fromChatKey: input.chatKey,
          targetChatKey: resolvedMsg.chatKey,
        });
        errors.push(msg);

        continue;
      }

      try {
        const resolvedEmojiId = resolveReactionEmojiId(unit.emojiId);

        dispatches.push({
          targetChatKey: resolvedMsg.chatKey,
          unit: {
            kind: "qq_reaction",
            messageId: resolvedMsg.rawId,
            emojiId: resolvedEmojiId,
            ...(unit.remove ? { remove: true } : {}),
          },
        });
      } catch (error) {
        const msg = errorMessage(error);

        logger.warn("Dropped qq_reaction with unrecognized emojiId", {
          fromChatKey: input.chatKey,
          emojiId: unit.emojiId,
          error: msg,
        });
        errors.push(msg);
      }

      continue;
    }

    if (unit.kind === "qq_poke") {
      const targetChatKey = resolveUnitTarget(unit.targetRef);

      if (!targetChatKey) {
        continue;
      }

      let resolvedUserId: string | null = null;

      if (unit.userRef?.trim()) {
        try {
          resolvedUserId = ids.resolveUser(unit.userRef);
        } catch {
          logger.warn("Dropped qq_poke with unresolvable userRef", {
            fromChatKey: input.chatKey,
            userRef: unit.userRef,
          });
          errors.push(
            `无法解析戳一戳目标句柄 ${unit.userRef}，请使用上下文或 qq_directory 返回的 u_* 句柄`,
          );

          continue;
        }
      } else if (targetChatKey.startsWith("private:")) {
        resolvedUserId = targetChatKey.slice("private:".length);
      } else if (speakerQQ) {
        resolvedUserId = speakerQQ;
      } else {
        errors.push("群聊多人批次发送 qq_poke 时必须明确指定 userRef");

        continue;
      }

      if (botQQ && resolvedUserId === botQQ) {
        errors.push("不能对自己发送戳一戳，已忽略");

        continue;
      }

      dispatches.push({
        targetChatKey,
        unit: { kind: "qq_poke", userId: resolvedUserId },
      });

      continue;
    }

    if (unit.kind === "qq_image") {
      const targetChatKey = resolveUnitTarget(unit.targetRef);

      if (!targetChatKey) {
        continue;
      }

      const sticker = await store.stickers.get(unit.stickerId);

      if (sticker?.status !== "approved" || !sticker.enabled) {
        logger.warn("Dropped qq_image with unavailable sticker", {
          fromChatKey: input.chatKey,
          targetChatKey,
          stickerId: unit.stickerId,
        });
        errors.push(
          `表情包 #${unit.stickerId} 不存在或未启用，请先调用 search_stickers 获取可用 stickerId`,
        );

        continue;
      }

      const rawQuote = resolveSameChatQuote(unit.quoteMessageId, targetChatKey);

      dispatches.push({
        targetChatKey,
        unit: {
          kind: "qq_image",
          stickerId: sticker.id,
          filePath: sticker.filePath,
          summary: sticker.tags[0] || sticker.meaning.slice(0, 12) || "表情包",
          ...(rawQuote ? { quoteMessageId: rawQuote } : {}),
        },
      });

      continue;
    }

    const targetChatKey = resolveUnitTarget(unit.targetRef);

    if (!targetChatKey) {
      continue;
    }

    const rawQuote = resolveSameChatQuote(unit.quoteMessageId, targetChatKey);

    dispatches.push({
      targetChatKey,
      unit: {
        kind: "qq_reply",
        text: unit.text,
        ...(rawQuote ? { quoteMessageId: rawQuote } : {}),
      },
    });
  }

  return { dispatches, errors };
}
