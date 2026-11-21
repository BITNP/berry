import type { RouteLocationRaw } from "vue-router";

export type AiCallsTab = "calls" | "gate" | "context";
export type LogsTab = "logs" | "jobs" | "deliveries";
export type JobLaneFilter = "all" | "background" | "realtime";
export type SettingsTab =
  | "bot"
  | "models"
  | "media"
  | "policy"
  | "digest"
  | "guild"
  | "mcp"
  | "storage";

function cleanQuery(
  raw: Record<string, string | undefined>,
): Record<string, string> | undefined {
  const out: Record<string, string> = {};

  for (const [key, value] of Object.entries(raw)) {
    if (value !== undefined && value !== "") {
      out[key] = value;
    }
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

export const routes = {
  chat: (chatKey?: string): RouteLocationRaw => ({
    path: "/chats",
    query: cleanQuery({ chatKey }),
  }),
  aiCalls: (
    query: {
      tab?: AiCallsTab;
      chatKey?: string;
      purpose?: string;
      status?: "error";
    } = {},
  ): RouteLocationRaw => ({
    path: "/ai",
    query: cleanQuery(query),
  }),
  docs: (): RouteLocationRaw => ({
    path: "/docs",
  }),
  guild: (): RouteLocationRaw => ({ path: "/guild" }),
  memories: (): RouteLocationRaw => ({ path: "/memories" }),
  logs: (
    query: { tab?: LogsTab; lane?: JobLaneFilter } = {},
  ): RouteLocationRaw => ({
    path: "/logs",
    query: cleanQuery(query),
  }),
  settings: (tab?: SettingsTab): RouteLocationRaw => ({
    path: "/settings",
    query: cleanQuery({ tab }),
  }),
};
