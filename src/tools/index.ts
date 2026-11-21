import type { SubagentRegistry } from "../agent/subagents/registry.ts";
import { inspectMediaTool } from "./media.ts";
import { memoryManageTool } from "./memory.ts";
import { qqDirectoryTool, searchQqEmojisTool } from "./qq.ts";
import { ToolRegistry } from "./registry.ts";
import { scheduleManageTool } from "./schedule.ts";

export { memoryManageTool } from "./memory.ts";
export { ToolRegistry } from "./registry.ts";
export type {
  AgentServices,
  Tool,
  ToolActor,
  ToolContext,
  ToolEntry,
  ToolProvider,
} from "./types.ts";
export { defineTool, defineToolProvider, resolveTools } from "./types.ts";

export const createDefaultMainToolRegistry = (
  subagents: SubagentRegistry,
): ToolRegistry =>
  new ToolRegistry().register(
    subagents.asDelegateToolProvider(),
    memoryManageTool,
    scheduleManageTool,
    inspectMediaTool,
    qqDirectoryTool,
    searchQqEmojisTool,
  );
