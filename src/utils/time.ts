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
