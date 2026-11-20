<script setup lang="ts">
import {
  Download,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Trash2,
} from "@lucide/vue";
import type { DataTableColumns } from "naive-ui";
import {
  NAlert,
  NButton,
  NCard,
  NDataTable,
  NDescriptions,
  NDescriptionsItem,
  NDrawer,
  NDrawerContent,
  NEmpty,
  NInput,
  NPopconfirm,
  NRadioButton,
  NRadioGroup,
  NSelect,
  NSpace,
  NSwitch,
  NTabPane,
  NTabs,
  NTag,
  NText,
  useMessage,
} from "naive-ui";
import { computed, h, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";

import { apiFetch } from "../api/client.ts";
import { useChatOptions } from "../composables/useChatOptions.ts";
import { useEventStream } from "../composables/useEventStream.ts";
import { formatTime } from "../utils/format.ts";

type LogLevel = "debug" | "info" | "warn" | "error";

interface LogEntryView {
  id: number;
  time: number;
  level: LogLevel;
  scope: string;
  message: string;
  context: Record<string, unknown>;
}

type JobLane = "gate" | "dialog" | "background";
type JobTagType =
  "default" | "primary" | "info" | "success" | "warning" | "error";
type JobLaneFilter = "all" | "background" | "realtime";

interface JobTypeDescriptor {
  kind: string;
  label: string;
  lane: JobLane;
  tagType: JobTagType;
}

interface JobActionLink {
  label: string;
  to: string;
}

interface JobCounts {
  pending: number;
  running: number;
  failed: number;
  backgroundActive: number;
}

interface JobRow {
  id: number;
  kind: string;
  label?: string;
  lane?: JobLane;
  tagType?: JobTagType;
  dedupeKey: string;
  chatKey: string;
  payload: Record<string, unknown>;
  summary?: string;
  links?: JobActionLink[];
  state: "pending" | "running" | "done" | "failed";
  attempts: number;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

interface DeliveryRow {
  id: number;
  chatKey: string;
  kind: string;
  payload: Record<string, unknown>;
  status: "queued" | "retrying" | "sent" | "failed";
  attempts: number;
  error: string | null;
  onebotMessageId: string | null;
  updatedAt: number;
}

const MAX_LOG_ITEMS = 2000;

const route = useRoute();
const router = useRouter();
const message = useMessage();
const { chatOptions } = useChatOptions();

function initialTab(): "logs" | "jobs" | "deliveries" {
  const q = route.query.tab;

  if (q === "jobs" || q === "deliveries") {
    return q;
  }

  return "logs";
}

function initialJobLane(): JobLaneFilter {
  const q = route.query.lane;

  if (q === "background" || q === "realtime") {
    return q;
  }

  return "all";
}

const activeTab = ref<"logs" | "jobs" | "deliveries">(initialTab());

// Logs state
const loadingLogs = ref(false);
const entries = ref<LogEntryView[]>([]);
const scopes = ref<string[]>([]);
const filterLevel = ref<LogLevel | null>(null);
const filterScope = ref<string | null>(null);
const filterSearch = ref("");
const autoScroll = ref(true);
const consoleRef = ref<HTMLElement | null>(null);

// Jobs state
const loadingJobs = ref(false);
const jobs = ref<JobRow[]>([]);
const jobKinds = ref<JobTypeDescriptor[]>([]);
const jobCounts = ref<JobCounts>({
  pending: 0,
  running: 0,
  failed: 0,
  backgroundActive: 0,
});
const filterJobLane = ref<JobLaneFilter>(initialJobLane());
const filterJobKind = ref<string | null>(
  typeof route.query.kind === "string" && route.query.kind
    ? route.query.kind
    : null,
);
const filterJobState = ref<JobRow["state"] | null>(
  route.query.state === "pending" ||
    route.query.state === "running" ||
    route.query.state === "done" ||
    route.query.state === "failed"
    ? route.query.state
    : null,
);
const filterJobChatKey = ref<string | null>(null);
const filterJobSearch = ref("");
const retryingAll = ref(false);
const busyJobId = ref<number | null>(null);
const selectedJob = ref<JobRow | null>(null);
const jobDrawerOpen = ref(false);
const nowTick = ref(Date.now());

// Deliveries state
const loadingDeliveries = ref(false);
const deliveries = ref<DeliveryRow[]>([]);
const filterDeliveryStatus = ref<DeliveryRow["status"] | null>(null);
const filterDeliveryChatKey = ref<string | null>(null);
const selectedDelivery = ref<DeliveryRow | null>(null);
const deliveryDrawerOpen = ref(false);

const levelPriority: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const levelTagType: Record<LogLevel, "default" | "info" | "warning" | "error"> =
  {
    debug: "default",
    info: "info",
    warn: "warning",
    error: "error",
  };

const scopeOptions = computed(() =>
  scopes.value.map((s) => ({ label: s, value: s })),
);

const visibleEntries = computed(() => {
  const minPrio = filterLevel.value ? levelPriority[filterLevel.value] : 0;
  const kw = filterSearch.value.trim().toLowerCase();

  return entries.value.filter((entry) => {
    if (levelPriority[entry.level] < minPrio) {
      return false;
    }

    if (filterScope.value && entry.scope !== filterScope.value) {
      return false;
    }

    if (!kw) {
      return true;
    }

    const ctxText = JSON.stringify(entry.context).toLowerCase();

    return (
      entry.message.toLowerCase().includes(kw) ||
      entry.scope.toLowerCase().includes(kw) ||
      ctxText.includes(kw)
    );
  });
});

const jobKindMap = computed(
  () => new Map(jobKinds.value.map((item) => [item.kind, item])),
);

function jobMeta(row: Pick<JobRow, "kind" | "label" | "lane" | "tagType">): {
  label: string;
  lane: JobLane;
  tagType: JobTagType;
} {
  const registered = jobKindMap.value.get(row.kind);

  return {
    label: row.label ?? registered?.label ?? row.kind,
    lane: row.lane ?? registered?.lane ?? "background",
    tagType: row.tagType ?? registered?.tagType ?? "default",
  };
}

const jobKindOptions = computed(() => {
  const seen = new Set<string>();
  const items: { label: string; value: string }[] = [];

  for (const desc of jobKinds.value) {
    if (filterJobLane.value === "background" && desc.lane !== "background") {
      continue;
    }

    if (filterJobLane.value === "realtime" && desc.lane === "background") {
      continue;
    }

    seen.add(desc.kind);
    items.push({ label: desc.label, value: desc.kind });
  }

  for (const job of jobs.value) {
    if (seen.has(job.kind)) {
      continue;
    }

    const meta = jobMeta(job);

    if (
      (filterJobLane.value === "background" && meta.lane !== "background") ||
      (filterJobLane.value === "realtime" && meta.lane === "background")
    ) {
      continue;
    }

    seen.add(job.kind);
    items.push({ label: meta.label, value: job.kind });
  }

  return items;
});

const jobTargetOptions = computed(() => {
  const base = [...chatOptions.value];
  const known = new Set(base.map((opt) => opt.value));

  for (const job of jobs.value) {
    if (job.chatKey && !known.has(job.chatKey)) {
      known.add(job.chatKey);
      base.push({ label: job.chatKey, value: job.chatKey });
    }
  }

  return base;
});

const visibleJobs = computed(() => {
  const kw = filterJobSearch.value.trim().toLowerCase();

  return jobs.value.filter((j) => {
    const meta = jobMeta(j);

    if (filterJobLane.value === "background" && meta.lane !== "background") {
      return false;
    }

    if (filterJobLane.value === "realtime" && meta.lane === "background") {
      return false;
    }

    if (filterJobKind.value && j.kind !== filterJobKind.value) {
      return false;
    }

    if (filterJobState.value && j.state !== filterJobState.value) {
      return false;
    }

    if (filterJobChatKey.value && j.chatKey !== filterJobChatKey.value) {
      return false;
    }

    if (!kw) {
      return true;
    }

    return (
      j.chatKey.toLowerCase().includes(kw) ||
      meta.label.toLowerCase().includes(kw) ||
      j.kind.toLowerCase().includes(kw) ||
      (j.summary ?? "").toLowerCase().includes(kw) ||
      (j.lastError ?? "").toLowerCase().includes(kw)
    );
  });
});

const visibleDeliveries = computed(() =>
  deliveries.value.filter((d) => {
    if (filterDeliveryStatus.value && d.status !== filterDeliveryStatus.value) {
      return false;
    }

    if (
      filterDeliveryChatKey.value &&
      d.chatKey !== filterDeliveryChatKey.value
    ) {
      return false;
    }

    return true;
  }),
);

const failedJobCount = computed(() => jobCounts.value.failed);

function toggleJobStateFilter(state: JobRow["state"]) {
  filterJobState.value = filterJobState.value === state ? null : state;
}

function scrollToBottom() {
  if (!autoScroll.value || !consoleRef.value) {
    return;
  }

  void nextTick(() => {
    if (consoleRef.value) {
      consoleRef.value.scrollTop = consoleRef.value.scrollHeight;
    }
  });
}

const { paused: streamPaused, togglePause } = useEventStream((type, data) => {
  if (type === "log" && data && typeof data === "object") {
    const entry = data as LogEntryView;

    entries.value.push(entry);

    if (entries.value.length > MAX_LOG_ITEMS) {
      entries.value.splice(0, entries.value.length - MAX_LOG_ITEMS);
    }

    if (entry.scope && !scopes.value.includes(entry.scope)) {
      scopes.value = [...scopes.value, entry.scope].sort();
    }

    scrollToBottom();

    return;
  }

  if (type === "job_update") {
    void loadJobs();
  }

  if (type === "delivery_update") {
    void loadDeliveries();
  }
});

async function loadLogs() {
  loadingLogs.value = true;

  try {
    const qs = new URLSearchParams({ limit: "400" });

    if (filterLevel.value) {
      qs.set("level", filterLevel.value);
    }

    if (filterScope.value) {
      qs.set("scope", filterScope.value);
    }

    if (filterSearch.value.trim()) {
      qs.set("search", filterSearch.value.trim());
    }

    const res = await apiFetch<{
      items: LogEntryView[];
      latestId: number;
      scopes: string[];
    }>(`/api/admin/logs?${qs.toString()}`);

    entries.value = res.items;
    scopes.value = res.scopes;
    scrollToBottom();
  } catch (err) {
    message.error(err instanceof Error ? err.message : "加载日志失败");
  } finally {
    loadingLogs.value = false;
  }
}

async function loadJobs() {
  loadingJobs.value = true;

  try {
    const qs = new URLSearchParams({ limit: "150" });

    if (filterJobLane.value === "background") {
      qs.set("lane", "background");
    }

    if (filterJobKind.value) {
      qs.set("kind", filterJobKind.value);
    }

    if (filterJobState.value) {
      qs.set("state", filterJobState.value);
    }

    if (filterJobChatKey.value) {
      qs.set("chatKey", filterJobChatKey.value);
    }

    const res = await apiFetch<{
      items: JobRow[];
      kinds?: JobTypeDescriptor[];
      counts?: JobCounts;
    }>(`/api/admin/jobs?${qs.toString()}`);

    jobs.value = res.items;

    if (res.kinds) {
      jobKinds.value = res.kinds;
    }

    if (res.counts) {
      jobCounts.value = res.counts;
    }

    if (selectedJob.value) {
      const updated = res.items.find(
        (item) => item.id === selectedJob.value?.id,
      );

      if (updated) {
        selectedJob.value = updated;
      }
    }
  } catch (err) {
    message.error(err instanceof Error ? err.message : "加载任务队列失败");
  } finally {
    loadingJobs.value = false;
  }
}

async function loadDeliveries() {
  loadingDeliveries.value = true;

  try {
    const res = await apiFetch<{ items: DeliveryRow[] }>(
      "/api/admin/deliveries",
    );

    deliveries.value = res.items;
  } catch (err) {
    message.error(err instanceof Error ? err.message : "加载出站记录失败");
  } finally {
    loadingDeliveries.value = false;
  }
}

async function handleClear() {
  try {
    await apiFetch("/api/admin/logs/clear", { method: "POST" });
    entries.value = [];
    message.success("已清空内存日志缓冲");
  } catch (err) {
    message.error(err instanceof Error ? err.message : "清空日志失败");
  }
}

async function handleRetryAllFailed() {
  retryingAll.value = true;

  try {
    const res = await apiFetch<{ retried: number }>(
      "/api/admin/jobs/retry-failed",
      { method: "POST" },
    );

    message.success(`已重新入队 ${res.retried} 个失败任务`);
    await loadJobs();
  } catch (err) {
    message.error(err instanceof Error ? err.message : "批量重试失败");
  } finally {
    retryingAll.value = false;
  }
}

async function handleRetryJob(id: number) {
  busyJobId.value = id;

  try {
    await apiFetch(`/api/admin/jobs/${id}/retry`, { method: "POST" });
    message.success(`任务 #${id} 已重试`);
    await loadJobs();
  } catch (err) {
    message.error(err instanceof Error ? err.message : "重试失败");
  } finally {
    busyJobId.value = null;
  }
}

async function handleCancelJob(id: number) {
  busyJobId.value = id;

  try {
    await apiFetch(`/api/admin/jobs/${id}/cancel`, { method: "POST" });
    message.success(`任务 #${id} 已取消`);
    await loadJobs();
  } catch (err) {
    message.error(err instanceof Error ? err.message : "取消失败");
  } finally {
    busyJobId.value = null;
  }
}

function handleExport() {
  const lines = visibleEntries.value.map((entry) => {
    const ctx =
      Object.keys(entry.context).length > 0
        ? ` ${JSON.stringify(entry.context)}`
        : "";

    return `${new Date(entry.time).toISOString()} ${entry.level.toUpperCase()} [${entry.scope}] ${entry.message}${ctx}`;
  });
  const blob = new Blob([lines.join("\n")], {
    type: "text/plain;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");

  anchor.href = url;
  anchor.download = `berry-${new Date().toISOString().slice(0, 19).replaceAll(":", "-")}.log`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function formatContext(ctx: Record<string, unknown>): string {
  if (!ctx || Object.keys(ctx).length === 0) {
    return "";
  }

  return Object.entries(ctx)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" ");
}

function summarizePayload(
  payload: Record<string, unknown>,
  kind: string,
): string {
  if (kind === "qq_reply") {
    return typeof payload.text === "string" ? payload.text : "";
  }

  if (kind === "qq_forward") {
    const title =
      typeof payload.title === "string" ? payload.title : "合并转发";
    const items = Array.isArray(payload.items) ? payload.items.length : 0;

    return `${title}（${items} 条）`;
  }

  if (kind === "qq_reaction") {
    return `表情回应 #${String(payload.emojiId ?? "")} -> ${String(payload.messageId ?? "")}`;
  }

  return JSON.stringify(payload);
}

const jobLaneLabel: Record<JobLane, string> = {
  background: "后台任务",
  dialog: "主对话",
  gate: "门控分流",
};

const deliveryKindLabel: Record<string, string> = {
  qq_reply: "文本回复",
  qq_forward: "合并转发",
  qq_reaction: "表情回应",
};

function formatDurationMs(ms: number): string {
  const safe = Math.max(0, ms);

  if (safe < 1000) {
    return `${safe} ms`;
  }

  if (safe < 60_000) {
    return `${(safe / 1000).toFixed(1)} s`;
  }

  const mins = Math.floor(safe / 60_000);
  const secs = Math.round((safe % 60_000) / 1000);

  return `${mins}m ${secs}s`;
}

function jobDuration(row: JobRow): string {
  if (row.state === "running") {
    return formatDurationMs(nowTick.value - row.updatedAt);
  }

  if (row.state === "pending") {
    return "等待中";
  }

  return formatDurationMs(row.updatedAt - row.createdAt);
}

const jobStateLabel: Record<
  JobRow["state"],
  { text: string; type: "default" | "info" | "success" | "error" }
> = {
  pending: { text: "排队中", type: "info" },
  running: { text: "执行中", type: "info" },
  done: { text: "已完成", type: "success" },
  failed: { text: "失败", type: "error" },
};

const jobColumns: DataTableColumns<JobRow> = [
  { title: "ID", key: "id", width: 56 },
  {
    title: "类型",
    key: "kind",
    width: 108,
    render: (row) => {
      const cfg = jobMeta(row);

      return h(
        NTag,
        { size: "small", type: cfg.tagType },
        { default: () => cfg.label },
      );
    },
  },
  {
    title: "状态",
    key: "state",
    width: 78,
    render: (row) => {
      const cfg = jobStateLabel[row.state];

      return h(
        NTag,
        { size: "small", type: cfg.type },
        { default: () => cfg.text },
      );
    },
  },
  {
    title: "会话 / 目标",
    key: "chatKey",
    width: 176,
    ellipsis: { tooltip: true },
    render: (row) => h("span", { class: "mono" }, row.chatKey),
  },
  {
    title: "任务内容 / 错误",
    key: "summary",
    minWidth: 240,
    ellipsis: { tooltip: true },
    render: (row) => {
      if (row.lastError) {
        return h(
          NText,
          { type: "error", class: "sub-note" },
          { default: () => row.lastError },
        );
      }

      return row.summary || "—";
    },
  },
  {
    title: "耗时",
    key: "duration",
    width: 84,
    align: "right",
    render: (row) => h("span", { class: "tabular" }, jobDuration(row)),
  },
  {
    title: "更新时间",
    key: "updatedAt",
    width: 136,
    render: (row) => h("span", { class: "tabular" }, formatTime(row.updatedAt)),
  },
  {
    title: "操作",
    key: "actions",
    width: 72,
    render: (row) => {
      if (row.state === "failed") {
        return h(
          NButton,
          {
            size: "tiny",
            secondary: true,
            loading: busyJobId.value === row.id,
            onClick: (e: MouseEvent) => {
              e.stopPropagation();
              void handleRetryJob(row.id);
            },
          },
          { default: () => "重试" },
        );
      }

      if (row.state === "pending") {
        return h(
          NButton,
          {
            size: "tiny",
            quaternary: true,
            loading: busyJobId.value === row.id,
            onClick: (e: MouseEvent) => {
              e.stopPropagation();
              void handleCancelJob(row.id);
            },
          },
          { default: () => "取消" },
        );
      }

      return "—";
    },
  },
];

const deliveryStatusLabel: Record<
  DeliveryRow["status"],
  { text: string; type: "default" | "warning" | "success" | "error" }
> = {
  queued: { text: "待投递", type: "default" },
  retrying: { text: "重试中", type: "warning" },
  sent: { text: "已送达", type: "success" },
  failed: { text: "失败", type: "error" },
};

const deliveryColumns: DataTableColumns<DeliveryRow> = [
  { title: "ID", key: "id", width: 64 },
  {
    title: "会话",
    key: "chatKey",
    width: 176,
    ellipsis: { tooltip: true },
    render: (row) => h("span", { class: "mono" }, row.chatKey),
  },
  {
    title: "类型",
    key: "kind",
    width: 96,
    render: (row) =>
      h(
        NTag,
        { size: "small" },
        { default: () => deliveryKindLabel[row.kind] ?? row.kind },
      ),
  },
  {
    title: "状态",
    key: "status",
    width: 82,
    render: (row) => {
      const cfg = deliveryStatusLabel[row.status];

      return h(
        NTag,
        { size: "small", type: cfg.type },
        { default: () => cfg.text },
      );
    },
  },
  {
    title: "内容摘要",
    key: "payload",
    minWidth: 220,
    ellipsis: { tooltip: true },
    render: (row) => summarizePayload(row.payload, row.kind) || "—",
  },
  {
    title: "错误",
    key: "error",
    minWidth: 140,
    ellipsis: { tooltip: true },
    render: (row) => row.error || "—",
  },
  {
    title: "更新时间",
    key: "updatedAt",
    width: 144,
    render: (row) => h("span", { class: "tabular" }, formatTime(row.updatedAt)),
  },
];

watch(activeTab, (tab) => {
  if (route.query.tab !== tab) {
    void router.replace({ query: { ...route.query, tab } });
  }

  if (tab === "jobs") {
    void loadJobs();
  } else if (tab === "deliveries") {
    void loadDeliveries();
  }
});

watch([filterJobLane, filterJobKind, filterJobState, filterJobChatKey], () => {
  if (
    filterJobKind.value &&
    !jobKindOptions.value.some((o) => o.value === filterJobKind.value)
  ) {
    filterJobKind.value = null;
  }

  if (activeTab.value === "jobs") {
    const nextQuery: Record<string, string> = { tab: "jobs" };

    if (filterJobLane.value !== "all") {
      nextQuery.lane = filterJobLane.value;
    }

    if (filterJobKind.value) {
      nextQuery.kind = filterJobKind.value;
    }

    if (filterJobState.value) {
      nextQuery.state = filterJobState.value;
    }

    void router.replace({ query: nextQuery });
    void loadJobs();
  }
});

watch(
  () => route.query,
  (q) => {
    if (q.tab === "logs" || q.tab === "jobs" || q.tab === "deliveries") {
      activeTab.value = q.tab;
    }

    if (q.lane === "background" || q.lane === "realtime") {
      filterJobLane.value = q.lane;
    } else if (q.tab === "jobs" && !q.lane) {
      filterJobLane.value = "all";
    }
  },
);

let tickTimer: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  void Promise.all([loadLogs(), loadJobs(), loadDeliveries()]);
  tickTimer = setInterval(() => {
    if (jobs.value.some((j) => j.state === "running")) {
      nowTick.value = Date.now();
    }
  }, 1000);
});

onUnmounted(() => {
  if (tickTimer) {
    clearInterval(tickTimer);
  }
});
</script>

<template>
  <div>
    <div class="page-bar">
      <h1 class="page-title">日志队列</h1>
      <NSpace :size="8" wrap>
        <NButton size="small" @click="togglePause">
          <template #icon>
            <Play v-if="streamPaused" :size="14" />
            <Pause v-else :size="14" />
          </template>
          {{ streamPaused ? "恢复实时流" : "暂停实时流" }}
        </NButton>
        <NButton v-if="activeTab === 'logs'" size="small" @click="handleExport">
          <template #icon>
            <Download :size="14" />
          </template>
          导出 .log
        </NButton>
        <NPopconfirm v-if="activeTab === 'logs'" @positive-click="handleClear">
          <template #trigger>
            <NButton quaternary size="small" type="warning">
              <template #icon>
                <Trash2 :size="14" />
              </template>
              清空缓冲
            </NButton>
          </template>
          仅清空后台实时缓冲视图，不影响标准输出。确认继续？
        </NPopconfirm>
      </NSpace>
    </div>

    <NCard size="small">
      <NTabs v-model:value="activeTab" type="line">
        <NTabPane name="logs" :tab="`实时日志 (${visibleEntries.length})`">
          <div class="filter-bar">
            <NSelect
              v-model:value="filterLevel"
              class="w-135"
              clearable
              :options="[
                { label: 'DEBUG 以上', value: 'debug' },
                { label: 'INFO 以上', value: 'info' },
                { label: 'WARN 以上', value: 'warn' },
                { label: '仅 ERROR', value: 'error' },
              ]"
              placeholder="全部级别"
              size="small"
            />
            <NSelect
              v-model:value="filterScope"
              class="w-155"
              clearable
              filterable
              :options="scopeOptions"
              placeholder="全部模块"
              size="small"
            />
            <NInput
              v-model:value="filterSearch"
              class="w-240"
              clearable
              placeholder="过滤消息、模块或附带字段"
              size="small"
              @keyup.enter="loadLogs"
            />
            <NButton :loading="loadingLogs" size="small" @click="loadLogs">
              <template #icon>
                <RefreshCw :size="14" />
              </template>
              刷新
            </NButton>
            <NSpace align="center" class="ml-auto" :size="6">
              <NSwitch v-model:value="autoScroll" size="small" />
              <NText class="sub-note" depth="2">自动滚动</NText>
            </NSpace>
          </div>

          <div ref="consoleRef" class="log-console">
            <NEmpty
              v-if="visibleEntries.length === 0"
              class="py-empty"
              description="当前筛选下暂无日志"
            />
            <div
              v-for="entry in visibleEntries"
              :key="entry.id"
              class="log-line"
              :class="`lvl-${entry.level}`"
            >
              <span class="log-time tabular">{{ formatTime(entry.time) }}</span>
              <NTag
                class="log-lvl"
                size="tiny"
                :type="levelTagType[entry.level]"
              >
                {{ entry.level.toUpperCase() }}
              </NTag>
              <span class="log-scope mono">[{{ entry.scope }}]</span>
              <span class="log-msg">{{ entry.message }}</span>
              <span
                v-if="Object.keys(entry.context).length > 0"
                class="log-ctx mono"
              >
                {{ formatContext(entry.context) }}
              </span>
            </div>
          </div>
        </NTabPane>

        <NTabPane
          name="jobs"
          :tab="
            failedJobCount > 0
              ? `任务队列 (${failedJobCount} 失败)`
              : jobCounts.running > 0
                ? `任务队列 (${jobCounts.running} 执行中)`
                : `任务队列 (${jobs.length})`
          "
        >
          <div class="job-toolbar">
            <NRadioGroup v-model:value="filterJobLane" size="small">
              <NRadioButton value="all">全部</NRadioButton>
              <NRadioButton value="background">
                后台任务
                <template v-if="jobCounts.backgroundActive > 0">
                  ({{ jobCounts.backgroundActive }})
                </template>
              </NRadioButton>
              <NRadioButton value="realtime">对话与分流</NRadioButton>
            </NRadioGroup>

            <NSpace align="center" :size="6" wrap>
              <NButton
                v-if="jobCounts.running > 0"
                :secondary="filterJobState !== 'running'"
                size="tiny"
                :type="filterJobState === 'running' ? 'info' : 'default'"
                @click="toggleJobStateFilter('running')"
              >
                <span class="dot ok" />
                执行中 {{ jobCounts.running }}
              </NButton>
              <NButton
                v-if="jobCounts.pending > 0"
                :secondary="filterJobState !== 'pending'"
                size="tiny"
                :type="filterJobState === 'pending' ? 'info' : 'default'"
                @click="toggleJobStateFilter('pending')"
              >
                排队中 {{ jobCounts.pending }}
              </NButton>
              <NButton
                v-if="jobCounts.failed > 0"
                :secondary="filterJobState !== 'failed'"
                size="tiny"
                :type="filterJobState === 'failed' ? 'error' : 'warning'"
                @click="toggleJobStateFilter('failed')"
              >
                失败 {{ jobCounts.failed }}
              </NButton>
            </NSpace>
          </div>

          <div class="filter-bar">
            <NSelect
              v-model:value="filterJobKind"
              class="w-155"
              clearable
              filterable
              :options="jobKindOptions"
              placeholder="全部类型"
              size="small"
            />
            <NSelect
              v-model:value="filterJobState"
              class="w-120"
              clearable
              :options="[
                { label: '排队中', value: 'pending' },
                { label: '执行中', value: 'running' },
                { label: '失败', value: 'failed' },
                { label: '已完成', value: 'done' },
              ]"
              placeholder="全部状态"
              size="small"
            />
            <NSelect
              v-model:value="filterJobChatKey"
              class="w-240"
              clearable
              filterable
              :options="jobTargetOptions"
              placeholder="筛选目标（会话/后台目标）"
              size="small"
              tag
            />
            <NInput
              v-model:value="filterJobSearch"
              class="w-220"
              clearable
              placeholder="搜索内容、错误或目标"
              size="small"
            />
            <NButton :loading="loadingJobs" size="small" @click="loadJobs">
              <template #icon>
                <RefreshCw :size="14" />
              </template>
              刷新
            </NButton>
            <NButton
              v-if="failedJobCount > 0"
              :loading="retryingAll"
              secondary
              size="small"
              type="warning"
              @click="handleRetryAllFailed"
            >
              <template #icon>
                <RotateCcw :size="14" />
              </template>
              重试全部失败任务
            </NButton>
          </div>
          <NDataTable
            class="clickable-table"
            :columns="jobColumns"
            :data="visibleJobs"
            :loading="loadingJobs"
            :pagination="{ pageSize: 15 }"
            :row-props="
              (row: JobRow) => ({
                onClick: () => {
                  selectedJob = row;
                  jobDrawerOpen = true;
                },
              })
            "
            :scroll-x="960"
            size="small"
          />
        </NTabPane>

        <NTabPane name="deliveries" :tab="`出站投递 (${deliveries.length})`">
          <div class="filter-bar">
            <NSelect
              v-model:value="filterDeliveryStatus"
              class="w-120"
              clearable
              :options="[
                { label: '已送达', value: 'sent' },
                { label: '待投递', value: 'queued' },
                { label: '重试中', value: 'retrying' },
                { label: '失败', value: 'failed' },
              ]"
              placeholder="全部状态"
              size="small"
            />
            <NSelect
              v-model:value="filterDeliveryChatKey"
              class="w-240"
              clearable
              filterable
              :options="chatOptions"
              placeholder="筛选会话（支持群名/群号）"
              size="small"
              tag
            />
            <NButton
              :loading="loadingDeliveries"
              size="small"
              @click="loadDeliveries"
            >
              <template #icon>
                <RefreshCw :size="14" />
              </template>
              刷新
            </NButton>
          </div>
          <NDataTable
            class="clickable-table"
            :columns="deliveryColumns"
            :data="visibleDeliveries"
            :loading="loadingDeliveries"
            :pagination="{ pageSize: 15 }"
            :row-props="
              (row: DeliveryRow) => ({
                onClick: () => {
                  selectedDelivery = row;
                  deliveryDrawerOpen = true;
                },
              })
            "
            :scroll-x="840"
            size="small"
          />
        </NTabPane>
      </NTabs>
    </NCard>

    <NDrawer v-model:show="jobDrawerOpen" class="drawer-safe" :width="520">
      <NDrawerContent v-if="selectedJob" closable title="任务详情">
        <NSpace :size="12" vertical>
          <NAlert v-if="selectedJob.lastError" title="执行失败" type="error">
            {{ selectedJob.lastError }}
          </NAlert>
          <NDescriptions
            bordered
            class="job-meta"
            :column="1"
            label-placement="left"
            size="small"
          >
            <NDescriptionsItem label="任务 ID">
              #{{ selectedJob.id }}
            </NDescriptionsItem>
            <NDescriptionsItem label="类型">
              <NTag size="small" :type="jobMeta(selectedJob).tagType">
                {{ jobMeta(selectedJob).label }}
              </NTag>
            </NDescriptionsItem>
            <NDescriptionsItem label="队列通道">
              {{ jobLaneLabel[jobMeta(selectedJob).lane] }}
            </NDescriptionsItem>
            <NDescriptionsItem label="状态">
              <NTag size="small" :type="jobStateLabel[selectedJob.state].type">
                {{ jobStateLabel[selectedJob.state].text }}
              </NTag>
            </NDescriptionsItem>
            <NDescriptionsItem label="耗时">
              <span class="tabular">{{ jobDuration(selectedJob) }}</span>
            </NDescriptionsItem>
            <NDescriptionsItem label="目标">
              <span class="mono break-all">{{ selectedJob.chatKey }}</span>
            </NDescriptionsItem>
            <NDescriptionsItem label="尝试次数">
              {{ selectedJob.attempts }}
            </NDescriptionsItem>
            <NDescriptionsItem label="去重键">
              <span class="mono break-all">{{ selectedJob.dedupeKey }}</span>
            </NDescriptionsItem>
            <NDescriptionsItem label="创建时间">
              {{ formatTime(selectedJob.createdAt) }}
            </NDescriptionsItem>
            <NDescriptionsItem label="更新时间">
              {{ formatTime(selectedJob.updatedAt) }}
            </NDescriptionsItem>
          </NDescriptions>

          <div v-if="selectedJob.summary">
            <div class="section-title">任务内容</div>
            <pre class="code-block">{{ selectedJob.summary }}</pre>
          </div>

          <div class="section-title">原始载荷（Payload）</div>
          <pre class="code-block">{{
            JSON.stringify(selectedJob.payload, null, 2)
          }}</pre>

          <NSpace :size="8" wrap>
            <NButton
              v-if="selectedJob.state === 'failed'"
              :loading="busyJobId === selectedJob.id"
              secondary
              size="small"
              type="warning"
              @click="handleRetryJob(selectedJob.id)"
            >
              重新执行
            </NButton>
            <NButton
              v-if="selectedJob.state === 'pending'"
              :loading="busyJobId === selectedJob.id"
              quaternary
              size="small"
              type="error"
              @click="handleCancelJob(selectedJob.id)"
            >
              取消任务
            </NButton>
            <NButton
              v-for="link in selectedJob.links ?? []"
              :key="link.to"
              secondary
              size="small"
              @click="
                jobDrawerOpen = false;
                router.push(link.to);
              "
            >
              {{ link.label }}
            </NButton>
          </NSpace>
        </NSpace>
      </NDrawerContent>
    </NDrawer>

    <NDrawer v-model:show="deliveryDrawerOpen" class="drawer-safe" :width="480">
      <NDrawerContent v-if="selectedDelivery" closable title="出站投递详情">
        <NSpace :size="12" vertical>
          <NAlert v-if="selectedDelivery.error" title="投递失败" type="error">
            {{ selectedDelivery.error }}
          </NAlert>
          <NDescriptions
            bordered
            class="job-meta"
            :column="1"
            label-placement="left"
            size="small"
          >
            <NDescriptionsItem label="记录 ID">
              {{ selectedDelivery.id }}
            </NDescriptionsItem>
            <NDescriptionsItem label="会话">
              <span class="mono">{{ selectedDelivery.chatKey }}</span>
            </NDescriptionsItem>
            <NDescriptionsItem label="类型">
              <span class="mono">{{ selectedDelivery.kind }}</span>
            </NDescriptionsItem>
            <NDescriptionsItem label="状态">
              <NTag
                size="small"
                :type="deliveryStatusLabel[selectedDelivery.status].type"
              >
                {{ deliveryStatusLabel[selectedDelivery.status].text }}
              </NTag>
            </NDescriptionsItem>
            <NDescriptionsItem label="尝试次数">
              {{ selectedDelivery.attempts }}
            </NDescriptionsItem>
            <NDescriptionsItem label="消息 ID">
              <span class="mono">
                {{ selectedDelivery.onebotMessageId || "—" }}
              </span>
            </NDescriptionsItem>
            <NDescriptionsItem label="更新时间">
              {{ formatTime(selectedDelivery.updatedAt) }}
            </NDescriptionsItem>
          </NDescriptions>
          <div class="section-title">投递内容</div>
          <pre class="code-block">{{
            JSON.stringify(selectedDelivery.payload, null, 2)
          }}</pre>
        </NSpace>
      </NDrawerContent>
    </NDrawer>
  </div>
</template>

<style scoped>
.job-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 10px;
}

.dot {
  display: inline-block;
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: #15803d;
  margin-right: 5px;
}

.break-all {
  word-break: break-all;
}

.job-meta :deep(.n-descriptions-table-header) {
  white-space: nowrap;
  width: 88px;
}

.log-console {
  max-height: 65vh;
  overflow-y: auto;
  font-family: var(--berry-mono);
  font-size: 12px;
  line-height: 1.6;
  background: var(--berry-inset);
  border: 1px solid var(--berry-border);
  border-radius: 6px;
  padding: 8px 10px;
}

.log-line {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
  padding: 3px 4px;
  border-bottom: 1px dashed var(--berry-border);
}

.log-line:last-child {
  border-bottom: none;
}

.log-time {
  color: var(--berry-muted);
  font-size: 11px;
  flex-shrink: 0;
}

.log-lvl {
  flex-shrink: 0;
}

.log-scope {
  color: var(--berry-muted);
  flex-shrink: 0;
}

.log-msg {
  word-break: break-word;
}

.log-ctx {
  color: var(--berry-muted);
  font-size: 11px;
  word-break: break-all;
}
</style>
