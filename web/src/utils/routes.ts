import type { RouteLocationRaw } from "vue-router";

type AiCallsTab = "calls" | "gate" | "context";

export type JobLaneFilter = "all" | "background" | "realtime";

type SettingsTab =
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
  guild: (): RouteLocationRaw => ({ path: "/guild" }),
  memories: (): RouteLocationRaw => ({ path: "/memories" }),
  settings: (tab?: SettingsTab): RouteLocationRaw => ({
    path: "/settings",
    query: cleanQuery({ tab }),
  }),
};
