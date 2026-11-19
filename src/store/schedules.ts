import { randomUUID } from "node:crypto";

import { Cron } from "croner";
import type { Selectable } from "kysely";

import type { ChatKind, ScheduleRecord, ScheduleSpec } from "../types.ts";
import { makeChatKey } from "../types.ts";
import type { BerryDatabase } from "./database.ts";
import type { BerryTables } from "./schema.ts";

const WEEKDAY_MAP: Record<string, number> = {
  mon: 1,
  monday: 1,
  tue: 2,
  tuesday: 2,
  wed: 3,
  wednesday: 3,
  thu: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
  sun: 0,
  sunday: 0,
};

function parseClock(time: string): { hour: number; minute: number } {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());

  if (!match) {
    throw new Error(`Invalid HH:MM time: ${time}`);
  }

  const hour = Number(match[1]);
  const minute = Number(match[2]);

  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error(`Invalid clock value: ${time}`);
  }

  return { hour, minute };
}

function nextCronRunMs(
  pattern: string,
  afterMs: number,
  timeZone: string,
): number | null {
  const cron = new Cron(pattern, { timezone: timeZone });
  let next = cron.nextRun(new Date(afterMs));

  if (next && next.getTime() <= afterMs) {
    next = cron.nextRun(new Date(afterMs + 1000));
  }

  return next ? next.getTime() : null;
}

export function computeNextRunAt(
  spec: ScheduleSpec,
  afterMs: number,
  timeZone = "Asia/Shanghai",
): number | null {
  switch (spec.kind) {
    case "once": {
      const target = Date.parse(spec.at);

      if (Number.isNaN(target)) {
        throw new TypeError(`Invalid once timestamp: ${spec.at}`);
      }

      return target > afterMs ? target : null;
    }

    case "interval": {
      const intervalMs =
        ((spec.everySeconds ?? 0) +
          (spec.everyMinutes ?? 0) * 60 +
          (spec.everyHours ?? 0) * 3600 +
          (spec.everyDays ?? 0) * 86_400) *
        1000;

      if (intervalMs <= 0) {
        throw new Error("Interval schedule requires a positive duration");
      }

      return afterMs + intervalMs;
    }

    case "daily": {
      const { hour, minute } = parseClock(spec.time);

      return nextCronRunMs(`${minute} ${hour} * * *`, afterMs, timeZone);
    }

    case "weekly": {
      const { hour, minute } = parseClock(spec.time);
      const weekdays = [
        ...new Set(
          spec.weekdays.map((item) => {
            const day = WEEKDAY_MAP[item.trim().toLowerCase()];

            if (day === undefined) {
              throw new Error(`Invalid weekday: ${item}`);
            }

            return day;
          }),
        ),
      ];

      if (weekdays.length === 0) {
        throw new Error("Weekly schedule requires at least one weekday");
      }

      return nextCronRunMs(
        `${minute} ${hour} * * ${weekdays.join(",")}`,
        afterMs,
        timeZone,
      );
    }

    case "monthly": {
      const { hour, minute } = parseClock(spec.time);
      const days = [
        ...new Set(
          spec.daysOfMonth.filter(
            (day) => Number.isInteger(day) && day >= 1 && day <= 31,
          ),
        ),
      ];

      if (days.length === 0) {
        throw new Error(
          "Monthly schedule requires at least one valid day of month",
        );
      }

      return nextCronRunMs(
        `${minute} ${hour} ${days.join(",")} * *`,
        afterMs,
        timeZone,
      );
    }

    case "yearly": {
      const { hour, minute } = parseClock(spec.time);
      const probe = new Date(Date.UTC(2024, spec.month - 1, spec.day));

      if (
        probe.getUTCMonth() + 1 !== spec.month ||
        probe.getUTCDate() !== spec.day
      ) {
        return null;
      }

      return nextCronRunMs(
        `${minute} ${hour} ${spec.day} ${spec.month} *`,
        afterMs,
        timeZone,
      );
    }
  }
}

const decodeSchedule = (
  row: Selectable<BerryTables["schedules"]>,
): ScheduleRecord => ({
  id: row.id,
  title: row.title,
  chatKey: row.chat_key,
  kind: row.kind as ChatKind | "",
  chatId: row.chat_id,
  content: row.content,
  schedule: JSON.parse(row.schedule_json) as ScheduleSpec,
  enabled: Boolean(row.enabled),
  nextRunAt: row.next_run_at,
  lastRunAt: row.last_run_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export class SchedulesStore {
  #database: BerryDatabase;

  constructor(database: BerryDatabase) {
    this.#database = database;
  }

  public async list(): Promise<ScheduleRecord[]> {
    const rows = await this.#database.db
      .selectFrom("schedules")
      .selectAll()
      .orderBy("created_at", "desc")
      .execute();

    return rows.map(decodeSchedule);
  }

  public async get(id: string): Promise<ScheduleRecord | null> {
    const row = await this.#database.db
      .selectFrom("schedules")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();

    return row ? decodeSchedule(row) : null;
  }

  public async create(
    input: {
      title: string;
      kind?: ChatKind | "";
      chatId?: string;
      content: string;
      schedule: ScheduleSpec;
      enabled?: boolean;
    },
    timeZone: string,
  ): Promise<ScheduleRecord> {
    const now = Date.now();
    const enabled = input.enabled ?? true;
    const kind = input.kind ?? "";
    const chatId = input.chatId ?? "";
    const chatKey = kind && chatId ? makeChatKey(kind, chatId) : "";
    const nextRunAt = enabled
      ? computeNextRunAt(input.schedule, now, timeZone)
      : null;

    const row = await this.#database.writeTx((trx) =>
      trx
        .insertInto("schedules")
        .values({
          id: randomUUID().slice(0, 8),
          title: input.title,
          chat_key: chatKey,
          kind,
          chat_id: chatId,
          content: input.content,
          schedule_json: JSON.stringify(input.schedule),
          enabled: Number(enabled),
          next_run_at: nextRunAt,
          last_run_at: null,
          created_at: now,
          updated_at: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow(),
    );

    return decodeSchedule(row);
  }

  public async update(
    id: string,
    patch: {
      title?: string;
      content?: string;
      schedule?: ScheduleSpec;
      enabled?: boolean;
      kind?: ChatKind | "";
      chatId?: string;
    },
    timeZone: string,
  ): Promise<ScheduleRecord | null> {
    const existing = await this.get(id);

    if (!existing) {
      return null;
    }

    const now = Date.now();
    const nextSchedule = patch.schedule ?? existing.schedule;
    const nextEnabled = patch.enabled ?? existing.enabled;
    const nextKind = patch.kind ?? existing.kind;
    const nextChatId = patch.chatId ?? existing.chatId;
    const nextChatKey =
      nextKind && nextChatId ? makeChatKey(nextKind, nextChatId) : "";
    const nextRunAt = nextEnabled
      ? computeNextRunAt(nextSchedule, now, timeZone)
      : null;

    const row = await this.#database.writeTx((trx) =>
      trx
        .updateTable("schedules")
        .set({
          title: patch.title ?? existing.title,
          content: patch.content ?? existing.content,
          schedule_json: JSON.stringify(nextSchedule),
          enabled: Number(nextEnabled),
          kind: nextKind,
          chat_id: nextChatId,
          chat_key: nextChatKey,
          next_run_at: nextRunAt,
          updated_at: now,
        })
        .where("id", "=", id)
        .returningAll()
        .executeTakeFirst(),
    );

    return row ? decodeSchedule(row) : null;
  }

  public async remove(id: string): Promise<boolean> {
    return this.#database.writeTx(async (trx) => {
      const res = await trx
        .deleteFrom("schedules")
        .where("id", "=", id)
        .executeTakeFirst();

      return Number(res.numDeletedRows) > 0;
    });
  }

  public async due(now = Date.now()): Promise<ScheduleRecord[]> {
    const rows = await this.#database.db
      .selectFrom("schedules")
      .selectAll()
      .where("enabled", "=", 1)
      .where("next_run_at", "is not", null)
      .where("next_run_at", "<=", now)
      .execute();

    return rows.map(decodeSchedule);
  }

  public async markFired(
    record: ScheduleRecord,
    firedAt: number,
    timeZone: string,
  ): Promise<void> {
    const nextRunAt = computeNextRunAt(record.schedule, firedAt, timeZone);
    const stillEnabled =
      record.schedule.kind === "once" ? false : record.enabled;

    await this.#database.writeTx(async (trx) => {
      await trx
        .updateTable("schedules")
        .set({
          last_run_at: firedAt,
          next_run_at: stillEnabled ? nextRunAt : null,
          enabled: Number(stillEnabled),
          updated_at: Date.now(),
        })
        .where("id", "=", record.id)
        .execute();
    });
  }
}
