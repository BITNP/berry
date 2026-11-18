import { randomUUID } from "node:crypto";

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

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
}

function getZonedParts(ms: number, timeZone: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
    hour12: false,
  });

  const map = new Map(
    formatter
      .formatToParts(new Date(ms))
      .map((part) => [part.type, part.value]),
  );

  const rawHour = Number(map.get("hour"));

  return {
    year: Number(map.get("year")),
    month: Number(map.get("month")),
    day: Number(map.get("day")),
    hour: rawHour === 24 ? 0 : rawHour,
    minute: Number(map.get("minute")),
    second: Number(map.get("second")),
    weekday: WEEKDAY_MAP[(map.get("weekday") ?? "").toLowerCase()] ?? 0,
  };
}

function fromZonedLocal(
  parts: {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second?: number;
  },
  timeZone: string,
): number {
  const targetUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second ?? 0,
  );
  let candidate = targetUtc;

  for (let i = 0; i < 2; i++) {
    const actual = getZonedParts(candidate, timeZone);
    const actualUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
    );

    candidate += targetUtc - actualUtc;
  }

  return candidate;
}

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

function addDays(
  year: number,
  month: number,
  day: number,
  deltaDays: number,
): { year: number; month: number; day: number } {
  const date = new Date(Date.UTC(year, month - 1, day + deltaDays));

  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
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
      const local = getZonedParts(afterMs, timeZone);

      for (let offset = 0; offset <= 2; offset++) {
        const day = addDays(local.year, local.month, local.day, offset);
        const candidate = fromZonedLocal({ ...day, hour, minute }, timeZone);

        if (candidate > afterMs) {
          return candidate;
        }
      }

      return null;
    }

    case "weekly": {
      const { hour, minute } = parseClock(spec.time);
      const weekdays = new Set(
        spec.weekdays.map((item) => {
          const day = WEEKDAY_MAP[item.trim().toLowerCase()];

          if (day === undefined) {
            throw new Error(`Invalid weekday: ${item}`);
          }

          return day;
        }),
      );
      const local = getZonedParts(afterMs, timeZone);

      for (let offset = 0; offset <= 14; offset++) {
        const day = addDays(local.year, local.month, local.day, offset);
        const candidate = fromZonedLocal({ ...day, hour, minute }, timeZone);

        if (
          candidate > afterMs &&
          weekdays.has(getZonedParts(candidate, timeZone).weekday)
        ) {
          return candidate;
        }
      }

      return null;
    }

    case "monthly": {
      const { hour, minute } = parseClock(spec.time);
      const days = new Set(spec.daysOfMonth);
      const local = getZonedParts(afterMs, timeZone);

      for (let offset = 0; offset <= 62; offset++) {
        const day = addDays(local.year, local.month, local.day, offset);

        if (!days.has(day.day)) {
          continue;
        }

        const candidate = fromZonedLocal({ ...day, hour, minute }, timeZone);

        if (candidate > afterMs) {
          return candidate;
        }
      }

      return null;
    }

    case "yearly": {
      const { hour, minute } = parseClock(spec.time);
      const local = getZonedParts(afterMs, timeZone);

      for (let yearOffset = 0; yearOffset <= 4; yearOffset++) {
        const year = local.year + yearOffset;
        const probe = new Date(Date.UTC(year, spec.month - 1, spec.day));

        if (
          probe.getUTCMonth() + 1 !== spec.month ||
          probe.getUTCDate() !== spec.day
        ) {
          continue;
        }

        const candidate = fromZonedLocal(
          { year, month: spec.month, day: spec.day, hour, minute },
          timeZone,
        );

        if (candidate > afterMs) {
          return candidate;
        }
      }

      return null;
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
