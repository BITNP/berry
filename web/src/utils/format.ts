export interface ScheduleSpecView {
  kind: "once" | "interval" | "daily" | "weekly" | "monthly" | "yearly";
  at?: string;
  everySeconds?: number;
  everyMinutes?: number;
  everyHours?: number;
  everyDays?: number;
  time?: string;
  weekdays?: string[];
  daysOfMonth?: number[];
  month?: number;
  day?: number;
}

const WEEKDAY_LABEL: Record<string, string> = {
  mon: "周一",
  monday: "周一",
  tue: "周二",
  tuesday: "周二",
  wed: "周三",
  wednesday: "周三",
  thu: "周四",
  thursday: "周四",
  fri: "周五",
  friday: "周五",
  sat: "周六",
  saturday: "周六",
  sun: "周日",
  sunday: "周日",
};

export function formatTime(ms: number | null | undefined): string {
  if (!ms) {
    return "—";
  }

  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(ms));
}

export function formatPercent(numerator: number, denominator: number): string {
  if (denominator <= 0) {
    return "0.0%";
  }

  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatScheduleLabel(spec: ScheduleSpecView): string {
  switch (spec.kind) {
    case "once": {
      return `单次 ${spec.at ?? ""}`;
    }

    case "interval": {
      const parts: string[] = [];

      if (spec.everyDays) {
        parts.push(`${spec.everyDays} 天`);
      }

      if (spec.everyHours) {
        parts.push(`${spec.everyHours} 小时`);
      }

      if (spec.everyMinutes) {
        parts.push(`${spec.everyMinutes} 分钟`);
      }

      if (spec.everySeconds) {
        parts.push(`${spec.everySeconds} 秒`);
      }

      return `每隔 ${parts.join(" ") || "1 分钟"}`;
    }

    case "daily": {
      return `每天 ${spec.time ?? "09:00"}`;
    }

    case "weekly": {
      const days = (spec.weekdays ?? [])
        .map((d) => WEEKDAY_LABEL[d.toLowerCase()] ?? d)
        .join("、");

      return `每${days || "周"} ${spec.time ?? "09:00"}`;
    }

    case "monthly": {
      const days = (spec.daysOfMonth ?? []).map((d) => `${d}日`).join("、");

      return `每月 ${days} ${spec.time ?? "09:00"}`;
    }

    case "yearly": {
      return `每年 ${spec.month ?? 1}月${spec.day ?? 1}日 ${spec.time ?? "09:00"}`;
    }
  }
}
