import { Type } from "typebox";

import { parseChatKey } from "../utils/chat-key.ts";
import { isAdmin } from "./access.ts";
import { assertCanReadChat } from "./chat.ts";
import { defineTool } from "./define.ts";

export const memoryManageTool = defineTool({
  name: "memory_manage",
  description:
    '读取、保存或删除轻量长期记忆（每轮自动注入上下文，仅用于树莓娘行为/发言/群活跃度约定、成员称呼/外号/身份映射、群别称、成员稳定偏好，以及带 ttlDays 或 expiresAt 的短期提醒）。项目架构、技术讨论、工作流程规范（SOP）、问题跟进、会议纪要和长篇参考资料属于知识库，应放 Bunko 云文档（bunko_operator），禁止写入长期记忆。所有用户可读取当前可见范围记忆；写删仅限管理员或网协管理层。针对单个群的规则必须用 scope="chat" 并传该群 targetRef，禁止误写为 global；已有同类记忆时优先复用原 key 覆盖去重；管理员给出新偏好/称呼/规则时必须实际调用 upsert 落库，不可仅口头答应。',
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
