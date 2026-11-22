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
  NButton,
  NCard,
  NDataTable,
  NDrawer,
  NDrawerContent,
  NEmpty,
  NInput,
  NPopconfirm,
  NRadioButton,
  NRadioGroup,
  NSelect,
  NSpace,
  NSpin,
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
import DeliveriesPane from "../components/DeliveriesPane.vue";
import GateMonitorPane from "../components/GateMonitorPane.vue";
import type { JobCounts } from "../components/RuntimeJobsPane.vue";
import RuntimeJobsPane from "../components/RuntimeJobsPane.vue";
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

const route = useRoute();
const router = useRouter();
const message = useMessage();
const { chatOptions } = useChatOptions();

type AiTab = "calls" | "gate" | "jobs" | "deliveries" | "context" | "usage";
type TraceScope = "active" | "all" | "error";

function initialTab(): AiTab {
  const q = route.query.tab;

  if (
    q === "gate" ||
    q === "jobs" ||
    q === "deliveries" ||
    q === "context" ||
    q === "usage"
  ) {
    return q;
  }

  return "calls";
}

const activeTab = ref<AiTab>(initialTab());
const loadingTraces = ref(false);
const loadingMeta = ref(false);
const traces = ref<AiTraceView[]>([]);
const totalTraces = ref(0);
const selectedTraceId = ref<string | null>(null);
const gateTotal = ref<number | null>(null);
const jobsSummary = ref<{ total: number; counts: JobCounts } | null>(null);
const deliveriesSummary = ref<{ total: number; failed: number } | null>(null);
const gatePaneRef = ref<InstanceType<typeof GateMonitorPane> | null>(null);
const jobsPaneRef = ref<InstanceType<typeof RuntimeJobsPane> | null>(null);
const deliveriesPaneRef = ref<InstanceType<typeof DeliveriesPane> | null>(null);
const usageBuckets = ref<UsageBucket[]>([]);
const conversation = ref<ConversationView | null>(null);
const contextMode = ref<"active" | "full">("active");
const fullTapeEntries = ref<TapeEntryView[]>([]);
const loadingTape = ref(false);
const sidecarDrawerOpen = ref(false);
const sidecarIdActive = ref<string | null>(null);
const sidecarEntries = ref<TapeEntryView[]>([]);
const loadingSidecar = ref(false);
const resettingContext = ref(false);

const filterPurpose = ref<string | null>(
  typeof route.query.purpose === "string" && route.query.purpose
    ? route.query.purpose
    : null,
);
const traceScope = ref<TraceScope>(
  route.query.status === "error"
    ? "error"
    : filterPurpose.value === "gate"
      ? "all"
      : "active",
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
    message.error(err instanceof Error ? err.message : "加载上下文与用量失败");
  } finally {
    loadingMeta.value = false;
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
  sidecarDrawerOpen.value = true;
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
  if (activeTab.value === "gate") {
    await gatePaneRef.value?.loadDecisions();

    return;
  }

  if (activeTab.value === "jobs") {
    await jobsPaneRef.value?.refresh();

    return;
  }

  if (activeTab.value === "deliveries") {
    await deliveriesPaneRef.value?.refresh();

    return;
  }

  await Promise.all([
    loadTraces(),
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

function inspectChatCalls(chatKey: string) {
  filterChatKey.value = chatKey;
  activeTab.value = "calls";
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
  if (route.query.tab !== tab) {
    void router.replace({ query: { ...route.query, tab } });
  }

  if (tab === "context" || tab === "usage") {
    void loadMeta();
  }
});

watch(
  () => route.query,
  (q) => {
    if (
      q.tab === "calls" ||
      q.tab === "gate" ||
      q.tab === "jobs" ||
      q.tab === "deliveries" ||
      q.tab === "context" ||
      q.tab === "usage"
    ) {
      activeTab.value = q.tab;
    } else if (!q.tab) {
      activeTab.value = "calls";
    }

    if (typeof q.chatKey === "string" && q.chatKey !== filterChatKey.value) {
      filterChatKey.value = q.chatKey || null;
    }

    if (typeof q.purpose === "string" && q.purpose !== filterPurpose.value) {
      filterPurpose.value = q.purpose || null;
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
  void loadTraces();
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
        <NText
          v-else-if="activeTab === 'gate' && gateTotal !== null"
          class="sub-note tabular"
          depth="3"
        >
          {{ gateTotal }} 条分流
        </NText>
        <NText
          v-else-if="activeTab === 'jobs' && jobsSummary"
          class="sub-note tabular"
          depth="3"
        >
          {{ jobsSummary.total }} 个任务
          <template v-if="jobsSummary.counts.failed > 0">
            · {{ jobsSummary.counts.failed }} 失败
          </template>
        </NText>
        <NText
          v-else-if="activeTab === 'deliveries' && deliveriesSummary"
          class="sub-note tabular"
          depth="3"
        >
          {{ deliveriesSummary.total }} 条投递
          <template v-if="deliveriesSummary.failed > 0">
            · {{ deliveriesSummary.failed }} 失败
          </template>
        </NText>
      </NSpace>
      <NSpace :size="8" wrap>
        <NButton
          v-if="activeTab === 'gate'"
          size="small"
          type="primary"
          @click="gatePaneRef?.openDryRun()"
        >
          <template #icon>
            <FlaskConical :size="14" />
          </template>
          沙盒试跑
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

      <NTabPane name="gate" tab="消息分流">
        <NCard size="small">
          <GateMonitorPane
            ref="gatePaneRef"
            :chat-key="filterChatKey"
            :paused="streamPaused"
            @inspect-chat-calls="inspectChatCalls"
            @update:total="(n: number) => (gateTotal = n)"
          />
        </NCard>
      </NTabPane>

      <NTabPane
        name="jobs"
        :tab="
          jobsSummary && jobsSummary.counts.failed > 0
            ? `任务队列 (${jobsSummary.counts.failed} 失败)`
            : jobsSummary && jobsSummary.counts.running > 0
              ? `任务队列 (${jobsSummary.counts.running} 运行中)`
              : '任务队列'
        "
      >
        <NCard size="small">
          <RuntimeJobsPane
            ref="jobsPaneRef"
            :paused="streamPaused"
            @update:summary="(s) => (jobsSummary = s)"
          />
        </NCard>
      </NTabPane>

      <NTabPane
        name="deliveries"
        :tab="
          deliveriesSummary && deliveriesSummary.failed > 0
            ? `出站投递 (${deliveriesSummary.failed} 失败)`
            : '出站投递'
        "
      >
        <NCard size="small">
          <DeliveriesPane
            ref="deliveriesPaneRef"
            :paused="streamPaused"
            @update:summary="(s) => (deliveriesSummary = s)"
          />
        </NCard>
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

    <NDrawer v-model:show="sidecarDrawerOpen" class="drawer-safe" :width="620">
      <NDrawerContent closable :title="`子代理轨迹 · ${sidecarIdActive ?? ''}`">
        <div v-if="loadingSidecar" class="trace-list-state">
          <NSpin size="small" />
        </div>
        <NSpace v-else :size="10" vertical>
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
      </NDrawerContent>
    </NDrawer>
  </div>
</template>

<style scoped>
.ai-page {
  display: flex;
  flex-direction: column;
  min-height: calc(100vh - 88px);
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
