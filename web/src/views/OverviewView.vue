<script setup lang="ts">
import { RefreshCw, RotateCcw, Trash2 } from "@lucide/vue";
import type { DataTableColumns } from "naive-ui";
import {
  NAlert,
  NButton,
  NCard,
  NDataTable,
  NDescriptions,
  NDescriptionsItem,
  NEmpty,
  NInputNumber,
  NPopconfirm,
  NSpace,
  NTabPane,
  NTabs,
  NTag,
  NText,
  useMessage,
} from "naive-ui";
import { computed, h, onMounted, ref } from "vue";
import { useRoute } from "vue-router";

import { apiFetch } from "../api/client.ts";
import { useEventStream } from "../composables/useEventStream.ts";
import { formatBytes, formatPercent, formatTime } from "../utils/format.ts";

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

interface McpStatus {
  name: string;
  transport: string;
  connected: boolean;
  toolCount: number;
  error?: string;
}

interface StorageSummary {
  dbBytes: number;
  assetsFiles: number;
  assetsBytes: number;
  avatarsFiles: number;
  avatarsBytes: number;
  tables: {
    messages: number;
    gateDecisions: number;
    conversations: number;
    memories: number;
    messageAssets: number;
    jobs: number;
    deliveries: number;
    schedules: number;
    guildAuditLogs: number;
    llmUsage: number;
  };
}

interface OverviewResponse {
  workerRunning: boolean;
  botPaused: boolean;
  botQQ: string;
  botAccount: { user_id: string; nickname: string } | null;
  gatewayHealth: { configured: boolean; reachable: boolean; error?: string };
  gatewayStreamConnected: boolean;
  pendingJobs: number;
  gate24h: { reply: number; memory: number; ignore: number };
  chatCount: number;
  activeChatCount: number;
  todayUsage: {
    calls: number;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  guildApiConfigured: boolean;
  guildStreamConnected: boolean;
  keycloakConfigured: boolean;
  mcpServers: McpStatus[];
  storage: StorageSummary;
  usageBuckets: UsageBucket[];
}

interface JobRow {
  id: number;
  kind: string;
  dedupeKey: string;
  chatKey: string;
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

interface PurgeResult {
  olderThanDays: number;
  deletedMessages: number;
  deletedDecisions: number;
  deletedJobs: number;
  deletedDeliveries: number;
  deletedAssetRows: number;
  freedBytes: number;
}

interface ConversationView {
  chatKey: string;
  sessionId: string;
  summary: string;
  afterMessageId: number;
  updatedAt: number;
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
const message = useMessage();

const loading = ref(false);
const activeTab = ref(route.query.tab === "context" ? "context" : "usage");
const overview = ref<OverviewResponse | null>(null);
const jobs = ref<JobRow[]>([]);
const deliveries = ref<DeliveryRow[]>([]);
const conversation = ref<ConversationView | null>(null);
const resettingContext = ref(false);
const retryingAll = ref(false);
const busyJobId = ref<number | null>(null);
const purging = ref(false);
const purgeDays = ref(30);
const lastPurge = ref<PurgeResult | null>(null);

const gateTotal24h = computed(() => {
  if (!overview.value) {
    return 0;
  }

  const g = overview.value.gate24h;

  return g.reply + g.memory + g.ignore;
});

const connectedMcpCount = computed(
  () => overview.value?.mcpServers.filter((s) => s.connected).length ?? 0,
);

const usageTotals30d = computed(() => {
  const buckets = overview.value?.usageBuckets ?? [];
  let calls = 0;
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;

  for (const row of buckets) {
    calls += row.calls;
    inputTokens += row.inputTokens;
    cachedInputTokens += row.cachedInputTokens;
    outputTokens += row.outputTokens;
  }

  return {
    calls,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
});

async function loadAll() {
  loading.value = true;

  try {
    const [ov, jobRes, delRes, convRes] = await Promise.all([
      apiFetch<OverviewResponse>("/api/admin/overview"),
      apiFetch<{ items: JobRow[] }>("/api/admin/jobs"),
      apiFetch<{ items: DeliveryRow[] }>("/api/admin/deliveries"),
      apiFetch<ConversationView>("/api/admin/conversation"),
    ]);

    overview.value = ov;
    jobs.value = jobRes.items;
    deliveries.value = delRes.items;
    conversation.value = convRes;
  } catch (err) {
    message.error(err instanceof Error ? err.message : "加载概览数据失败");
  } finally {
    loading.value = false;
  }
}

async function handleResetConversation() {
  resettingContext.value = true;

  try {
    conversation.value = await apiFetch<ConversationView>(
      "/api/admin/conversation/reset",
      { method: "POST" },
    );
    message.success("全局上下文已重置");
    await loadAll();
  } catch (err) {
    message.error(err instanceof Error ? err.message : "重置全局上下文失败");
  } finally {
    resettingContext.value = false;
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
    await loadAll();
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
    await loadAll();
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
    await loadAll();
  } catch (err) {
    message.error(err instanceof Error ? err.message : "取消失败");
  } finally {
    busyJobId.value = null;
  }
}

async function handlePurgeStorage() {
  purging.value = true;

  try {
    const res = await apiFetch<PurgeResult>("/api/admin/storage/purge", {
      method: "POST",
      body: JSON.stringify({ olderThanDays: purgeDays.value }),
    });

    lastPurge.value = res;
    message.success(
      `清理完成：删除 ${res.deletedMessages} 条消息、释放 ${formatBytes(res.freedBytes)}`,
    );
    await loadAll();
  } catch (err) {
    message.error(err instanceof Error ? err.message : "存储清理失败");
  } finally {
    purging.value = false;
  }
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

const PURPOSE_LABELS: Record<string, string> = {
  dialog: "主对话",
  subagent: "子代理",
  gate: "门控分流",
  memory_update: "记忆提炼",
  compaction: "摘要压缩",
  vision: "图像识别",
  audio: "语音转写",
  report: "公会周报",
};

const usageColumns: DataTableColumns<UsageBucket> = [
  { title: "日期", key: "day", width: 96 },
  {
    title: "用途",
    key: "purpose",
    width: 96,
    render: (row) =>
      h(
        NTag,
        { size: "small" },
        { default: () => PURPOSE_LABELS[row.purpose] ?? row.purpose },
      ),
  },
  {
    title: "模型",
    key: "model",
    minWidth: 120,
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
    title: "输入 Tokens",
    key: "inputTokens",
    width: 96,
    align: "right",
    render: (row) =>
      h("span", { class: "tabular" }, row.inputTokens.toLocaleString()),
  },
  {
    title: "缓存命中",
    key: "cachedInputTokens",
    width: 90,
    align: "right",
    render: (row) =>
      h("span", { class: "tabular" }, row.cachedInputTokens.toLocaleString()),
  },
  {
    title: "输出 Tokens",
    key: "outputTokens",
    width: 96,
    align: "right",
    render: (row) =>
      h("span", { class: "tabular" }, row.outputTokens.toLocaleString()),
  },
  {
    title: "合计 Tokens",
    key: "totalTokens",
    width: 100,
    align: "right",
    render: (row) =>
      h(
        "span",
        { class: "tabular" },
        (row.inputTokens + row.outputTokens).toLocaleString(),
      ),
  },
  {
    title: "平均耗时",
    key: "avgDurationMs",
    width: 84,
    align: "right",
    render: (row) => h("span", { class: "tabular" }, `${row.avgDurationMs} ms`),
  },
];

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
  { title: "ID", key: "id", width: 54 },
  {
    title: "类型",
    key: "kind",
    width: 112,
    render: (row) => h("span", { class: "mono" }, row.kind),
  },
  {
    title: "会话",
    key: "chatKey",
    width: 136,
    ellipsis: { tooltip: true },
    render: (row) => h("span", { class: "mono" }, row.chatKey),
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
  { title: "重试", key: "attempts", width: 56, align: "right" },
  {
    title: "错误信息",
    key: "lastError",
    minWidth: 130,
    ellipsis: { tooltip: true },
    render: (row) => row.lastError || "—",
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
    width: 76,
    render: (row) => {
      if (row.state === "failed") {
        return h(
          NButton,
          {
            size: "tiny",
            secondary: true,
            loading: busyJobId.value === row.id,
            onClick: () => {
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
            onClick: () => {
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
  { title: "ID", key: "id", width: 68 },
  {
    title: "会话",
    key: "chatKey",
    width: 150,
    render: (row) => h("span", { class: "mono" }, row.chatKey),
  },
  {
    title: "类型",
    key: "kind",
    width: 112,
    render: (row) => h("span", { class: "mono" }, row.kind),
  },
  {
    title: "状态",
    key: "status",
    width: 88,
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
    width: 155,
    render: (row) => h("span", { class: "tabular" }, formatTime(row.updatedAt)),
  },
];

useEventStream((type) => {
  if (
    type === "job_update" ||
    type === "delivery_update" ||
    type === "gate_decision"
  ) {
    void loadAll();
  }
});

onMounted(() => {
  void loadAll();
});
</script>

<template>
  <div>
    <div class="page-bar">
      <h1 class="page-title">运行概览</h1>
      <NButton :loading size="small" @click="loadAll">
        <template #icon>
          <RefreshCw :size="14" />
        </template>
        刷新
      </NButton>
    </div>

    <div v-if="overview" class="metric-strip">
      <div class="metric-cell">
        <span class="metric-label">调度器 / 应答</span>
        <span class="metric-value">
          {{ overview.workerRunning ? "运行中" : "已停止" }} /
          {{ overview.botPaused ? "已暂停" : "自动" }}
        </span>
      </div>
      <div class="metric-cell">
        <span class="metric-label">今日模型调用</span>
        <span class="metric-value">
          {{ overview.todayUsage.calls }}
        </span>
      </div>
      <div class="metric-cell">
        <span class="metric-label">今日 Token 消耗</span>
        <span class="metric-value">
          {{ overview.todayUsage.totalTokens.toLocaleString() }}
        </span>
        <span class="metric-sub">
          入 {{ overview.todayUsage.inputTokens.toLocaleString() }}（缓存
          {{
            formatPercent(
              overview.todayUsage.cachedInputTokens,
              overview.todayUsage.inputTokens,
            )
          }}）· 出 {{ overview.todayUsage.outputTokens.toLocaleString() }}
        </span>
      </div>
      <div class="metric-cell">
        <span class="metric-label">24 小时分流（放行率）</span>
        <span class="metric-value">
          {{ overview.gate24h.reply }} / {{ overview.gate24h.memory }} /
          {{ overview.gate24h.ignore }}（{{
            formatPercent(overview.gate24h.reply, gateTotal24h)
          }}）
        </span>
      </div>
      <div class="metric-cell">
        <span class="metric-label">启用会话</span>
        <span class="metric-value">
          {{ overview.activeChatCount }} / {{ overview.chatCount }}
        </span>
      </div>
      <div class="metric-cell">
        <span class="metric-label">待处理队列</span>
        <span class="metric-value">{{ overview.pendingJobs }}</span>
      </div>
      <div class="metric-cell">
        <span class="metric-label">数据库体积</span>
        <span class="metric-value">
          {{ formatBytes(overview.storage.dbBytes) }}
        </span>
      </div>
    </div>

    <NCard v-if="overview" class="mb-md" size="small">
      <NSpace :size="8" wrap>
        <NTag
          size="small"
          :type="overview.gatewayHealth.reachable ? 'success' : 'warning'"
        >
          Message Gateway：{{
            overview.gatewayHealth.reachable
              ? "在线"
              : overview.gatewayHealth.configured
                ? "不可达"
                : "未配置"
          }}
        </NTag>
        <NTag
          size="small"
          :type="overview.gatewayStreamConnected ? 'success' : 'default'"
        >
          网关事件流：{{
            overview.gatewayStreamConnected ? "已连接" : "未连接"
          }}
        </NTag>
        <NTag
          size="small"
          :type="overview.guildApiConfigured ? 'success' : 'default'"
        >
          公会内部接口：{{ overview.guildApiConfigured ? "已配置" : "未配置" }}
        </NTag>
        <NTag
          size="small"
          :type="overview.guildStreamConnected ? 'success' : 'default'"
        >
          公会事件流：{{ overview.guildStreamConnected ? "已连接" : "未连接" }}
        </NTag>
        <NTag
          size="small"
          :type="overview.keycloakConfigured ? 'success' : 'default'"
        >
          Keycloak 目录：{{ overview.keycloakConfigured ? "已配置" : "未配置" }}
        </NTag>
        <NTag size="small" :type="connectedMcpCount > 0 ? 'info' : 'default'">
          MCP 服务：{{ connectedMcpCount }} /
          {{ overview.mcpServers.length }} 在线
        </NTag>
      </NSpace>
    </NCard>

    <NCard size="small">
      <NTabs v-model:value="activeTab" type="line">
        <NTabPane name="usage" tab="用量明细">
          <div class="filter-bar">
            <NText class="tabular sub-note" depth="2">
              近 30 日累计：调用 {{ usageTotals30d.calls.toLocaleString() }} 次
              · 合计 {{ usageTotals30d.totalTokens.toLocaleString() }} Tokens（
              输入 {{ usageTotals30d.inputTokens.toLocaleString() }} / 缓存命中
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
            :data="overview?.usageBuckets ?? []"
            :loading
            :pagination="{ pageSize: 15 }"
            :scroll-x="820"
            size="small"
          />
        </NTabPane>

        <NTabPane name="jobs" tab="任务队列">
          <div class="filter-bar">
            <NButton
              :loading="retryingAll"
              secondary
              size="small"
              @click="handleRetryAllFailed"
            >
              <template #icon>
                <RotateCcw :size="14" />
              </template>
              重试全部失败任务
            </NButton>
          </div>
          <NDataTable
            :columns="jobColumns"
            :data="jobs"
            :loading
            :pagination="{ pageSize: 15 }"
            :scroll-x="760"
            size="small"
          />
        </NTabPane>

        <NTabPane name="deliveries" tab="出站记录">
          <NDataTable
            :columns="deliveryColumns"
            :data="deliveries"
            :loading
            :pagination="{ pageSize: 15 }"
            :scroll-x="760"
            size="small"
          />
        </NTabPane>

        <NTabPane name="storage" tab="存储维护">
          <NSpace v-if="overview" :size="16" vertical>
            <NDescriptions
              bordered
              :column="3"
              label-placement="left"
              size="small"
            >
              <NDescriptionsItem label="SQLite 库文件">
                {{ formatBytes(overview.storage.dbBytes) }}
              </NDescriptionsItem>
              <NDescriptionsItem label="媒体缓存">
                {{ overview.storage.assetsFiles }} 个文件 /
                {{ formatBytes(overview.storage.assetsBytes) }}
              </NDescriptionsItem>
              <NDescriptionsItem label="头像缓存">
                {{ overview.storage.avatarsFiles }} 个文件 /
                {{ formatBytes(overview.storage.avatarsBytes) }}
              </NDescriptionsItem>
              <NDescriptionsItem label="群聊消息数">
                {{ overview.storage.tables.messages }}
              </NDescriptionsItem>
              <NDescriptionsItem label="分流记录数">
                {{ overview.storage.tables.gateDecisions }}
              </NDescriptionsItem>
              <NDescriptionsItem label="结构化记忆">
                {{ overview.storage.tables.memories }}
              </NDescriptionsItem>
              <NDescriptionsItem label="媒体附件记录">
                {{ overview.storage.tables.messageAssets }}
              </NDescriptionsItem>
              <NDescriptionsItem label="后台任务">
                {{ overview.storage.tables.jobs }}
              </NDescriptionsItem>
              <NDescriptionsItem label="出站投递">
                {{ overview.storage.tables.deliveries }}
              </NDescriptionsItem>
              <NDescriptionsItem label="定时任务">
                {{ overview.storage.tables.schedules }}
              </NDescriptionsItem>
              <NDescriptionsItem label="公会审计">
                {{ overview.storage.tables.guildAuditLogs }}
              </NDescriptionsItem>
              <NDescriptionsItem label="用量流水">
                {{ overview.storage.tables.llmUsage }}
              </NDescriptionsItem>
            </NDescriptions>

            <div class="filter-bar">
              <NText depth="2">保留最近天数：</NText>
              <NInputNumber
                v-model:value="purgeDays"
                class="w-110"
                :max="3650"
                :min="1"
                size="small"
              />
              <NPopconfirm @positive-click="handlePurgeStorage">
                <template #trigger>
                  <NButton :loading="purging" size="small" type="warning">
                    <template #icon>
                      <Trash2 :size="14" />
                    </template>
                    清理过期数据
                  </NButton>
                </template>
                将删除超过 {{ purgeDays }}
                天的未受保护历史消息、分流记录、已完成任务及孤立媒体文件；被长期记忆引用的消息会自动保留。确认继续？
              </NPopconfirm>
            </div>

            <NAlert v-if="lastPurge" type="success">
              本次清理范围：超过 {{ lastPurge.olderThanDays }} 天；共清理
              {{ lastPurge.deletedMessages }} 条消息、{{
                lastPurge.deletedDecisions
              }}
              条分流日志、{{ lastPurge.deletedJobs }} 条任务、{{
                lastPurge.deletedDeliveries
              }}
              条投递、{{ lastPurge.deletedAssetRows }} 条媒体记录，释放磁盘
              {{ formatBytes(lastPurge.freedBytes) }}。
            </NAlert>
          </NSpace>
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
                    重置全局上下文
                  </NButton>
                </template>
                将清空全局短期上下文轮次并刷新
                sessionId，全局/群聊/成员长期记忆保留不变。
              </NPopconfirm>
            </div>

            <NCard
              v-if="conversation.summary"
              size="small"
              title="全局压缩摘要"
            >
              <div class="pre-wrap">{{ conversation.summary }}</div>
            </NCard>

            <NCard
              v-if="conversation.pendingResults.length > 0"
              size="small"
              title="待消费投递回执"
            >
              <pre class="code-block">{{
                JSON.stringify(conversation.pendingResults, null, 2)
              }}</pre>
            </NCard>

            <NEmpty
              v-if="conversation.messages.length === 0"
              description="全局上下文当前暂无短期轮次"
            />

            <div
              v-for="(turn, idx) in conversation.messages"
              :key="idx"
              class="turn-box"
            >
              <div class="turn-head">
                <NTag size="tiny">{{ turn.role }}</NTag>
                <NTag
                  v-for="call in turn.tool_calls ?? []"
                  :key="call.id"
                  size="tiny"
                  type="info"
                >
                  {{ call.function.name }}
                </NTag>
                <span v-if="turn.tool_call_id" class="mono">
                  {{ turn.tool_call_id }}
                </span>
              </div>
              <pre class="code-block mt-xs">{{
                turn.content ||
                (turn.tool_calls?.length
                  ? JSON.stringify(
                      turn.tool_calls.map((c) => ({
                        tool: c.function.name,
                        args: c.function.arguments,
                      })),
                      null,
                      2,
                    )
                  : "(empty)")
              }}</pre>
            </div>
          </NSpace>
        </NTabPane>
      </NTabs>
    </NCard>
  </div>
</template>
