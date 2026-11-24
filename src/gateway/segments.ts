import type { ModelIds } from "../agent/model-ids.ts";
import type { MessageRecord, OneBotSegment } from "../types.ts";
import { qfaceName } from "./qface.ts";

export interface ExtractedAttachment {
  kind: "image" | "audio" | "forward" | "file";
  rawUrl: string;
  name: string;
  isSticker?: boolean;
  embeddedForward?: unknown[];
}

export interface ParsedSegments {
  segments: OneBotSegment[];
  text: string;
  replyToMessageId: string | null;
  mentionedBot: boolean;
  attachments: ExtractedAttachment[];
}

interface ParsedContactCard {
  kind: "user" | "group";
  rawId: string;
  name: string;
  tag: string;
}

const CQ_PATTERN = /\[CQ:([\w.-]+)(?:,([^\]]*))?\]/g;
const HTTP_URL_RE = /^https?:\/\//i;
const DIGITS_RE = /^\d+$/;

const unescapeCQ = (value: string): string =>
  value
    .replaceAll("&#44;", ",")
    .replaceAll("&#91;", "[")
    .replaceAll("&#93;", "]")
    .replaceAll("&amp;", "&");

function formatContactCard(card: ParsedContactCard, ids?: ModelIds): string {
  const ref =
    ids && card.rawId
      ? card.kind === "group"
        ? ids.groupRef(card.rawId)
        : ids.userRef(card.rawId)
      : "";

  if (card.name && ref) {
    return `[${card.tag}: ${card.name} (${ref})]`;
  }

  if (ref) {
    return `[${card.tag}: ${ref}]`;
  }

  if (card.name) {
    return `[${card.tag}: ${card.name}]`;
  }

  return `[${card.tag}]`;
}

function parseContactFromJsonCard(
  doc: Record<string, unknown>,
  meta: Record<string, unknown> | null,
  prompt: string,
): ParsedContactCard | null {
  const app = typeof doc.app === "string" ? doc.app : "";
  const view = typeof doc.view === "string" ? doc.view : "";
  const contactObj =
    meta?.contact && typeof meta.contact === "object"
      ? (meta.contact as Record<string, unknown>)
      : null;

  let candidate: Record<string, unknown> | null = contactObj;

  if (!candidate && meta) {
    for (const value of Object.values(meta)) {
      if (!value || typeof value !== "object") {
        continue;
      }

      const inner = value as Record<string, unknown>;
      const jump =
        typeof inner.jumpUrl === "string"
          ? inner.jumpUrl
          : typeof inner.qqdocurl === "string"
            ? inner.qqdocurl
            : "";

      if (jump.startsWith("mqqapi://card/show_pslcard")) {
        candidate = inner;

        break;
      }
    }
  }

  const isContactCard =
    Boolean(candidate) ||
    view === "contact" ||
    app === "com.tencent.contact.lua" ||
    app === "com.tencent.troopsharecard";

  if (!isContactCard) {
    return null;
  }

  const inner = candidate ?? {};
  const jumpUrl =
    typeof inner.jumpUrl === "string"
      ? inner.jumpUrl.trim()
      : typeof inner.qqdocurl === "string"
        ? inner.qqdocurl.trim()
        : "";
  let urlUin = "";
  let urlGroupCode = "";
  let urlCardType = "";

  if (jumpUrl) {
    try {
      const parsed = new URL(jumpUrl);

      urlUin = parsed.searchParams.get("uin")?.trim() ?? "";
      urlGroupCode = parsed.searchParams.get("group_code")?.trim() ?? "";
      urlCardType = parsed.searchParams.get("card_type")?.trim() ?? "";
    } catch {
      // Ignore malformed internal scheme URL.
    }
  }

  const rawTag = typeof inner.tag === "string" ? inner.tag.trim() : "";
  const kind: "user" | "group" =
    urlCardType === "group" ||
    Boolean(urlGroupCode) ||
    app === "com.tencent.troopsharecard" ||
    rawTag.includes("群") ||
    prompt.includes("群")
      ? "group"
      : "user";
  const tag = rawTag || (kind === "group" ? "推荐群聊" : "推荐好友");

  let rawId = "";

  if (DIGITS_RE.test(urlGroupCode)) {
    rawId = urlGroupCode;
  } else if (DIGITS_RE.test(urlUin)) {
    rawId = urlUin;
  } else if (typeof inner.contact === "string") {
    rawId = inner.contact.match(/\d{5,}/)?.[0] ?? "";
  }

  const nickname =
    typeof inner.nickname === "string" ? inner.nickname.trim() : "";
  const title = typeof inner.title === "string" ? inner.title.trim() : "";
  const promptName = prompt
    .replace(/^\[?推荐(?:联系人|好友|群聊)\]?[：:]\s*/, "")
    .trim();
  const name = nickname || title || promptName;

  return { kind, rawId, name, tag };
}

function summarizeJsonCard(rawData: unknown, ids?: ModelIds): string {
  if (typeof rawData !== "string" || !rawData.trim()) {
    return "[卡片消息]";
  }

  try {
    const doc = JSON.parse(rawData) as Record<string, unknown>;
    const prompt = typeof doc.prompt === "string" ? doc.prompt.trim() : "";
    const meta =
      doc.meta && typeof doc.meta === "object"
        ? (doc.meta as Record<string, unknown>)
        : null;

    const contact = parseContactFromJsonCard(doc, meta, prompt);

    if (contact) {
      return formatContactCard(contact, ids);
    }

    if (meta) {
      for (const value of Object.values(meta)) {
        if (value && typeof value === "object") {
          const inner = value as Record<string, unknown>;
          const title =
            typeof inner.title === "string" ? inner.title.trim() : "";
          const desc = typeof inner.desc === "string" ? inner.desc.trim() : "";
          const rawLink =
            typeof inner.qqdocurl === "string"
              ? inner.qqdocurl.trim()
              : typeof inner.jumpUrl === "string"
                ? inner.jumpUrl.trim()
                : "";
          const link = HTTP_URL_RE.test(rawLink) ? rawLink : "";
          const parts = [title, desc, link].filter(Boolean);

          if (parts.length > 0) {
            return `[分享: ${parts.join(" - ").slice(0, 220)}]`;
          }
        }
      }
    }

    if (prompt) {
      return `[卡片: ${prompt.slice(0, 180)}]`;
    }
  } catch {
    // Non-JSON payload fallback.
  }

  return "[卡片消息]";
}

function normalizeSegments(rawMessage: unknown): OneBotSegment[] {
  if (Array.isArray(rawMessage)) {
    return rawMessage
      .filter(
        (item): item is { type: string; data?: Record<string, unknown> } =>
          Boolean(item) &&
          typeof item === "object" &&
          typeof (item as { type?: unknown }).type === "string",
      )
      .map((item) => ({
        type: item.type,
        data:
          item.data && typeof item.data === "object" ? { ...item.data } : {},
      }));
  }

  if (typeof rawMessage !== "string") {
    return [];
  }

  const segments: OneBotSegment[] = [];
  let cursor = 0;

  for (const match of rawMessage.matchAll(CQ_PATTERN)) {
    const index = match.index ?? 0;

    if (index > cursor) {
      segments.push({
        type: "text",
        data: { text: unescapeCQ(rawMessage.slice(cursor, index)) },
      });
    }

    const type = match[1]!;
    const rawParams = match[2] ?? "";
    const data: Record<string, string> = {};

    if (rawParams) {
      for (const pair of rawParams.split(",")) {
        const eq = pair.indexOf("=");

        if (eq > 0) {
          data[pair.slice(0, eq)] = unescapeCQ(pair.slice(eq + 1));
        }
      }
    }

    segments.push({ type, data });
    cursor = index + match[0].length;
  }

  if (cursor < rawMessage.length) {
    segments.push({
      type: "text",
      data: { text: unescapeCQ(rawMessage.slice(cursor)) },
    });
  }

  return segments;
}

export interface MessageMentions {
  mentionedBot: boolean;
  mentionedAll: boolean;
  mentionedUsers: { qq: string; userRef?: string; name?: string }[];
}

export function cleanMentionName(raw: unknown, qq?: string): string {
  const cleaned = String(raw ?? "")
    .trim()
    .replace(/^@+/, "")
    .trim();

  if (!cleaned || (qq && cleaned === qq)) {
    return "";
  }

  return cleaned;
}

export function extractMessageMentions(
  segments: readonly OneBotSegment[],
  botQQ: string,
  options?: { ids?: ModelIds; userNames?: ReadonlyMap<string, string> },
): MessageMentions {
  let mentionedBot = false;
  let mentionedAll = false;
  const seen = new Set<string>();
  const mentionedUsers: { qq: string; userRef?: string; name?: string }[] = [];

  for (const seg of segments) {
    if (seg.type !== "at") {
      continue;
    }

    const qq = String(seg.data.qq ?? "").trim();

    if (!qq) {
      continue;
    }

    if (qq === "all") {
      mentionedAll = true;

      continue;
    }

    if (botQQ && qq === botQQ) {
      mentionedBot = true;

      continue;
    }

    if (!DIGITS_RE.test(qq) || seen.has(qq)) {
      continue;
    }

    seen.add(qq);
    const name =
      cleanMentionName(seg.data.name, qq) || options?.userNames?.get(qq) || "";
    const userRef = options?.ids ? options.ids.userRef(qq) : undefined;

    mentionedUsers.push({
      qq,
      ...(userRef ? { userRef } : {}),
      ...(name ? { name } : {}),
    });
  }

  return { mentionedBot, mentionedAll, mentionedUsers };
}

export function parseOneBotSegments(
  rawMessage: unknown,
  botQQ: string,
  botName = "树莓娘",
  ids?: ModelIds,
  userNames?: ReadonlyMap<string, string>,
): ParsedSegments {
  const segments = normalizeSegments(rawMessage);
  const parts: string[] = [];
  const attachments: ExtractedAttachment[] = [];
  let replyToMessageId: string | null = null;
  let mentionedBot = false;

  for (const seg of segments) {
    switch (seg.type) {
      case "text": {
        const text = String(seg.data.text ?? "");

        if (text) {
          parts.push(text);
        }

        break;
      }

      case "at": {
        const qq = String(seg.data.qq ?? "").trim();
        const isBotMention = Boolean(qq && botQQ && qq === botQQ);

        if (isBotMention) {
          mentionedBot = true;
        }

        const name =
          cleanMentionName(seg.data.name, qq) || userNames?.get(qq) || "";

        if (qq === "all") {
          parts.push("@全体成员");
        } else if (isBotMention) {
          parts.push(`@${botName || "树莓娘"}`);
        } else if (ids && DIGITS_RE.test(qq)) {
          const ref = ids.userRef(qq);

          parts.push(name ? `@${name} (${ref})` : `@${ref}`);
        } else if (name) {
          parts.push(`@${name}`);
        } else if (qq) {
          parts.push(`@${qq}`);
        }

        break;
      }

      case "reply": {
        const id = seg.data.id ?? seg.data.seq;

        if (id !== undefined && id !== null && !replyToMessageId) {
          replyToMessageId = String(id);
        }

        break;
      }

      case "image": {
        const rawUrl = String(
          seg.data.url ?? seg.data.file ?? seg.data.file_id ?? "",
        ).trim();
        const name = String(seg.data.summary ?? seg.data.file ?? "").trim();
        const subType = String(seg.data.sub_type ?? seg.data.subType ?? "");
        const isSticker =
          subType === "1" || /动画表情|表情包|\[表情\]/.test(name);

        attachments.push({
          kind: "image",
          rawUrl,
          name,
          ...(isSticker ? { isSticker: true } : {}),
        });
        parts.push(name ? `[图片: ${name}]` : "[图片]");

        break;
      }

      case "record":
      case "audio": {
        const rawUrl = String(
          seg.data.url ?? seg.data.file ?? seg.data.file_id ?? "",
        ).trim();
        const name = String(seg.data.file ?? "").trim();

        attachments.push({ kind: "audio", rawUrl, name });
        parts.push("[语音]");

        break;
      }

      case "video": {
        parts.push("[视频]");

        break;
      }

      case "file": {
        const name = String(seg.data.name ?? seg.data.file ?? "").trim();
        const rawUrl = String(
          seg.data.url ?? seg.data.file_id ?? seg.data.file ?? "",
        ).trim();

        attachments.push({ kind: "file", rawUrl, name });
        parts.push(name ? `[文件: ${name}]` : "[文件]");

        break;
      }

      case "face": {
        parts.push(`[表情: ${qfaceName(seg.data.id)}]`);

        break;
      }

      case "forward": {
        const rawUrl = String(seg.data.id ?? "").trim();
        const embeddedForward = Array.isArray(seg.data.content)
          ? seg.data.content
          : undefined;

        attachments.push({
          kind: "forward",
          rawUrl,
          name: "合并转发",
          embeddedForward,
        });
        parts.push("[合并转发]");

        break;
      }

      case "contact": {
        const kind = seg.data.type === "group" ? "group" : "user";
        const rawId = String(seg.data.id ?? "").trim();

        parts.push(
          formatContactCard(
            {
              kind,
              rawId: DIGITS_RE.test(rawId) ? rawId : "",
              name: "",
              tag: kind === "group" ? "推荐群聊" : "推荐好友",
            },
            ids,
          ),
        );

        break;
      }

      case "json": {
        parts.push(summarizeJsonCard(seg.data.data, ids));

        break;
      }

      case "xml": {
        parts.push("[XML卡片消息]");

        break;
      }

      default: {
        parts.push(`[${seg.type}]`);

        break;
      }
    }
  }

  return {
    segments,
    text: parts.join("").trim(),
    replyToMessageId,
    mentionedBot,
    attachments,
  };
}

export function renderMessageTextForModel(
  message: Pick<MessageRecord, "text" | "segments">,
  options: {
    botQQ: string;
    botName?: string;
    ids?: ModelIds;
    userNames?: ReadonlyMap<string, string>;
  },
): string {
  if (message.segments.length === 0) {
    return message.text;
  }

  return parseOneBotSegments(
    message.segments,
    options.botQQ,
    options.botName,
    options.ids,
    options.userNames,
  ).text;
}
