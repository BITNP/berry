import type { AgentTool } from "../agent/loop.ts";
import type { AgentServices, ToolContext, ToolEntry } from "./types.ts";

export function resolveTools(
  entries: readonly ToolEntry[],
  ctx: ToolContext,
): AgentTool[] {
  const resolved: AgentTool[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    let items: readonly AgentTool[];

    if (entry.kind === "tool") {
      if (entry.available && !entry.available(ctx.services)) {
        continue;
      }

      if (entry.guard?.(ctx)) {
        continue;
      }

      items = [entry.bind(ctx)];
    } else {
      items = entry.resolve(ctx);
    }

    for (const tool of items) {
      if (seen.has(tool.name)) {
        throw new Error(`Duplicate resolved tool name: ${tool.name}`);
      }

      seen.add(tool.name);
      resolved.push(tool);
    }
  }

  return resolved;
}

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
