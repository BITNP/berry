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
import {
  NAlert,
  NButton,
  NEmpty,
  NInput,
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
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";

import { apiFetch } from "../api/client.ts";
import TraceInspector from "../components/TraceInspector.vue";
import GateDryRunModal from "../components/ai/GateDryRunModal.vue";
import GlobalContextPane from "../components/ai/GlobalContextPane.vue";
import UsageStatsPane from "../components/ai/UsageStatsPane.vue";
import { useChatOptions } from "../composables/useChatOptions.ts";
import { useLiveRefresh } from "../composables/useEventStream.ts";
import type { AiTraceView, TraceOutcome } from "../utils/ai.ts";
import {
  PURPOSE_FILTER_OPTIONS,
  formatDurationHuman,
  purposeMeta,
} from "../utils/ai.ts";
import { formatTime } from "../utils/format.ts";

interface JobCountsSummary {
  pending: number;
  running: number;
  failed: number;
}

type AiTab = "calls" | "context" | "usage";
type TraceScope = "active" | "all" | "error";

const route = useRoute();
const router = useRouter();
const message = useMessage();
const { chatOptions } = useChatOptions();

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
const traces = ref<AiTraceView[]>([]);
const totalTraces = ref(0);
const selectedTraceId = ref<string | null>(null);
const jobCounts = ref<JobCountsSummary>({ pending: 0, running: 0, failed: 0 });
const retryingJobs = ref(false);
const dryRunOpen = ref(false);
const streamPaused = ref(false);

const contextPaneRef = ref<InstanceType<typeof GlobalContextPane> | null>(null);
const usagePaneRef = ref<InstanceType<typeof UsageStatsPane> | null>(null);

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

async function refreshAll() {
  if (activeTab.value === "context") {
    await contextPaneRef.value?.refresh();

    return;
  }

  if (activeTab.value === "usage") {
    await usagePaneRef.value?.refresh();

    return;
  }

  await Promise.all([loadTraces(), loadJobStatus()]);
}

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
        <NButton :loading="loadingTraces" size="small" @click="refreshAll">
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
        <GlobalContextPane ref="contextPaneRef" :paused="streamPaused" />
      </NTabPane>

      <NTabPane name="usage" tab="用量统计">
        <UsageStatsPane ref="usagePaneRef" :paused="streamPaused" />
      </NTabPane>
    </NTabs>

    <GateDryRunModal v-model:show="dryRunOpen" @done="loadTraces" />
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
