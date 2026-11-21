import { knowledgeTools } from "../../tools/knowledge.ts";
import type { SubagentDefinition } from "./types.ts";

export const knowledgeOperatorSubagent: SubagentDefinition = {
  kind: "knowledge_operator",
  title: "本地知识库",
  summary: "检索并阅读本地只读知识库（knowledge/）文档",
  describeCapability: () =>
    "列出、关键词检索并按行读取本地只读知识库（knowledge/）中的基础资料和文档。",
  systemPrompt:
    "你是隔离运行的本地只读知识库检索子代理。按要求在 knowledge/ 目录中列出、检索并读取相关片段，最后只返回精炼结论及出处路径。",
  tools: knowledgeTools,
};
