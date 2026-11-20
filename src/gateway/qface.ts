import { QFACE_CATALOG } from "./qface-data.ts";

export interface QFaceEntry {
  id: string;
  name: string;
  associateWords: readonly string[];
}

const SINGLE_UNICODE_EMOJI_RE =
  /^[\p{Extended_Pictographic}\p{Emoji_Presentation}]$/u;
const EMOJI_PRESENTATION_RE = /\p{Emoji_Presentation}/u;

// Unicode emoji decimal codepoints known to render in QQ's emoji-like reaction
// panel (QQ official EmojiType=2 list + verified QQNT entries like ㊗️ and ❤️).
// Sending arbitrary codepoints outside this set (e.g. 🥵 / 129397) renders as a
// blank reaction chip on QQ clients.
const SUPPORTED_UNICODE_REACTION_IDS = new Set<string>([
  "9728", // ☀️ 晴天
  "9749", // ☕ 咖啡
  "9786", // ☺️ 可爱
  "10024", // ✨ 闪光
  "10060", // ❌ 错误
  "10068", // ❔ 问号
  "10084", // ❤️ 红心
  "12951", // ㊗️ 祝
  "127801", // 🌹 玫瑰
  "127817", // 🍉 西瓜
  "127822", // 🍎 苹果
  "127827", // 🍓 草莓
  "127836", // 🍜 拉面
  "127838", // 🍞 面包
  "127847", // 🍧 刨冰
  "127866", // 🍺 啤酒
  "127867", // 🍻 干杯
  "127881", // 🎉 庆祝
  "128027", // 🐛 虫
  "128046", // 🐮 牛
  "128051", // 🐳 鲸鱼
  "128053", // 🐵 猴
  "128074", // 👊 拳头
  "128076", // 👌 好的
  "128077", // 👍 厉害
  "128079", // 👏 鼓掌
  "128089", // 👙 内衣
  "128102", // 👦 男孩
  "128104", // 👨 爸爸
  "128147", // 💓 爱心
  "128157", // 💝 礼物
  "128164", // 💤 睡觉
  "128166", // 💦 水
  "128168", // 💨 吹气
  "128170", // 💪 肌肉
  "128235", // 📫 邮箱
  "128293", // 🔥 火
  "128513", // 😁 呲牙
  "128514", // 😂 激动
  "128516", // 😄 高兴
  "128522", // 😊 嘿嘿
  "128524", // 😌 羞涩
  "128527", // 😏 哼哼
  "128530", // 😒 不屑
  "128531", // 😓 汗
  "128532", // 😔 失落
  "128536", // 😘 飞吻
  "128538", // 😚 亲亲
  "128540", // 😜 淘气
  "128541", // 😝 吐舌
  "128557", // 😭 大哭
  "128560", // 😰 紧张
  "128563", // 😳 瞪眼
]);

function extractSupportedUnicodeEmojiCodepoint(text: string): string | null {
  const base = text.replace(/\uFE0F$/u, "").replace(/\p{Emoji_Modifier}$/u, "");

  if (!SINGLE_UNICODE_EMOJI_RE.test(base)) {
    return null;
  }

  const cp = base.codePointAt(0);
  const id = cp !== undefined && cp >= 0x20_00 ? String(cp) : null;

  return id && SUPPORTED_UNICODE_REACTION_IDS.has(id) ? id : null;
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
 * - Valid numeric IDs in the QQNT catalog (`"76"`, `"478"`) or QQ's supported
 *   Unicode reaction whitelist (`"12951"`, `"128077"`) pass through; unknown or
 *   unsupported numeric IDs are rejected so QQ clients won't render blank
 *   chips.
 * - Supported single Unicode emojis (`"㊗️"`, `"🔥"`, `"👍"`, `"❤️"`) resolve to
 *   their decimal Unicode codepoint.
 * - Official QQNT native face names & aliases (`"对的对的"`, `"吃瓜"`, `"狗头"`) resolve
 *   to their numeric QQ face ID (`"478"`, `"271"`, `"179"`).
 */
export function resolveReactionEmojiId(input: string): string {
  const cleaned = stripDecorators(input);

  if (!cleaned) {
    throw new Error("emojiId 不能为空");
  }

  if (/^\d+$/.test(cleaned)) {
    if (BY_ID.has(cleaned) || SUPPORTED_UNICODE_REACTION_IDS.has(cleaned)) {
      return cleaned;
    }

    throw new Error(
      `不支持的表情数字 ID "${cleaned}"：不在 QQNT 官方表情目录或 QQ 表情回应白名单内，请改用 QQ 原生表情（可用 search_qq_emojis 查询）或常用白名单 Emoji`,
    );
  }

  const byName = BY_NAME.get(cleaned.toLowerCase());

  if (byName) {
    return byName;
  }

  const unicodeId = extractSupportedUnicodeEmojiCodepoint(cleaned);

  if (unicodeId) {
    return unicodeId;
  }

  throw new Error(
    `不支持的表情回应 "${input}"：该表情不在 QQ 原生表情目录或 QQ 回应白名单内，请改用 QQ 原生表情名称（可用 search_qq_emojis 查询）或白名单常用 Emoji（如 ㊗️、🔥、👍、👌、🎉、❤️）`,
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
    ? (extractSupportedUnicodeEmojiCodepoint(cleaned) ?? undefined)
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
