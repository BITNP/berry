<script setup lang="ts">
import { RefreshCw, RotateCcw } from "@lucide/vue";
import type { DataTableColumns } from "naive-ui";
import {
  NAlert,
  NButton,
  NCollapse,
  NCollapseItem,
  NDataTable,
  NDescriptions,
  NDescriptionsItem,
  NDrawer,
  NDrawerContent,
  NInput,
  NRadioButton,
  NRadioGroup,
  NSelect,
  NSpace,
  NSpin,
  NTag,
  NText,
  useMessage,
} from "naive-ui";
import { computed, h, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";

import { apiFetch } from "../api/client.ts";
import { useChatOptions } from "../composables/useChatOptions.ts";
import { useLiveClock, useLiveRefresh } from "../composables/useEventStream.ts";
import type { AiTraceView, LlmCallRow } from "../utils/ai.ts";
import { formatTime } from "../utils/format.ts";
import type { JobLane, JobTagType } from "../utils/jobs.ts";
import { jobActionLinks, jobTagType } from "../utils/jobs.ts";
import type { JobLaneFilter } from "../utils/routes.ts";
import InlineAiCallsList from "./InlineAiCallsList.vue";
import TraceInspector from "./TraceInspector.vue";

export interface JobCounts {
  pending: number;
  running: number;
  failed: number;
  backgroundActive: number;
}

interface JobTypeDescriptor {
  kind: string;
  label: string;
  lane: JobLane;
}

interface JobRow {
  id: number;
  kind: string;
  label: string;
  lane: JobLane;
  dedupeKey: string;
  chatKey: string;
  payload: Record<string, unknown>;
  summary: string;
  state: "pending" | "running" | "done" | "failed";
  attempts: number;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

const emit = defineEmits<{
  "update:summary": [payload: { total: number; counts: JobCounts }];
}>();

const props = defineProps<{
  paused?: boolean;
}>();

const route = useRoute();
const router = useRouter();
const message = useMessage();
const { chatOptions, chatTitle } = useChatOptions();

function initialLane(): JobLaneFilter {
  const q = route.query.lane;

  if (q === "background" || q === "realtime") {
    return q;
  }

  return "all";
}

const loadingJobs = ref(false);
const jobs = ref<JobRow[]>([]);
const jobKinds = ref<JobTypeDescriptor[]>([]);
const jobCounts = ref<JobCounts>({
  pending: 0,
  running: 0,
  failed: 0,
  backgroundActive: 0,
});
const filterJobLane = ref<JobLaneFilter>(initialLane());
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
const filterJobChatKey = ref<string | null>(
  typeof route.query.chatKey === "string" && route.query.chatKey
    ? route.query.chatKey
    : null,
);
const filterJobSearch = ref("");
const retryingAll = ref(false);
const busyJobId = ref<number | null>(null);

const selectedJob = ref<JobRow | null>(null);
const jobDrawerOpen = ref(false);
const jobTraceLoading = ref(false);
const jobMessageTrace = ref<AiTraceView | null>(null);
const jobRelatedCalls = ref<LlmCallRow[]>([]);

const pausedRef = computed(() => Boolean(props.paused));

const nowTick = useLiveClock(
  () =>
    jobs.value.some((j) => j.state === "running") ||
    (jobDrawerOpen.value && selectedJob.value?.state === "running"),
);

const jobMeta = (
  row: Pick<JobRow, "kind" | "label" | "lane">,
): { label: string; lane: JobLane; tagType: JobTagType } => ({
  label: row.label,
  lane: row.lane,
  tagType: jobTagType(row.kind, row.lane),
});

const selectedJobLinks = computed(() =>
  selectedJob.value ? jobActionLinks(selectedJob.value) : [],
);

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
      base.push({ label: chatTitle(job.chatKey), value: job.chatKey });
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
      chatTitle(j.chatKey).toLowerCase().includes(kw) ||
      meta.label.toLowerCase().includes(kw) ||
      j.kind.toLowerCase().includes(kw) ||
      j.summary.toLowerCase().includes(kw) ||
      (j.lastError ?? "").toLowerCase().includes(kw)
    );
  });
});

function primaryMessageIdForJob(job: JobRow): number | null {
  const p = job.payload;

  if (Array.isArray(p.triggerMessageIds)) {
    const first = p.triggerMessageIds.find((id) => typeof id === "number");

    if (typeof first === "number") {
      return first;
    }
  }

  if (Array.isArray(p.messageIds)) {
    const first = p.messageIds.find((id) => typeof id === "number");

    if (typeof first === "number") {
      return first;
    }
  }

  if (typeof p.messageId === "number") {
    return p.messageId;
  }

  if (typeof p.triggerMessageId === "number") {
    return p.triggerMessageId;
  }

  return null;
}

function matchesJobPurpose(job: JobRow, purpose: string): boolean {
  switch (job.kind) {
    case "gate_batch": {
      return purpose === "gate";
    }

    case "invoke": {
      return purpose !== "gate";
    }

    case "memory_update": {
      return purpose === "memory_update";
    }

    case "group_digest": {
      return purpose.startsWith("subagent");
    }

    case "guild_task": {
      return job.payload.task === "weekly" ? purpose === "report" : true;
    }

    default: {
      return true;
    }
  }
}

async function loadJobTrace(job: JobRow, options: { silent?: boolean } = {}) {
  const targetJobId = job.id;

  if (!options.silent) {
    jobTraceLoading.value = true;
    jobMessageTrace.value = null;
    jobRelatedCalls.value = [];
  }

  try {
    const msgId = primaryMessageIdForJob(job);

    if (msgId !== null) {
      const trace = await apiFetch<AiTraceView>(
        `/api/admin/messages/${msgId}/trace`,
      );

      if (selectedJob.value?.id !== targetJobId) {
        return;
      }

      jobMessageTrace.value = trace;

      return;
    }

    const startMs = job.createdAt - 1000;
    const endMs = (job.state === "running" ? Date.now() : job.updatedAt) + 2000;
    const isChatTarget =
      job.chatKey.startsWith("group:") || job.chatKey.startsWith("private:");
    const qs = new URLSearchParams({ limit: "25" });

    if (isChatTarget) {
      qs.set("chatKey", job.chatKey);
    } else if (job.kind === "guild_task" && job.payload.task === "weekly") {
      qs.set("purpose", "report");
    } else {
      return;
    }

    const res = await apiFetch<{ items: LlmCallRow[] }>(
      `/api/admin/llm-calls?${qs.toString()}`,
    );

    if (selectedJob.value?.id !== targetJobId) {
      return;
    }

    jobRelatedCalls.value = res.items
      .filter(
        (c) =>
          c.createdAt >= startMs &&
          c.createdAt <= endMs &&
          matchesJobPurpose(job, c.purpose),
      )
      .reverse();
  } catch {
    // Non-critical detail trace.
  } finally {
    if (!options.silent && selectedJob.value?.id === targetJobId) {
      jobTraceLoading.value = false;
    }
  }
}

function openJobDetail(row: JobRow) {
  selectedJob.value = row;
  jobDrawerOpen.value = true;
  void loadJobTrace(row);
}

function toggleJobStateFilter(state: JobRow["state"]) {
  filterJobState.value = filterJobState.value === state ? null : state;
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
      kinds: JobTypeDescriptor[];
      counts: JobCounts;
    }>(`/api/admin/jobs?${qs.toString()}`);

    jobs.value = res.items;
    jobKinds.value = res.kinds;
    jobCounts.value = res.counts;
    emit("update:summary", { total: res.items.length, counts: res.counts });

    if (selectedJob.value) {
      const updated = res.items.find((i) => i.id === selectedJob.value?.id);

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

const jobLaneLabel: Record<JobLane, string> = {
  background: "后台任务",
  dialog: "主对话",
  gate: "门控分流",
};

const jobStateLabel: Record<
  JobRow["state"],
  { text: string; type: "default" | "info" | "success" | "error" }
> = {
  pending: { text: "排队中", type: "info" },
  running: { text: "执行中", type: "info" },
  done: { text: "已完成", type: "success" },
  failed: { text: "失败", type: "error" },
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
    width: 180,
    ellipsis: { tooltip: true },
    render: (row) => h("span", null, chatTitle(row.chatKey)),
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

useLiveRefresh({
  events: ["job_update"],
  debounceMs: 250,
  paused: pausedRef,
  refresh: () => loadJobs(),
});

watch([filterJobLane, filterJobKind, filterJobState, filterJobChatKey], () => {
  if (
    filterJobKind.value &&
    !jobKindOptions.value.some((o) => o.value === filterJobKind.value)
  ) {
    filterJobKind.value = null;
  }

  void loadJobs();
});

watch(
  () => route.query.lane,
  (lane) => {
    if (lane === "background" || lane === "realtime") {
      filterJobLane.value = lane;
    } else if (route.query.tab === "jobs" && !lane) {
      filterJobLane.value = "all";
    }
  },
);

onMounted(() => {
  void loadJobs();
});

defineExpose({ refresh: loadJobs });
</script>

<template>
  <div>
    <div class="job-toolbar">
      <NRadioGroup v-model:value="filterJobLane" size="small">
        <NRadioButton value="all">全部</NRadioButton>
        <NRadioButton value="background">
          后台任务
          <template v-if="jobCounts.backgroundActive > 0">
            ({{ jobCounts.backgroundActive }})
          </template>
        </NRadioButton>
        <NRadioButton value="realtime">实时调度</NRadioButton>
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
        v-if="jobCounts.failed > 0"
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
          onClick: () => openJobDetail(row),
        })
      "
      :scroll-x="960"
      size="small"
    />

    <NDrawer v-model:show="jobDrawerOpen" class="drawer-safe" :width="720">
      <NDrawerContent
        v-if="selectedJob"
        closable
        :title="`任务详情 #${selectedJob.id} · ${jobMeta(selectedJob).label}`"
      >
        <NSpace :size="14" vertical>
          <NAlert v-if="selectedJob.lastError" title="执行失败" type="error">
            {{ selectedJob.lastError }}
          </NAlert>

          <NDescriptions
            bordered
            :column="2"
            label-placement="left"
            size="small"
          >
            <NDescriptionsItem label="状态">
              <NTag size="small" :type="jobStateLabel[selectedJob.state].type">
                {{ jobStateLabel[selectedJob.state].text }}
              </NTag>
            </NDescriptionsItem>
            <NDescriptionsItem label="通道">
              {{ jobLaneLabel[jobMeta(selectedJob).lane] }}
            </NDescriptionsItem>
            <NDescriptionsItem label="目标">
              {{ chatTitle(selectedJob.chatKey) }}
            </NDescriptionsItem>
            <NDescriptionsItem label="耗时 / 尝试">
              <span class="tabular">
                {{ jobDuration(selectedJob) }} · {{ selectedJob.attempts }} 次
              </span>
            </NDescriptionsItem>
          </NDescriptions>

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
              v-for="link in selectedJobLinks"
              :key="link.label"
              quaternary
              size="small"
              @click="
                jobDrawerOpen = false;
                router.push(link.to);
              "
            >
              {{ link.label }}
            </NButton>
          </NSpace>

          <div v-if="jobTraceLoading" class="trace-loading">
            <NSpin size="small" />
          </div>
          <TraceInspector
            v-else-if="jobMessageTrace"
            :trace="jobMessageTrace"
          />
          <div v-else-if="jobRelatedCalls.length > 0">
            <div class="section-title">
              关联 AI 调用（{{ jobRelatedCalls.length }}）
            </div>
            <InlineAiCallsList :calls="jobRelatedCalls" :loading="false" />
          </div>

          <NCollapse class="drawer-collapse">
            <NCollapseItem name="payload" title="原始任务载荷（Payload）">
              <div class="sub-note mono break-all mb-sm">
                dedupeKey: {{ selectedJob.dedupeKey }} / created:
                {{ formatTime(selectedJob.createdAt) }}
              </div>
              <pre class="code-block">{{
                JSON.stringify(selectedJob.payload, null, 2)
              }}</pre>
            </NCollapseItem>
          </NCollapse>
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
  width: 6px;
  height: 6px;
  border-radius: 999px;
  margin-right: 5px;
}

.dot.ok {
  background: #18a058;
}

.trace-loading {
  display: flex;
  justify-content: center;
  padding: 24px 0;
}
</style>
