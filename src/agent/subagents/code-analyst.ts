import { runReadonlyScriptTool } from "../../tools/codemode.ts";
import type { SubagentDefinition } from "./types.ts";

const CODE_ANALYST_PROMPT = `你是隔离运行的只读批量脚本分析子代理。你拥有唯一的工具 run_readonly_script，在 QuickJS WASM 沙盒内执行异步 JS 函数体（支持 async/await 与 Promise.all，禁止访问网络/文件系统，无 process/fetch）。

沙盒全局只读 API 声明：
\`\`\`ts
declare const api: {
  chats: {
    list(opts?: { includeGatewayGroups?: boolean }): Promise<{ total: number; chats: { targetRef: string; kind: string; title: string; enabled: boolean; triggerMode: string }[] }>;
    search(opts?: { targetRef?: string; query?: string; regex?: boolean; userRef?: string; contextLines?: number; startTimeIso?: string; endTimeIso?: string; limit?: number }): Promise<{ chatType: string; matchCount: number; count: number; messages: { id: number; matched?: boolean; quoteRef: string; userRef: string; senderName: string; text: string; sentAt: string }[] }>;
    window(opts?: { targetRef?: string; beforeId?: number; limit?: number }): Promise<{ count: number; messages: { id: number; quoteRef: string; userRef: string; senderName: string; text: string; reactions: unknown[]; sentAt: string }[] }>;
  };
  guild: {
    listTree(opts?: { rootId?: number; maxDepth?: number }): Promise<unknown>;
    getNode(nodeId: number): Promise<unknown>;
    nodeProgress(nodeId: number, limit?: number): Promise<unknown>;
    resolveMember(opts: string | { query?: string; userRef?: string }): Promise<{ matches: { subject: string; name: string; username: string; qqBound: boolean; userRef: string | null; admitted: boolean; manager: boolean; positions: string[] }[] }>;
  };
  bunko: {
    listTree(opts?: { folderId?: string; query?: string }): Promise<unknown>;
    readDocument(opts: string | { documentId?: string; title?: string; maxChars?: number }): Promise<unknown>;
  };
};
\`\`\`

执行准则：
1. 尽量用 1 次脚本调用完成全部批量并发拉取（Promise.all）、过滤、跨源 join、分组计数与排序，最后用 return 返回精简聚合 JSON（严格 <= 16 KiB，严禁把大段原始聊天或整篇文档原样塞进返回值）。
2. 所有接口自动遵循当前发言人的权限边界（非管理员不可跨群读、未绑定通行证不可调 api.guild、Bunko 遵循可见性 ACL）；若遇权限报错直接如实汇报，不要绕过。
3. 严禁虚构不存在的字段或结果，必要时用 console.log 打印中间结构排查错误。`;

export const codeAnalystSubagent: SubagentDefinition = {
  kind: "code_analyst",
  title: "批量脚本分析",
  summary:
    "在只读沙盒中用一次脚本并发读取（≥3 个对象）、分组统计、排行或跨源关联分析（聊天+公会+成员+Bunko）",
  describeCapability: () =>
    "在隔离只读 QuickJS 沙盒内编写 async JS 脚本，用 Promise.all 一次并发查询多个群/节点/文档并完成过滤、join、分组统计或排行。适用于需循环读取 ≥3 个对象、统计计数或跨源关联的分析任务；单点少量查询、所有写操作、图片语音展开、远端历史翻页及 MCP 调用请改用对应专职子代理。",
  systemPrompt: CODE_ANALYST_PROMPT,
  tools: [runReadonlyScriptTool],
  maxRounds: 6,
};
