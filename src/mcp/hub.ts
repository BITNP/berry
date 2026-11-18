import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import type { McpServerConfig } from "../config/settings.ts";
import { Logger } from "../utils/logger.ts";
import { errorMessage } from "../utils/time.ts";

export interface McpToolEntry {
  exposedName: string;
  serverName: string;
  toolName: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpServerStatus {
  name: string;
  transport: string;
  connected: boolean;
  toolCount: number;
  error?: string;
}

export class McpHub {
  #clients = new Map<string, Client>();
  #tools = new Map<string, McpToolEntry>();
  #statuses: McpServerStatus[] = [];
  #logger = new Logger("mcp");

  public get tools(): McpToolEntry[] {
    return [...this.#tools.values()];
  }

  public get statuses(): McpServerStatus[] {
    return [...this.#statuses];
  }

  public async sync(configs: McpServerConfig[]): Promise<void> {
    await this.close();
    this.#statuses = [];

    for (const cfg of configs) {
      if (!cfg.enabled) {
        this.#statuses.push({
          name: cfg.name,
          transport: cfg.transport,
          connected: false,
          toolCount: 0,
          error: "已禁用",
        });

        continue;
      }

      try {
        const client = new Client(
          { name: "berry", version: "0.1.0" },
          { capabilities: {} },
        );

        if (cfg.transport === "stdio") {
          if (!cfg.command) {
            throw new Error("stdio server requires command");
          }

          const transport = new StdioClientTransport({
            command: cfg.command,
            args: cfg.args ?? [],
          });

          await client.connect(transport);
        } else {
          if (!cfg.url) {
            throw new Error("http server requires url");
          }

          const transport = new StreamableHTTPClientTransport(
            new URL(cfg.url),
            cfg.headers ? { requestInit: { headers: cfg.headers } } : undefined,
          );

          await client.connect(transport);
        }

        const listed = await client.listTools();
        const allowed = cfg.allowedTools?.length
          ? new Set(cfg.allowedTools)
          : null;
        let count = 0;

        for (const tool of listed.tools) {
          if (allowed && !allowed.has(tool.name)) {
            continue;
          }

          const exposedName = `mcp__${cfg.name}__${tool.name}`;

          this.#tools.set(exposedName, {
            exposedName,
            serverName: cfg.name,
            toolName: tool.name,
            description: tool.description ?? `${cfg.name}:${tool.name}`,
            inputSchema: tool.inputSchema ?? {
              type: "object",
              properties: {},
            },
          });
          count++;
        }

        this.#clients.set(cfg.name, client);
        this.#statuses.push({
          name: cfg.name,
          transport: cfg.transport,
          connected: true,
          toolCount: count,
        });
        this.#logger.info("MCP server connected", {
          name: cfg.name,
          tools: count,
        });
      } catch (error) {
        const msg = errorMessage(error);

        this.#statuses.push({
          name: cfg.name,
          transport: cfg.transport,
          connected: false,
          toolCount: 0,
          error: msg,
        });
        this.#logger.warn("MCP connection failed", {
          name: cfg.name,
          error: msg,
        });
      }
    }
  }

  public async call(
    exposedName: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const entry = this.#tools.get(exposedName);

    if (!entry) {
      throw new Error(`Unknown MCP tool: ${exposedName}`);
    }

    const client = this.#clients.get(entry.serverName);

    if (!client) {
      throw new Error(`MCP server ${entry.serverName} is not connected`);
    }

    const result = await client.callTool({
      name: entry.toolName,
      arguments: args,
    });

    return result;
  }

  public async close(): Promise<void> {
    const clients = [...this.#clients.values()];

    this.#clients.clear();
    this.#tools.clear();
    await Promise.allSettled(clients.map((client) => client.close()));
  }
}
