import { readFile } from "node:fs/promises";

import { Type } from "typebox";

import { checkStickerEligibility } from "../media/sticker-filter.ts";
import type { MessageAssetRecord } from "../types.ts";
import { isAdmin } from "./access.ts";
import { defineTool, defineToolProvider } from "./define.ts";
import type { ToolContext } from "./types.ts";

export const searchStickersTool = defineTool({
  name: "search_stickers",
  description:
    '按情绪或语境关键词检索表情包库中已审核启用的表情包（支持多关键词空格分隔，如 "无语 傲娇"、"开心 贴贴"、"吃瓜"；留空或无精确命中时也会返回可用候选供挑选）。查到后（或直接从本轮 availableStickers 中选出后）在最终回复 JSON 的 units 中输出 {"kind":"qq_image","stickerId":123} 发送，切勿把 qq_image 当成工具调用。',
  parameters: Type.Object(
    {
      query: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 24 })),
    },
    { additionalProperties: false },
  ),
  execute: async (args, ctx) => {
    const { total, libraryTotal, fallback, items } =
      await ctx.services.store.stickers.searchApproved(
        args.query ?? "",
        args.limit ?? 8,
      );

    return {
      total,
      libraryTotal,
      ...(fallback
        ? {
            fallback: true,
            note: "未精确命中关键词，已返回表情包库中的可用候选，可按语境挑选合适的一张直接发送",
          }
        : {}),
      items: items.map((item) => ({
        stickerId: item.id,
        meaning: item.meaning,
        tags: item.tags,
      })),
    };
  },
});

async function resolveImageAsset(
  ctx: ToolContext,
  args: { assetId?: number; messageRef?: string },
): Promise<MessageAssetRecord> {
  const { store, media } = ctx.services;

  let candidate: MessageAssetRecord | null = null;

  if (args.assetId !== undefined) {
    candidate = await store.assets.get(args.assetId);
    if (candidate?.kind !== "image") {
      throw new Error(`未找到图片附件 #${args.assetId}`);
    }
  } else if (args.messageRef?.trim()) {
    const meta = ctx.ids.resolveMessageMeta(args.messageRef.trim());
    const targetChatKey = meta.chatKey ?? ctx.actor.chatKey;
    const msg = await store.messages.findByOnebotId(targetChatKey, meta.rawId);

    if (!msg) {
      throw new Error(`未找到消息 ${args.messageRef}`);
    }

    const assetMap = await store.assets.listForMessages([msg.id]);

    candidate =
      (assetMap.get(msg.id) ?? []).find((item) => item.kind === "image") ??
      null;

    if (!candidate) {
      throw new Error(`消息 ${args.messageRef} 中不包含图片附件`);
    }
  } else {
    const recent = await store.messages.recent(ctx.actor.chatKey, 15);
    const assetMap = await store.assets.listForMessages(
      recent.map((m) => m.id),
    );

    for (let i = recent.length - 1; i >= 0; i--) {
      const msg = recent[i]!;
      const img = (assetMap.get(msg.id) ?? []).find(
        (item) => item.kind === "image",
      );

      if (img) {
        candidate = img;

        break;
      }
    }

    if (!candidate) {
      throw new Error("当前会话近期消息里未找到图片附件，请先发送或引用一张图");
    }
  }

  if (!candidate.filePath || !candidate.sha256) {
    await media.inspectAssetOnDemand(candidate.id).catch(() => {});
    candidate = (await store.assets.get(candidate.id)) ?? candidate;
  }

  if (!candidate.filePath || !candidate.sha256) {
    throw new Error(
      `图片附件 #${candidate.id} 尚未缓存到本地磁盘，暂时无法收录`,
    );
  }

  return candidate;
}

const saveStickerTool = defineTool({
  name: "save_sticker",
  description:
    "仅管理员可用：把聊天中真正的表情包/梗图/Q版反应图收录并上架到表情包库（立即审核通过并启用，随后可用 search_stickers 搜到并用 qq_image 发送）。严禁收录聊天截图、通知横条截图、后台/网页界面截图、代码报错图或普通照片；批量收录前请先确认每张图的识图描述确实是表情包且未重复。优先传上下文中的 assetId（[附件 #N]）或 messageRef（m_* 句柄）；均省略时自动取当前会话最近一张图片。",
  mutating: true,
  parameters: Type.Object(
    {
      assetId: Type.Optional(Type.Integer({ minimum: 1 })),
      messageRef: Type.Optional(Type.String({ minLength: 1 })),
      meaning: Type.String({ minLength: 1, maxLength: 180 }),
      tags: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    },
    { additionalProperties: false },
  ),
  execute: async (args, ctx) => {
    if (!isAdmin(ctx.actor)) {
      throw new Error("仅管理员或网协管理层可直接收录表情包");
    }

    const asset = await resolveImageAsset(ctx, args);
    const cleanMeaning = args.meaning.trim().slice(0, 180);
    const bytes = await readFile(asset.filePath!).catch(() => undefined);
    const eligibility = checkStickerEligibility({
      bytes,
      meaning: cleanMeaning,
      transcript: asset.transcript,
    });

    if (!eligibility.ok) {
      throw new Error(eligibility.reason);
    }

    const cleanTags = (args.tags ?? [])
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 8);
    const tags = cleanTags.length > 0 ? cleanTags : ["表情包"];

    const existingBySha = await ctx.services.store.stickers.getBySha256(
      asset.sha256,
    );

    if (!existingBySha) {
      const existingByMeaning =
        await ctx.services.store.stickers.findByNormalizedMeaning(cleanMeaning);

      if (existingByMeaning) {
        return {
          ok: true,
          stickerId: existingByMeaning.id,
          created: false,
          deduplicated: true,
          meaning: existingByMeaning.meaning,
          tags: existingByMeaning.tags,
          status: existingByMeaning.status,
          enabled: existingByMeaning.enabled,
        };
      }
    }

    const { record, created } =
      await ctx.services.store.stickers.collectIfAbsent({
        sha256: asset.sha256,
        filePath: asset.filePath!,
        mimeType: asset.mimeType || "image/png",
        meaning: cleanMeaning,
        tags,
        sourceChatKey: asset.chatKey,
        status: "approved",
        enabled: true,
      });

    const finalRecord = created
      ? record
      : ((await ctx.services.store.stickers.update(record.id, {
          meaning: cleanMeaning,
          tags,
          status: "approved",
          enabled: true,
        })) ?? record);

    return {
      ok: true,
      stickerId: finalRecord.id,
      created,
      meaning: finalRecord.meaning,
      tags: finalRecord.tags,
      status: finalRecord.status,
      enabled: finalRecord.enabled,
    };
  },
});

export const saveStickerToolProvider = defineToolProvider({
  id: "save_sticker",
  describe: () => [
    "- save_sticker(meaning, tags?, assetId?, messageRef?): 仅管理员可用，直接把聊天中的图片附件收录上架到表情包库",
  ],
  resolve: (ctx) => (isAdmin(ctx.actor) ? [saveStickerTool.bind(ctx)] : []),
});
