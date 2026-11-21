<script setup lang="ts">
import {
  Copy,
  FlaskConical,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
} from "@lucide/vue";
import type { DataTableColumns } from "naive-ui";
import {
  NAlert,
  NButton,
  NCard,
  NCollapse,
  NCollapseItem,
  NDataTable,
  NDescriptions,
  NDescriptionsItem,
  NDrawer,
  NDrawerContent,
  NInput,
  NPopconfirm,
  NRadioButton,
  NRadioGroup,
  NSelect,
  NSpace,
  NTabPane,
  NTabs,
  NTag,
  NText,
  useMessage,
} from "naive-ui";
import { computed, h, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";

import { apiFetch } from "../api/client.ts";
import ChronoVirtualList from "../components/ChronoVirtualList.vue";
import GateMonitorPane from "../components/GateMonitorPane.vue";
import { useChatOptions } from "../composables/useChatOptions.ts";
import {
  useEventStream,
  useLiveRefresh,
} from "../composables/useEventStream.ts";
import type { LlmCallRow } from "../utils/ai.ts";
import {
  PURPOSE_FILTER_OPTIONS,
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
  messages: {
    role: string;
    content: string | null;
    tool_call_id?: string;
    tool_calls?: {
      id: string;
      function: { name: string; arguments: string };
    }[];
  }[];
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

type AiTab = "calls" | "gate" | "context" | "usage";
type CallScope = "core" | "all" | "error";

function initialTab(): AiTab {
  const q = route.query.tab;

  if (q === "gate" || q === "context" || q === "usage") {
    return q;
  }

  return "calls";
}

const activeTab = ref<AiTab>(initialTab());
const loadingCalls = ref(false);
const loadingMeta = ref(false);
const calls = ref<LlmCallRow[]>([]);
const totalCalls = ref(0);
const gateTotal = ref<number | null>(null);
const gatePaneRef = ref<InstanceType<typeof GateMonitorPane> | null>(null);
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
const callScope = ref<CallScope>(
  route.query.status === "error"
    ? "error"
    : filterPurpose.value === "gate"
      ? "all"
      : "core",
);
const filterChatKey = ref<string | null>(
  typeof route.query.chatKey === "string" && route.query.chatKey
    ? route.query.chatKey
    : null,
);
const filterSearch = ref("");

const selectedCall = ref<LlmCallRow | null>(null);
const detailOpen = ref(false);
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
  const source =
    contextMode.value === "full"
      ? fullTapeEntries.value
      : (conversation.value?.entries ?? []);

  return source.map(formatTapeEntry);
});

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

async function loadCalls() {
  loadingCalls.value = true;

  try {
    const qs = new URLSearchParams({ limit: "100" });

    if (filterPurpose.value) {
      qs.set("purpose", filterPurpose.value);
    } else if (callScope.value === "core") {
      qs.set("excludePurpose", "gate");
    }

    if (callScope.value === "error") {
      qs.set("status", "error");
    }

    if (filterChatKey.value?.trim()) {
      qs.set("chatKey", filterChatKey.value.trim());
    }

    if (filterSearch.value.trim()) {
      qs.set("search", filterSearch.value.trim());
    }

    const res = await apiFetch<{ items: LlmCallRow[]; total: number }>(
      `/api/admin/llm-calls?${qs.toString()}`,
    );

    calls.value = res.items;
    totalCalls.value = res.total;
  } catch (err) {
    message.error(err instanceof Error ? err.message : "加载 AI 调用记录失败");
  } finally {
    loadingCalls.value = false;
  }
}

async function loadFullTape() {
  loadingTape.value = true;

  try {
    const res = await apiFetch<{ entries: TapeEntryView[] }>(
      "/api/admin/tape?tapeId=global&limit=200",
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
      `/api/admin/tape?tapeId=${encodeURIComponent(`sidecar:${sidecarId}`)}&limit=100`,
    );

    sidecarEntries.value = res.entries;
  } catch (err) {
    message.error(
      err instanceof Error ? err.message : "加载子代理 Sidecar 失败",
    );
  } finally {
    loadingSidecar.value = false;
  }
}

async function loadMeta() {
  loadingMeta.value = true;

  try {
    const [ov, conv] = await Promise.all([
      apiFetch<{ usageBuckets: UsageBucket[] }>("/api/admin/overview"),
      apiFetch<ConversationView>("/api/admin/conversation"),
    ]);

    usageBuckets.value = ov.usageBuckets;
    conversation.value = conv;

    if (contextMode.value === "full") {
      await loadFullTape();
    }
  } catch (err) {
    message.error(err instanceof Error ? err.message : "加载上下文失败");
  } finally {
    loadingMeta.value = false;
  }
}

async function refreshAll() {
  await Promise.all([
    loadCalls(),
    loadMeta(),
    gatePaneRef.value?.loadDecisions(),
  ]);
}

function inspectChatCalls(chatKey: string) {
  filterChatKey.value = chatKey;
  activeTab.value = "calls";
}

function openDetail(row: LlmCallRow) {
  selectedCall.value = row;
  detailOpen.value = true;
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    message.success("已复制到剪贴板");
  } catch {
    message.error("复制失败");
  }
}

async function handleResetConversation() {
  resettingContext.value = true;

  try {
    conversation.value = await apiFetch<ConversationView>(
      "/api/admin/conversation/reset",
      { method: "POST" },
    );
    if (contextMode.value === "full") {
      await loadFullTape();
    }

    message.success("已追加重置检查点，历史轨迹仍保留在完整 Tape 中");
  } catch (err) {
    message.error(err instanceof Error ? err.message : "重置全局上下文失败");
  } finally {
    resettingContext.value = false;
  }
}

const { paused: streamPaused, togglePause } = useEventStream(() => undefined);

useLiveRefresh({
  events: ["llm_call"],
  debounceMs: 250,
  paused: streamPaused,
  refresh: () => loadCalls(),
});

useLiveRefresh({
  events: ["conversation_update", "llm_call"],
  debounceMs: 350,
  paused: streamPaused,
  enabled: () => activeTab.value === "context" || activeTab.value === "usage",
  refresh: () => loadMeta(),
});

let filterTimer: ReturnType<typeof setTimeout> | null = null;

watch(filterPurpose, (purpose) => {
  if (purpose === "gate" && callScope.value === "core") {
    callScope.value = "all";
  }
});

watch([callScope, filterPurpose, filterChatKey], () => {
  void loadCalls();
});

watch(filterSearch, () => {
  if (filterTimer) {
    clearTimeout(filterTimer);
  }

  filterTimer = setTimeout(() => {
    void loadCalls();
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
      q.tab === "context" ||
      q.tab === "usage"
    ) {
      activeTab.value = q.tab;
    }

    if (typeof q.chatKey === "string" && q.chatKey !== filterChatKey.value) {
      filterChatKey.value = q.chatKey || null;
    }

    if (typeof q.purpose === "string" && q.purpose !== filterPurpose.value) {
      filterPurpose.value = q.purpose || null;
    }
  },
);

const callColumns: DataTableColumns<LlmCallRow> = [
  {
    title: "时间",
    key: "createdAt",
    width: 124,
    render: (row) => h("span", { class: "tabular" }, formatTime(row.createdAt)),
  },
  {
    title: "用途",
    key: "purpose",
    width: 128,
    render: (row) => {
      const meta = purposeMeta(row.purpose);

      return h(
        NTag,
        { size: "small", type: meta.type },
        { default: () => meta.label },
      );
    },
  },
  {
    title: "状态",
    key: "status",
    width: 62,
    render: (row) =>
      h(
        NTag,
        {
          size: "small",
          type: row.status === "error" ? "error" : "success",
        },
        { default: () => (row.status === "error" ? "失败" : "成功") },
      ),
  },
  {
    title: "模型",
    key: "model",
    width: 176,
    ellipsis: { tooltip: true },
    render: (row) => h("span", { class: "mono" }, row.model),
  },
  {
    title: "工具调用 / 输出摘要",
    key: "summary",
    minWidth: 190,
    render: (row) => {
      if (row.error) {
        return h(
          NText,
          { type: "error", class: "sub-note" },
          { default: () => row.error },
        );
      }

      if (row.toolCalls.length > 0) {
        return h(
          NSpace,
          { size: 4, wrap: true },
          {
            default: () =>
              row.toolCalls.map((call, index) =>
                h(
                  NTag,
                  { key: `${call.name}-${index}`, size: "tiny", type: "info" },
                  { default: () => call.name },
                ),
              ),
          },
        );
      }

      const text = (row.responseText ?? "").replaceAll(/\s+/g, " ").trim();

      return h(
        "span",
        {
          style:
            "display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:280px;",
        },
        text || "—",
      );
    },
  },
  {
    title: "会话",
    key: "chatKey",
    width: 176,
    ellipsis: { tooltip: true },
    render: (row) => h("span", { class: "mono" }, row.chatKey || "全局"),
  },
  {
    title: "Tokens",
    key: "tokens",
    width: 204,
    align: "right",
    render: (row) => {
      const label = h(
        "span",
        { class: "tabular sub-note", style: "white-space: nowrap;" },
        `${row.inputTokens.toLocaleString()} / ${row.outputTokens.toLocaleString()}`,
      );

      if (!row.cacheWarning) {
        return label;
      }

      const tagLabel = row.cacheWarning.startsWith("前缀未变")
        ? "缓存偏低"
        : "前缀失效";

      return h(
        NSpace,
        { align: "center", justify: "end", size: 6, wrap: false },
        {
          default: () => [
            label,
            h(
              NTag,
              {
                size: "tiny",
                type: "warning",
                title: row.cacheWarning,
                style: "flex-shrink: 0;",
              },
              { default: () => tagLabel },
            ),
          ],
        },
      );
    },
  },
  {
    title: "耗时",
    key: "durationMs",
    width: 96,
    align: "right",
    render: (row) => h("span", { class: "tabular" }, `${row.durationMs} ms`),
  },
];

const usageColumns: DataTableColumns<UsageBucket> = [
  { title: "日期", key: "day", width: 96 },
  {
    title: "用途",
    key: "purpose",
    width: 138,
    render: (row) => {
      const meta = purposeMeta(row.purpose);

      return h(
        NTag,
        { size: "small", type: meta.type },
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
    title: "平均耗时",
    key: "avgDurationMs",
    width: 86,
    align: "right",
    render: (row) => h("span", { class: "tabular" }, `${row.avgDurationMs} ms`),
  },
];

function roleTagType(role: string): "default" | "info" | "success" | "warning" {
  if (role === "assistant") {
    return "success";
  }

  if (role === "tool") {
    return "warning";
  }

  if (role === "user") {
    return "info";
  }

  return "default";
}

onMounted(() => {
  void refreshAll();
});
</script>

<template>
  <div>
    <div class="page-bar">
      <NSpace align="center" :size="10">
        <h1 class="page-title">AI 追踪</h1>
        <NText v-if="activeTab === 'calls'" class="sub-note" depth="3">
          共 {{ totalCalls }} 条调用
        </NText>
        <NText
          v-else-if="activeTab === 'gate' && gateTotal !== null"
          class="sub-note"
          depth="3"
        >
          共 {{ gateTotal }} 条分流
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
          :loading="loadingCalls || loadingMeta"
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

    <NCard size="small">
      <NTabs v-model:value="activeTab" type="line">
        <NTabPane name="calls" tab="调用明细">
          <div class="filter-bar">
            <NRadioGroup v-model:value="callScope" size="small">
              <NRadioButton value="core">核心调用</NRadioButton>
              <NRadioButton value="all">全部</NRadioButton>
              <NRadioButton value="error">仅失败</NRadioButton>
            </NRadioGroup>
            <NSelect
              v-model:value="filterPurpose"
              class="w-175"
              clearable
              :options="PURPOSE_FILTER_OPTIONS"
              placeholder="全部用途"
              size="small"
            />
            <NSelect
              v-model:value="filterChatKey"
              class="w-240"
              clearable
              filterable
              :options="chatOptions"
              placeholder="选择或输入会话（支持名称/群号）"
              size="small"
              tag
            />
            <NInput
              v-model:value="filterSearch"
              class="w-220"
              clearable
              placeholder="搜索工具名、模型、输入或输出"
              size="small"
            />
          </div>

          <NDataTable
            class="clickable-table"
            :columns="callColumns"
            :data="calls"
            :loading="loadingCalls"
            :pagination="{ pageSize: 20 }"
            :row-props="
              (row: LlmCallRow) => ({
                onClick: () => openDetail(row),
              })
            "
            :scroll-x="1160"
            size="small"
          />
        </NTabPane>

        <NTabPane name="gate" tab="消息分流">
          <GateMonitorPane
            ref="gatePaneRef"
            :chat-key="filterChatKey"
            :paused="streamPaused"
            @inspect-chat-calls="inspectChatCalls"
            @update:total="(n: number) => (gateTotal = n)"
          />
        </NTabPane>

        <NTabPane name="context" tab="全局上下文">
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

            <NCard
              v-if="conversation.handoff"
              size="small"
              :title="`结构化交接摘要（Anchor #${conversation.anchorEntryId ?? '-'}）`"
            >
              <NSpace :size="8" vertical>
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
                <NText
                  v-if="conversation.handoff.sourceEntryIds.length > 0"
                  class="mono sub-note"
                  depth="3"
                >
                  溯源条目：#{{ conversation.handoff.sourceEntryIds[0] }} ~ #{{
                    conversation.handoff.sourceEntryIds[
                      conversation.handoff.sourceEntryIds.length - 1
                    ]
                  }}（共 {{ conversation.handoff.sourceEntryIds.length }} 条）
                </NText>
              </NSpace>
            </NCard>

            <NCard
              v-if="conversation.pendingResults.length > 0"
              size="small"
              title="待消费投递回执"
            >
              <pre class="code-block pending-results-block">{{
                JSON.stringify(conversation.pendingResults, null, 2)
              }}</pre>
            </NCard>

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
                </div>
                <NRadioGroup
                  size="small"
                  :value="contextMode"
                  @update:value="
                    (v: 'active' | 'full') => {
                      contextMode = v;
                      if (v === 'full') void loadFullTape();
                    }
                  "
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
                        <span v-if="item.toolCallId" class="mono turn-time">
                          {{ item.toolCallId }}
                        </span>
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
        </NTabPane>

        <NTabPane name="usage" tab="用量统计">
          <div class="filter-bar">
            <NText class="tabular sub-note" depth="2">
              近 30 日累计：调用
              {{ usageTotals30d.calls.toLocaleString() }} 次，合计
              {{ usageTotals30d.totalTokens.toLocaleString() }} Tokens（ 输入
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
            :scroll-x="820"
            size="small"
          />
        </NTabPane>
      </NTabs>
    </NCard>

    <NDrawer v-model:show="detailOpen" class="drawer-safe" :width="580">
      <NDrawerContent v-if="selectedCall" closable title="AI 调用详情">
        <NSpace :size="12" vertical>
          <NAlert v-if="selectedCall.error" title="调用失败" type="error">
            {{ selectedCall.error }}
          </NAlert>
          <NAlert
            v-if="selectedCall.cacheWarning"
            title="缓存前缀告警"
            type="warning"
          >
            {{ selectedCall.cacheWarning }}
          </NAlert>

          <NDescriptions
            bordered
            :column="2"
            label-placement="left"
            size="small"
          >
            <NDescriptionsItem label="时间">
              <span class="tabular">
                {{ formatTime(selectedCall.createdAt) }}
              </span>
            </NDescriptionsItem>
            <NDescriptionsItem label="用途">
              <NTag size="small" :type="purposeMeta(selectedCall.purpose).type">
                {{ purposeMeta(selectedCall.purpose).label }}
              </NTag>
            </NDescriptionsItem>
            <NDescriptionsItem label="模型">
              <span class="mono">{{ selectedCall.model }}</span>
            </NDescriptionsItem>
            <NDescriptionsItem label="耗时">
              <span class="tabular">{{ selectedCall.durationMs }} ms</span>
            </NDescriptionsItem>
            <NDescriptionsItem label="会话">
              <span class="mono">{{ selectedCall.chatKey || "全局" }}</span>
            </NDescriptionsItem>
            <NDescriptionsItem label="Tokens">
              <span class="tabular">
                入 {{ selectedCall.inputTokens.toLocaleString() }}（缓
                {{
                  formatPercent(
                    selectedCall.cachedInputTokens,
                    selectedCall.inputTokens,
                  )
                }}） / 出 {{ selectedCall.outputTokens.toLocaleString() }}
              </span>
            </NDescriptionsItem>
          </NDescriptions>

          <div v-if="selectedCall.toolCalls.length > 0">
            <div class="section-title">
              发起的工具调用（{{ selectedCall.toolCalls.length }}）
            </div>
            <NSpace :size="8" vertical>
              <div
                v-for="(call, idx) in selectedCall.toolCalls"
                :key="`${call.name}-${idx}`"
                class="turn-box"
              >
                <div class="turn-head">
                  <NTag size="small" type="info">{{ call.name }}</NTag>
                </div>
                <pre class="code-block mt-xs">{{
                  prettyMaybeJson(call.arguments)
                }}</pre>
              </div>
            </NSpace>
          </div>

          <div v-if="selectedCall.responseText">
            <div class="filter-bar space-between mt-md">
              <span class="section-title-inline">模型输出</span>
              <NButton
                quaternary
                size="tiny"
                @click="copyText(selectedCall.responseText)"
              >
                <template #icon>
                  <Copy :size="12" />
                </template>
                复制
              </NButton>
            </div>
            <pre class="code-block mt-xs">{{
              prettyMaybeJson(selectedCall.responseText)
            }}</pre>
          </div>

          <NCollapse
            v-if="selectedCall.requestPreview"
            default-expanded-names="req"
          >
            <NCollapseItem name="req" title="请求上下文预览">
              <pre class="code-block">{{ selectedCall.requestPreview }}</pre>
            </NCollapseItem>
          </NCollapse>

          <NText
            v-if="
              !selectedCall.requestPreview &&
              !selectedCall.responseText &&
              selectedCall.toolCalls.length === 0 &&
              !selectedCall.error
            "
            depth="3"
          >
            该记录产生于追踪升级之前，仅包含用量统计。
          </NText>
        </NSpace>
      </NDrawerContent>
    </NDrawer>

    <NDrawer v-model:show="sidecarDrawerOpen" class="drawer-safe" :width="620">
      <NDrawerContent
        closable
        :title="`子代理 Sidecar Tape (${sidecarIdActive ?? ''})`"
      >
        <NSpace :size="10" vertical>
          <NText v-if="loadingSidecar" depth="3">正在加载 Sidecar 轨迹…</NText>
          <NText v-else-if="sidecarItems.length === 0" depth="3">
            暂无轨迹记录。
          </NText>
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
        </NSpace>
      </NDrawerContent>
    </NDrawer>
  </div>
</template>
