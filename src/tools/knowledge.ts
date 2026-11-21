import { Type } from "typebox";

import type { Tool } from "./types.ts";
import { defineTool } from "./types.ts";

export const listKnowledgeFilesTool = defineTool({
  name: "list_knowledge_files",
  description: "列出本地只读知识库（knowledge/）目录中的文件。",
  parameters: Type.Object(
    {
      prefix: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
  ),
  execute: async (args, ctx) =>
    ctx.services.knowledge.listFiles(args.prefix ?? ""),
});

export const searchKnowledgeTool = defineTool({
  name: "search_knowledge",
  description: "在本地只读知识库（knowledge/）中按字面检索。",
  parameters: Type.Object(
    {
      query: Type.String(),
    },
    { additionalProperties: false },
  ),
  execute: async (args, ctx) => ctx.services.knowledge.search(args.query),
});

export const readKnowledgeLinesTool = defineTool({
  name: "read_knowledge_lines",
  description: "读取指定本地只读知识库文件的行片段。",
  parameters: Type.Object(
    {
      path: Type.String(),
      startLine: Type.Optional(Type.Integer({ minimum: 1 })),
      endLine: Type.Optional(Type.Integer({ minimum: 1 })),
    },
    { additionalProperties: false },
  ),
  execute: async (args, ctx) =>
    ctx.services.knowledge.readLines(
      args.path,
      args.startLine ?? 1,
      args.endLine ?? 120,
    ),
});

export const knowledgeTools: readonly Tool[] = [
  listKnowledgeFilesTool,
  searchKnowledgeTool,
  readKnowledgeLinesTool,
];
