import { Type } from "typebox";

import { parseChatKey } from "../utils/chat-key.ts";
import { assertCanReadChat, resolveAuthorizedChat } from "./chat.ts";
import { defineTool } from "./define.ts";

export const inspectMediaTool = defineTool({
  name: "inspect_media",
  description:
    "查看消息附带的图片识图结论、语音转写文本或合并转发内容，或按需对原图做高精度细节读图。当上下文中的 [图片内容 #N: 摘要] 细节不足（如需要核对截图中的小字、完整代码/报错堆栈、表格数值或局部画面）时，直接传 assetId（即 #N）和 question（想看清的具体问题/关注点）即可让视觉模型重新细看原图；也支持按 quoteRef / messageId 查询，inspectNow=true 时立即触发未完成的识别。",
  parameters: Type.Object(
    {
      assetId: Type.Optional(Type.Integer({ minimum: 1 })),
      question: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
      targetRef: Type.Optional(Type.String()),
      messageId: Type.Optional(Type.Integer({ minimum: 1 })),
      quoteRef: Type.Optional(Type.String()),
      inspectNow: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  ),
  execute: async (args, ctx) => {
    const { store, media } = ctx.services;
    const { ids } = ctx;
    const question = args.question?.trim() || null;

    if (args.assetId !== undefined) {
      const existing = await store.assets.get(args.assetId);

      if (!existing) {
        throw new Error(`未找到附件 #${args.assetId}`);
      }

      const parsedChat = parseChatKey(existing.chatKey);

      assertCanReadChat(ctx, parsedChat.kind, parsedChat.chatId);
      await media.waitForMessages([existing.messageId]);

      let asset = (await store.assets.get(existing.id)) ?? existing;

      if (question) {
        const { asset: resolved, detail } = await media.askImageDetail(
          asset.id,
          question,
          { jobId: ctx.trace?.jobId ?? null },
        );

        return {
          assetId: resolved.id,
          messageId: resolved.messageId,
          question,
          summary: resolved.transcript,
          detail,
        };
      }

      if (args.inspectNow && (asset.status !== "ready" || !asset.transcript)) {
        asset = await media.inspectAssetOnDemand(asset.id);
      }

      return { messageId: asset.messageId, assets: [asset] };
    }

    let targetId = args.messageId ?? null;
    let verifiedChat = false;

    if (!targetId && args.quoteRef) {
      const meta = ids.resolveMessageMeta(args.quoteRef);
      let lookupKey: string;

      if (meta.chatKey) {
        const parsedLookup = parseChatKey(meta.chatKey);

        assertCanReadChat(ctx, parsedLookup.kind, parsedLookup.chatId);
        lookupKey = meta.chatKey;
      } else {
        lookupKey = resolveAuthorizedChat(ctx, args.targetRef).targetChatKey;
      }

      verifiedChat = true;
      const msg = await store.messages.findByOnebotId(lookupKey, meta.rawId);

      targetId = msg?.id ?? null;
    }

    if (!targetId) {
      throw new Error("请提供有效的 assetId、messageId 或 quoteRef");
    }

    const msgRow = await store.messages.get(targetId);

    if (!msgRow) {
      throw new Error("未找到指定消息");
    }

    if (!verifiedChat) {
      assertCanReadChat(ctx, msgRow.kind, msgRow.chatId);
    }

    await media.waitForMessages([targetId]);
    let assets = await store.assets.listForMessage(targetId);

    if (question) {
      const images = assets.filter((asset) => asset.kind === "image");

      if (images.length === 0) {
        throw new Error("该消息不包含图片附件，无法进行细节读图");
      }

      const details = await Promise.all(
        images.slice(0, 4).map(async (img) => {
          const res = await media.askImageDetail(img.id, question, {
            jobId: ctx.trace?.jobId ?? null,
          });

          return {
            assetId: res.asset.id,
            summary: res.asset.transcript,
            detail: res.detail,
          };
        }),
      );

      return { messageId: targetId, question, details };
    }

    if (args.inspectNow) {
      assets = await Promise.all(
        assets.map((asset) =>
          asset.status === "ready" && asset.transcript
            ? Promise.resolve(asset)
            : media.inspectAssetOnDemand(asset.id),
        ),
      );
    }

    return { messageId: targetId, assets };
  },
});
