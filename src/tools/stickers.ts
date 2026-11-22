import { Type } from "typebox";

import { defineTool } from "./define.ts";

export const searchStickersTool = defineTool({
  name: "search_stickers",
  description:
    '按情绪或语境关键词检索表情包库中已审核启用的表情包（支持多关键词空格分隔，如 "无语 傲娇"、"开心 贴贴"、"吃瓜"；留空返回可用表情包列表）。查到后在最终回复 JSON 的 units 中输出 {"kind":"qq_image","stickerId":123} 发送，切勿把 qq_image 当成工具调用。',
  parameters: Type.Object(
    {
      query: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 12 })),
    },
    { additionalProperties: false },
  ),
  execute: async (args, ctx) => {
    const { total, items } = await ctx.services.store.stickers.searchApproved(
      args.query ?? "",
      args.limit ?? 6,
    );

    return {
      total,
      items: items.map((item) => ({
        stickerId: item.id,
        meaning: item.meaning,
        tags: item.tags,
      })),
    };
  },
});
