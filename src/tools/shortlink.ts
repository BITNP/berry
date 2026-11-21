import { Type } from "typebox";

import { defineTool } from "./define.ts";

export const shortenUrlTool = defineTool({
  name: "shorten_url",
  description:
    "将较长的 http/https 链接通过 BITNP 短链服务（p.bitnp.net）缩短为简短链接，便于在 QQ 中发送。",
  available: (services) => services.shortlink.enabled,
  parameters: Type.Object(
    {
      url: Type.String({ minLength: 1, maxLength: 2048 }),
    },
    { additionalProperties: false },
  ),
  execute: async (args, ctx) => {
    const shortUrl = await ctx.services.shortlink.shorten(args.url);

    return {
      originalUrl: args.url.trim(),
      shortUrl,
    };
  },
});
