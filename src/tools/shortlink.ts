import { Type } from "typebox";

import { requirePrivileged } from "./access.ts";
import { defineTool } from "./define.ts";

export const shortenUrlTool = defineTool({
  name: "shorten_url",
  description:
    "将较长的 http/https 链接通过 BITNP 短链服务（p.bitnp.net）缩短为简短链接，便于在 QQ 中发送（仅管理员或网协管理层可用）。",
  available: (services) => services.shortlink.enabled,
  guard: requirePrivileged("使用短链服务"),
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
