import type { AgentTool } from "../agent/loop.ts";
import {
  defineToolProvider,
  isPrivilegedActor,
  requirePrivileged,
} from "./types.ts";

const checkMcpAccess = requirePrivileged("调用外部 MCP 工具");

export const mcpToolProvider = defineToolProvider({
  id: "mcp",
  resolve: (ctx) => {
    if (!isPrivilegedActor(ctx.actor)) {
      return [];
    }

    return ctx.services.mcp.tools.map<AgentTool>((remote) => ({
      name: remote.exposedName,
      description: remote.description,
      parameters: remote.inputSchema,
      mutating: true,
      execute: async (args) => {
        const denied = checkMcpAccess(ctx);

        if (denied) {
          throw new Error(denied);
        }

        return ctx.services.mcp.call(remote.exposedName, args);
      },
    }));
  },
});
