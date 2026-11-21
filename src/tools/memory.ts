import { Type } from "typebox";

import { parseChatKey } from "../types.ts";
import { assertCanReadChat } from "./chat.ts";
import { defineTool, isPrivilegedActor } from "./types.ts";

export const memoryManageTool = defineTool({
  name: "memory_manage",
  description:
    "读取、保存或删除长期记忆。普通权限仅可读取当前可见范围的记忆；写入或删除（global / chat / user）仅限管理员或网协管理层（非管理员禁止跨会话修改或操作他人个人记忆）。",
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

    // Write / delete guards: require privileged role (admin or management).
    if (!isPrivilegedActor(actor)) {
      throw new Error("仅管理员或网协管理层可修改或删除长期记忆");
    }

    if (args.scope === "chat") {
      if (!actor.actorIsAdmin && ownerId !== actor.chatKey) {
        throw new Error("禁止跨会话修改或删除其他会话的记忆");
      }
    } else if (
      args.scope === "user" &&
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
