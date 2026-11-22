export interface LlmToolCallItem {
  id?: string;
  name: string;
  arguments: string;
  ok?: boolean;
  result?: string;
  durationMs?: number;
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
  cacheWarning: string | null;
  jobId?: number | null;
  messageIds?: number[];
  createdAt: number;
}

export interface TraceAssetView {
  id: number;
  messageId: number;
  kind: "image" | "audio" | "forward" | "file";
  rawUrl: string;
  filePath: string | null;
  mimeType: string;
  transcript: string | null;
  status: "pending" | "ready" | "failed";
  error: string | null;
}

export interface TraceMessageSnippet {
  id: number;
  onebotMessageId: string;
  senderName: string;
  userId: string;
  isBot: boolean;
  text: string;
  sentAt: number;
  replyToMessageId: string | null;
  assets: TraceAssetView[];
}

export interface TraceGateDecision {
  id: number;
  chatKey: string;
  messageId: number | null;
  action: "reply" | "memory" | "ignore";
  stage: string;
  confidence: number;
  reason: string;
  model: string;
  durationMs: number;
  createdAt: number;
}

export interface TraceOutcome {
  kind:
    | "reply"
    | "reaction"
    | "silent"
    | "ignore"
    | "memory"
    | "vision"
    | "error"
    | "other";
  label: string;
  preview: string;
}

export interface AiTraceView {
  id: string;
  kind: "message" | "job" | "standalone";
  chatKey: string | null;
  chatTitle: string;
  chatKind: "group" | "private" | null;
  triggerMessages: TraceMessageSnippet[];
  quotedMessages: TraceMessageSnippet[];
  replyMessages: TraceMessageSnippet[];
  instruction: string | null;
  gateDecisions: TraceGateDecision[];
  steps: LlmCallRow[];
  status: "ok" | "error";
  outcome: TraceOutcome;
  totalDurationMs: number;
  totalInputTokens: number;
  totalCachedTokens: number;
  totalOutputTokens: number;
  hasCacheWarning: boolean;
  startedAt: number;
  endedAt: number;
}

export interface MessageTraceSummary {
  gateAction: "reply" | "memory" | "ignore" | null;
  gateReason: string | null;
  aiCalls: number;
  aiErrors: number;
  hasTrace: boolean;
}

export interface ParsedDialogUnit {
  kind: "qq_reply" | "qq_reaction" | "qq_forward" | "qq_poke";
  text?: string;
  title?: string;
  emojiId?: string;
  userRef?: string;
  remove?: boolean;
  quoteMessageId?: string;
  targetRef?: string;
  itemCount?: number;
}

export function formatDurationHuman(ms: number): string {
  if (ms >= 60_000) {
    return `${(ms / 60_000).toFixed(1)}m`;
  }

  if (ms >= 1000) {
    return `${(ms / 1000).toFixed(ms >= 10_000 ? 1 : 2)}s`;
  }

  return `${Math.round(ms)}ms`;
}

export function parseDialogUnits(
  raw: string | null | undefined,
): ParsedDialogUnit[] | null {
  if (!raw?.trim().startsWith("{")) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as {
      units?: {
        kind?: string;
        text?: string;
        title?: string;
        emojiId?: string;
        userRef?: string;
        remove?: boolean;
        quoteMessageId?: string;
        targetRef?: string;
        items?: unknown[];
      }[];
    };

    if (!Array.isArray(parsed.units)) {
      return null;
    }

    return parsed.units
      .filter(
        (u) =>
          u.kind === "qq_reply" ||
          u.kind === "qq_reaction" ||
          u.kind === "qq_forward" ||
          u.kind === "qq_poke",
      )
      .map((u) => ({
        kind: u.kind as ParsedDialogUnit["kind"],
        text: u.text,
        title: u.title,
        emojiId: u.emojiId,
        userRef: u.userRef,
        remove: u.remove,
        quoteMessageId: u.quoteMessageId,
        targetRef: u.targetRef,
        itemCount: Array.isArray(u.items) ? u.items.length : undefined,
      }));
  } catch {
    return null;
  }
}

export function parseGateDecisionsFromResponse(raw: string | null | undefined):
  | {
      messageId?: number;
      action: string;
      confidence?: number;
      reason?: string;
    }[]
  | null {
  if (!raw?.trim().startsWith("{")) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as {
      decisions?: {
        messageId?: number;
        action?: string;
        confidence?: number;
        reason?: string;
      }[];
    };

    if (!Array.isArray(parsed.decisions)) {
      return null;
    }

    return parsed.decisions.map((d) => ({
      messageId: d.messageId,
      action: d.action ?? "ignore",
      confidence: d.confidence,
      reason: d.reason,
    }));
  } catch {
    return null;
  }
}

export function parseSubagentOutput(
  raw: string | null | undefined,
): { brief: string; references: string[] } | null {
  if (!raw?.trim().startsWith("{")) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as {
      brief?: unknown;
      references?: unknown;
    };

    if (typeof parsed.brief !== "string" || !parsed.brief.trim()) {
      return null;
    }

    return {
      brief: parsed.brief.trim(),
      references: Array.isArray(parsed.references)
        ? parsed.references.filter((r): r is string => typeof r === "string")
        : [],
    };
  } catch {
    return null;
  }
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
  "subagent:code_analyst": { label: "子代理：批量脚本分析", type: "info" },
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
  { label: "子代理：批量脚本分析", value: "subagent:code_analyst" },
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

export function formatToolArguments(call: LlmToolCallItem): string {
  if (call.name === "run_readonly_script") {
    try {
      const parsed = JSON.parse(call.arguments) as Record<string, unknown>;

      if (
        parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        typeof parsed.code === "string" &&
        Object.keys(parsed).length === 1
      ) {
        return parsed.code;
      }
    } catch {
      // Fall through to generic JSON formatter.
    }
  }

  return prettyMaybeJson(call.arguments);
}
