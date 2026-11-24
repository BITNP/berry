import type { Static } from "typebox";
import { Type } from "typebox";

import { resolveReactionEmojiId } from "../gateway/qface.ts";
import type { AccessRole } from "../identity/permissions.ts";
import type { Store } from "../store/index.ts";
import type {
  ChatKey,
  MessageRecord,
  OneBotSegment,
  OutputUnit,
  UnifiedInput,
} from "../types.ts";
import { Logger } from "../utils/logger.ts";
import { errorMessage } from "../utils/time.ts";
import type { ModelIds } from "./model-ids.ts";

const logger = new Logger("agent:dispatch");

const INLINE_MENTION_RE =
  /@([^\s@()（）]{1,40})\s*[（(](u_[a-z0-9_]+)[)）]|@(u_[a-z0-9_]+)\b/g;
const LEADING_SPACE_OR_PUNCT_RE = /^[\s,，.。!！?？:：;；、)）\]】]/;

function pushTextSegment(segments: OneBotSegment[], text: string): void {
  if (!text) {
    return;
  }

  const prev = segments.at(-1);

  if (prev?.type === "text") {
    prev.data.text = `${String(prev.data.text ?? "")}${text}`;
  } else {
    segments.push({ type: "text", data: { text } });
  }
}

function buildReplyContent(options: {
  text: string;
  mentionUserRefs?: readonly string[];
  isGroup: boolean;
  ids: ModelIds;
  botQQ: string;
  userNames?: ReadonlyMap<string, string>;
  errors: string[];
}): { text: string; segments?: OneBotSegment[] } {
  const { text, mentionUserRefs, isGroup, ids, botQQ, userNames, errors } =
    options;

  if (!isGroup) {
    const cleaned = text.replaceAll(
      INLINE_MENTION_RE,
      (
        full,
        inlineName: string | undefined,
        ref1: string | undefined,
        ref2: string | undefined,
      ) => {
        const ref = ref1 ?? ref2 ?? "";

        try {
          const qq = ids.resolveUser(ref);
          const name = userNames?.get(qq) || inlineName?.trim();

          return name ? `@${name}` : full;
        } catch {
          return inlineName?.trim() ? `@${inlineName.trim()}` : full;
        }
      },
    );

    return { text: cleaned };
  }

  const bodySegments: OneBotSegment[] = [];
  const plainParts: string[] = [];
  const inlineQQs = new Set<string>();
  let hasAt = false;
  let lastIndex = 0;

  for (const match of text.matchAll(INLINE_MENTION_RE)) {
    const idx = match.index ?? 0;

    if (idx > lastIndex) {
      const before = text.slice(lastIndex, idx);

      pushTextSegment(bodySegments, before);
      plainParts.push(before);
    }

    const inlineName = match[1]?.trim() ?? "";
    const ref = match[2] ?? match[3] ?? "";
    const nextChar = text.slice(
      idx + match[0].length,
      idx + match[0].length + 1,
    );
    let resolvedQQ: string | null = null;

    try {
      resolvedQQ = ids.resolveUser(ref);
    } catch {
      resolvedQQ = null;
    }

    if (resolvedQQ && resolvedQQ !== botQQ) {
      const displayName = userNames?.get(resolvedQQ) || inlineName;

      bodySegments.push({
        type: "at",
        data: {
          qq: resolvedQQ,
          ...(displayName ? { name: displayName } : {}),
        },
      });
      inlineQQs.add(resolvedQQ);
      hasAt = true;
      plainParts.push(displayName ? `@${displayName}` : `@${resolvedQQ}`);
      if (nextChar && !LEADING_SPACE_OR_PUNCT_RE.test(nextChar)) {
        pushTextSegment(bodySegments, " ");
        plainParts.push(" ");
      }
    } else if (inlineName) {
      pushTextSegment(bodySegments, `@${inlineName}`);
      plainParts.push(`@${inlineName}`);
    } else {
      pushTextSegment(bodySegments, match[0]);
      plainParts.push(match[0]);
    }

    lastIndex = idx + match[0].length;
  }

  if (lastIndex < text.length) {
    const tail = text.slice(lastIndex);

    pushTextSegment(bodySegments, tail);
    plainParts.push(tail);
  }

  const prependMentions: { qq: string; name?: string }[] = [];
  const seenPrepend = new Set<string>(inlineQQs);

  for (const rawRef of mentionUserRefs ?? []) {
    const ref = rawRef.trim();

    if (!ref) {
      continue;
    }

    let qq: string;

    try {
      qq = ids.resolveUser(ref);
    } catch {
      logger.warn("Ignored unresolvable mentionUserRef on qq_reply", { ref });
      errors.push(
        `无法解析 @ 提及目标句柄 ${ref}，请使用上下文或 qq_directory 返回的 u_* 句柄`,
      );

      continue;
    }

    if ((botQQ && qq === botQQ) || seenPrepend.has(qq)) {
      continue;
    }

    seenPrepend.add(qq);
    const name = userNames?.get(qq);

    prependMentions.push({ qq, ...(name ? { name } : {}) });
  }

  if (prependMentions.length > 0) {
    hasAt = true;

    // Avoid duplicate "@name @name ..." if the model also typed "@name" at the start of text.
    const firstSeg = bodySegments[0];

    if (firstSeg?.type === "text") {
      let leadText = String(firstSeg.data.text ?? "");

      for (const m of prependMentions) {
        if (!m.name) {
          continue;
        }

        const prefix = `@${m.name}`;

        if (leadText.startsWith(prefix)) {
          leadText = leadText.slice(prefix.length).replace(/^\s+/, "");
        }
      }

      firstSeg.data.text = leadText;
      if (!leadText) {
        bodySegments.shift();
      }
    }

    const finalSegments: OneBotSegment[] = [];
    const prefixPlain: string[] = [];

    for (const m of prependMentions) {
      if (finalSegments.length > 0) {
        pushTextSegment(finalSegments, " ");
        prefixPlain.push(" ");
      }

      finalSegments.push({
        type: "at",
        data: {
          qq: m.qq,
          ...(m.name ? { name: m.name } : {}),
        },
      });
      prefixPlain.push(m.name ? `@${m.name}` : `@${m.qq}`);
    }

    const firstBodyText =
      bodySegments[0]?.type === "text"
        ? String(bodySegments[0].data.text ?? "")
        : "";

    if (
      bodySegments.length > 0 &&
      (!firstBodyText || !LEADING_SPACE_OR_PUNCT_RE.test(firstBodyText))
    ) {
      pushTextSegment(finalSegments, " ");
      prefixPlain.push(" ");
    }

    for (const seg of bodySegments) {
      if (seg.type === "text") {
        pushTextSegment(finalSegments, String(seg.data.text ?? ""));
      } else {
        finalSegments.push(seg);
      }
    }

    const bodyPlain = bodySegments
      .map((seg) => {
        if (seg.type === "text") {
          return String(seg.data.text ?? "");
        }

        if (seg.type === "at") {
          const qq = String(seg.data.qq ?? "");
          const name = String(seg.data.name ?? "").trim();

          return name ? `@${name}` : `@${qq}`;
        }

        return "";
      })
      .join("");

    return {
      text: `${prefixPlain.join("")}${bodyPlain}`.trim(),
      segments: finalSegments,
    };
  }

  const finalPlain = plainParts.join("");

  return hasAt
    ? { text: finalPlain, segments: bodySegments }
    : { text: finalPlain };
}

export const outputUnitSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("qq_reply"),
      text: Type.String({ minLength: 1 }),
      mentionUserRefs: Type.Optional(
        Type.Array(Type.String({ minLength: 1 }), { maxItems: 10 }),
      ),
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
    userNames?: ReadonlyMap<string, string>;
  },
): Promise<{
  dispatches: { targetChatKey: ChatKey; unit: OutputUnit }[];
  errors: string[];
}> {
  const {
    store,
    ids,
    input,
    requestMessages,
    speakerQQ,
    role,
    botQQ,
    userNames,
  } = ctx;
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
          isSticker: true,
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
    const replyContent = buildReplyContent({
      text: unit.text,
      mentionUserRefs: unit.mentionUserRefs,
      isGroup: targetChatKey.startsWith("group:"),
      ids,
      botQQ,
      userNames,
      errors,
    });

    dispatches.push({
      targetChatKey,
      unit: {
        kind: "qq_reply",
        text: replyContent.text,
        ...(replyContent.segments ? { segments: replyContent.segments } : {}),
        ...(rawQuote ? { quoteMessageId: rawQuote } : {}),
      },
    });
  }

  return { dispatches, errors };
}
