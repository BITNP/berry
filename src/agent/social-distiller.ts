import { Type } from "typebox";

import type { RuntimeSettings } from "../config/settings.ts";
import {
  resolveMaxOutputTokens,
  resolveThinkingEffort,
} from "../config/settings.ts";
import type { Store } from "../store/index.ts";
import type { ChatConfig, ChatKey, MemberImpressionRecord } from "../types.ts";
import { completeChat, validateModelJson } from "./llm.ts";

const jargonExtractSchema = Type.Object(
  {
    entries: Type.Array(
      Type.Object(
        {
          term: Type.String({ minLength: 2, maxLength: 48 }),
          aliases: Type.Optional(Type.Array(Type.String())),
          meaning: Type.String({ minLength: 2, maxLength: 240 }),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export class SocialDistiller {
  #store: Store;
  #getSettings: () => RuntimeSettings;

  constructor(store: Store, getSettings: () => RuntimeSettings) {
    this.#store = store;
    this.#getSettings = getSettings;
  }

  public async distillChatStyle(
    chatKey: ChatKey,
    options?: { sampleLimit?: number; jobId?: number | null },
  ): Promise<ChatConfig> {
    const settings = this.#getSettings();
    const { chat, sampleCount, transcript } = await this.#loadChatSamples(
      chatKey,
      options?.sampleLimit ?? 80,
    );
    const cfg = this.#requireMainModel(settings, "提炼群聊表达风格");
    const thinkingEffort = resolveThinkingEffort(settings, "style_distill");
    const response = await completeChat({
      apiKey: cfg.apiKey,
      baseURL: cfg.baseURL,
      model: cfg.model,
      timeoutMs: cfg.timeoutMs,
      maxRetries: 1,
      store: this.#store,
      timeZone: settings.bot.timezone,
      purpose: "style_distill",
      chatKey,
      jobId: options?.jobId ?? null,
      params: {
        temperature: 0.2,
        max_tokens: resolveMaxOutputTokens(settings, "style_distill"),
        ...(thinkingEffort === "none"
          ? {}
          : { reasoning_effort: thinkingEffort }),
        messages: [
          {
            role: "system",
            content:
              "你是 QQ 群聊风格提炼助手。请根据近期群聊抽样，用 2～4 句精炼中文（总长不超过 260 字）总结该群的聊天氛围、说话节奏、常用口头禅或表达习惯，以及树莓娘在此群发言应注意的分寸。只输出可直接作为风格提示的纯文本，不要加标题、编号或 Markdown 围栏，不要照抄具体隐私信息。",
          },
          {
            role: "user",
            content: JSON.stringify({
              chatTitle: chat.title || chat.chatKey,
              existingStyle: chat.stylePrompt || null,
              sampleCount,
              transcript,
            }),
          },
        ],
      },
    });

    const distilled = (response.choices[0]?.message?.content ?? "")
      .trim()
      .replace(/^```[\s\S]*?\n|```$/g, "")
      .trim()
      .slice(0, 600);

    if (!distilled) {
      throw new Error("模型未返回有效的群风格摘要");
    }

    return this.#store.chats.update(chatKey, { stylePrompt: distilled });
  }

  public async distillChatJargon(
    chatKey: ChatKey,
    options?: { sampleLimit?: number; jobId?: number | null },
  ): Promise<{ inserted: number; totalExtracted: number }> {
    const settings = this.#getSettings();
    const { chat, transcript } = await this.#loadChatSamples(
      chatKey,
      options?.sampleLimit ?? 100,
    );
    const cfg = this.#requireMainModel(settings, "提炼群内黑话词条");
    const existingTerms = (await this.#store.jargon.list({ chatKey })).map(
      (item) => item.term,
    );
    const thinkingEffort = resolveThinkingEffort(settings, "jargon_distill");
    const response = await completeChat({
      apiKey: cfg.apiKey,
      baseURL: cfg.baseURL,
      model: cfg.model,
      timeoutMs: cfg.timeoutMs,
      maxRetries: 1,
      store: this.#store,
      timeZone: settings.bot.timezone,
      purpose: "jargon_distill",
      chatKey,
      jobId: options?.jobId ?? null,
      params: {
        temperature: 0.2,
        max_tokens: resolveMaxOutputTokens(settings, "jargon_distill"),
        response_format: { type: "json_object" },
        ...(thinkingEffort === "none"
          ? {}
          : { reasoning_effort: thinkingEffort }),
        messages: [
          {
            role: "system",
            content:
              '你是群内黑话与圈内梗词典提炼助手。请从群聊样本中挑出真正具有圈内特定含义的梗、黑话、外号或简称（最多 8 条；忽略普通日常词汇、单字词和已收录词条；若没有明显黑话则返回空数组）。严格输出 JSON：{"entries":[{"term":"词条","aliases":["同义写法"],"meaning":"一句简明解释"}]}。',
          },
          {
            role: "user",
            content: JSON.stringify({
              chatTitle: chat.title || chat.chatKey,
              existingTerms,
              transcript,
            }),
          },
        ],
      },
    });

    const parsed = validateModelJson(
      jargonExtractSchema,
      response.choices[0]?.message?.content ?? "{}",
    );

    if (!parsed.ok) {
      throw new Error(`黑话提炼返回格式无效：${parsed.issue}`);
    }

    const status = settings.social.jargonAutoApprove ? "approved" : "pending";
    let inserted = 0;

    for (const entry of parsed.value.entries.slice(0, 8)) {
      const added = await this.#store.jargon.insertIfAbsent({
        chatKey,
        term: entry.term,
        aliases: entry.aliases ?? [],
        meaning: entry.meaning,
        status,
        source: "auto",
      });

      if (added) {
        inserted += 1;
      }
    }

    return { inserted, totalExtracted: parsed.value.entries.length };
  }

  public async refreshMemberImpression(
    userId: string,
    options?: {
      displayName?: string;
      force?: boolean;
      jobId?: number | null;
    },
  ): Promise<MemberImpressionRecord | null> {
    const cleanUserId = userId.trim();

    if (!cleanUserId) {
      throw new Error("缺少成员 QQ 号");
    }

    const settings = this.#getSettings();
    const existing = await this.#store.impressions.get(cleanUserId);

    if (existing?.locked && !options?.force) {
      return existing;
    }

    const samples = (
      await this.#store.messages.recentByUser(cleanUserId, 40)
    ).filter((m) => m.text.trim().length > 0);

    if (samples.length < 5) {
      throw new Error(
        `该成员近期发言样本不足（当前 ${samples.length} 条，至少需要 5 条）`,
      );
    }

    const cfg = this.#requireMainModel(settings, "提炼成员印象");
    const displayName =
      options?.displayName?.trim() ||
      samples.at(-1)?.senderName.trim() ||
      existing?.displayName ||
      cleanUserId;
    const transcript = samples
      .map((m) => m.text.replace(/\s+/g, " ").slice(0, 120))
      .join("\n");
    const thinkingEffort = resolveThinkingEffort(settings, "impression_update");
    const response = await completeChat({
      apiKey: cfg.apiKey,
      baseURL: cfg.baseURL,
      model: cfg.model,
      timeoutMs: cfg.timeoutMs,
      maxRetries: 1,
      store: this.#store,
      timeZone: settings.bot.timezone,
      purpose: "impression_update",
      chatKey: null,
      jobId: options?.jobId ?? null,
      params: {
        temperature: 0.2,
        max_tokens: resolveMaxOutputTokens(settings, "impression_update"),
        ...(thinkingEffort === "none"
          ? {}
          : { reasoning_effort: thinkingEffort }),
        messages: [
          {
            role: "system",
            content:
              "你是树莓娘的轻量成员印象提炼助手。请根据该成员的近期聊天样本，提炼**一句极简中文印象**（不超过 45 字，例如“爱开玩笑测试我，偶尔问正经技术问题”或“提问认真克制，偏关注系统运维”）。不要打分、不要做道德评判、不要提敏感隐私，只输出这一句纯文本。",
          },
          {
            role: "user",
            content: JSON.stringify({
              displayName,
              existingImpression: existing?.impression ?? null,
              recentLines: transcript,
            }),
          },
        ],
      },
    });

    const impression = (response.choices[0]?.message?.content ?? "")
      .trim()
      .replace(/^["“”'`]+|["“”'`]+$/g, "")
      .replace(/\s+/g, " ")
      .slice(0, 120);

    if (!impression) {
      throw new Error("模型未返回有效的成员印象");
    }

    return this.#store.impressions.upsert({
      userId: cleanUserId,
      displayName,
      impression,
      source: "auto",
      locked: false,
    });
  }

  #requireMainModel(settings: RuntimeSettings, actionLabel: string) {
    const cfg = settings.mainModel;

    if (!cfg.apiKey || !cfg.model) {
      throw new Error(`主模型未配置，无法${actionLabel}`);
    }

    return cfg;
  }

  async #loadChatSamples(chatKey: ChatKey, sampleLimit: number) {
    const chat = await this.#store.chats.get(chatKey);

    if (!chat) {
      throw new Error(`未找到会话：${chatKey}`);
    }

    const bounded = Math.max(40, Math.min(200, sampleLimit));
    const recent = await this.#store.messages.recent(chatKey, bounded);
    const samples = recent.filter((m) => !m.isBot && m.text.trim().length > 0);

    if (samples.length < 10) {
      throw new Error(
        `近期有效群聊样本不足（当前 ${samples.length} 条，至少需要 10 条非机器人消息）`,
      );
    }

    const transcript = samples
      .slice(-bounded)
      .map(
        (m) => `${m.senderName}: ${m.text.replace(/\s+/g, " ").slice(0, 140)}`,
      )
      .join("\n");

    return { chat, sampleCount: samples.length, transcript };
  }
}
