import { Type } from "typebox";

import type { AgentServices, AgentTool } from "../agent/loop.ts";
import { defineTool } from "../agent/loop.ts";
import type { ModelIds } from "../agent/model-ids.ts";
import { runSubagent } from "../agent/subagents.ts";
import { scheduleSpecSchema } from "../config/settings.ts";
import type { ChatKey, ScheduleSpec } from "../types.ts";
import { parseChatKey } from "../types.ts";

export interface ToolActor {
  chatKey: ChatKey;
  senderQQ: string | null;
  actorSubject: string | null;
  actorName: string | null;
  actorIsAdmin: boolean;
  triggerMessageId?: number | null;
}

export const createMemoryManageTool = (
  services: AgentServices,
  actor: ToolActor,
  ids: ModelIds,
): AgentTool =>
  defineTool({
    name: "memory_manage",
    description:
      "读取、保存或删除长期记忆。scope 可选 global（全局共识/设定）、chat（指定或当前会话记忆）、user（特定成员偏好）。",
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
    execute: async (args) => {
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
          deleted: await services.store.memories.remove(
            args.scope,
            ownerId,
            key,
          ),
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

export function buildMainTools(
  services: AgentServices,
  actor: ToolActor,
  ids: ModelIds,
): AgentTool[] {
  const parsedChat = parseChatKey(actor.chatKey);

  return [
    defineTool({
      name: "delegate_subagent",
      description:
        "委派隔离的零历史任务子代理完成检索或执行操作，只返回精炼结论，避免污染全局主上下文。kind 可选：chat_analyst（查各群聊/本人私聊记录、媒体识图转写、QQ 通讯录）、guild_operator（查询或代理创建/更新公会节点、发布评论、解析成员身份）、workspace_operator（检索知识库、读写记事本与调用外部 MCP 工具）。",
      parameters: Type.Object(
        {
          kind: Type.Union([
            Type.Literal("chat_analyst"),
            Type.Literal("guild_operator"),
            Type.Literal("workspace_operator"),
          ]),
          task: Type.String({ minLength: 1 }),
        },
        { additionalProperties: false },
      ),
      execute: (args) =>
        runSubagent({
          kind: args.kind,
          task: args.task,
          services,
          actor,
          ids,
        }),
    }),
    createMemoryManageTool(services, actor, ids),
    defineTool({
      name: "schedule_manage",
      description:
        "列出、创建、更新或删除持久化定时任务（once/interval/daily/weekly/monthly/yearly）。可用 targetRef 指定投递群或私聊。",
      parameters: Type.Object(
        {
          action: Type.Union([
            Type.Literal("list"),
            Type.Literal("create"),
            Type.Literal("update"),
            Type.Literal("delete"),
          ]),
          id: Type.Optional(Type.String()),
          title: Type.Optional(Type.String()),
          content: Type.Optional(Type.String()),
          schedule: Type.Optional(scheduleSpecSchema),
          enabled: Type.Optional(Type.Boolean()),
          targetRef: Type.Optional(Type.String()),
          targetCurrentChat: Type.Optional(Type.Boolean()),
        },
        { additionalProperties: false },
      ),
      execute: async (args) => {
        const tz = services.getSettings().bot.timezone;

        switch (args.action) {
          case "list": {
            return {
              mutated: false,
              tasks: await services.store.schedules.list(),
            };
          }

          case "create": {
            let kind: "group" | "private" | "" = "";
            let chatId = "";

            if (args.targetRef?.trim()) {
              const resolved = parseChatKey(
                ids.resolveTargetChatKey(args.targetRef),
              );

              kind = resolved.kind;
              chatId = resolved.chatId;
            } else if (args.targetCurrentChat !== false) {
              kind = parsedChat.kind;
              chatId = parsedChat.chatId;
            }

            const task = await services.store.schedules.create(
              {
                title: args.title ?? "",
                content: args.content ?? "",
                schedule: args.schedule as ScheduleSpec,
                kind,
                chatId,
              },
              tz,
            );

            return { mutated: true, task };
          }

          case "update": {
            const task = await services.store.schedules.update(
              args.id ?? "",
              {
                ...(args.title === undefined ? {} : { title: args.title }),
                ...(args.content === undefined
                  ? {}
                  : { content: args.content }),
                ...(args.schedule === undefined
                  ? {}
                  : { schedule: args.schedule }),
                ...(args.enabled === undefined
                  ? {}
                  : { enabled: args.enabled }),
              },
              tz,
            );

            return { mutated: task !== null, updated: task !== null, task };
          }

          case "delete": {
            const deleted = await services.store.schedules.remove(
              args.id ?? "",
            );

            return { mutated: deleted, deleted };
          }
        }
      },
    }),
  ];
}
