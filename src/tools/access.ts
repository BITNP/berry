import type { ToolActor, ToolContext } from "./types.ts";

export const isAdmin = (actor: ToolActor): boolean => actor.role === "admin";

export const requireAdmin =
  (action: string) =>
  (ctx: ToolContext): string | null =>
    isAdmin(ctx.actor) ? null : `仅管理员或网协管理层可${action}`;
