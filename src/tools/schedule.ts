import { Type } from "typebox";

import { scheduleSpecSchema } from "../config/settings.ts";
import type { ScheduleSpec } from "../types.ts";
import { parseChatKey } from "../utils/chat-key.ts";
import { isAdmin } from "./access.ts";
import { defineTool } from "./define.ts";
import type { ToolActor } from "./types.ts";

function assertAdminForSchedule(actor: ToolActor, verb: string): void {
  if (!isAdmin(actor)) {
    throw new Error(`仅管理员或网协管理层可${verb}定时任务`);
  }
}

export const scheduleManageTool = defineTool({
  name: "schedule_manage",
  description:
    "列出、创建、更新或删除持久化定时任务（once/interval/daily/weekly/monthly/yearly）。查看当前会话任务对所有用户开放；查看全部及创建/修改/删除仅限管理员或网协管理层。",
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
        const all = await services.store.schedules.list();
        const tasks = isAdmin(actor)
          ? all
          : all.filter((task) => task.chatKey === actor.chatKey);

        return {
          mutated: false,
          tasks,
        };
      }

      case "create": {
        assertAdminForSchedule(actor, "创建");

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
        assertAdminForSchedule(actor, "修改");

        const existing = await services.store.schedules.get(args.id ?? "");

        if (!existing) {
          return { mutated: false, updated: false, task: null };
        }

        const task = await services.store.schedules.update(
          existing.id,
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
        assertAdminForSchedule(actor, "删除");

        const existing = await services.store.schedules.get(args.id ?? "");

        if (!existing) {
          return { mutated: false, deleted: false };
        }

        const deleted = await services.store.schedules.remove(existing.id);

        return { mutated: deleted, deleted };
      }
    }
  },
});
