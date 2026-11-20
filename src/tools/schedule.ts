import { Type } from "typebox";

import { scheduleSpecSchema } from "../config/settings.ts";
import type { ScheduleSpec } from "../types.ts";
import { parseChatKey } from "../types.ts";
import { defineTool } from "./types.ts";

export const scheduleManageTool = defineTool({
  name: "schedule_manage",
  description:
    "列出、创建、更新或删除持久化定时任务（once/interval/daily/weekly/monthly/yearly）。可用 targetRef 指定投递群或私聊。",
  capability:
    "- schedule_manage: 管理持久化定时提醒或周期任务，可绑定当前会话或指定 g_*/u_* 目标。",
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
  execute: async (args, ctx) => {
    const { services, actor, ids } = ctx;
    const parsedChat = parseChatKey(actor.chatKey);
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
            ...(args.content === undefined ? {} : { content: args.content }),
            ...(args.schedule === undefined ? {} : { schedule: args.schedule }),
            ...(args.enabled === undefined ? {} : { enabled: args.enabled }),
          },
          tz,
        );

        return { mutated: task !== null, updated: task !== null, task };
      }

      case "delete": {
        const deleted = await services.store.schedules.remove(args.id ?? "");

        return { mutated: deleted, deleted };
      }
    }
  },
});
