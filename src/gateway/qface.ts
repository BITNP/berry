import { QFACE_CATALOG } from "./qface-data.ts";

interface QFaceEntry {
  id: string;
  name: string;
  emoji?: string;
  kind: "qface" | "unicode";
  associateWords: readonly string[];
}

const SINGLE_UNICODE_EMOJI_RE =
  /^[\p{Extended_Pictographic}\p{Emoji_Presentation}]$/u;
const EMOJI_PRESENTATION_RE = /\p{Emoji_Presentation}/u;

// Unicode emoji decimal codepoints known to render in QQ's emoji-like reaction
// panel (QQ official EmojiType=2 list + verified QQNT entries like ㊗️ and ❤️).
// Sending arbitrary codepoints outside this set (e.g. 🥵 / 129397) renders as a
// blank reaction chip on QQ clients.
const SUPPORTED_UNICODE_REACTIONS: readonly (readonly [
  id: string,
  emoji: string,
  name: string,
  associateWords?: readonly string[],
])[] = [
  ["9728", "☀️", "晴天", ["太阳", "阳光"]],
  ["9749", "☕", "咖啡", ["喝茶", "提神"]],
  ["9786", "☺️", "可爱", ["微笑", "害羞"]],
  ["10024", "✨", "闪光", ["星星", "闪亮", "亮晶晶"]],
  ["10060", "❌", "错误", ["叉", "不行", "不对"]],
  ["10068", "❔", "问号", ["疑问", "疑惑"]],
  ["10084", "❤️", "红心", ["爱心", "喜欢", "比心"]],
  ["12951", "㊗️", "祝", ["恭喜", "祝贺", "庆祝"]],
  ["127801", "🌹", "玫瑰", ["花", "鲜花"]],
  ["127817", "🍉", "西瓜", ["吃瓜", "水果"]],
  ["127822", "🍎", "苹果", ["水果"]],
  ["127827", "🍓", "草莓", ["树莓", "树莓娘", "水果"]],
  ["127836", "🍜", "拉面", ["面条", "食物", "干饭"]],
  ["127838", "🍞", "面包", ["吐司", "食物", "干饭"]],
  ["127847", "🍧", "刨冰", ["冰沙", "甜点", "食物"]],
  ["127866", "🍺", "啤酒", ["喝酒", "干杯"]],
  ["127867", "🍻", "干杯", ["啤酒", "庆祝"]],
  ["127881", "🎉", "庆祝", ["撒花", "恭喜", "礼花", "派对"]],
  ["128027", "🐛", "虫", ["bug", "虫子"]],
  ["128046", "🐮", "牛", ["牛逼", "厉害"]],
  ["128051", "🐳", "鲸鱼", ["鲸"]],
  ["128053", "🐵", "猴", ["猴子"]],
  ["128074", "👊", "拳头", ["加油", "碰拳"]],
  ["128076", "👌", "好的", ["ok", "没问题"]],
  ["128077", "👍", "厉害", ["赞", "点赞", "强"]],
  ["128079", "👏", "鼓掌", ["拍手", "欢迎"]],
  ["128089", "👙", "内衣"],
  ["128102", "👦", "男孩"],
  ["128104", "👨", "爸爸"],
  ["128147", "💓", "心动", ["爱心", "心跳"]],
  ["128157", "💝", "礼物", ["爱心礼物"]],
  ["128164", "💤", "睡觉", ["困", "晚安"]],
  ["128166", "💦", "水", ["汗", "水滴"]],
  ["128168", "💨", "吹气", ["溜了", "跑路"]],
  ["128170", "💪", "肌肉", ["加油", "强壮"]],
  ["128235", "📫", "邮箱", ["邮件", "收信"]],
  ["128293", "🔥", "火", ["热门", "给力", "着火"]],
  ["128513", "😁", "呲牙", ["大笑", "开心"]],
  ["128514", "😂", "笑哭", ["激动", "哈哈"]],
  ["128516", "😄", "高兴", ["开心", "笑"]],
  ["128522", "😊", "嘿嘿", ["微笑", "开心"]],
  ["128524", "😌", "羞涩", ["安心", "放松"]],
  ["128527", "😏", "哼哼", ["坏笑", "得意"]],
  ["128530", "😒", "不屑", ["无语", "白眼"]],
  ["128531", "😓", "汗", ["尴尬", "流汗"]],
  ["128532", "😔", "失落", ["难过", "叹气"]],
  ["128536", "😘", "飞吻", ["亲亲"]],
  ["128538", "😚", "亲亲", ["么么"]],
  ["128540", "😜", "淘气", ["调皮", "吐舌"]],
  ["128541", "😝", "吐舌", ["调皮"]],
  ["128557", "😭", "大哭", ["哭", "泪目"]],
  ["128560", "😰", "紧张", ["冷汗", "害怕"]],
  ["128563", "😳", "瞪眼", ["震惊", "脸红"]],
];

const SUPPORTED_UNICODE_REACTION_IDS = new Set<string>(
  SUPPORTED_UNICODE_REACTIONS.map(([id]) => id),
);
const UNICODE_BY_ID = new Map<string, QFaceEntry>();

function extractSupportedUnicodeEmojiCodepoint(text: string): string | null {
  const base = text.replace(/\uFE0F$/u, "").replace(/\p{Emoji_Modifier}$/u, "");

  if (!SINGLE_UNICODE_EMOJI_RE.test(base)) {
    return null;
  }

  const id = String(base.codePointAt(0)!);

  return SUPPORTED_UNICODE_REACTION_IDS.has(id) ? id : null;
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
  const entry: QFaceEntry = { id, name, kind: "qface", associateWords: words };

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

for (const [id, emoji, name, words = []] of SUPPORTED_UNICODE_REACTIONS) {
  const entry: QFaceEntry = {
    id,
    name,
    emoji,
    kind: "unicode",
    associateWords: words,
  };

  UNICODE_BY_ID.set(id, entry);

  const normalized = name.toLowerCase();

  if (!BY_NAME.has(normalized)) {
    BY_NAME.set(normalized, id);
  }
}

function decodeUnicodeEmojiId(id: string): string | null {
  if (!/^\d+$/.test(id)) {
    return null;
  }

  const cp = Number(id);

  if (cp < 0x20_00 || cp > 0x10_ff_ff) {
    return null;
  }

  const ch = String.fromCodePoint(cp);

  if (!SINGLE_UNICODE_EMOJI_RE.test(ch)) {
    return null;
  }

  return EMOJI_PRESENTATION_RE.test(ch) ? ch : `${ch}\uFE0F`;
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
  items: {
    id: string;
    name: string;
    emoji?: string;
    kind: "qface" | "unicode";
    associateWords?: readonly string[];
  }[];
} {
  const capped = Math.min(100, Math.max(1, limit));
  const cleaned = stripDecorators(query);

  const resolvedUnicodeId = cleaned
    ? (extractSupportedUnicodeEmojiCodepoint(cleaned) ?? undefined)
    : undefined;

  const needle = cleaned.toLowerCase();
  const aliasTargetId = needle ? BY_NAME.get(needle) : undefined;
  const matched: QFaceEntry[] = [];
  const seen = new Set<string>();

  function pushIfNew(entry: QFaceEntry) {
    if (!seen.has(entry.id)) {
      seen.add(entry.id);
      matched.push(entry);
    }
  }

  if (resolvedUnicodeId) {
    const unicodeEntry = UNICODE_BY_ID.get(resolvedUnicodeId);

    if (unicodeEntry) {
      pushIfNew(unicodeEntry);
    }
  }

  for (const entry of [...BY_ID.values(), ...UNICODE_BY_ID.values()]) {
    if (!needle) {
      pushIfNew(entry);

      continue;
    }

    if (
      entry.id === needle ||
      entry.id === aliasTargetId ||
      entry.emoji === cleaned ||
      entry.name.toLowerCase().includes(needle) ||
      entry.associateWords.some((w) => w.toLowerCase().includes(needle))
    ) {
      pushIfNew(entry);
    }
  }

  return {
    total: matched.length,
    ...(resolvedUnicodeId ? { resolvedUnicodeId } : {}),
    items: matched.slice(0, capped).map((entry) => ({
      id: entry.id,
      name: entry.name,
      ...(entry.emoji ? { emoji: entry.emoji } : {}),
      kind: entry.kind,
      ...(entry.associateWords.length > 0
        ? { associateWords: entry.associateWords }
        : {}),
    })),
  };
}
