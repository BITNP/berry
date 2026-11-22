import { runReadonlyScriptTool } from "../../tools/codemode.ts";
import type { SubagentDefinition } from "./types.ts";

const CODE_ANALYST_PROMPT = `你是隔离运行的只读批量脚本分析子代理。你拥有唯一的工具 run_readonly_script，在 QuickJS WASM 沙盒内执行异步 JS 函数体（支持 async/await 与 Promise.all，禁止访问网络/文件系统，无 process/fetch）。

沙盒全局只读 API 声明：
\`\`\`ts
type GuildUserRef = { subject: string; userName: string };
type GuildTreeNode = {
  id: number;
  title: string;
  completed: boolean;
  dueAt: string | null;
  tags: string[];
  childCount: number;
  commentCount: number;
  url: string;
  children: GuildTreeNode[];
};
type GuildNodeSummary = {
  id: number;
  parentId: number | null;
  title: string;
  dueAt: string | null;
  completedAt: string | null;
  tags: string[];
  sortOrder: number;
  childCount: number;
  commentCount: number;
  myRelation: "leader" | "member" | null;
  updatedAt: string;
};
type GuildProgressItem =
  | { kind: "comment"; comment: { id: number; nodeId: number; author: GuildUserRef; body: string; createdAt: string; reactions: { emoji: string; count: number; reactedByMe: boolean }[] } }
  | { kind: "description_change"; descriptionChange: { id: number; nodeId: number; author: GuildUserRef; before: string; after: string; createdAt: string } };

declare const api: {
  chats: {
    list(opts?: { includeGatewayGroups?: boolean }): Promise<{ total: number; chats: { targetRef: string; kind: "group" | "private"; title: string; enabled: boolean; triggerMode: string }[] }>;
    search(opts?: { targetRef?: string; query?: string; regex?: boolean; userRef?: string; contextLines?: number; startTimeIso?: string; endTimeIso?: string; limit?: number }): Promise<{ chatType: "group" | "private"; matchCount: number; count: number; localOldestSentAt: string | null; messages: { id: number; matched?: boolean; quoteRef: string; userRef: string; senderName: string; text: string; sentAt: string }[] }>;
    window(opts?: { targetRef?: string; beforeId?: number; limit?: number }): Promise<{ count: number; localOldestSentAt: string | null; messages: { id: number; quoteRef: string; userRef: string; senderName: string; text: string; reactions: { emojiId: string; emojiName: string; count: number; userIds: string[] }[]; sentAt: string }[] }>;
  };
  qq: {
    members(opts?: string | { groupRef?: string; query?: string; page?: number; pageSize?: number }): Promise<{ total: number; page: number; items: { userRef: string; name: string; role: string }[] }>;
    groups(opts?: string | { query?: string; page?: number; pageSize?: number }): Promise<{ total: number; page: number; items: { groupRef: string; name: string; memberCount: number | null }[] }>;
    friends(opts?: string | { query?: string; page?: number; pageSize?: number }): Promise<{ total: number; page: number; items: { userRef: string; nickname: string }[] }>;
    users(opts?: string | { query?: string; groupRef?: string; page?: number; pageSize?: number }): Promise<{ total: number; page: number; items: { userRef: string; name: string; sources: string[]; positions?: string[]; sharedGroups?: string[] }[] }>;
  };
  guild: {
    listTree(opts?: { rootId?: number; maxDepth?: number }): Promise<{ totalNodes: number; rootCount: number; roots: GuildTreeNode[] }>;
    getNode(nodeId: number): Promise<GuildNodeSummary & { description: string; createdBySubject: string; url: string; breadcrumb: { id: number; title: string }[]; directLeaders: GuildUserRef[]; directMembers: GuildUserRef[]; children: GuildNodeSummary[] }>;
    nodeProgress(nodeId: number, limit?: number): Promise<{ items: GuildProgressItem[]; hasMore: boolean; nextBefore: { createdAt: string; kind: string; id: number } | null }>;
    resolveMember(opts: string | { query?: string; userRef?: string }): Promise<{ matches: { subject: string; name: string; username: string; qqBound: boolean; userRef: string | null; admitted: boolean; manager: boolean; positions: string[] }[] }>;
  };
  bunko: {
    listTree(opts?: { folderId?: string; query?: string; recursive?: boolean; limit?: number }): Promise<{ folder?: { id: string; name: string; isPrivate: boolean } | null; breadcrumb?: string[]; query?: string | null; folders: { id: string; name: string; path?: string; isPrivate: boolean }[]; documents: { id: string; title: string; folderPath?: string; folderId: string | null; isPublic: boolean; isPrivate?: boolean; version: number; updatedAt: string; url: string }[] }>;
    readDocument(opts: string | { documentId: string; startLine?: number; endLine?: number }): Promise<{ id: string; title: string; url: string; originalUrl?: string; breadcrumb: string[]; isPublic: boolean; isPrivate: boolean; version: number; headVersion: number; materialized: boolean; stale: boolean; totalLines: number; startLine: number; endLine: number; content: string }>;
  };
};
\`\`\`

执行准则：
1. 尽量用 1 次脚本调用编排全部顺序依赖（await）与批量并发（Promise.all）：需要严格先后顺序的步骤按序 await（例如先分页循环拉完 api.qq.members({ page, pageSize: 60 }) 筛出 owner/admin，再 Promise.all 调用 api.guild.resolveMember({ userRef }) 联查姓名、职务与 Keycloak 权限；或先查目录/树再批量读详情），最后用 return 返回精简聚合 JSON（严格 <= 16 KiB，严禁把大段原始聊天或整篇文档原样塞进返回值）。
2. 所有接口自动遵循当前发言人的权限边界（非管理员不可跨群读/查全部群列表、未绑定通行证不可调公会节点接口、Bunko 遵循可见性 ACL；群成员列表 api.qq.members 在当前群内可读，api.guild.resolveMember 可按 userRef 查成员身份与职务）；若遇权限报错直接如实汇报，不要绕过。
3. 严禁虚构不存在的字段或结果，必要时用 console.log 打印中间结构排查错误。`;

export const codeAnalystSubagent: SubagentDefinition = {
  kind: "code_analyst",
  title: "批量脚本分析",
  summary:
    "Code Mode 只读沙盒：处理有调用时序/前后依赖的多步查询、分页遍历、批量读取及跨源联查（QQ成员+Keycloak+公会+聊天+Bunko）",
  describeCapability: () =>
    "Code Mode 隔离只读 QuickJS 沙盒：编写 1 段 async JS 脚本按序编排（await）与并发聚合（Promise.all）QQ 通讯录/群成员、Keycloak 成员职务权限、公会节点、群聊记录和 Bunko 文档。凡涉及具体调用时序/前后依赖（先查列表或分页再逐个关联详情）、分页遍历、批量读取（≥2 个对象）、统计排行或跨源联查，必须优先派给 code_analyst 一次搞定。仅用于查询网协内部数据，绝不用于替用户写 C++/Python 等业务代码、做编程作业或回答通用编程题；单点简单查询、所有写操作、图片语音展开、远端历史翻页及 MCP 调用请改用对应专职子代理。",
  systemPrompt: CODE_ANALYST_PROMPT,
  tools: [runReadonlyScriptTool],
  maxRounds: 6,
};
