import { QFACE_CATALOG } from "./qface-data.ts";

export interface QFaceEntry {
  id: string;
  name: string;
  associateWords: readonly string[];
}

const SINGLE_UNICODE_EMOJI_RE =
  /^[\p{Extended_Pictographic}\p{Emoji_Presentation}]$/u;
const EMOJI_PRESENTATION_RE = /\p{Emoji_Presentation}/u;

function extractUnicodeEmojiCodepoint(text: string): string | null {
  const base = text.replace(/\uFE0F$/u, "").replace(/\p{Emoji_Modifier}$/u, "");

  if (!SINGLE_UNICODE_EMOJI_RE.test(base)) {
    return null;
  }

  const cp = base.codePointAt(0);

  return cp !== undefined && cp >= 0x20_00 ? String(cp) : null;
}

// Common colloquial aliases that differ from QQNT's official `describe` text.
const QFACE_ALIASES: Record<string, string> = {
  狗头: "179",
  滑稽: "178",
  大拇指: "76",
  强: "76",
  弱: "77",
  好耶: "320",
  鼓掌加油: "99",
  感谢: "297",
  谢谢: "297",
};

const BY_ID = new Map<string, QFaceEntry>();
const BY_NAME = new Map<string, string>();

for (const tuple of QFACE_CATALOG) {
  const [id, name, words = []] = tuple;
  const entry: QFaceEntry = { id, name, associateWords: words };

  BY_ID.set(id, entry);

  const normalized = name.toLowerCase();

  if (!BY_NAME.has(normalized)) {
    BY_NAME.set(normalized, id);
  }
}

for (const [alias, id] of Object.entries(QFACE_ALIASES)) {
  const normalized = alias.toLowerCase();

  if (!BY_NAME.has(normalized) && BY_ID.has(id)) {
    BY_NAME.set(normalized, id);
  }
}

function decodeUnicodeEmojiId(id: string): string | null {
  if (!/^\d+$/.test(id)) {
    return null;
  }

  const cp = Number(id);

  if (!Number.isInteger(cp) || cp < 0x20_00 || cp > 0x10_ff_ff) {
    return null;
  }

  try {
    const ch = String.fromCodePoint(cp);

    if (!SINGLE_UNICODE_EMOJI_RE.test(ch)) {
      return null;
    }

    return EMOJI_PRESENTATION_RE.test(ch) ? ch : `${ch}\uFE0F`;
  } catch {
    return null;
  }
}

export function qfaceName(rawId: unknown): string {
  const key = String(rawId ?? "").trim();

  if (!key) {
    return "表情";
  }

  const known = BY_ID.get(key);

  if (known) {
    return known.name;
  }

  const unicode = decodeUnicodeEmojiId(key);

  if (unicode) {
    return unicode;
  }

  return `#${key}`;
}

function stripDecorators(raw: string): string {
  let text = raw.trim();

  if (text.startsWith("[") && text.endsWith("]") && text.length > 2) {
    text = text
      .slice(1, -1)
      .trim()
      .replace(/^表情\s*[:：]\s*/, "");
  }

  return text.replace(/^\/+/, "").trim();
}

/**
 * Resolve any reaction input into the numeric `emoji_id` string expected by
 * NapCat `set_msg_emoji_like`:
 *
 * - Numeric IDs (`"76"`, `"478"`, `"12951"`) pass straight through.
 * - Single standard Unicode emojis (`"㊗️"`, `"🔥"`, `"👍"`, `"❤️"`) resolve to
 *   their decimal Unicode codepoint (`"12951"`, `"128293"`, `"128077"`,
 *   `"10084"`).
 * - Official QQNT native face names & aliases (`"对的对的"`, `"吃瓜"`, `"狗头"`) resolve
 *   to their numeric QQ face ID (`"478"`, `"271"`, `"179"`).
 */
export function resolveReactionEmojiId(input: string): string {
  const cleaned = stripDecorators(input);

  if (!cleaned) {
    throw new Error("emojiId 不能为空");
  }

  if (/^\d+$/.test(cleaned)) {
    return cleaned;
  }

  const byName = BY_NAME.get(cleaned.toLowerCase());

  if (byName) {
    return byName;
  }

  const unicodeId = extractUnicodeEmojiCodepoint(cleaned);

  if (unicodeId) {
    return unicodeId;
  }

  throw new Error(
    `无法识别的表情回应 "${input}"：请直接传入单个标准 Unicode Emoji（如 ㊗️、🔥）、QQ 官方表情名称（可用 search_qq_emojis 查询）或数字 ID`,
  );
}

export function searchQFaceCatalog(
  query = "",
  limit = 30,
): {
  total: number;
  resolvedUnicodeId?: string;
  items: { id: string; name: string; associateWords?: readonly string[] }[];
} {
  const capped = Math.min(100, Math.max(1, limit));
  const cleaned = stripDecorators(query);

  const resolvedUnicodeId = cleaned
    ? (extractUnicodeEmojiCodepoint(cleaned) ?? undefined)
    : undefined;

  const needle = cleaned.toLowerCase();
  const aliasTargetId = needle ? BY_NAME.get(needle) : undefined;
  const matched: QFaceEntry[] = [];

  for (const entry of BY_ID.values()) {
    if (!needle) {
      matched.push(entry);

      continue;
    }

    if (
      entry.id === needle ||
      entry.id === aliasTargetId ||
      entry.name.toLowerCase().includes(needle) ||
      entry.associateWords.some((w) => w.toLowerCase().includes(needle))
    ) {
      matched.push(entry);
    }
  }

  return {
    total: matched.length,
    ...(resolvedUnicodeId ? { resolvedUnicodeId } : {}),
    items: matched.slice(0, capped).map((entry) => ({
      id: entry.id,
      name: entry.name,
      ...(entry.associateWords.length > 0
        ? { associateWords: entry.associateWords }
        : {}),
    })),
  };
}
