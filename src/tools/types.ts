import type { Static, TObject } from "typebox";
import * as Value from "typebox/value";

import type { AgentTool } from "../agent/loop.ts";
import type { ModelIds } from "../agent/model-ids.ts";
import type { BunkoClient } from "../bunko/client.ts";
import type { RuntimeSettings } from "../config/settings.ts";
import type { MessageGatewayClient } from "../gateway/client.ts";
import type { GuildInternalClient } from "../guild/client.ts";
import type { IdentityDirectory } from "../identity/keycloak.ts";
import type { KnowledgeBase } from "../knowledge/files.ts";
import type { McpHub } from "../mcp/hub.ts";
import type { MediaProcessor } from "../media/processor.ts";
import type { Store } from "../store/index.ts";
import type { ChatKey } from "../types.ts";

export interface AgentServices {
  store: Store;
  gateway: MessageGatewayClient;
  media: MediaProcessor;
  knowledge: KnowledgeBase;
  bunko: BunkoClient;
  directory: IdentityDirectory;
  guild: GuildInternalClient;
  mcp: McpHub;
  getSettings: () => RuntimeSettings;
}

export interface ToolActor {
  chatKey: ChatKey;
  senderQQ: string | null;
  actorSubject: string | null;
  actorName: string | null;
  actorIsAdmin: boolean;
  actorIsPrivileged: boolean;
  actorAdmitted: boolean;
  triggerMessageId?: number | null;
}

export interface ToolContext {
  services: AgentServices;
  actor: ToolActor;
  ids: ModelIds;
}

export const isPrivilegedActor = (actor: ToolActor): boolean =>
  actor.actorIsAdmin || actor.actorIsPrivileged;

export const requirePrivileged =
  (action: string) =>
  (ctx: ToolContext): string | null =>
    isPrivilegedActor(ctx.actor) ? null : `仅管理员或网协管理层可${action}`;

export interface Tool {
  readonly kind: "tool";
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly mutating?: boolean;
  readonly available?: (services: AgentServices) => boolean;
  readonly guard?: (ctx: ToolContext) => string | null;
  readonly bind: (ctx: ToolContext) => AgentTool;
}

export interface ToolProvider {
  readonly kind: "provider";
  readonly id: string;
  readonly describe?: (services: AgentServices) => readonly string[];
  readonly resolve: (ctx: ToolContext) => readonly AgentTool[];
}

export type ToolEntry = Tool | ToolProvider;

export const defineTool = <S extends TObject>(spec: {
  name: string;
  description: string;
  parameters: S;
  mutating?: boolean;
  available?: (services: AgentServices) => boolean;
  guard?: (ctx: ToolContext) => string | null;
  execute: (args: Static<S>, ctx: ToolContext) => Promise<unknown>;
}): Tool => ({
  kind: "tool",
  name: spec.name,
  description: spec.description,
  parameters: spec.parameters as Record<string, unknown>,
  mutating: spec.mutating,
  available: spec.available,
  guard: spec.guard,
  bind: (ctx) => ({
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters as Record<string, unknown>,
    mutating: spec.mutating,
    execute: async (rawArgs) => {
      const denied = spec.guard?.(ctx);

      if (denied) {
        throw new Error(denied);
      }

      const candidate = Value.Default(
        spec.parameters,
        structuredClone(rawArgs),
      );

      if (!Value.Check(spec.parameters, candidate)) {
        const details = [...Value.Errors(spec.parameters, candidate)]
          .map((err) => `${err.instancePath || "/"} ${err.message}`)
          .join("; ");

        throw new Error(`Invalid tool arguments for ${spec.name}: ${details}`);
      }

      return spec.execute(candidate, ctx);
    },
  }),
});

export const defineToolProvider = (spec: {
  id: string;
  describe?: (services: AgentServices) => readonly string[];
  resolve: (ctx: ToolContext) => readonly AgentTool[];
}): ToolProvider => ({
  kind: "provider",
  id: spec.id,
  describe: spec.describe,
  resolve: spec.resolve,
});

export function resolveTools(
  entries: readonly ToolEntry[],
  ctx: ToolContext,
): AgentTool[] {
  const resolved: AgentTool[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    let items: readonly AgentTool[];

    if (entry.kind === "tool") {
      if (entry.available && !entry.available(ctx.services)) {
        continue;
      }

      if (entry.guard?.(ctx)) {
        continue;
      }

      items = [entry.bind(ctx)];
    } else {
      items = entry.resolve(ctx);
    }

    for (const tool of items) {
      if (seen.has(tool.name)) {
        throw new Error(`Duplicate resolved tool name: ${tool.name}`);
      }

      seen.add(tool.name);
      resolved.push(tool);
    }
  }

  return resolved;
}
