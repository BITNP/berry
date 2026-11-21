import type { OneBotSegment } from "../types.ts";
import { qfaceName } from "./qface.ts";

export interface ExtractedAttachment {
  kind: "image" | "audio" | "forward" | "file";
  rawUrl: string;
  name: string;
  embeddedForward?: unknown[];
}

export interface ParsedSegments {
  segments: OneBotSegment[];
  text: string;
  replyToMessageId: string | null;
  mentionedBot: boolean;
  attachments: ExtractedAttachment[];
}

const CQ_PATTERN = /\[CQ:([\w.-]+)(?:,([^\]]*))?\]/g;

const unescapeCQ = (value: string): string =>
  value
    .replaceAll("&#44;", ",")
    .replaceAll("&#91;", "[")
    .replaceAll("&#93;", "]")
    .replaceAll("&amp;", "&");

function summarizeJsonCard(rawData: unknown): string {
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

    if (meta) {
      for (const value of Object.values(meta)) {
        if (value && typeof value === "object") {
          const inner = value as Record<string, unknown>;
          const title =
            typeof inner.title === "string" ? inner.title.trim() : "";
          const desc = typeof inner.desc === "string" ? inner.desc.trim() : "";
          const link =
            typeof inner.qqdocurl === "string"
              ? inner.qqdocurl.trim()
              : typeof inner.jumpUrl === "string"
                ? inner.jumpUrl.trim()
                : "";
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

export function parseOneBotSegments(
  rawMessage: unknown,
  botQQ: string,
  botName = "树莓娘",
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
        const qq = String(seg.data.qq ?? "");
        const isBotMention = Boolean(qq && botQQ && qq === botQQ);

        if (isBotMention) {
          mentionedBot = true;
        }

        const name = String(seg.data.name ?? "").trim();

        if (qq === "all") {
          parts.push("@全体成员");
        } else if (isBotMention) {
          parts.push(`@${botName || "树莓娘"}`);
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

        attachments.push({ kind: "image", rawUrl, name });
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

      case "json": {
        parts.push(summarizeJsonCard(seg.data.data));

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
