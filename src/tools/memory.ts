import { Type } from "typebox";

import { parseChatKey } from "../types.ts";
import { assertCanReadChat } from "./chat.ts";
import { defineTool } from "./types.ts";

export const memoryManageTool = defineTool({
  name: "memory_manage",
  description:
    "读取、保存或删除长期记忆。scope 可选 global（全局共识/设定，仅管理员或部长级负责人可写删）、chat（当前会话记忆，仅网协在籍成员或管理员可写删且禁止跨群写删）、user（个人偏好，仅本人或管理员可写删）。",
  capability:
    "- memory_manage: 读写 global（全局共识）、chat（会话级）或 user（个人偏好）长期记忆（受身份权限约束）。",
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
      if (args.scope === "chat") {
        const parsed = parseChatKey(ownerId);

        await assertCanReadChat(ctx, parsed.kind, parsed.chatId);
      } else if (
        args.scope === "user" &&
        !actor.actorIsAdmin &&
        ownerId !== actor.senderQQ
      ) {
        throw new Error("无权读取其他用户的个人记忆");
      }

      return {
        mutated: false,
        memory: await services.store.memories.get(args.scope, ownerId, key),
      };
    }

    // Write / delete guards.
    if (args.scope === "global") {
      if (!actor.actorIsAdmin && !actor.actorIsManager) {
        throw new Error("仅管理员或部长级负责人可修改或删除全局记忆");
      }
    } else if (args.scope === "chat") {
      if (!actor.actorIsAdmin && ownerId !== actor.chatKey) {
        throw new Error("禁止跨会话修改或删除其他会话的记忆");
      }

      if (!actor.actorIsAdmin && !actor.actorAdmitted) {
        throw new Error("仅网协在籍成员或管理员可修改或删除会话记忆");
      }
    } else if (
      !actor.actorIsAdmin &&
      (!actor.senderQQ || ownerId !== actor.senderQQ)
    ) {
      throw new Error("仅可修改或删除本人的个人记忆");
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
