import { mcpToolsSource, workspaceTools } from "../../tools/workspace.ts";
import type { SubagentDefinition } from "./types.ts";

export const workspaceOperatorSubagent: SubagentDefinition = {
  kind: "workspace_operator",
  title: "资料库",
  summary: "检索知识库、读写记事本与调用外部 MCP 工具",
  describeCapability: (services) => {
    const mcpTools = services.mcp.tools;
    const mcpNote =
      mcpTools.length > 0
        ? `已接入 ${mcpTools.length} 个 MCP 外部工具（可在委派 workspace_operator 时要求调用：${mcpTools.map((t) => t.exposedName).join("、")}）。`
        : "当前未挂载额外 MCP 工具。";

    return `检索只读知识库、读写记事本（notebooks/）及调用 MCP 工具。${mcpNote}`;
  },
  systemPrompt:
    "你是隔离运行的资料库、记事本与外部 MCP 工具子代理。按要求检索文档、写入 notebooks/ 笔记或执行外部 MCP 工具，最后只返回精炼结果与出处。",
  tools: [...workspaceTools, mcpToolsSource],
};
