import { Type } from "typebox";

import type { AgentTool } from "../agent/loop.ts";
import type { DynamicToolSource, ToolActor, ToolDefinition } from "./types.ts";
import { defineTool } from "./types.ts";

function assertMemberOrAdmin(actor: ToolActor, action: string): void {
  if (!actor.actorIsAdmin && !actor.actorAdmitted) {
    throw new Error(`仅网协在籍成员或管理员可${action}`);
  }
}

export const listKnowledgeFilesTool = defineTool({
  name: "list_knowledge_files",
  description: "列出 knowledge 与 notebooks 目录中的文件。",
  parameters: Type.Object(
    {
      scope: Type.Optional(
        Type.Union([
          Type.Literal("all"),
          Type.Literal("knowledge"),
          Type.Literal("notebook"),
        ]),
      ),
      prefix: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
  ),
  execute: (args, ctx) =>
    ctx.services.knowledge.listFiles(args.scope ?? "all", args.prefix ?? ""),
});

export const searchKnowledgeTool = defineTool({
  name: "search_knowledge",
  description: "在知识库与记事本中按字面检索。",
  parameters: Type.Object(
    {
      query: Type.String(),
      scope: Type.Optional(
        Type.Union([
          Type.Literal("all"),
          Type.Literal("knowledge"),
          Type.Literal("notebook"),
        ]),
      ),
    },
    { additionalProperties: false },
  ),
  execute: (args, ctx) =>
    ctx.services.knowledge.search(args.query, args.scope ?? "all"),
});

export const readKnowledgeLinesTool = defineTool({
  name: "read_knowledge_lines",
  description: "读取指定知识库或记事本文件的行片段。",
  parameters: Type.Object(
    {
      scope: Type.Union([Type.Literal("knowledge"), Type.Literal("notebook")]),
      path: Type.String(),
      startLine: Type.Optional(Type.Integer({ minimum: 1 })),
      endLine: Type.Optional(Type.Integer({ minimum: 1 })),
    },
    { additionalProperties: false },
  ),
  execute: (args, ctx) =>
    ctx.services.knowledge.readLines(
      args.scope,
      args.path,
      args.startLine ?? 1,
      args.endLine ?? 120,
    ),
});

export const notebookWriteTool = defineTool({
  name: "notebook_write",
  description:
    "新建或更新记事本（notebooks/）内的 Markdown 文档（仅网协在籍成员或管理员可用）。",
  mutating: true,
  parameters: Type.Object(
    {
      path: Type.String(),
      content: Type.String(),
      mode: Type.Optional(
        Type.Union([Type.Literal("replace"), Type.Literal("append")]),
      ),
    },
    { additionalProperties: false },
  ),
  execute: async (args, ctx) => {
    assertMemberOrAdmin(ctx.actor, "写入记事本");

    return ctx.services.knowledge.writeNotebook(
      args.path,
      args.content,
      args.mode ?? "replace",
    );
  },
});

export const notebookDeleteTool = defineTool({
  name: "notebook_delete",
  description:
    "删除记事本（notebooks/）内指定的 Markdown 文档（仅网协在籍成员或管理员可用）。",
  mutating: true,
  parameters: Type.Object(
    { path: Type.String() },
    { additionalProperties: false },
  ),
  execute: async (args, ctx) => {
    assertMemberOrAdmin(ctx.actor, "删除记事本");

    return ctx.services.knowledge.deleteNotebook(args.path);
  },
});

export const workspaceTools: readonly ToolDefinition[] = [
  listKnowledgeFilesTool,
  searchKnowledgeTool,
  readKnowledgeLinesTool,
  notebookWriteTool,
  notebookDeleteTool,
];

export const mcpToolsSource: DynamicToolSource = {
  id: "mcp",
  resolve: (ctx) => {
    if (!ctx.actor.actorIsAdmin && !ctx.actor.actorAdmitted) {
      return [];
    }

    return ctx.services.mcp.tools.map<AgentTool>((remote) => ({
      name: remote.exposedName,
      description: remote.description,
      parameters: remote.inputSchema,
      mutating: true,
      execute: async (args) => {
        assertMemberOrAdmin(ctx.actor, "调用外部 MCP 工具");

        return ctx.services.mcp.call(remote.exposedName, args);
      },
    }));
  },
};
