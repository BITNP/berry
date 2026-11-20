import type { Static, TObject } from "typebox";
import * as Value from "typebox/value";

import type { AgentTool } from "../agent/loop.ts";
import type { ModelIds } from "../agent/model-ids.ts";
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
  triggerMessageId?: number | null;
}

export interface ToolContext {
  services: AgentServices;
  actor: ToolActor;
  ids: ModelIds;
}

export type CapabilitySummary = string | string[] | null | undefined;

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly mutating?: boolean;
  readonly describeCapability?: (services: AgentServices) => CapabilitySummary;
  bind: (ctx: ToolContext) => AgentTool;
}

export interface DynamicToolSource {
  readonly id: string;
  readonly describeCapability?: (services: AgentServices) => CapabilitySummary;
  resolve: (ctx: ToolContext) => AgentTool[];
}

export type ToolSource = ToolDefinition | DynamicToolSource;

export function defineTool<S extends TObject>(spec: {
  name: string;
  description: string;
  parameters: S;
  mutating?: boolean;
  capability?: string | ((services: AgentServices) => CapabilitySummary);
  execute: (args: Static<S>, ctx: ToolContext) => Promise<unknown>;
}): ToolDefinition {
  const describeCapability =
    typeof spec.capability === "string"
      ? () => spec.capability as string
      : spec.capability;

  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters as Record<string, unknown>,
    mutating: spec.mutating,
    describeCapability,
    bind: (ctx) => ({
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters as Record<string, unknown>,
      mutating: spec.mutating,
      execute: (rawArgs) => {
        const candidate = Value.Default(
          spec.parameters,
          structuredClone(rawArgs),
        );

        if (!Value.Check(spec.parameters, candidate)) {
          const details = [...Value.Errors(spec.parameters, candidate)]
            .map((err) => `${err.instancePath || "/"} ${err.message}`)
            .join("; ");

          throw new Error(
            `Invalid tool arguments for ${spec.name}: ${details}`,
          );
        }

        return spec.execute(candidate, ctx);
      },
    }),
  };
}

export function resolveTools(
  sources: readonly ToolSource[],
  ctx: ToolContext,
): AgentTool[] {
  const resolved: AgentTool[] = [];
  const seen = new Set<string>();

  for (const source of sources) {
    const items = "bind" in source ? [source.bind(ctx)] : source.resolve(ctx);

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
