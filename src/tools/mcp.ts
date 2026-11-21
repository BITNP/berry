import type { AgentTool } from "../agent/loop.ts";
import { isPrivilegedActor } from "./access.ts";
import { defineToolProvider } from "./define.ts";

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
      execute: (args) => ctx.services.mcp.call(remote.exposedName, args),
    }));
  },
});
