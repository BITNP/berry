import { Type } from "typebox";

import { parseChatKey } from "../types.ts";
import { assertCanReadChat, resolveAuthorizedChat } from "./chat.ts";
import type { ToolDefinition } from "./types.ts";
import { defineTool } from "./types.ts";

export const inspectMediaTool = defineTool({
  name: "inspect_media",
  description:
    "查看消息附带的图片识图结论、语音转写文本或合并转发内容；inspectNow=true 时立即触发未完成的识别。",
  capability:
    "- inspect_media: 查看或按需触发消息的图片识图、语音转写或合并转发展开（支持 quoteRef 或 messageId）。",
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
    const { actor, ids } = ctx;
    let targetId = args.messageId ?? null;

    if (!targetId && args.quoteRef) {
      const meta = ids.resolveMessageMeta(args.quoteRef);
      const lookupKey =
        meta.chatKey ??
        resolveAuthorizedChat(ctx, args.targetRef).targetChatKey;
      const parsedLookup = parseChatKey(lookupKey);

      assertCanReadChat(actor, parsedLookup.kind, parsedLookup.chatId);
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

    assertCanReadChat(actor, msgRow.kind, msgRow.chatId);
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

export const mediaTools: readonly ToolDefinition[] = [inspectMediaTool];
