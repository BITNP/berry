import { Type } from "typebox";

import { defineTool } from "./types.ts";

export const memoryManageTool = defineTool({
  name: "memory_manage",
  description:
    "读取、保存或删除长期记忆。scope 可选 global（全局共识/设定）、chat（指定或当前会话记忆）、user（特定成员偏好）。",
  capability:
    "- memory_manage: 读写 global（全局共识）、chat（会话级）或 user（个人偏好）长期记忆。",
  parameters: Type.Object(
    {
      action: Type.Union([
        Type.Literal("read"),
        Type.Literal("upsert"),
        Type.Literal("delete"),
      ]),
      scope: Type.Union([
        Type.Literal("global"),
        Type.Literal("chat"),
        Type.Literal("user"),
      ]),
      targetRef: Type.Optional(Type.String()),
      userRef: Type.Optional(Type.String()),
      key: Type.String({ minLength: 1 }),
      summary: Type.Optional(Type.String()),
      content: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
  ),
  execute: async (args, ctx) => {
    const { services, actor, ids } = ctx;
    let ownerId = "global";

    if (args.scope === "chat") {
      ownerId = args.targetRef
        ? ids.resolveTargetChatKey(args.targetRef)
        : actor.chatKey;
    } else if (args.scope === "user") {
      ownerId = args.userRef
        ? ids.resolveUser(args.userRef)
        : (actor.senderQQ ?? "");
    }

    if (!ownerId) {
      throw new Error("缺少有效的归属引用");
    }

    const key = args.key.trim();

    if (!key) {
      throw new Error("key 不能为空");
    }

    if (args.action === "read") {
      return {
        mutated: false,
        memory: await services.store.memories.get(args.scope, ownerId, key),
      };
    }

    if (args.action === "delete") {
      return {
        mutated: true,
        deleted: await services.store.memories.remove(args.scope, ownerId, key),
      };
    }

    return {
      mutated: true,
      memory: await services.store.memories.upsert({
        scope: args.scope,
        ownerId,
        key,
        summary: (args.summary ?? "").slice(0, 200),
        content: args.content ?? "",
        sourceMessageId: actor.triggerMessageId ?? null,
      }),
    };
  },
});
