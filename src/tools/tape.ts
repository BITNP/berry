import { Type } from "typebox";

import { requireAdmin } from "./access.ts";
import { defineTool } from "./define.ts";

const MAX_SNIPPET = 2400;

export const inspectTapeTool = defineTool({
  name: "inspect_tape",
  description:
    "仅管理员可用。按 entryIds 回查主 Tape 中被压缩摘要覆盖的原始对话条目（来自 conversationHandoff.sourceEntryIds），或按 sidecarId 查看子代理旁路 Sidecar Tape 的完整工具调用与原始产物，避免重复运行子代理。",
  guard: requireAdmin("回查主 Tape 或子代理 Sidecar 记录"),
  parameters: Type.Object(
    {
      entryIds: Type.Optional(
        Type.Array(Type.Integer({ minimum: 1 }), {
          minItems: 1,
          maxItems: 20,
        }),
      ),
      sidecarId: Type.Optional(Type.String({ minLength: 1 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 60 })),
    },
    { additionalProperties: false },
  ),
  execute: async (args, ctx) => {
    const { conversations } = ctx.services.store;

    if (args.sidecarId?.trim()) {
      const cleanId = args.sidecarId.trim().replace(/^sidecar:/, "");
      const entries = await conversations.listEntries({
        tapeId: `sidecar:${cleanId}`,
        limit: args.limit ?? 40,
      });

      return {
        tapeId: `sidecar:${cleanId}`,
        count: entries.length,
        entries: entries.map((entry) =>
          entry.kind === "anchor"
            ? {
                id: entry.id,
                kind: entry.kind,
                anchor: entry.anchor,
                createdAt: new Date(entry.createdAt).toISOString(),
              }
            : {
                id: entry.id,
                kind: entry.kind,
                role: entry.role,
                chatKey: entry.chatKey,
                content:
                  typeof entry.message.content === "string"
                    ? entry.message.content.slice(0, MAX_SNIPPET)
                    : null,
                toolCalls:
                  entry.message.role === "assistant"
                    ? entry.message.tool_calls?.map((c) => ({
                        id: c.id,
                        name: c.function.name,
                        arguments: c.function.arguments.slice(0, 600),
                      }))
                    : undefined,
                createdAt: new Date(entry.createdAt).toISOString(),
              },
        ),
      };
    }

    if (args.entryIds?.length) {
      const entries = await conversations.getEntriesByIds(args.entryIds);

      return {
        tapeId: "global",
        count: entries.length,
        entries: entries.map((entry) =>
          entry.kind === "anchor"
            ? {
                id: entry.id,
                kind: entry.kind,
                anchor: entry.anchor,
                createdAt: new Date(entry.createdAt).toISOString(),
              }
            : {
                id: entry.id,
                kind: entry.kind,
                role: entry.role,
                chatKey: entry.chatKey,
                sidecarId: entry.sidecarId,
                content:
                  typeof entry.message.content === "string"
                    ? entry.message.content.slice(0, MAX_SNIPPET)
                    : null,
                createdAt: new Date(entry.createdAt).toISOString(),
              },
        ),
      };
    }

    throw new Error("请提供 entryIds 或 sidecarId 之一");
  },
});
