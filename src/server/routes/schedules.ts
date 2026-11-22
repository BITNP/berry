import type { Router } from "h3";
import { createError, defineEventHandler } from "h3";
import { Type } from "typebox";

import type { BerryApp } from "../../app.ts";
import { scheduleSpecSchema } from "../../config/settings.ts";
import { parseBody, parseParams, stringIdParamSchema } from "../http.ts";

const nonBlankString = Type.String({ minLength: 1, pattern: "\\S" });
const scheduleKindSchema = Type.Union([
  Type.Literal("group"),
  Type.Literal("private"),
  Type.Literal(""),
]);

const createScheduleBodySchema = Type.Object({
  title: nonBlankString,
  kind: Type.Optional(scheduleKindSchema),
  chatId: Type.Optional(Type.String()),
  content: nonBlankString,
  schedule: scheduleSpecSchema,
  enabled: Type.Optional(Type.Boolean()),
});

const patchScheduleBodySchema = Type.Object({
  title: Type.Optional(nonBlankString),
  kind: Type.Optional(scheduleKindSchema),
  chatId: Type.Optional(Type.String()),
  content: Type.Optional(nonBlankString),
  schedule: Type.Optional(scheduleSpecSchema),
  enabled: Type.Optional(Type.Boolean()),
});

export function registerScheduleRoutes(router: Router, berry: BerryApp): void {
  router.get(
    "/api/admin/schedules",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);

      return { items: await berry.store.schedules.list() };
    }),
  );

  router.post(
    "/api/admin/schedules",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);
      const body = await parseBody(event, createScheduleBodySchema);

      return berry.store.schedules.create(body, berry.settings.bot.timezone);
    }),
  );

  router.patch(
    "/api/admin/schedules/:id",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);
      const { id } = await parseParams(event, stringIdParamSchema);
      const body = await parseBody(event, patchScheduleBodySchema);
      const updated = await berry.store.schedules.update(
        id,
        body,
        berry.settings.bot.timezone,
      );

      if (!updated) {
        throw createError({ statusCode: 404, message: "定时任务不存在" });
      }

      return updated;
    }),
  );

  router.delete(
    "/api/admin/schedules/:id",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);
      const { id } = await parseParams(event, stringIdParamSchema);

      return { deleted: await berry.store.schedules.remove(id) };
    }),
  );

  router.post(
    "/api/admin/schedules/:id/run",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);
      const { id } = await parseParams(event, stringIdParamSchema);
      const ok = await berry.scheduler.triggerScheduleNow(id);

      if (!ok) {
        throw createError({ statusCode: 404, message: "定时任务不存在" });
      }

      return { queued: true };
    }),
  );
}
