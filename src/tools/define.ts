import type { Static, TObject } from "typebox";
import * as Value from "typebox/value";

import type { AgentTool } from "../agent/loop.ts";
import type {
  AgentServices,
  Tool,
  ToolContext,
  ToolProvider,
} from "./types.ts";

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
