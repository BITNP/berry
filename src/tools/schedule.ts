import { Type } from "typebox";

import { scheduleSpecSchema } from "../config/settings.ts";
import type { ScheduleSpec } from "../types.ts";
import { parseChatKey } from "../utils/chat-key.ts";
import { isPrivilegedActor } from "./access.ts";
import { defineTool } from "./define.ts";
import type { ToolActor } from "./types.ts";

const MIN_NON_ADMIN_INTERVAL_SECONDS = 300;

function assertPrivilegedForSchedule(actor: ToolActor, verb: string): void {
  if (!isPrivilegedActor(actor)) {
    throw new Error(`仅管理员或网协管理层可${verb}定时任务`);
  }
}

function assertScheduleIntervalAllowed(
  spec: ScheduleSpec | undefined,
  actor: ToolActor,
): void {
  if (spec?.kind !== "interval" || actor.actorIsAdmin) {
    return;
  }

  const totalSeconds =
    (spec.everySeconds ?? 0) +
    (spec.everyMinutes ?? 0) * 60 +
    (spec.everyHours ?? 0) * 3600 +
    (spec.everyDays ?? 0) * 86_400;

  if (totalSeconds < MIN_NON_ADMIN_INTERVAL_SECONDS) {
    throw new Error(
      `非管理员创建的轮询定时任务间隔不得短于 ${MIN_NON_ADMIN_INTERVAL_SECONDS / 60} 分钟`,
    );
  }
}

export const scheduleManageTool = defineTool({
  name: "schedule_manage",
  description:
    "列出、创建、更新或删除持久化定时任务（once/interval/daily/weekly/monthly/yearly）。仅管理员或网协管理层可创建/改删；非管理员仅限操作当前会话的任务且轮询间隔不得短于 5 分钟。",
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
        const tasks = actor.actorIsAdmin
          ? all
          : all.filter((task) => task.chatKey === actor.chatKey);

        return {
          mutated: false,
          tasks,
        };
      }

      case "create": {
        assertPrivilegedForSchedule(actor, "创建");
        assertScheduleIntervalAllowed(args.schedule, actor);

        let kind: "group" | "private" | "" = "";
        let chatId = "";

        if (args.targetRef?.trim()) {
          const targetChatKey = ids.resolveTargetChatKey(args.targetRef);

          if (!actor.actorIsAdmin && targetChatKey !== actor.chatKey) {
            throw new Error("非管理员禁止为其他群或他人创建定时任务");
          }

          const resolved = parseChatKey(targetChatKey);

          kind = resolved.kind;
          chatId = resolved.chatId;
        } else if (args.targetCurrentChat === false) {
          if (!actor.actorIsAdmin) {
            throw new Error("非管理员禁止创建无目标的全局定时任务");
          }
        } else {
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
        assertPrivilegedForSchedule(actor, "修改");

        const existing = await services.store.schedules.get(args.id ?? "");

        if (!existing) {
          return { mutated: false, updated: false, task: null };
        }

        if (!actor.actorIsAdmin && existing.chatKey !== actor.chatKey) {
          throw new Error("非管理员禁止修改其他会话的定时任务");
        }

        assertScheduleIntervalAllowed(args.schedule, actor);

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
        assertPrivilegedForSchedule(actor, "删除");

        const existing = await services.store.schedules.get(args.id ?? "");

        if (!existing) {
          return { mutated: false, deleted: false };
        }

        if (!actor.actorIsAdmin && existing.chatKey !== actor.chatKey) {
          throw new Error("非管理员禁止删除其他会话的定时任务");
        }

        const deleted = await services.store.schedules.remove(existing.id);

        return { mutated: deleted, deleted };
      }
    }
  },
});
