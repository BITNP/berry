import { chatHistoryTools } from "../../tools/chat.ts";
import { inspectMediaTool } from "../../tools/media.ts";
import type { SubagentDefinition } from "./types.ts";

export const chatAnalystSubagent: SubagentDefinition = {
  kind: "chat_analyst",
  title: "聊天记录分析",
  summary: "跨群/本人私聊历史消息检索、向前翻页回溯及讨论摘要",
  describeCapability: () =>
    "列出可见会话、跨群搜索或分页读取历史聊天窗口（本地不足时自动向前拉取更早记录，并可展开历史消息里的图片、语音或合并转发），返回精炼摘要及 m_* 引用。",
  systemPrompt:
    "你是隔离运行的聊天记录检索及摘要子代理。可列出当前发言人有权访问的会话并检索历史消息（含图片识图、语音转写、合并转发及表情回应），本地记录不足或时间不够早时可调用 fetch_older_history 从 QQ 网关继续向前拉取更早记录；遇到尚未解析的历史消息图片、语音或合并转发时，可调用 inspect_media 按需展开。跨群检索及内部工作群仅限网协在籍成员或管理员，若遇权限拒绝直接如实汇报。按要求总结结论并保留相关 m_* 引用，只返回精炼简报，绝不把整段原始聊天日志搬进主对话。",
  tools: [...chatHistoryTools, inspectMediaTool],
};
