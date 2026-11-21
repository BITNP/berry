import { mcpToolProvider } from "../../tools/mcp.ts";
import { isPrivilegedActor } from "../../tools/types.ts";
import type { SubagentDefinition } from "./types.ts";

export const mcpOperatorSubagent: SubagentDefinition = {
  kind: "mcp_operator",
  title: "外部工具",
  summary: "调用已挂载的外部 MCP 工具",
  available: (services) => services.mcp.tools.length > 0,
  checkAvailability: (ctx) =>
    isPrivilegedActor(ctx.actor)
      ? null
      : "仅管理员或网协管理层可调用外部 MCP 工具。",
  describeCapability: (services) =>
    `调用已接入的外部 MCP 工具（当前可用：${services.mcp.tools.map((t) => t.exposedName).join("、")}）。`,
  systemPrompt:
    "你是隔离运行的外部 MCP 工具调用子代理。按要求调用合适的 MCP 工具并汇总结果，只返回精炼结论及必要出处。",
  tools: [mcpToolProvider],
};
