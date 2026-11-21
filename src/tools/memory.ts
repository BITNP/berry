import { Type } from "typebox";

import { parseChatKey } from "../utils/chat-key.ts";
import { isAdmin } from "./access.ts";
import { assertCanReadChat } from "./chat.ts";
import { defineTool } from "./define.ts";

export const memoryManageTool = defineTool({
  name: "memory_manage",
  description:
    "读取、保存或删除长期记忆。所有用户可读取当前可见范围的记忆（全局、当前会话及本人个人记忆）；写入或删除仅限管理员或网协管理层。对于临时排期、短期活动或有时效的通知，请设置 ttlDays 或 expiresAt（ISO 时间）让记忆到期自动失效；已有同类记忆时优先复用原 key 覆盖去重。",
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
      expiresAt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      ttlDays: Type.Optional(Type.Number({ minimum: 0.01, maximum: 3650 })),
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
      if (args.scope === "chat") {
        const parsed = parseChatKey(ownerId);

        assertCanReadChat(ctx, parsed.kind, parsed.chatId);
      } else if (
        args.scope === "user" &&
        !isAdmin(actor) &&
        ownerId !== actor.senderQQ
      ) {
        throw new Error("无权读取其他用户的个人记忆");
      }

      return {
        mutated: false,
        memory: await services.store.memories.get(args.scope, ownerId, key),
      };
    }

    if (!isAdmin(actor)) {
      throw new Error("仅管理员或网协管理层可修改或删除长期记忆");
    }

    if (args.action === "delete") {
      return {
        mutated: true,
        deleted: await services.store.memories.remove(args.scope, ownerId, key),
      };
    }

    let expiresAt: number | null = null;

    if (typeof args.expiresAt === "string" && args.expiresAt.trim()) {
      const parsed = Date.parse(args.expiresAt);

      if (!Number.isFinite(parsed)) {
        throw new TypeError(`无效的 expiresAt 时间格式：${args.expiresAt}`);
      }

      expiresAt = parsed;
    } else if (args.ttlDays !== undefined) {
      expiresAt = Date.now() + Math.round(args.ttlDays * 86_400_000);
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
        expiresAt,
      }),
    };
  },
});
