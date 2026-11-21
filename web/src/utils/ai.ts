export interface LlmToolCallItem {
  name: string;
  arguments: string;
}

export interface LlmCallRow {
  id: number;
  day: string;
  purpose: string;
  model: string;
  chatKey: string | null;
  status: "ok" | "error";
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  durationMs: number;
  requestPreview: string | null;
  responseText: string | null;
  toolCalls: LlmToolCallItem[];
  error: string | null;
  createdAt: number;
}

const PURPOSE_META: Record<
  string,
  {
    label: string;
    type: "default" | "info" | "success" | "warning" | "primary";
  }
> = {
  "dialog": { label: "主对话", type: "primary" },
  "subagent": { label: "子代理", type: "info" },
  "subagent:chat_analyst": { label: "子代理：聊天记录分析", type: "info" },
  "subagent:guild_operator": { label: "子代理：公会看板", type: "info" },
  "subagent:bunko_operator": { label: "子代理：Bunko 云文档", type: "info" },
  "subagent:mcp_operator": { label: "子代理：外部工具", type: "info" },
  "gate": { label: "门控分流", type: "default" },
  "memory_update": { label: "记忆提炼", type: "success" },
  "compaction": { label: "摘要压缩", type: "warning" },
  "vision": { label: "图像识别", type: "info" },
  "audio": { label: "语音转写", type: "info" },
  "report": { label: "公会周报", type: "success" },
};

export function purposeMeta(purpose: string): {
  label: string;
  type: "default" | "info" | "success" | "warning" | "primary";
} {
  if (PURPOSE_META[purpose]) {
    return PURPOSE_META[purpose];
  }

  if (purpose.startsWith("subagent:")) {
    return {
      label: `子代理：${purpose.slice("subagent:".length)}`,
      type: "info",
    };
  }

  return { label: purpose, type: "default" };
}

export const PURPOSE_FILTER_OPTIONS = [
  { label: "主对话", value: "dialog" },
  { label: "子代理（全部）", value: "subagent" },
  { label: "子代理：聊天记录分析", value: "subagent:chat_analyst" },
  { label: "子代理：公会看板", value: "subagent:guild_operator" },
  { label: "子代理：Bunko 云文档", value: "subagent:bunko_operator" },
  { label: "子代理：外部工具", value: "subagent:mcp_operator" },
  { label: "门控分流", value: "gate" },
  { label: "记忆提炼", value: "memory_update" },
  { label: "摘要压缩", value: "compaction" },
  { label: "图像识别", value: "vision" },
  { label: "语音转写", value: "audio" },
  { label: "公会周报", value: "report" },
];

export function prettyMaybeJson(raw: string | null | undefined): string {
  if (!raw) {
    return "";
  }

  const trimmed = raw.trim();

  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch {
      return raw;
    }
  }

  return raw;
}
