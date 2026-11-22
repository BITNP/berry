import type { ChatCompletionMessageFunctionToolCall } from "openai/resources/chat/completions";

export type ChatKind = "group" | "private";

export type GroupTriggerMode = "off" | "mention_only" | "smart_observe";

export type ChatKey = `${ChatKind}:${string}`;

export interface OneBotSegment {
  type: string;
  data: Record<string, unknown>;
}

export interface ChatConfig {
  chatKey: ChatKey;
  kind: ChatKind;
  chatId: string;
  title: string;
  enabled: boolean;
  triggerMode: GroupTriggerMode;
  createdAt: number;
  updatedAt: number;
}

export interface MessageRecord {
  id: number;
  chatKey: ChatKey;
  kind: ChatKind;
  chatId: string;
  onebotMessageId: string;
  userId: string;
  senderName: string;
  text: string;
  segments: OneBotSegment[];
  replyToMessageId: string | null;
  isBot: boolean;
  mentionedBot: boolean;
  quotedBot: boolean;
  recalledAt: number | null;
  sentAt: number;
  receivedAt: number;
}

export type GateAction = "reply" | "memory" | "ignore";

export type GateStage = "l0_rule" | "l1_classifier" | "dry_run";

export interface GateDecisionRecord {
  id: number;
  chatKey: string;
  messageId: number | null;
  action: GateAction;
  stage: GateStage;
  confidence: number;
  reason: string;
  model: string;
  durationMs: number;
  createdAt: number;
}

export interface OutputResult {
  module: string;
  status: "ok" | "error";
  detail: string;
  createdAt: number;
}

export type TurnMessage =
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: ChatCompletionMessageFunctionToolCall[];
    }
  | {
      role: "tool";
      tool_call_id: string;
      content: string;
    };

export interface TapeHandoff {
  summary: string;
  confirmedFacts: string[];
  openTasks: string[];
  pendingFollowups: string[];
  sourceEntryIds: number[];
}

export interface TapeAnchorPayload {
  reason: "compact" | "reset";
  sessionId: string;
  afterMessageId?: number;
  cutoffEntryId: number;
  handoff?: TapeHandoff;
}

export type TapeEntryRecord =
  | {
      id: number;
      tapeId: string;
      kind: "message";
      turnId: string;
      chatKey: string;
      role: TurnMessage["role"];
      message: TurnMessage;
      sidecarId: string | null;
      createdAt: number;
    }
  | {
      id: number;
      tapeId: string;
      kind: "anchor";
      turnId: string;
      chatKey: string;
      role: "anchor";
      anchor: TapeAnchorPayload;
      sidecarId: null;
      createdAt: number;
    };

export interface ConversationRecord {
  chatKey: string;
  sessionId: string;
  summary: string;
  handoff: TapeHandoff | null;
  anchorEntryId: number | null;
  messages: TurnMessage[];
  entries: TapeEntryRecord[];
  pendingResults: OutputResult[];
  afterMessageId: number;
  updatedAt: number;
}

export type OutputUnit =
  | {
      kind: "qq_reply";
      text: string;
      quoteMessageId?: string;
      targetRef?: string;
    }
  | {
      kind: "qq_forward";
      title: string;
      items: { text: string }[];
      targetRef?: string;
    }
  | {
      kind: "qq_reaction";
      messageId: string;
      emojiId: string;
      remove?: boolean;
    };

export interface UnifiedInput {
  source: "qq_batch" | "schedule" | "admin_inject" | "subagent_result";
  chatKey: ChatKey;
  kind: ChatKind;
  chatId: string;
  triggerMessageIds: number[];
  accessRole?: "admin" | "member" | "guest";
  senderId?: string;
  senderName?: string;
  content?: string;
}

export type GuildTaskKind = "due" | "assignments" | "weekly";

export interface JobPayloads {
  gate_batch: {
    chatKey: ChatKey;
    messageIds: number[];
  };
  invoke: UnifiedInput;
  subagent_task: {
    kind: string;
    task: string;
    chatKey: ChatKey;
    chatKind: ChatKind;
    chatId: string;
    senderId: string | null;
    senderName: string | null;
    triggerMessageId: number | null;
    fork: boolean;
    forkHistory?: TurnMessage[];
  };
  memory_update: {
    chatKey: ChatKey;
    messageId: number;
  };
  group_digest: {
    chatKey: ChatKey;
    groupId: string;
    startTimeMs: number;
    endTimeMs: number;
    prompt: string;
    folderId?: string;
  };
  guild_task: {
    task: GuildTaskKind;
  };
}

export type BuiltInJobKind = keyof JobPayloads;

export type JobKind = BuiltInJobKind | (string & {});

export type JobPayload<K extends JobKind = JobKind> = K extends BuiltInJobKind
  ? JobPayloads[K]
  : Record<string, unknown>;

export type JobLane = "gate" | "dialog" | "background";

export interface JobTypeDescriptor {
  kind: string;
  label: string;
  lane: JobLane;
}

export interface JobRecord<K extends JobKind = JobKind> {
  id: number;
  kind: K;
  dedupeKey: string;
  chatKey: string;
  payload: JobPayload<K>;
  state: "pending" | "running" | "done" | "failed";
  attempts: number;
  runAfter: number;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

export type DeliveryStatus = "queued" | "retrying" | "sent" | "failed";

export interface DeliveryRecord {
  id: number;
  chatKey: ChatKey;
  kind: OutputUnit["kind"];
  payload: OutputUnit;
  gatewayDeliveryId: string | null;
  status: DeliveryStatus;
  attempts: number;
  error: string | null;
  onebotMessageId: string | null;
  createdAt: number;
  updatedAt: number;
}

export type ScheduleSpec =
  | { kind: "once"; at: string }
  | {
      kind: "interval";
      everySeconds?: number;
      everyMinutes?: number;
      everyHours?: number;
      everyDays?: number;
    }
  | { kind: "daily"; time: string }
  | { kind: "weekly"; weekdays: string[]; time: string }
  | { kind: "monthly"; daysOfMonth: number[]; time: string }
  | { kind: "yearly"; month: number; day: number; time: string };

export interface ScheduleRecord {
  id: string;
  title: string;
  chatKey: string;
  kind: ChatKind | "";
  chatId: string;
  content: string;
  schedule: ScheduleSpec;
  enabled: boolean;
  nextRunAt: number | null;
  lastRunAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export type MemoryScope = "global" | "chat" | "user";

export interface MemoryRecord {
  id: number;
  scope: MemoryScope;
  ownerId: string;
  key: string;
  summary: string;
  content: string;
  sourceMessageId: number | null;
  expiresAt: number | null;
  updatedAt: number;
}

export type GuildAuditAction =
  | "create_node"
  | "update_node"
  | "move_node"
  | "replace_members"
  | "create_comment";

export interface GuildAuditRecord {
  id: number;
  chatKey: string;
  qqUserId: string;
  actorSubject: string;
  actorName: string;
  action: GuildAuditAction;
  nodeId: number | null;
  targetTitle: string;
  requestJson: string;
  responseJson: string;
  error: string | null;
  createdAt: number;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  id: number;
  time: number;
  level: LogLevel;
  scope: string;
  message: string;
  context: Record<string, unknown>;
}

export interface MessageAssetRecord {
  id: number;
  messageId: number;
  chatKey: ChatKey;
  kind: "image" | "audio" | "forward" | "file";
  rawUrl: string;
  filePath: string | null;
  mimeType: string;
  sha256: string;
  transcript: string | null;
  status: "pending" | "ready" | "failed";
  error: string | null;
  updatedAt: number;
}

export interface MessageReactionRecord {
  chatKey: ChatKey;
  onebotMessageId: string;
  emojiId: string;
  emojiName: string;
  userId: string;
  updatedAt: number;
}

export interface LlmToolCallSummary {
  id?: string;
  name: string;
  arguments: string;
  ok?: boolean;
  result?: string;
  durationMs?: number;
}

export interface LlmCallRecord {
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
  toolCalls: LlmToolCallSummary[];
  error: string | null;
  cacheWarning: string | null;
  jobId: number | null;
  messageIds: number[];
  createdAt: number;
}

export type AdminEvent =
  | { type: "gate_decision"; data: GateDecisionRecord }
  | { type: "delivery_update"; data: DeliveryRecord }
  | { type: "guild_audit"; data: GuildAuditRecord }
  | { type: "llm_call"; data: LlmCallRecord }
  | { type: "log"; data: LogEntry }
  | {
      type: "job_update";
      data: { id: number; kind: JobKind; chatKey: string; state: string };
    }
  | {
      type: "message_update";
      data: { chatKey: ChatKey; messageId: number | null };
    }
  | {
      type: "memory_update";
      data: { scope: MemoryScope; ownerId: string; key: string };
    }
  | { type: "schedule_update"; data: { id: string } }
  | { type: "conversation_update"; data: { sessionId: string } };
