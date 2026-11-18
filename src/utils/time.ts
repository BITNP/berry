export function formatDateTime(ms: number, timeZone = "Asia/Shanghai"): string {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(ms));

  const map = new Map(parts.map((part) => [part.type, part.value]));

  return `${map.get("year")}-${map.get("month")}-${map.get("day")} ${map.get("hour")}:${map.get("minute")}:${map.get("second")}`;
}

export const formatDay = (ms: number, timeZone = "Asia/Shanghai"): string =>
  formatDateTime(ms, timeZone).slice(0, 10);

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export function estimateTokens(text: string): number {
  if (!text) {
    return 0;
  }

  let ascii = 0;
  let nonAscii = 0;

  for (const ch of text) {
    if (ch.codePointAt(0)! <= 0x7f) {
      ascii++;
    } else {
      nonAscii++;
    }
  }

  // Conservative estimate for CJK + JSON payloads.
  return Math.ceil(ascii / 3.5 + nonAscii * 1.4);
}
