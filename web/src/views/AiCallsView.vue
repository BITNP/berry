<script setup lang="ts">
import {
  ChevronLeft,
  FlaskConical,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Search,
} from "@lucide/vue";
import type { DataTableColumns } from "naive-ui";
import {
  NAlert,
  NButton,
  NCard,
  NDataTable,
  NEmpty,
  NForm,
  NFormItem,
  NInput,
  NModal,
  NPopconfirm,
  NRadioButton,
  NRadioGroup,
  NSelect,
  NSpace,
  NSpin,
  NSwitch,
  NTabPane,
  NTabs,
  NTag,
  NText,
  useMessage,
} from "naive-ui";
import { computed, h, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";

import { apiFetch } from "../api/client.ts";
import ChronoVirtualList from "../components/ChronoVirtualList.vue";
import TraceInspector from "../components/TraceInspector.vue";
import { useChatOptions } from "../composables/useChatOptions.ts";
import { useLiveRefresh } from "../composables/useEventStream.ts";
import type { AiTraceView, TraceOutcome } from "../utils/ai.ts";
import {
  PURPOSE_FILTER_OPTIONS,
  formatDurationHuman,
  prettyMaybeJson,
  purposeMeta,
} from "../utils/ai.ts";
import { formatPercent, formatTime } from "../utils/format.ts";

interface UsageBucket {
  day: string;
  purpose: string;
  model: string;
  calls: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  avgDurationMs: number;
}

interface TapeHandoffView {
  summary: string;
  confirmedFacts: string[];
  openTasks: string[];
  pendingFollowups: string[];
  sourceEntryIds: number[];
}

interface TapeEntryView {
  id: number;
  tapeId: string;
  kind: "message" | "anchor";
  turnId: string;
  chatKey: string;
  role: string;
  sidecarId: string | null;
  createdAt: number;
  message?: {
    role: string;
    content: string | null;
    tool_call_id?: string;
    tool_calls?: {
      id: string;
      function: { name: string; arguments: string };
    }[];
  };
  anchor?: {
    reason: "compact" | "reset";
    sessionId: string;
    afterMessageId?: number;
    cutoffEntryId: number;
    handoff?: TapeHandoffView;
  };
}

interface ConversationView {
  chatKey: string;
  sessionId: string;
  summary: string;
  handoff: TapeHandoffView | null;
  anchorEntryId: number | null;
  afterMessageId: number;
  updatedAt: number;
  entries: TapeEntryView[];
  pendingResults: {
    module: string;
    status: string;
    detail: string;
    createdAt: number;
  }[];
}

interface DryRunResponse {
  result: {
    messageId: number;
    action: "reply" | "memory" | "ignore";
    confidence: number;
    reason: string;
  };
  model: string;
  durationMs: number;
}

interface JobCountsSummary {
  pending: number;
  running: number;
  failed: number;
}

const route = useRoute();
const router = useRouter();
const message = useMessage();
const { chatOptions } = useChatOptions();

type AiTab = "calls" | "context" | "usage";
type TraceScope = "active" | "all" | "error";

function resolveTab(rawTab: unknown): AiTab {
  if (rawTab === "context" || rawTab === "usage") {
    return rawTab;
  }

  return "calls";
}

function resolveScope(
  rawScope: unknown,
  rawStatus: unknown,
  rawTab: unknown,
  purpose: string | null,
): TraceScope {
  if (rawScope === "active" || rawScope === "all" || rawScope === "error") {
    return rawScope;
  }

  if (rawStatus === "error") {
    return "error";
  }

  if (purpose === "gate" || rawTab === "gate") {
    return "all";
  }

  return "active";
}

const activeTab = ref<AiTab>(resolveTab(route.query.tab));
const loadingTraces = ref(false);
const loadingMeta = ref(false);
const traces = ref<AiTraceView[]>([]);
const totalTraces = ref(0);
const selectedTraceId = ref<string | null>(null);
const jobCounts = ref<JobCountsSummary>({ pending: 0, running: 0, failed: 0 });
const retryingJobs = ref(false);
const usageBuckets = ref<UsageBucket[]>([]);
const conversation = ref<ConversationView | null>(null);
const contextMode = ref<"active" | "full">("active");
const fullTapeEntries = ref<TapeEntryView[]>([]);
const loadingTape = ref(false);
const sidecarModalOpen = ref(false);
const sidecarIdActive = ref<string | null>(null);
const sidecarEntries = ref<TapeEntryView[]>([]);
const loadingSidecar = ref(false);
const resettingContext = ref(false);

const dryRunOpen = ref(false);
const dryRunBusy = ref(false);
const dryRunForm = ref({
  chatKey: "group:10248888",
  triggerMode: "smart_observe",
  senderName: "测试群友",
  userId: "10001",
  mentionedBot: false,
  quotedBot: false,
  text: "树莓娘，能帮忙查一下上周公会看板上还有哪些没做完吗？",
  recentContextText: "硅草: 今天服务器刚部署完\n王润泽: 周末例会定在周日晚上",
});
const dryRunResult = ref<DryRunResponse | null>(null);

const dryRunActionMap: Record<
  DryRunResponse["result"]["action"],
  { text: string; type: "success" | "info" | "default" }
> = {
  reply: { text: "回复", type: "success" },
  memory: { text: "记入记忆", type: "info" },
  ignore: { text: "忽略", type: "default" },
};

const hasJobBanner = computed(
  () =>
    jobCounts.value.running > 0 ||
    jobCounts.value.pending > 0 ||
    jobCounts.value.failed > 0,
);

const initialPurpose =
  typeof route.query.purpose === "string" && route.query.purpose
    ? route.query.purpose
    : route.query.tab === "gate"
      ? "gate"
      : null;

const filterPurpose = ref<string | null>(initialPurpose);
const traceScope = ref<TraceScope>(
  resolveScope(
    route.query.scope,
    route.query.status,
    route.query.tab,
    initialPurpose,
  ),
);
const filterChatKey = ref<string | null>(
  typeof route.query.chatKey === "string" && route.query.chatKey
    ? route.query.chatKey
    : null,
);
const filterSearch = ref("");

const isMobile = ref(false);
const mobileShowDetail = ref(false);
let mediaQuery: MediaQueryList | null = null;

function handleViewportChange(event: MediaQueryListEvent | MediaQueryList) {
  isMobile.value = event.matches;
  if (!event.matches) {
    mobileShowDetail.value = false;
  }
}

const selectedTrace = computed(
  () => traces.value.find((t) => t.id === selectedTraceId.value) ?? null,
);

function selectTrace(trace: AiTraceView) {
  selectedTraceId.value = trace.id;
  if (isMobile.value) {
    mobileShowDetail.value = true;
  }
}

function traceHeadline(trace: AiTraceView): string {
  const firstMsg = trace.triggerMessages[0];

  if (firstMsg) {
    const text = firstMsg.text.replaceAll(/\s+/g, " ").trim();

    if (text) {
      return text;
    }

    if (firstMsg.assets.length > 0) {
      return `[附件 ×${firstMsg.assets.length}]`;
    }
  }

  if (trace.instruction) {
    return trace.instruction.replaceAll(/\s+/g, " ").trim();
  }

  return trace.outcome.preview || "后台模型调用";
}

function traceSender(trace: AiTraceView): string {
  const names = [
    ...new Set(trace.triggerMessages.map((m) => m.senderName).filter(Boolean)),
  ];

  if (names.length > 0) {
    return names.join("、");
  }

  return trace.instruction ? "系统指令" : "";
}

function summarizeStepBadges(trace: AiTraceView): {
  label: string;
  type: "default" | "info" | "success" | "warning" | "primary";
}[] {
  const counts = new Map<
    string,
    {
      label: string;
      type: "default" | "info" | "success" | "warning" | "primary";
      count: number;
    }
  >();

  for (const step of trace.steps) {
    const meta = purposeMeta(step.purpose);
    const shortLabel = meta.label.replace(/^子代理：/, "");
    const existing = counts.get(shortLabel);

    if (existing) {
      existing.count++;
    } else {
      counts.set(shortLabel, { label: shortLabel, type: meta.type, count: 1 });
    }
  }

  return [...counts.values()].map((item) => ({
    label: item.count > 1 ? `${item.label} ×${item.count}` : item.label,
    type: item.type,
  }));
}

function outcomeTagType(
  kind: TraceOutcome["kind"],
): "success" | "info" | "warning" | "error" | "default" | "primary" {
  switch (kind) {
    case "reply": {
      return "primary";
    }

    case "reaction":
    case "vision": {
      return "info";
    }

    case "memory": {
      return "success";
    }

    case "error": {
      return "error";
    }

    default: {
      return "default";
    }
  }
}

const expandedTurns = ref<Record<string, boolean>>({});
const TURN_PREVIEW_LIMIT = 900;

interface ContextTurnItem {
  key: string;
  index: number;
  kind: "message" | "anchor";
  role: string;
  chatKey: string;
  toolCallId?: string;
  toolNames: string[];
  sidecarId: string | null;
  anchorReason?: "compact" | "reset";
  createdAt?: number;
  body: string;
  preview: string;
  isLong: boolean;
}

function formatTapeEntry(entry: TapeEntryView): ContextTurnItem {
  if (entry.kind === "anchor" && entry.anchor) {
    const body = entry.anchor.handoff
      ? JSON.stringify(entry.anchor.handoff, null, 2)
      : `重置检查点（session: ${entry.anchor.sessionId}${entry.anchor.afterMessageId ? `, afterMessageId: ${entry.anchor.afterMessageId}` : ""}）`;
    const isLong = body.length > TURN_PREVIEW_LIMIT;

    return {
      key: `tape-${entry.tapeId}-${entry.id}`,
      index: entry.id,
      kind: "anchor",
      role: "anchor",
      chatKey: entry.chatKey,
      toolNames: [],
      sidecarId: null,
      anchorReason: entry.anchor.reason,
      createdAt: entry.createdAt,
      body,
      preview: isLong ? `${body.slice(0, TURN_PREVIEW_LIMIT)}\n…` : body,
      isLong,
    };
  }

  const turn = entry.message;
  const body = turn?.content
    ? prettyMaybeJson(turn.content)
    : turn?.tool_calls?.length
      ? JSON.stringify(
          turn.tool_calls.map((c) => ({
            tool: c.function.name,
            args: prettyMaybeJson(c.function.arguments),
          })),
          null,
          2,
        )
      : "(empty)";
  const isLong = body.length > TURN_PREVIEW_LIMIT;

  return {
    key: `tape-${entry.tapeId}-${entry.id}`,
    index: entry.id,
    kind: "message",
    role: entry.role,
    chatKey: entry.chatKey,
    toolCallId: turn?.tool_call_id,
    toolNames: (turn?.tool_calls ?? []).map((c) => c.function.name),
    sidecarId: entry.sidecarId,
    createdAt: entry.createdAt,
    body,
    preview: isLong ? `${body.slice(0, TURN_PREVIEW_LIMIT)}\n…` : body,
    isLong,
  };
}

const contextItems = computed<ContextTurnItem[]>(() => {
  const useFull =
    contextMode.value === "full" &&
    (fullTapeEntries.value.length > 0 || !loadingTape.value);
  const source = useFull
    ? fullTapeEntries.value
    : (conversation.value?.entries ?? []);

  return source.map(formatTapeEntry);
});

function handleContextModeChange(mode: "active" | "full") {
  if (mode === "full") {
    loadingTape.value = true;
    void loadFullTape();
  }

  contextMode.value = mode;
}

const sidecarItems = computed<ContextTurnItem[]>(() =>
  sidecarEntries.value.map(formatTapeEntry),
);

function toggleTurnExpand(key: string) {
  expandedTurns.value = {
    ...expandedTurns.value,
    [key]: !expandedTurns.value[key],
  };
}

const usageTotals30d = computed(() => {
  let totalCallCount = 0;
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;

  for (const row of usageBuckets.value) {
    totalCallCount += row.calls;
    inputTokens += row.inputTokens;
    cachedInputTokens += row.cachedInputTokens;
    outputTokens += row.outputTokens;
  }

  return {
    calls: totalCallCount,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
});

function roleTagType(role: string): "info" | "primary" | "warning" | "default" {
  if (role === "user") {
    return "info";
  }

  if (role === "assistant") {
    return "primary";
  }

  if (role === "tool") {
    return "warning";
  }

  return "default";
}

async function loadTraces() {
  loadingTraces.value = true;

  try {
    const params = new URLSearchParams({
      limit: "80",
      scope: traceScope.value,
    });

    if (filterPurpose.value) {
      params.set("purpose", filterPurpose.value);
    }

    if (filterChatKey.value) {
      params.set("chatKey", filterChatKey.value);
    }

    if (filterSearch.value.trim()) {
      params.set("search", filterSearch.value.trim());
    }

    const res = await apiFetch<{ items: AiTraceView[]; total: number }>(
      `/api/admin/ai/traces?${params.toString()}`,
    );

    traces.value = res.items;
    totalTraces.value = res.total;

    if (
      res.items.length > 0 &&
      (!selectedTraceId.value ||
        !res.items.some((item) => item.id === selectedTraceId.value))
    ) {
      selectedTraceId.value = res.items[0].id;
    } else if (res.items.length === 0) {
      selectedTraceId.value = null;
    }
  } catch (err) {
    message.error(err instanceof Error ? err.message : "加载追踪链路失败");
  } finally {
    loadingTraces.value = false;
  }
}

async function loadMeta() {
  loadingMeta.value = true;

  try {
    const [usageRes, convRes] = await Promise.all([
      apiFetch<{ buckets: UsageBucket[] }>("/api/admin/usage?days=30"),
      apiFetch<ConversationView>("/api/admin/conversation"),
    ]);

    usageBuckets.value = usageRes.buckets ?? [];
    conversation.value = convRes;

    if (contextMode.value === "full") {
      await loadFullTape();
    }
  } catch (err) {
    message.error(err instanceof Error ? err.message : "加载上下文和用量失败");
  } finally {
    loadingMeta.value = false;
  }
}

async function loadJobStatus() {
  try {
    const res = await apiFetch<{ counts?: Partial<JobCountsSummary> }>(
      "/api/admin/jobs?limit=1",
    );

    jobCounts.value = {
      pending: res.counts?.pending ?? 0,
      running: res.counts?.running ?? 0,
      failed: res.counts?.failed ?? 0,
    };
  } catch {
    // Non-critical live strip; keep previous counts silently.
  }
}

async function handleRetryAllFailed() {
  retryingJobs.value = true;

  try {
    const res = await apiFetch<{ retried: number }>(
      "/api/admin/jobs/retry-failed",
      { method: "POST" },
    );

    message.success(`已重新入队 ${res.retried} 个失败任务`);
    await Promise.all([loadJobStatus(), loadTraces()]);
  } catch (err) {
    message.error(err instanceof Error ? err.message : "批量重试失败");
  } finally {
    retryingJobs.value = false;
  }
}

async function handleDryRun() {
  if (!dryRunForm.value.text.trim()) {
    message.warning("请输入待测试的消息内容");

    return;
  }

  dryRunBusy.value = true;

  try {
    dryRunResult.value = await apiFetch<DryRunResponse>(
      "/api/admin/gate-decisions/dry-run",
      {
        method: "POST",
        body: JSON.stringify({
          chatKey: dryRunForm.value.chatKey.trim() || "group:100000",
          triggerMode: dryRunForm.value.triggerMode,
          senderName: dryRunForm.value.senderName.trim() || "测试群友",
          userId: dryRunForm.value.userId.trim() || "10001",
          mentionedBot: dryRunForm.value.mentionedBot,
          quotedBot: dryRunForm.value.quotedBot,
          text: dryRunForm.value.text.trim(),
          recentContext: dryRunForm.value.recentContextText
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean),
        }),
      },
    );
    await loadTraces();
  } catch (err) {
    message.error(err instanceof Error ? err.message : "分流试跑失败");
  } finally {
    dryRunBusy.value = false;
  }
}

async function loadFullTape() {
  loadingTape.value = true;

  try {
    const res = await apiFetch<{ entries: TapeEntryView[] }>(
      "/api/admin/tape?tapeId=global&limit=300",
    );

    fullTapeEntries.value = res.entries;
  } catch (err) {
    message.error(err instanceof Error ? err.message : "加载完整 Tape 失败");
  } finally {
    loadingTape.value = false;
  }
}

async function openSidecar(sidecarId: string) {
  sidecarIdActive.value = sidecarId;
  sidecarModalOpen.value = true;
  loadingSidecar.value = true;
  sidecarEntries.value = [];

  try {
    const res = await apiFetch<{ entries: TapeEntryView[] }>(
      `/api/admin/tape?tapeId=${encodeURIComponent(`sidecar:${sidecarId}`)}&limit=200`,
    );

    sidecarEntries.value = res.entries;
  } catch (err) {
    message.error(err instanceof Error ? err.message : "加载子代理轨迹失败");
  } finally {
    loadingSidecar.value = false;
  }
}

async function refreshAll() {
  await Promise.all([
    loadTraces(),
    loadJobStatus(),
    activeTab.value === "context" || activeTab.value === "usage"
      ? loadMeta()
      : Promise.resolve(),
  ]);
}

async function handleResetConversation() {
  resettingContext.value = true;

  try {
    await apiFetch("/api/admin/conversation/reset", { method: "POST" });
    message.success("已追加全局上下文重置检查点");
    await loadMeta();
  } catch (err) {
    message.error(err instanceof Error ? err.message : "重置上下文失败");
  } finally {
    resettingContext.value = false;
  }
}

const streamPaused = ref(false);

function togglePause() {
  streamPaused.value = !streamPaused.value;
}

useLiveRefresh({
  events: ["llm_call", "gate_decision"],
  paused: streamPaused,
  debounceMs: 600,
  refresh: () => {
    if (activeTab.value === "calls") {
      void loadTraces();
    } else if (activeTab.value === "usage") {
      void loadMeta();
    }
  },
});

useLiveRefresh({
  events: ["job_update"],
  paused: streamPaused,
  debounceMs: 400,
  refresh: () => {
    void loadJobStatus();
  },
});

useLiveRefresh({
  events: ["conversation_update"],
  paused: streamPaused,
  debounceMs: 600,
  refresh: () => {
    if (activeTab.value === "context") {
      void loadMeta();
    }
  },
});

let filterTimer: ReturnType<typeof setTimeout> | null = null;

watch([traceScope, filterPurpose, filterChatKey], () => {
  void loadTraces();
});

watch(filterSearch, () => {
  if (filterTimer) {
    clearTimeout(filterTimer);
  }

  filterTimer = setTimeout(() => {
    void loadTraces();
  }, 240);
});

watch(activeTab, (tab) => {
  const nextQuery = { ...route.query };

  if (tab === "calls") {
    delete nextQuery.tab;
  } else {
    nextQuery.tab = tab;
  }

  if (route.query.tab !== nextQuery.tab) {
    void router.replace({ query: nextQuery });
  }

  if (tab === "context" || tab === "usage") {
    void loadMeta();
  }
});

watch(
  () => route.query,
  (q) => {
    activeTab.value = resolveTab(q.tab);

    const nextChatKey =
      typeof q.chatKey === "string" && q.chatKey ? q.chatKey : null;

    if (nextChatKey !== filterChatKey.value) {
      filterChatKey.value = nextChatKey;
    }

    const nextPurpose =
      typeof q.purpose === "string" && q.purpose
        ? q.purpose
        : q.tab === "gate"
          ? "gate"
          : null;

    if (nextPurpose !== filterPurpose.value) {
      filterPurpose.value = nextPurpose;
    }

    if (q.scope || q.status || q.tab === "gate") {
      traceScope.value = resolveScope(q.scope, q.status, q.tab, nextPurpose);
    }
  },
);

const usageColumns: DataTableColumns<UsageBucket> = [
  { title: "日期", key: "day", width: 96 },
  {
    title: "用途",
    key: "purpose",
    width: 176,
    render: (row) => {
      const meta = purposeMeta(row.purpose);

      return h(
        NTag,
        {
          size: "small",
          type: meta.type,
          style: "max-width: 100%;",
        },
        { default: () => meta.label },
      );
    },
  },
  {
    title: "模型",
    key: "model",
    minWidth: 130,
    ellipsis: { tooltip: true },
    render: (row) => h("span", { class: "mono" }, row.model),
  },
  {
    title: "次数",
    key: "calls",
    width: 64,
    align: "right",
    render: (row) => h("span", { class: "tabular" }, String(row.calls)),
  },
  {
    title: "输入",
    key: "inputTokens",
    width: 92,
    align: "right",
    render: (row) =>
      h("span", { class: "tabular" }, row.inputTokens.toLocaleString()),
  },
  {
    title: "缓存命中",
    key: "cachedInputTokens",
    width: 92,
    align: "right",
    render: (row) =>
      h("span", { class: "tabular" }, row.cachedInputTokens.toLocaleString()),
  },
  {
    title: "输出",
    key: "outputTokens",
    width: 92,
    align: "right",
    render: (row) =>
      h("span", { class: "tabular" }, row.outputTokens.toLocaleString()),
  },
  {
    title: "均耗时",
    key: "avgDurationMs",
    width: 82,
    align: "right",
    render: (row) =>
      h("span", { class: "tabular" }, formatDurationHuman(row.avgDurationMs)),
  },
];

onMounted(() => {
  mediaQuery = window.matchMedia("(max-width: 960px)");
  handleViewportChange(mediaQuery);
  mediaQuery.addEventListener("change", handleViewportChange);

  if (
    route.query.tab === "gate" ||
    route.query.tab === "jobs" ||
    route.query.tab === "deliveries"
  ) {
    const cleaned = { ...route.query };

    delete cleaned.tab;
    if (route.query.tab === "gate") {
      cleaned.scope = "all";
      cleaned.purpose = "gate";
    }

    void router.replace({ query: cleaned });
  }

  void loadTraces();
  void loadJobStatus();
  if (activeTab.value === "context" || activeTab.value === "usage") {
    void loadMeta();
  }
});

onUnmounted(() => {
  mediaQuery?.removeEventListener("change", handleViewportChange);
});
</script>

<template>
  <div class="ai-page">
    <div class="page-bar">
      <NSpace align="center" :size="10">
        <h2 class="page-title">运行追踪</h2>
        <NText v-if="activeTab === 'calls'" class="sub-note tabular" depth="3">
          {{ totalTraces }} 条链路
        </NText>
      </NSpace>
      <NSpace :size="8" wrap>
        <NButton
          v-if="activeTab === 'calls'"
          size="small"
          @click="dryRunOpen = true"
        >
          <template #icon>
            <FlaskConical :size="14" />
          </template>
          分流试跑
        </NButton>
        <NButton size="small" @click="togglePause">
          <template #icon>
            <Play v-if="streamPaused" :size="14" />
            <Pause v-else :size="14" />
          </template>
          {{ streamPaused ? "恢复实时流" : "暂停实时流" }}
        </NButton>
        <NButton
          :loading="loadingTraces || loadingMeta"
          size="small"
          @click="refreshAll"
        >
          <template #icon>
            <RefreshCw :size="14" />
          </template>
          刷新
        </NButton>
      </NSpace>
    </div>

    <NTabs v-model:value="activeTab" class="ai-tabs" type="line">
      <NTabPane name="calls" tab="执行链路">
        <NAlert
          v-if="hasJobBanner"
          class="mb-sm"
          :show-icon="false"
          :type="jobCounts.failed > 0 ? 'warning' : 'info'"
        >
          <div class="jobs-strip">
            <span class="tabular">
              后台任务：
              <template v-if="jobCounts.running > 0">
                运行中 {{ jobCounts.running }}
              </template>
              <template v-if="jobCounts.pending > 0">
                {{ jobCounts.running > 0 ? " · " : "" }}排队
                {{ jobCounts.pending }}
              </template>
              <template v-if="jobCounts.failed > 0">
                {{
                  jobCounts.running > 0 || jobCounts.pending > 0 ? " · " : ""
                }}失败 {{ jobCounts.failed }}
              </template>
            </span>
            <NSpace :size="8">
              <NButton
                v-if="jobCounts.failed > 0"
                :loading="retryingJobs"
                secondary
                size="tiny"
                type="warning"
                @click="handleRetryAllFailed"
              >
                <template #icon>
                  <RotateCcw :size="12" />
                </template>
                重试全部失败
              </NButton>
              <NButton
                v-if="jobCounts.failed > 0 && traceScope !== 'error'"
                quaternary
                size="tiny"
                @click="traceScope = 'error'"
              >
                仅看异常
              </NButton>
            </NSpace>
          </div>
        </NAlert>

        <div v-show="!isMobile || !mobileShowDetail" class="filter-bar">
          <NRadioGroup v-model:value="traceScope" size="small">
            <NRadioButton value="active">有效交互</NRadioButton>
            <NRadioButton value="all">全部</NRadioButton>
            <NRadioButton value="error">仅异常</NRadioButton>
          </NRadioGroup>
          <NSelect
            v-model:value="filterPurpose"
            class="w-175"
            clearable
            :options="PURPOSE_FILTER_OPTIONS"
            placeholder="全部环节"
            size="small"
          />
          <NSelect
            v-model:value="filterChatKey"
            class="w-240"
            clearable
            filterable
            :options="chatOptions"
            placeholder="筛选会话（名称/群号）"
            size="small"
            tag
          />
          <NInput
            v-model:value="filterSearch"
            class="w-240"
            clearable
            placeholder="搜索消息、发送者或工具"
            size="small"
          >
            <template #prefix>
              <Search :size="13" />
            </template>
          </NInput>
        </div>

        <div class="trace-workbench">
          <!-- Left master list -->
          <div v-show="!isMobile || !mobileShowDetail" class="trace-list-pane">
            <div
              v-if="loadingTraces && traces.length === 0"
              class="trace-list-state"
            >
              <NSpin size="small" />
            </div>
            <NEmpty
              v-else-if="traces.length === 0"
              class="trace-list-state"
              description="暂无匹配的追踪链路"
            />
            <div v-else class="trace-list-scroll">
              <button
                v-for="trace in traces"
                :key="trace.id"
                class="trace-row"
                :class="{
                  active: trace.id === selectedTraceId,
                  error: trace.status === 'error',
                }"
                type="button"
                @click="selectTrace(trace)"
              >
                <div class="trace-row-top">
                  <span class="trace-row-chat">{{ trace.chatTitle }}</span>
                  <span v-if="traceSender(trace)" class="trace-row-sender">
                    {{ traceSender(trace) }}
                  </span>
                  <span class="trace-row-time tabular">
                    {{ formatTime(trace.endedAt) }}
                  </span>
                </div>

                <div class="trace-row-headline">
                  {{ traceHeadline(trace) }}
                </div>

                <div class="trace-row-bottom">
                  <div class="trace-row-pills">
                    <NTag
                      :bordered="false"
                      size="tiny"
                      :type="outcomeTagType(trace.outcome.kind)"
                    >
                      {{ trace.outcome.label }}
                    </NTag>
                    <NTag
                      v-for="badge in summarizeStepBadges(trace).slice(0, 3)"
                      :key="badge.label"
                      :bordered="false"
                      size="tiny"
                      :type="badge.type"
                    >
                      {{ badge.label }}
                    </NTag>
                  </div>
                  <span class="trace-row-dur tabular">
                    {{ formatDurationHuman(trace.totalDurationMs) }}
                  </span>
                </div>
              </button>
            </div>
          </div>

          <!-- Right inspector pane -->
          <div v-show="!isMobile || mobileShowDetail" class="trace-detail-pane">
            <div v-if="isMobile" class="trace-mobile-bar">
              <NButton
                quaternary
                size="small"
                @click="mobileShowDetail = false"
              >
                <template #icon>
                  <ChevronLeft :size="15" />
                </template>
                返回链路列表
              </NButton>
            </div>
            <div class="trace-detail-scroll">
              <TraceInspector :trace="selectedTrace" />
            </div>
          </div>
        </div>
      </NTabPane>

      <NTabPane name="context" tab="全局上下文">
        <NCard size="small">
          <NSpace v-if="conversation" :size="12" vertical>
            <div class="filter-bar space-between">
              <NText class="mono sub-note" depth="3">
                session: {{ conversation.sessionId }} · afterMessageId:
                {{ conversation.afterMessageId }} · 更新于
                {{ formatTime(conversation.updatedAt) }}
              </NText>
              <NPopconfirm @positive-click="handleResetConversation">
                <template #trigger>
                  <NButton
                    :loading="resettingContext"
                    size="small"
                    type="warning"
                  >
                    <template #icon>
                      <RotateCcw :size="14" />
                    </template>
                    追加重置检查点
                  </NButton>
                </template>
                将在 Tape 尾部追加重置 Anchor（历史记录不删除，可在完整 Tape
                中回放），长期记忆保留不变。确认继续？
              </NPopconfirm>
            </div>

            <div v-if="conversation.handoff" class="handoff-box">
              <div class="handoff-title">
                结构化交接摘要（Anchor #{{
                  conversation.anchorEntryId ?? "-"
                }}）
              </div>
              <div class="pre-wrap">{{ conversation.handoff.summary }}</div>
              <div
                v-if="conversation.handoff.confirmedFacts.length > 0"
                class="sub-note"
              >
                <strong>已确认事实：</strong>
                {{ conversation.handoff.confirmedFacts.join("；") }}
              </div>
              <div
                v-if="conversation.handoff.openTasks.length > 0"
                class="sub-note"
              >
                <strong>未完成任务：</strong>
                {{ conversation.handoff.openTasks.join("；") }}
              </div>
              <div
                v-if="conversation.handoff.pendingFollowups.length > 0"
                class="sub-note"
              >
                <strong>待跟进事项：</strong>
                {{ conversation.handoff.pendingFollowups.join("；") }}
              </div>
            </div>

            <div class="context-scroll-panel">
              <div class="context-scroll-head">
                <div class="context-scroll-title">
                  <span>
                    {{
                      contextMode === "full"
                        ? "完整 Tape 时间线"
                        : "活跃对话轮次"
                    }}
                  </span>
                  <NText class="tabular sub-note" depth="3">
                    {{ contextItems.length }} 条
                  </NText>
                  <NSpin v-if="loadingTape" :size="12" />
                </div>
                <NRadioGroup
                  size="small"
                  :value="contextMode"
                  @update:value="handleContextModeChange"
                >
                  <NRadioButton value="active">当前活跃视图</NRadioButton>
                  <NRadioButton value="full">完整 Tape</NRadioButton>
                </NRadioGroup>
              </div>

              <ChronoVirtualList
                class="context-vlist"
                :empty-text="
                  loadingTape
                    ? '正在加载完整 Tape...'
                    : '全局上下文当前暂无短期轮次'
                "
                :item-size="54"
                :items="contextItems"
                key-field="key"
              >
                <template #default="{ item }">
                  <div class="context-vlist-item">
                    <div
                      class="turn-box"
                      :class="
                        item.kind === 'anchor'
                          ? item.anchorReason === 'reset'
                            ? 'turn-box-anchor-reset'
                            : 'turn-box-anchor-compact'
                          : ''
                      "
                    >
                      <div class="turn-head">
                        <span class="mono turn-time">#{{ item.index }}</span>
                        <NTag
                          v-if="item.kind === 'anchor'"
                          size="tiny"
                          :type="
                            item.anchorReason === 'reset'
                              ? 'warning'
                              : 'success'
                          "
                        >
                          {{
                            item.anchorReason === "reset"
                              ? "anchor: reset"
                              : "anchor: compact"
                          }}
                        </NTag>
                        <NTag v-else size="tiny" :type="roleTagType(item.role)">
                          {{ item.role }}
                        </NTag>
                        <NTag v-if="item.chatKey" size="tiny" type="default">
                          {{ item.chatKey }}
                        </NTag>
                        <NTag
                          v-for="(toolName, tIdx) in item.toolNames"
                          :key="`${toolName}-${tIdx}`"
                          size="tiny"
                          type="info"
                        >
                          {{ toolName }}
                        </NTag>
                        <NButton
                          v-if="item.sidecarId"
                          secondary
                          size="tiny"
                          type="primary"
                          @click="openSidecar(item.sidecarId)"
                        >
                          Sidecar {{ item.sidecarId }}
                        </NButton>
                        <NButton
                          v-if="item.isLong"
                          class="ml-auto"
                          quaternary
                          size="tiny"
                          @click="toggleTurnExpand(item.key)"
                        >
                          {{
                            expandedTurns[item.key]
                              ? "收起"
                              : `展开全文 (${item.body.length.toLocaleString()} 字)`
                          }}
                        </NButton>
                      </div>
                      <pre class="code-block mt-xs">{{
                        expandedTurns[item.key] ? item.body : item.preview
                      }}</pre>
                    </div>
                  </div>
                </template>
              </ChronoVirtualList>
            </div>
          </NSpace>
        </NCard>
      </NTabPane>

      <NTabPane name="usage" tab="用量统计">
        <NCard size="small">
          <div class="filter-bar">
            <NText class="tabular sub-note" depth="2">
              近 30 日累计：调用
              {{ usageTotals30d.calls.toLocaleString() }} 次，合计
              {{ usageTotals30d.totalTokens.toLocaleString() }} Tokens（输入
              {{ usageTotals30d.inputTokens.toLocaleString() }} / 缓存命中
              {{ usageTotals30d.cachedInputTokens.toLocaleString() }}，{{
                formatPercent(
                  usageTotals30d.cachedInputTokens,
                  usageTotals30d.inputTokens,
                )
              }}
              / 输出 {{ usageTotals30d.outputTokens.toLocaleString() }}）
            </NText>
          </div>
          <NDataTable
            :columns="usageColumns"
            :data="usageBuckets"
            :loading="loadingMeta"
            :pagination="{ pageSize: 15 }"
            :scroll-x="860"
            size="small"
          />
        </NCard>
      </NTabPane>
    </NTabs>

    <NModal
      v-model:show="dryRunOpen"
      preset="card"
      :style="{ width: '520px', maxWidth: '94vw' }"
      title="小模型分流试跑"
    >
      <NForm label-placement="top" size="small">
        <NFormItem label="模拟会话标识">
          <NSelect
            v-model:value="dryRunForm.chatKey"
            filterable
            :options="chatOptions"
            placeholder="选择已有会话或输入 group:群号"
            tag
          />
        </NFormItem>
        <NFormItem
          v-if="!dryRunForm.chatKey.startsWith('private:')"
          label="群触发模式"
        >
          <NSelect
            v-model:value="dryRunForm.triggerMode"
            :options="[
              { label: '智能观察（smart_observe）', value: 'smart_observe' },
              { label: '仅提及（mention_only）', value: 'mention_only' },
            ]"
          />
        </NFormItem>
        <NFormItem label="发送者">
          <NSpace class="w-full">
            <NInput
              v-model:value="dryRunForm.senderName"
              class="w-190"
              placeholder="昵称"
            />
            <NInput
              v-model:value="dryRunForm.userId"
              class="w-190"
              placeholder="QQ 号"
            />
          </NSpace>
        </NFormItem>
        <NFormItem label="标记">
          <NSpace :size="20">
            <NSpace
              v-if="!dryRunForm.chatKey.startsWith('private:')"
              align="center"
              :size="6"
            >
              <NSwitch v-model:value="dryRunForm.mentionedBot" size="small" />
              <span>@ 树莓娘</span>
            </NSpace>
            <NSpace align="center" :size="6">
              <NSwitch v-model:value="dryRunForm.quotedBot" size="small" />
              <span>引用机器人消息</span>
            </NSpace>
          </NSpace>
        </NFormItem>
        <NFormItem label="模拟近期群聊上下文（每行一条）">
          <NInput
            v-model:value="dryRunForm.recentContextText"
            :rows="3"
            type="textarea"
          />
        </NFormItem>
        <NFormItem label="待判定消息">
          <NInput v-model:value="dryRunForm.text" :rows="3" type="textarea" />
        </NFormItem>
        <NButton
          block
          :loading="dryRunBusy"
          type="primary"
          @click="handleDryRun"
        >
          执行分类测试
        </NButton>
      </NForm>

      <NCard v-if="dryRunResult" class="mt-lg" size="small" title="判定结果">
        <NSpace :size="8" vertical>
          <NSpace align="center" :size="8">
            <NTag
              size="small"
              :type="dryRunActionMap[dryRunResult.result.action].type"
            >
              {{ dryRunActionMap[dryRunResult.result.action].text }}
            </NTag>
            <NText class="tabular">
              置信度 {{ Math.round(dryRunResult.result.confidence * 100) }}%
            </NText>
            <NText class="mono sub-note" depth="3">
              {{ dryRunResult.model }} / {{ dryRunResult.durationMs }} ms
            </NText>
          </NSpace>
          <div>{{ dryRunResult.result.reason }}</div>
        </NSpace>
      </NCard>
    </NModal>

    <NModal
      v-model:show="sidecarModalOpen"
      preset="card"
      :style="{ width: '680px', maxWidth: '94vw' }"
      :title="`子代理轨迹 · ${sidecarIdActive ?? ''}`"
    >
      <div v-if="loadingSidecar" class="trace-list-state">
        <NSpin size="small" />
      </div>
      <NSpace v-else class="sidecar-scroll" :size="10" vertical>
        <div v-for="item in sidecarItems" :key="item.key" class="turn-box">
          <div class="turn-head">
            <span class="mono turn-time">#{{ item.index }}</span>
            <NTag size="tiny" :type="roleTagType(item.role)">
              {{ item.role }}
            </NTag>
            <NTag
              v-for="(toolName, tIdx) in item.toolNames"
              :key="`${toolName}-${tIdx}`"
              size="tiny"
              type="info"
            >
              {{ toolName }}
            </NTag>
          </div>
          <pre class="code-block mt-xs">{{ item.body }}</pre>
        </div>
      </NSpace>
    </NModal>
  </div>
</template>

<style scoped>
.ai-page {
  display: flex;
  flex-direction: column;
  min-height: calc(100vh - 88px);
}

.jobs-strip {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 13px;
}

.mb-sm {
  margin-bottom: 10px;
}

.sidecar-scroll {
  max-height: 68vh;
  overflow-y: auto;
}

.trace-workbench {
  display: grid;
  grid-template-columns: 370px minmax(0, 1fr);
  height: calc(100vh - 236px);
  min-height: 440px;
  border: 1px solid var(--berry-border);
  border-radius: 8px;
  background: var(--berry-surface);
  overflow: hidden;
}

.trace-list-pane {
  border-right: 1px solid var(--berry-border);
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--berry-inset);
}

.trace-list-scroll {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}

.trace-list-state {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px 16px;
}

.trace-row {
  appearance: none;
  border: none;
  border-bottom: 1px solid var(--berry-border);
  border-left: 3px solid transparent;
  background: transparent;
  color: inherit;
  text-align: left;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 5px;
  cursor: pointer;
  transition: background-color 0.12s ease;
}

.trace-row:hover {
  background: var(--berry-surface);
}

.trace-row.active {
  background: var(--berry-surface);
  border-left-color: #e11d48;
}

.trace-row.error:not(.active) {
  border-left-color: rgba(239, 68, 68, 0.55);
}

.trace-row-top {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
}

.trace-row-chat {
  font-size: 12px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.trace-row-sender {
  font-size: 11px;
  color: var(--berry-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.trace-row-time {
  margin-left: auto;
  flex-shrink: 0;
  font-size: 11px;
  color: var(--berry-muted);
}

.trace-row-headline {
  font-size: 13px;
  line-height: 1.45;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
}

.trace-row-bottom {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.trace-row-pills {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
  min-width: 0;
}

.trace-row-dur {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--berry-muted);
}

.trace-detail-pane {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  background: var(--berry-surface);
}

.trace-detail-scroll {
  flex: 1;
  overflow-y: auto;
}

.trace-mobile-bar {
  padding: 8px 12px;
  border-bottom: 1px solid var(--berry-border);
}

.handoff-box {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 14px;
  border-radius: 6px;
  border: 1px solid var(--berry-border);
  background: var(--berry-inset);
}

.handoff-title {
  font-size: 13px;
  font-weight: 600;
}

.context-scroll-panel {
  border: 1px solid var(--berry-border);
  border-radius: 6px;
  background: var(--berry-surface);
  overflow: hidden;
}

.context-scroll-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--berry-border);
  background: var(--berry-inset);
}

.context-scroll-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
}

.context-vlist {
  height: 520px;
}

.context-vlist-item {
  padding: 6px 10px;
}

.turn-box {
  padding: 8px 10px;
  border-radius: 6px;
  border: 1px solid var(--berry-border);
  background: var(--berry-inset);
}

.turn-box-anchor-compact {
  border-color: rgba(22, 163, 74, 0.35);
}

.turn-box-anchor-reset {
  border-color: rgba(245, 158, 11, 0.45);
}

.turn-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}

.turn-time {
  font-size: 11px;
  color: var(--berry-muted);
}

.space-between {
  justify-content: space-between;
}

.ml-auto {
  margin-left: auto;
}

.mt-xs {
  margin-top: 6px;
}

.pre-wrap {
  white-space: pre-wrap;
  word-break: break-word;
}

@media (max-width: 960px) {
  .trace-workbench {
    grid-template-columns: minmax(0, 1fr);
    height: calc(100vh - 230px);
  }

  .trace-list-pane {
    border-right: none;
  }
}
</style>
