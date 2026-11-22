import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { fileTypeFromBuffer } from "file-type";
import OpenAI from "openai";

import { completeChat } from "../agent/llm.ts";
import type { ModelIds } from "../agent/model-ids.ts";
import type { RuntimeSettings } from "../config/settings.ts";
import { resolveMaxOutputTokens } from "../config/settings.ts";
import type { MessageGatewayClient } from "../gateway/client.ts";
import type { ExtractedAttachment } from "../gateway/segments.ts";
import {
  parseOneBotSegments,
  renderMessageTextForModel,
} from "../gateway/segments.ts";
import type { Store } from "../store/index.ts";
import type { ChatKey, MessageAssetRecord, MessageRecord } from "../types.ts";
import { parseChatKey } from "../utils/chat-key.ts";
import { Logger } from "../utils/logger.ts";
import { errorMessage } from "../utils/time.ts";
import { checkStickerEligibility } from "./sticker-filter.ts";

const MAX_ASSET_BYTES = 8 * 1024 * 1024;
const MAX_FORWARD_CHARS = 8000;

export class MediaProcessor {
  #store: Store;
  #gateway: MessageGatewayClient;
  #getSettings: () => RuntimeSettings;
  #logger = new Logger("media");
  #pendingByMessage = new Map<number, Promise<void>>();
  #closed = false;

  constructor(
    store: Store,
    gateway: MessageGatewayClient,
    getSettings: () => RuntimeSettings,
  ) {
    this.#store = store;
    this.#gateway = gateway;
    this.#getSettings = getSettings;
  }

  public async enqueueMessageAssets(
    message: MessageRecord,
    attachments: ExtractedAttachment[],
  ): Promise<void> {
    if (attachments.length === 0 || this.#closed) {
      return;
    }

    const created: {
      record: MessageAssetRecord;
      attachment: ExtractedAttachment;
    }[] = [];

    for (const att of attachments) {
      const record = await this.#store.assets.create({
        messageId: message.id,
        chatKey: message.chatKey,
        kind: att.kind,
        rawUrl: att.rawUrl,
        status: att.kind === "file" ? "ready" : "pending",
        transcript:
          att.kind === "file" && att.name ? `文件: ${att.name}` : null,
      });

      created.push({ record, attachment: att });
    }

    const task = this.#processList(created)
      .catch((error) => {
        this.#logger.warn("Media processing failed", {
          messageId: message.id,
          error: errorMessage(error),
        });
      })
      .finally(() => {
        this.#pendingByMessage.delete(message.id);
      });

    this.#pendingByMessage.set(message.id, task);
  }

  public async waitForMessages(messageIds: number[]): Promise<void> {
    const tasks = messageIds
      .map((id) => this.#pendingByMessage.get(id))
      .filter((p): p is Promise<void> => Boolean(p));

    if (tasks.length > 0) {
      await Promise.allSettled(tasks);
    }
  }

  public async inspectAssetOnDemand(
    assetId: number,
  ): Promise<MessageAssetRecord> {
    const asset = await this.#store.assets.get(assetId);

    if (!asset) {
      throw new Error(`附件 #${assetId} 不存在`);
    }

    if (asset.status === "ready" && asset.transcript) {
      return asset;
    }

    const settings = this.#getSettings();

    await this.#processOne(
      asset,
      { kind: asset.kind, rawUrl: asset.rawUrl, name: "" },
      settings,
      true,
    );

    return (await this.#store.assets.get(assetId)) ?? asset;
  }

  public async askImageDetail(
    assetId: number,
    question: string,
    options?: { jobId?: number | null },
  ): Promise<{ asset: MessageAssetRecord; detail: string }> {
    const cleanQuestion = question.trim();

    if (!cleanQuestion) {
      throw new Error("请提供需要核对的具体读图问题或关注点");
    }

    let asset = await this.#store.assets.get(assetId);

    if (!asset) {
      throw new Error(`附件 #${assetId} 不存在`);
    }

    if (asset.kind !== "image") {
      throw new Error(`附件 #${assetId} 不是图片，无法进行细节读图`);
    }

    await this.waitForMessages([asset.messageId]);
    asset = (await this.#store.assets.get(assetId)) ?? asset;

    const settings = this.#getSettings();
    let bytes: Buffer | null = null;
    let mimeType = asset.mimeType || "";

    if (asset.filePath) {
      bytes = await readFile(asset.filePath).catch(() => null);
    }

    if (!bytes && asset.rawUrl.startsWith("http")) {
      bytes = await this.#downloadBytes(asset.rawUrl);
      const detected = await fileTypeFromBuffer(bytes);

      if (!detected || !/^image\/(?:jpeg|png|gif|webp)$/i.test(detected.mime)) {
        throw new Error("不支持的图片格式");
      }

      mimeType = detected.mime;
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const filePath = join(
        this.#store.assetsDir,
        "images",
        `${sha256}.${detected.ext}`,
      );

      await writeFile(filePath, bytes);
      if (asset.status !== "ready" || !asset.filePath) {
        await this.#store.assets.markReady(asset.id, {
          filePath,
          mimeType: detected.mime,
          sha256,
          transcript: asset.transcript ?? "图片已缓存",
        });
        asset = (await this.#store.assets.get(asset.id)) ?? asset;
      }
    }

    if (!bytes) {
      throw new Error(`图片附件 #${assetId} 原图不可用，无法进行细节读图`);
    }

    if (!mimeType) {
      const detected = await fileTypeFromBuffer(bytes);

      mimeType = detected?.mime ?? "image/png";
    }

    const detail = await this.#analyzeImage(
      bytes,
      mimeType,
      asset.chatKey,
      asset.messageId,
      settings,
      { question: cleanQuestion, jobId: options?.jobId ?? null },
    );

    return { asset, detail };
  }

  public async resolveUserNames(
    chatKey: ChatKey,
    userIds: Iterable<string>,
    seedMessages?: readonly MessageRecord[],
  ): Promise<Map<string, string>> {
    const settings = this.#getSettings();
    const botQQ = settings.bot.botQQ;
    const botLabel = settings.bot.names[0] || "树莓娘";
    const resolved = new Map<string, string>();
    const requested = new Set<string>();

    for (const uid of userIds) {
      if (!uid || uid === "unknown") {
        continue;
      }

      if (uid === "bot" || (botQQ && uid === botQQ)) {
        resolved.set(uid, botLabel);

        continue;
      }

      requested.add(uid);
    }

    if (requested.size === 0) {
      return resolved;
    }

    if (seedMessages) {
      for (const msg of seedMessages) {
        if (
          !msg.isBot &&
          requested.has(msg.userId) &&
          !resolved.has(msg.userId) &&
          msg.senderName.trim()
        ) {
          resolved.set(msg.userId, msg.senderName.trim());
        }
      }
    }

    const missingForStore = [...requested].filter((id) => !resolved.has(id));

    if (missingForStore.length > 0) {
      const fromStore = await this.#store.messages.latestSenderNames(
        chatKey,
        missingForStore,
      );

      for (const [uid, name] of fromStore) {
        resolved.set(uid, name);
      }
    }

    const missingForGateway = [...requested].filter((id) => !resolved.has(id));

    if (missingForGateway.length > 0 && this.#gateway.configured) {
      const parsed = parseChatKey(chatKey);

      if (parsed.kind === "group") {
        const fetched = await Promise.all(
          missingForGateway.map(async (uid) => ({
            uid,
            name: await this.#gateway
              .getGroupMemberName(parsed.chatId, uid)
              .catch(() => null),
          })),
        );

        for (const item of fetched) {
          if (item.name) {
            resolved.set(item.uid, item.name);
          }
        }
      }
    }

    return resolved;
  }

  public async enrichMessagesText(
    chatKey: ChatKey,
    messages: MessageRecord[],
    ids?: ModelIds,
  ): Promise<Map<number, string>> {
    const out = new Map<number, string>();

    if (messages.length === 0) {
      return out;
    }

    const settings = this.#getSettings();
    const messageIds = messages.map((m) => m.id);
    const onebotIds = messages.map((m) => m.onebotMessageId);
    const [assetMap, reactionMap] = await Promise.all([
      this.#store.assets.listForMessages(messageIds),
      this.#store.reactions.aggregateForMessages(chatKey, onebotIds),
    ]);

    const reactorIds = new Set<string>();

    for (const list of reactionMap.values()) {
      for (const r of list) {
        for (const uid of r.userIds) {
          reactorIds.add(uid);
        }
      }
    }

    const reactorNames =
      reactorIds.size > 0
        ? await this.resolveUserNames(chatKey, reactorIds, messages)
        : new Map<string, string>();
    const botLabel = settings.bot.names[0] || "树莓娘";
    const formatReactor = (uid: string): string => {
      if (
        uid === "bot" ||
        (Boolean(settings.bot.botQQ) && uid === settings.bot.botQQ)
      ) {
        return botLabel;
      }

      if (!uid || uid === "unknown") {
        return "未知用户";
      }

      const name = reactorNames.get(uid);

      if (ids) {
        const ref = ids.userRef(uid);

        return name ? `${name}(${ref})` : ref;
      }

      return name ?? uid;
    };

    for (const msg of messages) {
      const baseText = renderMessageTextForModel(msg, {
        botQQ: settings.bot.botQQ,
        botName: settings.bot.names[0],
        ids,
      });
      const extra: string[] = [];
      const assets = assetMap.get(msg.id) ?? [];

      for (const asset of assets) {
        if (asset.status === "ready" && asset.transcript) {
          const label =
            asset.kind === "image"
              ? "图片内容"
              : asset.kind === "audio"
                ? "语音转写"
                : asset.kind === "forward"
                  ? "合并转发详情"
                  : "附件";

          extra.push(`[${label} #${asset.id}: ${asset.transcript}]`);
        }
      }

      const reactions = reactionMap.get(msg.onebotMessageId) ?? [];

      if (reactions.length > 0) {
        const MAX_NAMED_REACTORS = 8;
        const badge = reactions
          .map((r) => {
            const names = r.userIds
              .slice(0, MAX_NAMED_REACTORS)
              .map(formatReactor);
            const suffix =
              r.userIds.length > MAX_NAMED_REACTORS
                ? `等${r.userIds.length}人`
                : "";

            return names.length > 0
              ? `${r.emojiName}×${r.count}(${names.join("、")}${suffix})`
              : `${r.emojiName}×${r.count}`;
          })
          .join("、");

        extra.push(`[表情回应: ${badge}]`);
      }

      out.set(
        msg.id,
        extra.length > 0 ? `${baseText}\n${extra.join("\n")}`.trim() : baseText,
      );
    }

    return out;
  }

  public async close(): Promise<void> {
    this.#closed = true;
    await Promise.allSettled(this.#pendingByMessage.values());
  }

  async #processList(
    items: { record: MessageAssetRecord; attachment: ExtractedAttachment }[],
  ): Promise<void> {
    const settings = this.#getSettings();

    for (const item of items) {
      if (this.#closed) {
        return;
      }

      try {
        await this.#processOne(item.record, item.attachment, settings, false);
      } catch (error) {
        await this.#store.assets.markFailed(
          item.record.id,
          errorMessage(error),
        );
      }
    }
  }

  async #processOne(
    record: MessageAssetRecord,
    attachment: ExtractedAttachment,
    settings: RuntimeSettings,
    forceAnalyze: boolean,
  ): Promise<void> {
    if (record.kind === "forward") {
      if (!settings.media.expandForwards && !forceAnalyze) {
        return;
      }

      const text = await this.#expandForward(
        record.rawUrl,
        attachment.embeddedForward,
        settings.bot.botQQ,
      );

      await this.#store.assets.markReady(record.id, {
        transcript: text,
      });

      return;
    }

    if (record.kind === "image") {
      if (!record.rawUrl.startsWith("http")) {
        return;
      }

      const bytes = await this.#downloadBytes(record.rawUrl);
      const detected = await fileTypeFromBuffer(bytes);

      if (!detected || !/^image\/(?:jpeg|png|gif|webp)$/i.test(detected.mime)) {
        throw new Error("不支持的图片格式");
      }

      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const filePath = join(
        this.#store.assetsDir,
        "images",
        `${sha256}.${detected.ext}`,
      );

      await writeFile(filePath, bytes);

      const cached = await this.#store.assets.findReadyBySha256(sha256);

      if (cached?.transcript) {
        await this.#store.assets.markReady(record.id, {
          filePath,
          mimeType: detected.mime,
          sha256,
          transcript: cached.transcript,
        });
        await this.#maybeCollectSticker(
          record,
          attachment,
          {
            sha256,
            filePath,
            mimeType: detected.mime,
            bytes,
          },
          cached.transcript,
          settings,
        );

        return;
      }

      if (!settings.media.autoAnalyzeImages && !forceAnalyze) {
        const fallbackDesc = attachment.name || "图片已缓存";

        await this.#store.assets.markReady(record.id, {
          filePath,
          mimeType: detected.mime,
          sha256,
          transcript: fallbackDesc,
        });
        await this.#maybeCollectSticker(
          record,
          attachment,
          {
            sha256,
            filePath,
            mimeType: detected.mime,
            bytes,
          },
          fallbackDesc,
          settings,
        );

        return;
      }

      const description = await this.#analyzeImage(
        bytes,
        detected.mime,
        record.chatKey,
        record.messageId,
        settings,
      );

      await this.#store.assets.markReady(record.id, {
        filePath,
        mimeType: detected.mime,
        sha256,
        transcript: description,
      });
      await this.#maybeCollectSticker(
        record,
        attachment,
        {
          sha256,
          filePath,
          mimeType: detected.mime,
          bytes,
        },
        description,
        settings,
      );

      return;
    }

    if (record.kind === "audio") {
      if (!settings.media.autoTranscribeAudio && !forceAnalyze) {
        return;
      }

      if (!record.rawUrl.startsWith("http")) {
        return;
      }

      const bytes = await this.#downloadBytes(record.rawUrl);
      const detected = await fileTypeFromBuffer(bytes);
      const mimeType = detected?.mime ?? "audio/mpeg";
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const text = await this.#transcribeAudio(
        bytes,
        attachment.name || `audio.${detected?.ext ?? "mp3"}`,
        record.chatKey,
        record.messageId,
        settings,
      );

      await this.#store.assets.markReady(record.id, {
        mimeType,
        sha256,
        transcript: text,
      });
    }
  }

  async #expandForward(
    forwardId: string,
    embedded: unknown[] | undefined,
    botQQ: string,
    depth = 0,
  ): Promise<string> {
    if (depth > 3) {
      return "[嵌套转发过深]";
    }

    let nodes: unknown[] = embedded ?? [];

    if (nodes.length === 0 && forwardId && this.#gateway.configured) {
      nodes = await this.#gateway.getForwardMsg(forwardId);
    }

    const lines: string[] = [];

    for (const rawNode of nodes) {
      if (!rawNode || typeof rawNode !== "object") {
        continue;
      }

      const node = rawNode as Record<string, unknown>;
      const sender =
        node.sender && typeof node.sender === "object"
          ? (node.sender as Record<string, unknown>)
          : {};
      const senderName = String(
        sender.card || sender.nickname || node.nickname || "成员",
      );
      const content = node.message ?? node.content ?? "";
      const parsed = parseOneBotSegments(content, botQQ);
      let bodyText = parsed.text;

      for (const nested of parsed.attachments) {
        if (nested.kind === "forward") {
          const sub = await this.#expandForward(
            nested.rawUrl,
            nested.embeddedForward,
            botQQ,
            depth + 1,
          );

          bodyText = `${bodyText}\n  ${sub}`.trim();
        }
      }

      if (bodyText) {
        lines.push(`${senderName}: ${bodyText}`);
      }
    }

    return lines.join("\n").slice(0, MAX_FORWARD_CHARS) || "空转发消息";
  }

  async #downloadBytes(url: string): Promise<Buffer> {
    const delaysMs = [400, 1000];
    let lastError: unknown;

    for (let attempt = 0; attempt <= delaysMs.length; attempt++) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(12_000) });

        if (!res.ok) {
          if (res.status >= 500 && attempt < delaysMs.length) {
            throw new Error(`下载失败 HTTP ${res.status}`);
          }

          throw new Error(`下载失败 HTTP ${res.status}`);
        }

        const buf = Buffer.from(await res.arrayBuffer());

        if (buf.byteLength === 0 || buf.byteLength > MAX_ASSET_BYTES) {
          throw new Error("媒体体积超出允许范围（最大 8MB）");
        }

        return buf;
      } catch (error) {
        lastError = error;

        if (
          attempt >= delaysMs.length ||
          (error instanceof Error &&
            error.message.startsWith("媒体体积超出允许范围"))
        ) {
          throw error;
        }

        await new Promise((resolve) => setTimeout(resolve, delaysMs[attempt]));
      }
    }

    throw lastError instanceof Error ? lastError : new Error("媒体下载失败");
  }

  async #analyzeImage(
    bytes: Buffer,
    mimeType: string,
    chatKey: ChatKey,
    messageId: number,
    settings: RuntimeSettings,
    options?: { question?: string; jobId?: number | null },
  ): Promise<string> {
    const apiKey = settings.media.visionApiKey || settings.mainModel.apiKey;
    const baseURL = settings.media.visionBaseURL || settings.mainModel.baseURL;
    const model = settings.media.visionModel || settings.mainModel.model;

    if (!apiKey || !model) {
      return "图片已保存（未配置视觉模型密钥，跳过识图）";
    }

    const question = options?.question?.trim();
    const dataUrl = `data:${mimeType};base64,${bytes.toString("base64")}`;
    const systemPrompt = question
      ? "你是高精度细节读图助手。请仔细查看原图，严格围绕用户提出的问题或关注点作答，完整准确地提取相关文字、数值、代码、报错或画面细节；看不清或图中不存在的内容请如实说明，不要编造。"
      : "用简洁中文概括图片主要内容，提取关键可见文字、报错信息、代码或界面要点（简明扼要，细节可由后续按需详查）。";
    const userContent = question
      ? [
          { type: "text" as const, text: question },
          { type: "image_url" as const, image_url: { url: dataUrl } },
        ]
      : [{ type: "image_url" as const, image_url: { url: dataUrl } }];

    const completion = await completeChat({
      apiKey,
      baseURL,
      model,
      timeoutMs: settings.mainModel.timeoutMs,
      maxRetries: 1,
      store: this.#store,
      timeZone: settings.bot.timezone,
      purpose: "vision",
      chatKey,
      jobId: options?.jobId ?? null,
      messageIds: [messageId],
      params: {
        temperature: 0.2,
        max_tokens: resolveMaxOutputTokens(settings, "vision"),
        messages: [
          {
            role: "system",
            content: systemPrompt,
          },
          {
            role: "user",
            content: userContent,
          },
        ],
      },
    });

    const content = completion.choices[0]?.message.content?.trim();

    if (!content) {
      throw new Error("视觉模型返回空内容（输出上限可能被思考过程耗尽）");
    }

    return content;
  }

  async #transcribeAudio(
    bytes: Buffer,
    filename: string,
    chatKey: ChatKey,
    messageId: number,
    settings: RuntimeSettings,
  ): Promise<string> {
    const apiKey = settings.media.audioApiKey || settings.mainModel.apiKey;
    const baseURL = settings.media.audioBaseURL || settings.mainModel.baseURL;
    const model = settings.media.audioModel || "whisper-1";

    if (!apiKey) {
      return "语音已收到（未配置语音转写密钥）";
    }

    const started = performance.now();
    const client = new OpenAI({
      apiKey,
      baseURL,
      timeout: settings.mainModel.timeoutMs,
      maxRetries: 1,
    });
    const res = await client.audio.transcriptions.create({
      model,
      file: await OpenAI.toFile(bytes, filename),
      response_format: "json",
    });

    await this.#store.usage.record({
      purpose: "audio",
      model,
      chatKey,
      messageIds: [messageId],
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: res.text.length,
      durationMs: Math.round(performance.now() - started),
      timeZone: settings.bot.timezone,
    });

    return res.text.trim() || "空白语音";
  }

  async #maybeCollectSticker(
    record: MessageAssetRecord,
    attachment: ExtractedAttachment,
    file: {
      sha256: string;
      filePath: string;
      mimeType: string;
      bytes: Buffer;
    },
    description: string,
    settings: RuntimeSettings,
  ): Promise<void> {
    if (
      !settings.social.stickerCollectEnabled ||
      !record.chatKey.startsWith("group:")
    ) {
      return;
    }

    const isLikelySticker =
      Boolean(attachment.isSticker) ||
      (file.mimeType === "image/gif" && file.bytes.length <= 2 * 1024 * 1024);

    if (!isLikelySticker) {
      return;
    }

    const eligibility = checkStickerEligibility({
      bytes: file.bytes,
      transcript: description,
    });

    if (!eligibility.ok) {
      return;
    }

    const existing = await this.#store.stickers.getBySha256(file.sha256);

    if (existing) {
      return;
    }

    const total = await this.#store.stickers.count();

    if (total >= settings.social.stickerMaxCount) {
      return;
    }

    const cleanMeaning = description
      .replace(/\*\*[^*]+\*\*/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 180);
    const emotionKeywords = [
      "开心",
      "笑",
      "好笑",
      "无语",
      "惊讶",
      "震惊",
      "委屈",
      "哭",
      "生气",
      "傲娇",
      "可爱",
      "猫",
      "狗",
      "贴贴",
      "吃瓜",
      "疑问",
      "点赞",
      "赞",
      "摸鱼",
      "害羞",
      "吐槽",
      "害怕",
      "加油",
      "晚安",
      "早安",
    ];
    const tags = emotionKeywords
      .filter((kw) => cleanMeaning.includes(kw))
      .slice(0, 6);

    await this.#store.stickers.collectIfAbsent({
      sha256: file.sha256,
      filePath: file.filePath,
      mimeType: file.mimeType,
      meaning: cleanMeaning || attachment.name || "表情包",
      tags: tags.length > 0 ? tags : ["表情包"],
      sourceChatKey: record.chatKey,
      status: settings.social.stickerAutoApprove ? "approved" : "pending",
      enabled: true,
    });
  }
}
