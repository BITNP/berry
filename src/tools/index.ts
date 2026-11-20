import type { SubagentRegistry } from "../agent/subagents/registry.ts";
import { inspectMediaTool } from "./media.ts";
import { memoryManageTool } from "./memory.ts";
import { qqDirectoryTool, searchQqEmojisTool } from "./qq.ts";
import { ToolRegistry } from "./registry.ts";
import { scheduleManageTool } from "./schedule.ts";

export { chatHistoryTools } from "./chat.ts";
export { guildTools } from "./guild.ts";
export { inspectMediaTool, mediaTools } from "./media.ts";
export { memoryManageTool } from "./memory.ts";
export { qqDirectoryTool, qqTools, searchQqEmojisTool } from "./qq.ts";
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
    inspectMediaTool,
    qqDirectoryTool,
    searchQqEmojisTool,
  );
