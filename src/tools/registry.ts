import type { AgentTool } from "../agent/loop.ts";
import type { AgentServices, ToolContext, ToolSource } from "./types.ts";
import { resolveTools } from "./types.ts";

export class ToolRegistry {
  #sources: ToolSource[] = [];
  #keys = new Set<string>();

  public register(...sources: ToolSource[]): this {
    for (const source of sources) {
      const key =
        "bind" in source ? `tool:${source.name}` : `source:${source.id}`;

      if (this.#keys.has(key)) {
        throw new Error(`Duplicate tool registration: ${key}`);
      }

      this.#keys.add(key);
      this.#sources.push(source);
    }

    return this;
  }

  public listSources(): readonly ToolSource[] {
    return this.#sources;
  }

  public resolve(ctx: ToolContext): AgentTool[] {
    return resolveTools(this.#sources, ctx);
  }

  public describeCapabilities(services: AgentServices): string[] {
    const lines: string[] = [];

    for (const source of this.#sources) {
      const desc = source.describeCapability?.(services);

      if (!desc) {
        continue;
      }

      if (Array.isArray(desc)) {
        for (const line of desc) {
          if (line.trim()) {
            lines.push(line);
          }
        }
      } else if (desc.trim()) {
        lines.push(desc);
      }
    }

    return lines;
  }
}
