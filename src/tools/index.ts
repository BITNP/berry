import type { SubagentRegistry } from "../agent/subagents/registry.ts";
import { memoryManageTool } from "./memory.ts";
import { ToolRegistry } from "./registry.ts";
import { scheduleManageTool } from "./schedule.ts";

export { chatTools } from "./chat.ts";
export { guildTools } from "./guild.ts";
export { memoryManageTool } from "./memory.ts";
export { ToolRegistry } from "./registry.ts";
export { scheduleManageTool } from "./schedule.ts";
export type {
  AgentServices,
  CapabilitySummary,
  DynamicToolSource,
  ToolActor,
  ToolContext,
  ToolDefinition,
  ToolSource,
} from "./types.ts";
export { defineTool, resolveTools } from "./types.ts";
export { mcpToolsSource, workspaceTools } from "./workspace.ts";

export const createDefaultMainToolRegistry = (
  subagents: SubagentRegistry,
): ToolRegistry =>
  new ToolRegistry().register(
    subagents.asDelegateToolSource(),
    memoryManageTool,
    scheduleManageTool,
  );
