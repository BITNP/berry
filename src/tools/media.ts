import { Type } from "typebox";

import { parseChatKey } from "../utils/chat-key.ts";
import { assertCanReadChat, resolveAuthorizedChat } from "./chat.ts";
import { defineTool } from "./define.ts";

export const inspectMediaTool = defineTool({
  name: "inspect_media",
  description:
    "查看消息附带的图片识图结论、语音转写文本或合并转发内容（支持 quoteRef 或 messageId）；inspectNow=true 时立即触发未完成的识别。",
  parameters: Type.Object(
    {
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
      throw new Error("请提供有效的 messageId 或 quoteRef");
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
