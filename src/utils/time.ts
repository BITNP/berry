import { TZDate } from "@date-fns/tz";
import { format } from "date-fns";

export const formatDateTime = (
  ms: number,
  timeZone = "Asia/Shanghai",
): string => format(new TZDate(ms, timeZone), "yyyy-MM-dd HH:mm:ss");

export const formatDay = (ms: number, timeZone = "Asia/Shanghai"): string =>
  format(new TZDate(ms, timeZone), "yyyy-MM-dd");

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
