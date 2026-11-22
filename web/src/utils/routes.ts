import type { RouteLocationRaw } from "vue-router";

type AiCallsTab = "calls" | "context" | "usage";

type SettingsTab =
  | "bot"
  | "models"
  | "media"
  | "policy"
  | "digest"
  | "guild"
  | "social"
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
      scope?: "active" | "all" | "error";
      chatKey?: string;
      purpose?: string;
    } = {},
  ): RouteLocationRaw => ({
    path: "/ai",
    query: cleanQuery(query),
  }),
  memories: (): RouteLocationRaw => ({ path: "/memories" }),
  jargon: (): RouteLocationRaw => ({ path: "/jargon" }),
  impressions: (): RouteLocationRaw => ({ path: "/impressions" }),
  stickers: (): RouteLocationRaw => ({ path: "/stickers" }),
  settings: (tab?: SettingsTab): RouteLocationRaw => ({
    path: "/settings",
    query: cleanQuery({ tab }),
  }),
};
