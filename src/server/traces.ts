import type { BerryApp } from "../app.ts";
import type {
  ChatConfig,
  GateAction,
  GateDecisionRecord,
  JobRecord,
  LlmCallRecord,
  MessageAssetRecord,
  MessageRecord,
} from "../types.ts";

export interface TraceMessageSnippet {
  id: number;
  onebotMessageId: string;
  senderName: string;
  userId: string;
  isBot: boolean;
  text: string;
  sentAt: number;
  replyToMessageId: string | null;
  assets: MessageAssetRecord[];
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
  gateDecisions: GateDecisionRecord[];
  steps: LlmCallRecord[];
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
  gateAction: GateAction | null;
  gateReason: string | null;
  aiCalls: number;
  aiErrors: number;
  hasTrace: boolean;
}

const stripInlineMarkdown = (text: string): string =>
  text
    .replaceAll(/\*\*([^*]+)\*\*/g, "$1")
    .replaceAll(/\s+/g, " ")
    .trim();

const PURPOSE_LABELS: Record<string, string> = {
  dialog: "主对话",
  gate: "消息分流",
  vision: "图像识别",
  audio: "语音转写",
  memory_update: "记忆提炼",
  style_distill: "群风提炼",
  jargon_distill: "黑话提炼",
  impression_update: "成员印象",
  compaction: "上下文压缩",
  report: "周报汇总",
};

function purposeLabelCn(purpose: string | undefined): string {
  if (!purpose) {
    return "记录";
  }

  if (PURPOSE_LABELS[purpose]) {
    return PURPOSE_LABELS[purpose];
  }

  if (purpose.startsWith("subagent")) {
    return "子代理";
  }

  return purpose;
}

function summarizeFallbackResponse(call: LlmCallRecord | undefined): string {
  const raw = call?.responseText?.trim() ?? "";

  if (!raw) {
    if (call && call.toolCalls.length > 0) {
      return `调用工具：${call.toolCalls.map((t) => t.name).join("、")}`;
    }

    return "";
  }

  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw) as {
        brief?: string;
        action?: string;
        reason?: string;
        decisions?: { action?: string; reason?: string }[];
        units?: unknown[];
      };

      if (typeof parsed.brief === "string" && parsed.brief.trim()) {
        return stripInlineMarkdown(parsed.brief).slice(0, 140);
      }

      if (Array.isArray(parsed.decisions) && parsed.decisions.length > 0) {
        const first = parsed.decisions[0]!;
        const actLabel =
          first.action === "reply"
            ? "回复"
            : first.action === "memory"
              ? "记忆"
              : "忽略";

        return `${actLabel}：${first.reason ?? ""}`.trim().slice(0, 140);
      }

      if (typeof parsed.action === "string") {
        const actLabel =
          parsed.action === "reply"
            ? "回复"
            : parsed.action === "memory"
              ? "记忆"
              : "忽略";

        return `${actLabel}：${parsed.reason ?? ""}`.trim().slice(0, 140);
      }

      if (Array.isArray(parsed.units) && parsed.units.length === 0) {
        return "模型判断无需发言";
      }
    } catch {
      // Fall through to plain preview.
    }
  }

  return stripInlineMarkdown(raw).slice(0, 140);
}

function extractInstructionFromPreview(call: LlmCallRecord): string | null {
  const raw = call.requestPreview;

  if (!raw) {
    return null;
  }

  const match = /"instruction":"((?:\\.|[^"\\]){1,400})"/.exec(raw);

  if (!match?.[1]) {
    return null;
  }

  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return match[1];
  }
}

const toSnippet = (
  msg: MessageRecord,
  assetMap: Map<number, MessageAssetRecord[]>,
): TraceMessageSnippet => ({
  id: msg.id,
  onebotMessageId: msg.onebotMessageId,
  senderName: msg.isBot ? "树莓娘" : msg.senderName,
  userId: msg.userId,
  isBot: msg.isBot,
  text: msg.text,
  sentAt: msg.sentAt,
  replyToMessageId: msg.replyToMessageId,
  assets: assetMap.get(msg.id) ?? [],
});

function parseDialogOutcome(steps: LlmCallRecord[]): TraceOutcome | null {
  const dialogs = steps.filter((s) => s.purpose === "dialog");

  for (let i = dialogs.length - 1; i >= 0; i--) {
    const call = dialogs[i]!;

    if (call.status === "error") {
      return {
        kind: "error",
        label: "应答失败",
        preview: call.error ?? "模型调用失败",
      };
    }

    const raw = call.responseText?.trim();

    if (!raw?.startsWith("{")) {
      continue;
    }

    try {
      const parsed = JSON.parse(raw) as {
        units?: {
          kind?: string;
          text?: string;
          emojiId?: string;
          title?: string;
        }[];
      };

      if (!Array.isArray(parsed.units)) {
        continue;
      }

      if (parsed.units.length === 0) {
        return { kind: "silent", label: "静默", preview: "模型判断无需发言" };
      }

      const firstReply = parsed.units.find(
        (u) => u.kind === "qq_reply" || u.kind === "qq_forward",
      );

      if (firstReply) {
        const text = (firstReply.text ?? firstReply.title ?? "")
          .replaceAll(/\s+/g, " ")
          .trim();

        return {
          kind: "reply",
          label:
            parsed.units.length > 1 ? `回复 ×${parsed.units.length}` : "已回复",
          preview: text.slice(0, 140),
        };
      }

      const firstReaction = parsed.units.find((u) => u.kind === "qq_reaction");

      if (firstReaction) {
        return {
          kind: "reaction",
          label: "表情回应",
          preview: `贴表情 ${firstReaction.emojiId ?? ""}`.trim(),
        };
      }

      if (parsed.units.some((u) => u.kind === "qq_poke")) {
        return {
          kind: "reaction",
          label: "戳一戳",
          preview: "戳了戳对方",
        };
      }

      if (parsed.units.some((u) => u.kind === "qq_image")) {
        return {
          kind: "reaction",
          label: "表情包",
          preview: "发送了表情包",
        };
      }
    } catch {
      // Ignore malformed preview fragments.
    }
  }

  return null;
}

function computeOutcome(
  steps: LlmCallRecord[],
  gateDecisions: GateDecisionRecord[],
  replyMessages: TraceMessageSnippet[],
  triggerMessages: TraceMessageSnippet[],
): TraceOutcome {
  const failedStep = steps.find((s) => s.status === "error");
  const dialogOutcome = parseDialogOutcome(steps);

  if (dialogOutcome) {
    return dialogOutcome;
  }

  if (replyMessages.length > 0) {
    return {
      kind: "reply",
      label:
        replyMessages.length > 1 ? `回复 ×${replyMessages.length}` : "已回复",
      preview: replyMessages[0]!.text
        .replaceAll(/\s+/g, " ")
        .trim()
        .slice(0, 140),
    };
  }

  const latestGate = gateDecisions.at(-1);

  if (latestGate) {
    if (latestGate.action === "ignore") {
      return {
        kind: "ignore",
        label: "分流忽略",
        preview: latestGate.reason,
      };
    }

    if (latestGate.action === "memory") {
      return {
        kind: "memory",
        label: "记忆提炼",
        preview: latestGate.reason,
      };
    }
  }

  if (failedStep) {
    return {
      kind: "error",
      label: "调用失败",
      preview: failedStep.error ?? "模型调用异常",
    };
  }

  const failedAsset = triggerMessages
    .flatMap((m) => m.assets)
    .find((a) => a.status === "failed");

  if (failedAsset) {
    return {
      kind: "error",
      label: "媒体失败",
      preview: failedAsset.error ?? "附件解析失败",
    };
  }

  const visionStep = [...steps].reverse().find((s) => s.purpose === "vision");

  if (visionStep) {
    const text = stripInlineMarkdown(visionStep.responseText ?? "");

    return text
      ? { kind: "vision", label: "图像识别", preview: text.slice(0, 140) }
      : { kind: "error", label: "识图空白", preview: "视觉模型未返回正文" };
  }

  const memStep = steps.find((s) => s.purpose === "memory_update");

  if (memStep) {
    return {
      kind: "memory",
      label: "记忆提炼",
      preview:
        memStep.toolCalls.length > 0
          ? `更新记忆 (${memStep.toolCalls.length} 次操作)`
          : "检查记忆，无需写入",
    };
  }

  const last = steps.at(-1);

  return {
    kind: "other",
    label: purposeLabelCn(last?.purpose),
    preview: summarizeFallbackResponse(last),
  };
}

function finalizeTrace(input: {
  id: string;
  kind: AiTraceView["kind"];
  chatKey: string | null;
  chatTitle: string;
  chatKind: "group" | "private" | null;
  triggerMessages: TraceMessageSnippet[];
  quotedMessages: TraceMessageSnippet[];
  replyMessages: TraceMessageSnippet[];
  instruction: string | null;
  gateDecisions: GateDecisionRecord[];
  steps: LlmCallRecord[];
}): AiTraceView {
  const orderedSteps = [...input.steps].sort(
    (a, b) => a.createdAt - b.createdAt || a.id - b.id,
  );
  const totalDurationMs = orderedSteps.reduce(
    (acc, s) => acc + s.durationMs,
    0,
  );
  const totalInputTokens = orderedSteps.reduce(
    (acc, s) => acc + s.inputTokens,
    0,
  );
  const totalCachedTokens = orderedSteps.reduce(
    (acc, s) => acc + s.cachedInputTokens,
    0,
  );
  const totalOutputTokens = orderedSteps.reduce(
    (acc, s) => acc + s.outputTokens,
    0,
  );
  const hasCacheWarning = orderedSteps.some((s) => Boolean(s.cacheWarning));
  const outcome = computeOutcome(
    orderedSteps,
    input.gateDecisions,
    input.replyMessages,
    input.triggerMessages,
  );
  const hasFailedAsset = input.triggerMessages
    .flatMap((m) => m.assets)
    .some((a) => a.status === "failed");
  const status: "ok" | "error" =
    orderedSteps.some((s) => s.status === "error") ||
    outcome.kind === "error" ||
    hasFailedAsset
      ? "error"
      : "ok";
  const timestamps = [
    ...orderedSteps.map((s) => s.createdAt),
    ...input.gateDecisions.map((g) => g.createdAt),
    ...input.triggerMessages.map((m) => m.sentAt),
  ];
  const startedAt =
    timestamps.length > 0 ? Math.min(...timestamps) : Date.now();
  const endedAt = timestamps.length > 0 ? Math.max(...timestamps) : startedAt;

  return {
    id: input.id,
    kind: input.kind,
    chatKey: input.chatKey,
    chatTitle: input.chatTitle,
    chatKind: input.chatKind,
    triggerMessages: input.triggerMessages,
    quotedMessages: input.quotedMessages,
    replyMessages: input.replyMessages,
    instruction: input.instruction,
    gateDecisions: input.gateDecisions,
    steps: orderedSteps,
    status,
    outcome,
    totalDurationMs,
    totalInputTokens,
    totalCachedTokens,
    totalOutputTokens,
    hasCacheWarning,
    startedAt,
    endedAt,
  };
}

function collectJobMessageIds(job: JobRecord, berry: BerryApp): number[] {
  const def = berry.jobs.get(job.kind);

  return def?.referencedMessageIds?.(job.payload) ?? [];
}

export async function buildMessageTrace(
  berry: BerryApp,
  messageId: number,
): Promise<AiTraceView | null> {
  const message = await berry.store.messages.get(messageId);

  if (!message) {
    return null;
  }

  const [chats, gateMap, jobs, replyRecords] = await Promise.all([
    berry.store.chats.list(),
    berry.store.gate.listByMessageIds([message.id]),
    berry.store.jobs.list({ chatKey: message.chatKey, limit: 120 }),
    berry.store.messages.findBotRepliesTo(message.chatKey, [
      message.onebotMessageId,
    ]),
  ]);

  const chat = chats.find((c) => c.chatKey === message.chatKey) ?? null;
  const relatedJobs = jobs.filter((job) =>
    collectJobMessageIds(job, berry).includes(message.id),
  );
  const jobIds = relatedJobs.map((j) => j.id);

  // Follow up to 2 hops of quoted messages for context clarity.
  const quotedRecords: MessageRecord[] = [];
  const seenMsgIds = new Set<number>([message.id]);
  let currentReplyId = message.replyToMessageId;

  for (let hop = 0; hop < 2 && currentReplyId; hop++) {
    const quoted = await berry.store.messages.findByOnebotId(
      message.chatKey,
      currentReplyId,
    );

    if (!quoted || seenMsgIds.has(quoted.id)) {
      break;
    }

    seenMsgIds.add(quoted.id);
    quotedRecords.push(quoted);
    currentReplyId = quoted.replyToMessageId;
  }

  const allMsgIds = [
    message.id,
    ...quotedRecords.map((m) => m.id),
    ...replyRecords.map((m) => m.id),
  ];
  const assetMap = await berry.store.assets.listForMessages(allMsgIds);

  const calls = await berry.store.usage.listForTrace({
    jobIds,
    messageId: message.id,
  });

  return finalizeTrace({
    id: `msg:${message.id}`,
    kind: "message",
    chatKey: message.chatKey,
    chatTitle: chat?.title || message.chatId,
    chatKind: message.kind,
    triggerMessages: [toSnippet(message, assetMap)],
    quotedMessages: quotedRecords.map((m) => toSnippet(m, assetMap)),
    replyMessages: replyRecords.map((m) => toSnippet(m, assetMap)),
    instruction: null,
    gateDecisions: gateMap.get(message.id) ?? [],
    steps: calls,
  });
}

export async function buildAiTraces(
  berry: BerryApp,
  filter: {
    chatKey?: string;
    status?: "ok" | "error";
    purpose?: string;
    scope?: "all" | "active" | "error";
    search?: string;
    limit?: number;
  } = {},
): Promise<{ items: AiTraceView[]; total: number }> {
  const limit = Math.min(120, Math.max(1, filter.limit ?? 50));

  const [{ items: recentCalls }, chats, recentJobs] = await Promise.all([
    berry.store.usage.listRecent({
      chatKey: filter.chatKey,
      limit: 200,
    }),
    berry.store.chats.list(),
    berry.store.jobs.list({
      chatKey: filter.chatKey,
      limit: 160,
    }),
  ]);

  const chatByKey = new Map<string, ChatConfig>(
    chats.map((c) => [c.chatKey, c]),
  );
  const jobById = new Map(recentJobs.map((j) => [j.id, j]));

  // Map each call to its canonical group key (preferring triggering message ID, then job ID, then call ID).
  interface RawGroup {
    id: string;
    kind: AiTraceView["kind"];
    chatKey: string | null;
    messageIds: Set<number>;
    jobIds: Set<number>;
    steps: LlmCallRecord[];
    instruction: string | null;
  }

  const groups = new Map<string, RawGroup>();

  function getOrCreate(
    key: string,
    kind: AiTraceView["kind"],
    chatKey: string | null,
  ): RawGroup {
    let g = groups.get(key);

    if (!g) {
      g = {
        id: key,
        kind,
        chatKey,
        messageIds: new Set(),
        jobIds: new Set(),
        steps: [],
        instruction: null,
      };
      groups.set(key, g);
    }

    return g;
  }

  for (const call of recentCalls) {
    const job = call.jobId === null ? undefined : jobById.get(call.jobId);
    const jobMsgIds = job ? collectJobMessageIds(job, berry) : [];
    const callMsgIds = call.messageIds.length > 0 ? call.messageIds : jobMsgIds;

    let group: RawGroup;

    if (callMsgIds.length > 0) {
      const anchorId = callMsgIds[0]!;

      group = getOrCreate(`msg:${anchorId}`, "message", call.chatKey);
      for (const mid of callMsgIds) {
        group.messageIds.add(mid);
      }
    } else if (job) {
      group = getOrCreate(`job:${job.id}`, "job", call.chatKey);
    } else {
      group = getOrCreate(`call:${call.id}`, "standalone", call.chatKey);
    }

    if (job) {
      group.jobIds.add(job.id);
    }

    if (!group.instruction) {
      if (
        job?.kind === "invoke" &&
        "content" in job.payload &&
        typeof job.payload.content === "string"
      ) {
        group.instruction = job.payload.content;
      } else {
        group.instruction = extractInstructionFromPreview(call);
      }
    }

    group.steps.push(call);
  }

  // Batch load all referenced messages, their assets, gate decisions, and bot replies.
  const allTriggerMsgIds = [
    ...new Set([...groups.values()].flatMap((g) => [...g.messageIds])),
  ];
  const [triggerRecords, gateMap] = await Promise.all([
    berry.store.messages.getByIds(allTriggerMsgIds),
    berry.store.gate.listByMessageIds(allTriggerMsgIds),
  ]);
  const msgById = new Map(triggerRecords.map((m) => [m.id, m]));

  // Load 1-hop quoted messages & bot replies grouped by chatKey.
  const quotedLookupPairs = new Map<string, Set<string>>();
  const replyLookupByChat = new Map<string, Set<string>>();

  for (const msg of triggerRecords) {
    if (msg.replyToMessageId) {
      const set = quotedLookupPairs.get(msg.chatKey) ?? new Set<string>();

      set.add(msg.replyToMessageId);
      quotedLookupPairs.set(msg.chatKey, set);
    }

    const rset = replyLookupByChat.get(msg.chatKey) ?? new Set<string>();

    rset.add(msg.onebotMessageId);
    replyLookupByChat.set(msg.chatKey, rset);
  }

  const quotedByChatAndObId = new Map<string, MessageRecord>();

  for (const [ck, obIds] of quotedLookupPairs) {
    for (const obId of obIds) {
      const found = await berry.store.messages.findByOnebotId(ck, obId);

      if (found) {
        quotedByChatAndObId.set(`${ck}\0${obId}`, found);
      }
    }
  }

  const botRepliesByChatAndTarget = new Map<string, MessageRecord[]>();

  for (const [ck, obIds] of replyLookupByChat) {
    const replies = await berry.store.messages.findBotRepliesTo(ck, [...obIds]);

    for (const r of replies) {
      if (!r.replyToMessageId) {
        continue;
      }

      const key = `${ck}\0${r.replyToMessageId}`;
      const list = botRepliesByChatAndTarget.get(key);

      if (list) {
        list.push(r);
      } else {
        botRepliesByChatAndTarget.set(key, [r]);
      }
    }
  }

  const allLoadedMsgIds = [
    ...new Set([
      ...triggerRecords.map((m) => m.id),
      ...[...quotedByChatAndObId.values()].map((m) => m.id),
      ...[...botRepliesByChatAndTarget.values()].flat().map((m) => m.id),
    ]),
  ];
  const assetMap = await berry.store.assets.listForMessages(allLoadedMsgIds);

  let traces: AiTraceView[] = [];

  for (const g of groups.values()) {
    const tMsgs = [...g.messageIds]
      .map((id) => msgById.get(id))
      .filter((m): m is MessageRecord => Boolean(m))
      .sort((a, b) => a.sentAt - b.sentAt || a.id - b.id);

    const chatKey = g.chatKey ?? tMsgs[0]?.chatKey ?? null;
    const chat = chatKey ? chatByKey.get(chatKey) : undefined;
    const quotedList: TraceMessageSnippet[] = [];
    const seenQuoted = new Set<number>(tMsgs.map((m) => m.id));
    const replyList: TraceMessageSnippet[] = [];
    const seenReplies = new Set<number>();

    for (const m of tMsgs) {
      if (m.replyToMessageId) {
        const q = quotedByChatAndObId.get(
          `${m.chatKey}\0${m.replyToMessageId}`,
        );

        if (q && !seenQuoted.has(q.id)) {
          seenQuoted.add(q.id);
          quotedList.push(toSnippet(q, assetMap));
        }
      }

      for (const r of botRepliesByChatAndTarget.get(
        `${m.chatKey}\0${m.onebotMessageId}`,
      ) ?? []) {
        if (!seenReplies.has(r.id)) {
          seenReplies.add(r.id);
          replyList.push(toSnippet(r, assetMap));
        }
      }
    }

    const gateDecisions = [...g.messageIds]
      .flatMap((id) => gateMap.get(id) ?? [])
      .sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);

    traces.push(
      finalizeTrace({
        id: g.id,
        kind: g.kind,
        chatKey,
        chatTitle: chat?.title || chat?.chatId || chatKey || "全局任务",
        chatKind: chat?.kind ?? tMsgs[0]?.kind ?? null,
        triggerMessages: tMsgs.map((m) => toSnippet(m, assetMap)),
        quotedMessages: quotedList,
        replyMessages: replyList,
        instruction: g.instruction,
        gateDecisions,
        steps: g.steps,
      }),
    );
  }

  // Apply high-level filters.
  if (filter.status) {
    traces = traces.filter((t) => t.status === filter.status);
  }

  if (filter.scope === "error") {
    traces = traces.filter((t) => t.status === "error");
  } else if (filter.scope === "active") {
    traces = traces.filter((t) => t.steps.some((s) => s.purpose !== "gate"));
  }

  if (filter.purpose) {
    traces = traces.filter((t) =>
      filter.purpose === "subagent"
        ? t.steps.some((s) => s.purpose.startsWith("subagent"))
        : t.steps.some((s) => s.purpose === filter.purpose),
    );
  }

  if (filter.search?.trim()) {
    const q = filter.search.trim().toLowerCase();

    traces = traces.filter((t) => {
      const haystacks = [
        t.chatTitle,
        t.chatKey ?? "",
        t.instruction ?? "",
        t.outcome.preview,
        ...t.triggerMessages.flatMap((m) => [m.senderName, m.text]),
        ...t.replyMessages.map((m) => m.text),
        ...t.steps.flatMap((s) => [
          s.model,
          s.error ?? "",
          s.responseText ?? "",
          ...s.toolCalls.map((tc) => tc.name),
        ]),
      ];

      return haystacks.some((h) => h.toLowerCase().includes(q));
    });
  }

  traces.sort((a, b) => b.endedAt - a.endedAt);

  return {
    total: traces.length,
    items: traces.slice(0, limit),
  };
}

export async function summarizeMessageTraces(
  berry: BerryApp,
  messages: MessageRecord[],
  assetMap: Map<number, MessageAssetRecord[]>,
): Promise<Map<number, MessageTraceSummary>> {
  const ids = messages.map((m) => m.id);
  const idSet = new Set(ids);
  const [gateMap, linkedCalls] = await Promise.all([
    berry.store.gate.listByMessageIds(ids),
    berry.store.usage.listLinkedToMessages(ids),
  ]);

  const callStats = new Map<number, { count: number; errors: number }>();

  for (const call of linkedCalls) {
    for (const mid of new Set(call.messageIds)) {
      if (!idSet.has(mid)) {
        continue;
      }

      const cur = callStats.get(mid) ?? { count: 0, errors: 0 };

      cur.count++;
      if (call.status === "error") {
        cur.errors++;
      }

      callStats.set(mid, cur);
    }
  }

  const out = new Map<number, MessageTraceSummary>();

  for (const msg of messages) {
    const gates = gateMap.get(msg.id) ?? [];
    const latestGate = gates.at(-1) ?? null;
    const stats = callStats.get(msg.id) ?? { count: 0, errors: 0 };
    const assets = assetMap.get(msg.id) ?? [];
    const hasAssetTrace = assets.some((a) => a.status !== "pending");

    out.set(msg.id, {
      gateAction: latestGate?.action ?? null,
      gateReason: latestGate?.reason ?? null,
      aiCalls: stats.count,
      aiErrors: stats.errors,
      hasTrace: latestGate !== null || stats.count > 0 || hasAssetTrace,
    });
  }

  return out;
}
