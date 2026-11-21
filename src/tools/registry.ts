import type { AgentTool } from "../agent/loop.ts";
import type { AgentServices, ToolContext, ToolEntry } from "./types.ts";
import { resolveTools } from "./types.ts";

export class ToolRegistry {
  #entries: ToolEntry[] = [];
  #keys = new Set<string>();

  public register(...entries: ToolEntry[]): this {
    for (const entry of entries) {
      const key =
        entry.kind === "tool" ? `tool:${entry.name}` : `provider:${entry.id}`;

      if (this.#keys.has(key)) {
        throw new Error(`Duplicate tool registration: ${key}`);
      }

      this.#keys.add(key);
      this.#entries.push(entry);
    }

    return this;
  }

  public resolve(ctx: ToolContext): AgentTool[] {
    return resolveTools(this.#entries, ctx);
  }

  public describeCapabilities(services: AgentServices): string[] {
    const lines: string[] = [];

    for (const entry of this.#entries) {
      if (entry.kind === "tool") {
        if (entry.available && !entry.available(services)) {
          continue;
        }

        const trimmed = entry.description.trim();

        if (trimmed) {
          lines.push(`- ${entry.name}: ${trimmed}`);
        }

        continue;
      }

      for (const line of entry.describe?.(services) ?? []) {
        if (line.trim()) {
          lines.push(line);
        }
      }
    }

    return lines;
  }
}
