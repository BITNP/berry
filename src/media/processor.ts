import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import OpenAI from "openai";

import type { RuntimeSettings } from "../config/settings.ts";
import type { MessageGatewayClient } from "../gateway/client.ts";
import type { ExtractedAttachment } from "../gateway/segments.ts";
import { parseOneBotSegments } from "../gateway/segments.ts";
import type { Store } from "../store/index.ts";
import type { ChatKey, MessageAssetRecord, MessageRecord } from "../types.ts";
import { Logger } from "../utils/logger.ts";
import { errorMessage } from "../utils/time.ts";

const MAX_ASSET_BYTES = 8 * 1024 * 1024;
const MAX_FORWARD_CHARS = 8000;

function detectImageMime(bytes: Buffer): { mime: string; ext: string } | null {
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return { mime: "image/jpeg", ext: "jpg" };
  }

  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return { mime: "image/png", ext: "png" };
  }

  if (
    bytes.length >= 6 &&
    bytes.subarray(0, 6).toString("ascii").startsWith("GIF8")
  ) {
    return { mime: "image/gif", ext: "gif" };
  }

  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return { mime: "image/webp", ext: "webp" };
  }

  return null;
}

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

    const task = this.#processList(message, created)
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

  public async enrichMessagesText(
    chatKey: ChatKey,
    messages: MessageRecord[],
  ): Promise<Map<number, string>> {
    const out = new Map<number, string>();

    if (messages.length === 0) {
      return out;
    }

    const ids = messages.map((m) => m.id);
    const onebotIds = messages.map((m) => m.onebotMessageId);
    const [assetMap, reactionMap] = await Promise.all([
      this.#store.assets.listForMessages(ids),
      this.#store.reactions.aggregateForMessages(chatKey, onebotIds),
    ]);

    for (const msg of messages) {
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
        const badge = reactions
          .map((r) => `${r.emojiName}×${r.count}`)
          .join("、");

        extra.push(`[表情回应: ${badge}]`);
      }

      out.set(
        msg.id,
        extra.length > 0 ? `${msg.text}\n${extra.join("\n")}`.trim() : msg.text,
      );
    }

    return out;
  }

  public async close(): Promise<void> {
    this.#closed = true;
    await Promise.allSettled(this.#pendingByMessage.values());
  }

  async #processList(
    _message: MessageRecord,
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
      const detected = detectImageMime(bytes);

      if (!detected) {
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

        return;
      }

      if (!settings.media.autoAnalyzeImages && !forceAnalyze) {
        await this.#store.assets.markReady(record.id, {
          filePath,
          mimeType: detected.mime,
          sha256,
          transcript: attachment.name || "图片已缓存",
        });

        return;
      }

      const description = await this.#analyzeImage(
        bytes,
        detected.mime,
        record.chatKey,
        settings,
      );

      await this.#store.assets.markReady(record.id, {
        filePath,
        mimeType: detected.mime,
        sha256,
        transcript: description,
      });

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
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const text = await this.#transcribeAudio(
        bytes,
        attachment.name || "audio.mp3",
        record.chatKey,
        settings,
      );

      await this.#store.assets.markReady(record.id, {
        mimeType: "audio/mpeg",
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
        sender.card ??
          sender.nickname ??
          node.nickname ??
          sender.user_id ??
          "成员",
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
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });

    if (!res.ok) {
      throw new Error(`下载失败 HTTP ${res.status}`);
    }

    const buf = Buffer.from(await res.arrayBuffer());

    if (buf.byteLength === 0 || buf.byteLength > MAX_ASSET_BYTES) {
      throw new Error("媒体体积超出允许范围（最大 8MB）");
    }

    return buf;
  }

  async #analyzeImage(
    bytes: Buffer,
    mimeType: string,
    chatKey: ChatKey,
    settings: RuntimeSettings,
  ): Promise<string> {
    const apiKey = settings.media.visionApiKey || settings.mainModel.apiKey;
    const baseURL = settings.media.visionBaseURL || settings.mainModel.baseURL;
    const model = settings.media.visionModel || settings.mainModel.model;

    if (!apiKey || !model) {
      return "图片已保存（未配置视觉模型密钥，跳过识图）";
    }

    const started = performance.now();
    const client = new OpenAI({
      apiKey,
      baseURL,
      timeout: settings.mainModel.timeoutMs,
      maxRetries: 1,
    });
    const dataUrl = `data:${mimeType};base64,${bytes.toString("base64")}`;
    const completion = await client.chat.completions.create({
      model,
      temperature: 0.2,
      max_tokens: 400,
      messages: [
        {
          role: "system",
          content:
            "用简洁中文概括图片主要内容，并尽量完整提取图中可见文字、报错信息、代码或界面关键字段。",
        },
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: dataUrl } }],
        },
      ],
    });

    await this.#store.usage.record({
      purpose: "vision",
      model,
      chatKey,
      inputTokens: completion.usage?.prompt_tokens ?? 0,
      cachedInputTokens:
        completion.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      outputTokens: completion.usage?.completion_tokens ?? 0,
      durationMs: Math.round(performance.now() - started),
      timeZone: settings.bot.timezone,
    });

    return completion.choices[0]?.message.content?.trim() || "无法识别图片内容";
  }

  async #transcribeAudio(
    bytes: Buffer,
    filename: string,
    chatKey: ChatKey,
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
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: res.text.length,
      durationMs: Math.round(performance.now() - started),
      timeZone: settings.bot.timezone,
    });

    return res.text.trim() || "空白语音";
  }
}
