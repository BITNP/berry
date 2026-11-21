import type { ToolActor, ToolContext } from "./types.ts";

export const isPrivilegedActor = (actor: ToolActor): boolean =>
  actor.actorIsAdmin || actor.actorIsPrivileged;

export const requirePrivileged =
  (action: string) =>
  (ctx: ToolContext): string | null =>
    isPrivilegedActor(ctx.actor) ? null : `仅管理员或网协管理层可${action}`;
