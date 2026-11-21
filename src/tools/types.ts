import type { AgentTool } from "../agent/loop.ts";
import type { ModelIds } from "../agent/model-ids.ts";
import type { BunkoClient } from "../bunko/client.ts";
import type { RuntimeSettings } from "../config/settings.ts";
import type { MessageGatewayClient } from "../gateway/client.ts";
import type { GuildInternalClient } from "../guild/client.ts";
import type { IdentityDirectory } from "../identity/keycloak.ts";
import type { AccessRole } from "../identity/permissions.ts";
import type { McpHub } from "../mcp/hub.ts";
import type { MediaProcessor } from "../media/processor.ts";
import type { Store } from "../store/index.ts";
import type { ChatKey, TurnMessage } from "../types.ts";
import type { ShortLinkClient } from "../utils/shortlink.ts";

export interface AgentServices {
  store: Store;
  gateway: MessageGatewayClient;
  media: MediaProcessor;
  bunko: BunkoClient;
  shortlink: ShortLinkClient;
  directory: IdentityDirectory;
  guild: GuildInternalClient;
  mcp: McpHub;
  getSettings: () => RuntimeSettings;
  wakeWorker?: () => void;
}

export interface ToolActor {
  chatKey: ChatKey;
  senderQQ: string | null;
  actorSubject: string | null;
  actorName: string | null;
  role: AccessRole;
  triggerMessageId?: number | null;
}

export interface ToolContext {
  services: AgentServices;
  actor: ToolActor;
  ids: ModelIds;
  getForkHistory?: () => TurnMessage[];
}

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
