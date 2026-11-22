<script setup lang="ts">
import { ArrowRight, ExternalLink, RefreshCw, RotateCcw } from "@lucide/vue";
import {
  NAlert,
  NButton,
  NCard,
  NCollapse,
  NCollapseItem,
  NDescriptions,
  NDescriptionsItem,
  NDrawer,
  NDrawerContent,
  NEmpty,
  NSpace,
  NTag,
  NText,
  useMessage,
} from "naive-ui";
import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";

import { apiFetch } from "../api/client.ts";
import { useChatOptions } from "../composables/useChatOptions.ts";
import { useLiveRefresh } from "../composables/useEventStream.ts";
import type { LlmCallRow } from "../utils/ai.ts";
import {
  formatToolArguments,
  parseDialogUnits,
  parseGateDecisionsFromResponse,
  parseSubagentOutput,
  prettyMaybeJson,
  purposeMeta,
} from "../utils/ai.ts";
import { formatBytes, formatPercent, formatTime } from "../utils/format.ts";

interface McpStatus {
  name: string;
  transport: string;
  connected: boolean;
  toolCount: number;
  error?: string;
}

interface OverviewResponse {
  workerRunning: boolean;
  botPaused: boolean;
  botQQ: string;
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
  guildPublicUrl: string;
  bunkoConfigured: boolean;
  bunkoWorkspaceUrl: string;
  keycloakConfigured: boolean;
  mcpServers: McpStatus[];
  storage: {
    dbBytes: number;
    tables: {
      messages: number;
      deliveries: number;
    };
  };
}

interface JobRow {
  id: number;
  kind: string;
  chatKey: string;
  state: "pending" | "running" | "done" | "failed";
  lastError: string | null;
  updatedAt: number;
}

interface DeliveryRow {
  id: number;
  chatKey: string;
  kind: string;
  payload: Record<string, unknown>;
  status: "queued" | "retrying" | "sent" | "failed";
  error: string | null;
  updatedAt: number;
}

const route = useRoute();
const router = useRouter();
const message = useMessage();
const { chatTitle } = useChatOptions();

const RECENT_FEED_LIMIT = 8;

const loading = ref(false);
const retryingAll = ref(false);
const overview = ref<OverviewResponse | null>(null);
const recentCalls = ref<LlmCallRow[]>([]);
const recentDeliveries = ref<DeliveryRow[]>([]);
const jobs = ref<JobRow[]>([]);

const selectedCall = ref<LlmCallRow | null>(null);
const callDetailOpen = ref(false);

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

const failedJobCount = computed(
  () => jobs.value.filter((j) => j.state === "failed").length,
);

const failedDeliveryCount = computed(
  () => recentDeliveries.value.filter((d) => d.status === "failed").length,
);

async function loadAll() {
  loading.value = true;

  try {
    const [ov, callRes, delRes, jobRes] = await Promise.all([
      apiFetch<OverviewResponse>("/api/admin/overview"),
      apiFetch<{ items: LlmCallRow[] }>(
        `/api/admin/llm-calls?limit=${RECENT_FEED_LIMIT}`,
      ),
      apiFetch<{ items: DeliveryRow[] }>(
        `/api/admin/deliveries?limit=${RECENT_FEED_LIMIT}`,
      ),
      apiFetch<{ items: JobRow[] }>("/api/admin/jobs?limit=30"),
    ]);

    overview.value = ov;
    recentCalls.value = callRes.items.slice(0, RECENT_FEED_LIMIT);
    recentDeliveries.value = delRes.items.slice(0, RECENT_FEED_LIMIT);
    jobs.value = jobRes.items;
  } catch (err) {
    message.error(err instanceof Error ? err.message : "加载概览数据失败");
  } finally {
    loading.value = false;
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

function openCallDetail(call: LlmCallRow) {
  selectedCall.value = call;
  callDetailOpen.value = true;
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
    const verb = payload.remove ? "取消表情回应" : "表情回应";

    return `${verb} #${String(payload.emojiId ?? "")}`;
  }

  if (kind === "qq_poke") {
    return `戳了戳 ${String(payload.userId ?? "")}`;
  }

  return JSON.stringify(payload);
}

function summarizeCallOutput(call: LlmCallRow): string {
  if (call.purpose === "dialog") {
    const units = parseDialogUnits(call.responseText);

    if (units) {
      if (units.length === 0) {
        return "静默（无需发言）";
      }

      const first = units[0];

      if (first.kind === "qq_reply") {
        return first.text?.replaceAll(/\s+/g, " ").trim() || "发送回复";
      }

      if (first.kind === "qq_reaction") {
        return `${first.remove ? "取消表情" : "贴表情"} ${first.emojiId ?? ""}`.trim();
      }

      if (first.kind === "qq_poke") {
        return first.userRef ? `戳了戳 ${first.userRef}` : "戳一戳";
      }

      return `合并转发：${first.title ?? ""}`.trim();
    }
  }

  if (call.purpose === "gate") {
    const decisions = parseGateDecisionsFromResponse(call.responseText);

    if (decisions && decisions.length > 0) {
      const first = decisions[0];
      const act =
        first.action === "reply"
          ? "回复"
          : first.action === "memory"
            ? "记忆"
            : "忽略";

      return `${act}：${first.reason ?? ""}`.trim();
    }
  }

  if (call.purpose.startsWith("subagent")) {
    const sub = parseSubagentOutput(call.responseText);

    if (sub?.brief) {
      return sub.brief.replaceAll(/\s+/g, " ").trim();
    }
  }

  const plain = (call.responseText ?? "")
    .replaceAll(/\*\*([^*]+)\*\*/g, "$1")
    .replaceAll(/\s+/g, " ")
    .trim();

  if (plain) {
    return plain;
  }

  if (call.toolCalls.length > 0) {
    return `调用工具：${call.toolCalls.map((t) => t.name).join("、")}`;
  }

  return call.chatKey ? chatTitle(call.chatKey) : "—";
}

const deliveryStatusLabel: Record<
  DeliveryRow["status"],
  { text: string; type: "default" | "warning" | "success" | "error" }
> = {
  queued: { text: "待投递", type: "default" },
  retrying: { text: "重试中", type: "warning" },
  sent: { text: "已送达", type: "success" },
  failed: { text: "失败", type: "error" },
};

useLiveRefresh({
  events: ["job_update", "delivery_update", "gate_decision", "llm_call"],
  debounceMs: 400,
  refresh: () => loadAll(),
});

onMounted(() => {
  if (route.query.tab === "context") {
    void router.replace("/ai?tab=context");

    return;
  }

  if (route.query.tab === "storage") {
    void router.replace("/settings?tab=storage");

    return;
  }

  void loadAll();
});
</script>

<template>
  <div>
    <div class="page-bar">
      <h1 class="page-title">概览</h1>
      <NButton :loading size="small" @click="loadAll">
        <template #icon>
          <RefreshCw :size="14" />
        </template>
        刷新
      </NButton>
    </div>

    <div v-if="overview" class="metric-grid">
      <button class="metric-card" type="button" @click="router.push('/ai')">
        <div class="metric-card-top">
          <span class="metric-label">今日 AI 调用</span>
          <ArrowRight class="metric-arrow" :size="13" />
        </div>
        <span class="metric-value">
          {{ overview.todayUsage.calls }} 次 /
          {{ overview.todayUsage.totalTokens.toLocaleString() }} tok
        </span>
        <span class="metric-sub">
          入 {{ overview.todayUsage.inputTokens.toLocaleString() }}（缓
          {{
            formatPercent(
              overview.todayUsage.cachedInputTokens,
              overview.todayUsage.inputTokens,
            )
          }}） / 出 {{ overview.todayUsage.outputTokens.toLocaleString() }}
        </span>
      </button>

      <button
        class="metric-card"
        type="button"
        @click="router.push('/ai?tab=gate')"
      >
        <div class="metric-card-top">
          <span class="metric-label">24 小时分流</span>
          <ArrowRight class="metric-arrow" :size="13" />
        </div>
        <span class="metric-value">
          {{ overview.gate24h.reply }} / {{ overview.gate24h.memory }} /
          {{ overview.gate24h.ignore }}
        </span>
        <span class="metric-sub">
          回复放行率 {{ formatPercent(overview.gate24h.reply, gateTotal24h) }}
        </span>
      </button>

      <button class="metric-card" type="button" @click="router.push('/chats')">
        <div class="metric-card-top">
          <span class="metric-label">启用会话</span>
          <ArrowRight class="metric-arrow" :size="13" />
        </div>
        <span class="metric-value">
          {{ overview.activeChatCount }} / {{ overview.chatCount }}
        </span>
        <span class="metric-sub">
          {{ overview.botPaused ? "自动应答已暂停" : "自动应答运行中" }}
        </span>
      </button>

      <button
        class="metric-card"
        type="button"
        @click="router.push('/ai?tab=jobs')"
      >
        <div class="metric-card-top">
          <span class="metric-label">任务队列</span>
          <ArrowRight class="metric-arrow" :size="13" />
        </div>
        <span class="metric-value">
          待处理 {{ overview.pendingJobs }}
          <NText v-if="failedJobCount > 0" type="error">
            / 失败 {{ failedJobCount }}
          </NText>
        </span>
        <span class="metric-sub">
          调度器{{ overview.workerRunning ? "运行中" : "已停止" }}
        </span>
      </button>

      <button
        class="metric-card"
        type="button"
        @click="router.push('/ai?tab=deliveries')"
      >
        <div class="metric-card-top">
          <span class="metric-label">出站投递</span>
          <ArrowRight class="metric-arrow" :size="13" />
        </div>
        <span class="metric-value">
          {{ overview.storage.tables.deliveries }} 条
        </span>
        <span class="metric-sub">
          {{
            failedDeliveryCount > 0
              ? `近期失败 ${failedDeliveryCount} 条`
              : "近期投递正常"
          }}
        </span>
      </button>

      <button
        class="metric-card"
        type="button"
        @click="router.push('/settings?tab=storage')"
      >
        <div class="metric-card-top">
          <span class="metric-label">本地存储</span>
          <ArrowRight class="metric-arrow" :size="13" />
        </div>
        <span class="metric-value">
          {{ formatBytes(overview.storage.dbBytes) }}
        </span>
        <span class="metric-sub">
          消息 {{ overview.storage.tables.messages.toLocaleString() }} 条
        </span>
      </button>
    </div>

    <NCard v-if="overview" class="mb-md" size="small">
      <NSpace :size="8" wrap>
        <NTag
          class="status-link"
          size="small"
          :type="overview.gatewayHealth.reachable ? 'success' : 'warning'"
          @click="router.push('/logs?tab=logs')"
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
          class="status-link"
          size="small"
          :type="overview.gatewayStreamConnected ? 'success' : 'default'"
          @click="router.push('/logs?tab=logs')"
        >
          网关事件流：{{
            overview.gatewayStreamConnected ? "已连接" : "未连接"
          }}
        </NTag>
        <NTag
          class="status-link"
          size="small"
          :type="overview.guildApiConfigured ? 'success' : 'default'"
          @click="router.push('/settings?tab=guild')"
        >
          公会内部接口：{{ overview.guildApiConfigured ? "已配置" : "未配置" }}
        </NTag>
        <NTag
          class="status-link"
          size="small"
          :type="overview.guildStreamConnected ? 'success' : 'default'"
          @click="router.push('/settings?tab=guild')"
        >
          公会事件流：{{ overview.guildStreamConnected ? "已连接" : "未连接" }}
        </NTag>
        <NTag
          class="status-link"
          size="small"
          :type="overview.bunkoConfigured ? 'success' : 'default'"
          @click="router.push('/settings?tab=digest')"
        >
          Bunko 云文档：{{ overview.bunkoConfigured ? "已接入" : "未配置" }}
        </NTag>
        <NTag
          class="status-link"
          size="small"
          :type="overview.keycloakConfigured ? 'success' : 'default'"
          @click="router.push('/settings?tab=bot')"
        >
          Keycloak 目录：{{ overview.keycloakConfigured ? "已配置" : "未配置" }}
        </NTag>
        <NTag
          class="status-link"
          size="small"
          :type="connectedMcpCount > 0 ? 'info' : 'default'"
          @click="router.push('/settings?tab=mcp')"
        >
          MCP 服务：{{ connectedMcpCount }} /
          {{ overview.mcpServers.length }} 在线
        </NTag>
        <NButton
          v-if="overview.guildPublicUrl"
          :href="overview.guildPublicUrl"
          quaternary
          rel="noopener noreferrer"
          size="tiny"
          tag="a"
          target="_blank"
        >
          <template #icon>
            <ExternalLink :size="12" />
          </template>
          打开公会看板
        </NButton>
        <NButton
          v-if="overview.bunkoWorkspaceUrl"
          :href="overview.bunkoWorkspaceUrl"
          quaternary
          rel="noopener noreferrer"
          size="tiny"
          tag="a"
          target="_blank"
        >
          <template #icon>
            <ExternalLink :size="12" />
          </template>
          打开 Bunko 云文档
        </NButton>
      </NSpace>
    </NCard>

    <NAlert v-if="failedJobCount > 0" class="mb-md" type="warning">
      <div class="feed-row-top">
        <span>当前有 {{ failedJobCount }} 个后台任务执行失败。</span>
        <NSpace :size="8">
          <NButton
            :loading="retryingAll"
            secondary
            size="tiny"
            type="warning"
            @click="handleRetryAllFailed"
          >
            <template #icon>
              <RotateCcw :size="12" />
            </template>
            重试全部
          </NButton>
          <NButton quaternary size="tiny" @click="router.push('/ai?tab=jobs')">
            查看队列
          </NButton>
        </NSpace>
      </div>
    </NAlert>

    <div class="overview-grid">
      <NCard size="small" title="最近 AI 调用">
        <template #header-extra>
          <NButton quaternary size="tiny" @click="router.push('/ai')">
            查看全部
            <template #icon>
              <ArrowRight :size="12" />
            </template>
          </NButton>
        </template>

        <NEmpty
          v-if="recentCalls.length === 0"
          class="py-empty"
          description="暂无 AI 调用记录"
        />

        <div v-else class="feed-list">
          <div
            v-for="call in recentCalls"
            :key="call.id"
            class="feed-row feed-row-clickable"
            @click="openCallDetail(call)"
          >
            <div class="feed-row-top">
              <div class="feed-row-meta">
                <NTag size="tiny" :type="purposeMeta(call.purpose).type">
                  {{ purposeMeta(call.purpose).label }}
                </NTag>
                <NTag v-if="call.status === 'error'" size="tiny" type="error">
                  失败
                </NTag>
                <NTag
                  v-for="(tc, idx) in call.toolCalls.slice(0, 3)"
                  :key="`${tc.name}-${idx}`"
                  size="tiny"
                  type="info"
                >
                  {{ tc.name }}
                </NTag>
                <span class="mono sub-note">{{ call.model }}</span>
              </div>
              <span class="tabular turn-time sub-note">
                {{ call.durationMs }} ms / {{ formatTime(call.createdAt) }}
              </span>
            </div>
            <div class="feed-row-body">
              <NText v-if="call.error" type="error">{{ call.error }}</NText>
              <template v-else>
                {{ summarizeCallOutput(call) }}
              </template>
            </div>
          </div>
        </div>
      </NCard>

      <NCard size="small" title="最近出站投递">
        <template #header-extra>
          <NButton
            quaternary
            size="tiny"
            @click="router.push('/ai?tab=deliveries')"
          >
            查看全部
            <template #icon>
              <ArrowRight :size="12" />
            </template>
          </NButton>
        </template>

        <NEmpty
          v-if="recentDeliveries.length === 0"
          class="py-empty"
          description="暂无出站记录"
        />

        <div v-else class="feed-list">
          <div v-for="item in recentDeliveries" :key="item.id" class="feed-row">
            <div class="feed-row-top">
              <div class="feed-row-meta">
                <NTag size="tiny" :type="deliveryStatusLabel[item.status].type">
                  {{ deliveryStatusLabel[item.status].text }}
                </NTag>
                <span class="sub-note">{{ chatTitle(item.chatKey) }}</span>
              </div>
              <span class="tabular turn-time sub-note">
                {{ formatTime(item.updatedAt) }}
              </span>
            </div>
            <div class="feed-row-body">
              <NText v-if="item.error" type="error">{{ item.error }}</NText>
              <template v-else>
                {{ summarizePayload(item.payload, item.kind) || "—" }}
              </template>
            </div>
          </div>
        </div>
      </NCard>
    </div>

    <NDrawer v-model:show="callDetailOpen" class="drawer-safe" :width="560">
      <NDrawerContent v-if="selectedCall" closable title="AI 调用详情">
        <NSpace :size="12" vertical>
          <NAlert v-if="selectedCall.error" title="调用失败" type="error">
            {{ selectedCall.error }}
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
                入 {{ selectedCall.inputTokens.toLocaleString() }} / 出
                {{ selectedCall.outputTokens.toLocaleString() }}
              </span>
            </NDescriptionsItem>
          </NDescriptions>

          <div v-if="selectedCall.toolCalls.length > 0">
            <div class="section-title">发起的工具调用</div>
            <NSpace :size="8" vertical>
              <div
                v-for="(tc, idx) in selectedCall.toolCalls"
                :key="`${tc.name}-${idx}`"
                class="turn-box"
              >
                <div class="turn-head">
                  <NTag size="small" type="info">{{ tc.name }}</NTag>
                  <NTag
                    v-if="tc.ok !== undefined"
                    :bordered="false"
                    size="tiny"
                    :type="tc.ok ? 'success' : 'error'"
                  >
                    {{ tc.ok ? "成功" : "失败" }}
                  </NTag>
                  <span
                    v-if="tc.durationMs !== undefined"
                    class="mono turn-time tabular"
                  >
                    {{ tc.durationMs }} ms
                  </span>
                </div>
                <div class="tool-io-section">
                  <div class="tool-io-label"><span>入参</span></div>
                  <pre class="code-block tool-io-block">{{
                    formatToolArguments(tc)
                  }}</pre>
                </div>
                <div v-if="tc.result !== undefined" class="tool-io-section">
                  <div class="tool-io-label"><span>返回值</span></div>
                  <pre class="code-block tool-io-block">{{
                    prettyMaybeJson(tc.result)
                  }}</pre>
                </div>
              </div>
            </NSpace>
          </div>

          <div v-if="selectedCall.responseText">
            <div class="section-title">模型输出</div>
            <pre class="code-block">{{
              prettyMaybeJson(selectedCall.responseText)
            }}</pre>
          </div>

          <NCollapse v-if="selectedCall.requestPreview">
            <NCollapseItem name="req" title="请求上下文预览">
              <pre class="code-block">{{ selectedCall.requestPreview }}</pre>
            </NCollapseItem>
          </NCollapse>

          <NButton
            block
            secondary
            size="small"
            @click="
              callDetailOpen = false;
              router.push('/ai');
            "
          >
            在 AI 调用页查看更多
          </NButton>
        </NSpace>
      </NDrawerContent>
    </NDrawer>
  </div>
</template>
