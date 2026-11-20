import { chatTools } from "../../tools/chat.ts";
import type { SubagentDefinition } from "./types.ts";

export const chatAnalystSubagent: SubagentDefinition = {
  kind: "chat_analyst",
  title: "聊天分析",
  summary: "查各群聊/本人私聊记录、媒体识图转写、QQ 通讯录及 QQ 官方表情目录",
  describeCapability: () =>
    "列出已登记群聊、跨群搜索或分页读取聊天窗口（含图片视觉结论、语音转写、合并转发详情、表情回应）、按需触发识图（inspect_media）、查询 QQ 群成员及好友名单、检索 380+ QQNT 官方表情目录（search_qq_emojis）。",
  systemPrompt:
    "你是隔离运行的聊天消息及媒体分析子代理。可列出会话并跨群检索历史消息（含图片识图、语音转写、合并转发与表情回应），本地记录不足或时间不够早时可调用 fetch_older_history 从 QQ 网关继续向前拉取更早记录，也可调用 search_qq_emojis 检索全部 QQNT 官方表情及回应 ID。按要求总结结论并保留相关 m_* 引用，只返回精炼结论，绝不把整段原始日志搬进主对话。",
  tools: chatTools,
};
