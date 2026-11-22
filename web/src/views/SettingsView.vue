<script setup lang="ts">
import { ExternalLink, Plus, RefreshCw, Save, Trash2 } from "@lucide/vue";
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
  NDynamicTags,
  NForm,
  NFormItem,
  NInput,
  NInputNumber,
  NModal,
  NPopconfirm,
  NSelect,
  NSpace,
  NSwitch,
  NTabPane,
  NTabs,
  NTag,
  NText,
  useMessage,
} from "naive-ui";
import { computed, h, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";

import { apiFetch } from "../api/client.ts";
import { formatBytes } from "../utils/format.ts";

type ThinkingEffort = "none" | "low" | "medium" | "high";

interface ThinkingTaskOption {
  key: string;
  label: string;
  fallback?: ThinkingEffort;
}

interface WeeklySchedule {
  kind: "weekly";
  weekdays: string[];
  time: string;
}

interface McpServerFormRow {
  name: string;
  enabled: boolean;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  allowedTools?: string[];
}

interface RuntimeSettingsView {
  bot: {
    botQQ: string;
    names: string[];
    personaPrompt: string;
    timezone: string;
    paused: boolean;
  };
  mainModel: {
    baseURL: string;
    apiKey: string;
    model: string;
    contextTokens: number;
    maxOutputTokens: number;
    temperature: number;
    timeoutMs: number;
    thinkingEffort: ThinkingEffort;
    taskThinkingEffort: Record<string, ThinkingEffort>;
  };
  gateModel: {
    baseURL: string;
    apiKey: string;
    model: string;
    minConfidence: number;
    failClosed: boolean;
    batchWindowMs: number;
    contextMessages: number;
    timeoutMs: number;
  };
  policy: {
    privateDefaultEnabled: boolean;
    privateAccessMode: "all" | "members_and_admins" | "admins_only";
    groupDefaultMode: "off" | "mention_only" | "smart_observe";
    adminBypassGate: boolean;
    adminQQs: string[];
    allowedGroups: string[];
  };
  guildAutomation: {
    enabled: boolean;
    pollSeconds: number;
    dueReminderEnabled: boolean;
    dueAdvanceHours: number;
    assignmentsEnabled: boolean;
    weeklyReportEnabled: boolean;
    weeklySchedule: WeeklySchedule | null;
    weeklyFolderId: string;
  };
  groupDigest: {
    enabled: boolean;
    groups: string[];
    intervalMinutes: number;
    minMessages: number;
    prompt: string;
    folderId: string;
  };
  mcpServers: McpServerFormRow[];
  media: {
    autoAnalyzeImages: boolean;
    visionBaseURL: string;
    visionApiKey: string;
    visionModel: string;
    autoTranscribeAudio: boolean;
    audioBaseURL: string;
    audioApiKey: string;
    audioModel: string;
    expandForwards: boolean;
  };
}

interface EnvSummaryView {
  gatewayUrl: string;
  gatewayAccount: string;
  oidcIssuer: string;
  guildApiUrl: string;
  guildPublicUrl: string;
  guildConfigured: boolean;
  guildStreamConnected: boolean;
  bunkoApiUrl: string;
  bunkoPublicUrl: string;
  bunkoConfigured: boolean;
}

interface BunkoFolderOption {
  id: string;
  name: string;
  path: string;
  isPrivate: boolean;
}

interface McpStatusRow {
  name: string;
  transport: string;
  connected: boolean;
  toolCount: number;
  error?: string;
}

interface McpToolRow {
  exposedName: string;
  serverName: string;
  toolName: string;
  description: string;
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

interface PurgeResult {
  olderThanDays: number;
  deletedMessages: number;
  deletedDecisions: number;
  deletedJobs: number;
  deletedDeliveries: number;
  deletedAssetRows: number;
  freedBytes: number;
}

const VALID_TABS = new Set([
  "bot",
  "digest",
  "guild",
  "mcp",
  "media",
  "models",
  "policy",
  "storage",
]);

const route = useRoute();
const router = useRouter();
const message = useMessage();

const loading = ref(false);
const saving = ref(false);
const activeTab = ref(
  typeof route.query.tab === "string" && VALID_TABS.has(route.query.tab)
    ? route.query.tab
    : "bot",
);
const settings = ref<RuntimeSettingsView | null>(null);
const thinkingTasks = ref<ThinkingTaskOption[]>([]);
const envSummary = ref<EnvSummaryView | null>(null);
const bunkoFolders = ref<BunkoFolderOption[]>([]);
const mcpStatuses = ref<McpStatusRow[]>([]);
const mcpTools = ref<McpToolRow[]>([]);
const storage = ref<StorageSummary | null>(null);
const purging = ref(false);
const purgeDays = ref(30);
const lastPurge = ref<PurgeResult | null>(null);
const triggeringGuild = ref<"due" | "assignments" | "weekly" | null>(null);

const customWeeklyEnabled = ref(false);
const weeklyDays = ref<string[]>(["sun"]);
const weeklyTime = ref("20:00");

const mcpModalOpen = ref(false);
const editingMcpIndex = ref<number | null>(null);
const mcpForm = ref<{
  name: string;
  enabled: boolean;
  transport: "stdio" | "http";
  command: string;
  args: string[];
  url: string;
  headersList: { key: string; value: string }[];
  allowedTools: string[];
}>({
  name: "",
  enabled: true,
  transport: "stdio",
  command: "",
  args: [],
  url: "",
  headersList: [],
  allowedTools: [],
});

const bunkoFolderSelectOptions = computed(() => [
  { label: "工作区根目录（默认）", value: "" },
  ...bunkoFolders.value.map((f) => ({
    label: f.isPrivate ? `${f.path}（私密）` : f.path,
    value: f.id,
  })),
]);

const weekdayOptions = [
  { label: "周一", value: "mon" },
  { label: "周二", value: "tue" },
  { label: "周三", value: "wed" },
  { label: "周四", value: "thu" },
  { label: "周五", value: "fri" },
  { label: "周六", value: "sat" },
  { label: "周日", value: "sun" },
];

const THINKING_EFFORT_OPTIONS: { label: string; value: ThinkingEffort }[] = [
  { label: "关闭 (none)", value: "none" },
  { label: "低 (low)", value: "low" },
  { label: "中 (medium)", value: "medium" },
  { label: "高 (high)", value: "high" },
];

const THINKING_SHORT_LABEL: Record<ThinkingEffort, string> = {
  none: "关闭",
  low: "低",
  medium: "中",
  high: "高",
};

const taskOverrideCount = computed(
  () => Object.keys(settings.value?.mainModel.taskThinkingEffort ?? {}).length,
);

function defaultThinkingForTask(task: ThinkingTaskOption): ThinkingEffort {
  const base = settings.value?.mainModel.thinkingEffort ?? "none";
  const overrides = settings.value?.mainModel.taskThinkingEffort ?? {};

  if (task.key.startsWith("subagent:") && overrides.subagent) {
    return overrides.subagent;
  }

  if (task.fallback) {
    return task.fallback;
  }

  if (task.key === "memory_update" || task.key === "compaction") {
    return "none";
  }

  if (task.key === "subagent" || task.key.startsWith("subagent:")) {
    return base === "none" ? "none" : "low";
  }

  return base;
}

function setTaskThinking(key: string, value: ThinkingEffort | null) {
  if (!settings.value) {
    return;
  }

  const next = { ...settings.value.mainModel.taskThinkingEffort };

  if (value) {
    next[key] = value;
  } else {
    delete next[key];
  }

  settings.value.mainModel.taskThinkingEffort = next;
}

function resetAllTaskThinking() {
  if (!settings.value) {
    return;
  }

  settings.value.mainModel.taskThinkingEffort = {};
}

async function loadSettings() {
  loading.value = true;

  try {
    const [cfgRes, mcpRes, ovRes, bunkoRes] = await Promise.all([
      apiFetch<{
        settings: RuntimeSettingsView;
        thinkingTasks: ThinkingTaskOption[];
        envSummary: EnvSummaryView;
      }>("/api/admin/settings"),
      apiFetch<{ statuses: McpStatusRow[]; tools: McpToolRow[] }>(
        "/api/admin/mcp",
      ),
      apiFetch<{ storage: StorageSummary }>("/api/admin/overview"),
      apiFetch<{
        configured: boolean;
        folders: BunkoFolderOption[];
        error?: string;
      }>("/api/admin/bunko/folders").catch(() => ({
        configured: false,
        folders: [] as BunkoFolderOption[],
        error: "",
      })),
    ]);

    settings.value = cfgRes.settings;
    thinkingTasks.value = cfgRes.thinkingTasks;
    envSummary.value = cfgRes.envSummary;
    bunkoFolders.value = bunkoRes.folders;
    mcpStatuses.value = mcpRes.statuses;
    mcpTools.value = mcpRes.tools;
    storage.value = ovRes.storage;

    const ws = cfgRes.settings.guildAutomation.weeklySchedule;

    if (ws?.kind === "weekly") {
      customWeeklyEnabled.value = true;
      weeklyDays.value = [...ws.weekdays];
      weeklyTime.value = ws.time;
    } else {
      customWeeklyEnabled.value = false;
      weeklyDays.value = ["sun"];
      weeklyTime.value = "20:00";
    }
  } catch (err) {
    message.error(err instanceof Error ? err.message : "加载设置失败");
  } finally {
    loading.value = false;
  }
}

async function triggerGuildTask(task: "due" | "assignments" | "weekly") {
  const labels = {
    due: "到期提醒",
    assignments: "新指派通知",
    weekly: "生成周报",
  };

  triggeringGuild.value = task;

  try {
    const res = await apiFetch<{ alreadyActive: boolean; jobId: number }>(
      `/api/admin/guild/trigger/${task}`,
      { method: "POST" },
    );

    if (res.alreadyActive) {
      message.info(`「${labels[task]}」已在后台运行中（任务 #${res.jobId}）`);
    } else {
      message.success(`已入队「${labels[task]}」（任务 #${res.jobId}）`);
    }
  } catch (err) {
    message.error(err instanceof Error ? err.message : "触发公会任务失败");
  } finally {
    triggeringGuild.value = null;
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
    await loadSettings();
  } catch (err) {
    message.error(err instanceof Error ? err.message : "存储清理失败");
  } finally {
    purging.value = false;
  }
}

watch(activeTab, (tab) => {
  if (route.query.tab !== tab) {
    void router.replace({ query: { ...route.query, tab } });
  }
});

watch(
  () => route.query.tab,
  (tab) => {
    if (typeof tab === "string" && VALID_TABS.has(tab)) {
      activeTab.value = tab;
    }
  },
);

async function handleSave() {
  if (!settings.value) {
    return;
  }

  for (const qq of settings.value.policy.adminQQs) {
    if (!/^\d+$/.test(qq)) {
      message.warning(`管理员 QQ「${qq}」必须为纯数字`);

      return;
    }
  }

  for (const gid of settings.value.policy.allowedGroups) {
    if (!/^\d+$/.test(gid)) {
      message.warning(`白名单群号「${gid}」必须为纯数字`);

      return;
    }
  }

  for (const gid of settings.value.groupDigest.groups) {
    if (!/^\d+$/.test(gid)) {
      message.warning(`摘要监听群号「${gid}」必须为纯数字`);

      return;
    }
  }

  if (customWeeklyEnabled.value && weeklyDays.value.length === 0) {
    message.warning("启用自定义周报周期时请至少选择一个星期");

    return;
  }

  saving.value = true;

  try {
    const payload: RuntimeSettingsView = {
      ...settings.value,
      guildAutomation: {
        ...settings.value.guildAutomation,
        weeklySchedule: customWeeklyEnabled.value
          ? {
              kind: "weekly",
              weekdays: [...weeklyDays.value],
              time: weeklyTime.value.trim() || "20:00",
            }
          : null,
      },
    };

    await apiFetch<{ settings: RuntimeSettingsView }>("/api/admin/settings", {
      method: "PUT",
      body: JSON.stringify(payload),
    });

    await loadSettings();
    window.dispatchEvent(new CustomEvent("berry:status-changed"));
    message.success("设置已保存并生效");
  } catch (err) {
    message.error(err instanceof Error ? err.message : "保存失败");
  } finally {
    saving.value = false;
  }
}

function openCreateMcp() {
  editingMcpIndex.value = null;
  mcpForm.value = {
    name: "",
    enabled: true,
    transport: "http",
    command: "",
    args: [],
    url: "",
    headersList: [],
    allowedTools: [],
  };
  mcpModalOpen.value = true;
}

function openEditMcp(idx: number) {
  const row = settings.value?.mcpServers[idx];

  if (!row) {
    return;
  }

  editingMcpIndex.value = idx;
  mcpForm.value = {
    name: row.name,
    enabled: row.enabled,
    transport: row.transport,
    command: row.command ?? "",
    args: [...(row.args ?? [])],
    url: row.url ?? "",
    headersList: Object.entries(row.headers ?? {}).map(([key, value]) => ({
      key,
      value,
    })),
    allowedTools: [...(row.allowedTools ?? [])],
  };
  mcpModalOpen.value = true;
}

function saveMcpModal() {
  if (!settings.value) {
    return;
  }

  const name = mcpForm.value.name.trim();

  if (!/^[\w-]+$/.test(name)) {
    message.warning("服务名称仅允许字母、数字、下划线或连字符");

    return;
  }

  const entry: McpServerFormRow = {
    name,
    enabled: mcpForm.value.enabled,
    transport: mcpForm.value.transport,
  };

  if (mcpForm.value.transport === "stdio") {
    if (!mcpForm.value.command.trim()) {
      message.warning("请填写 stdio 启动命令");

      return;
    }

    entry.command = mcpForm.value.command.trim();

    if (mcpForm.value.args.length > 0) {
      entry.args = [...mcpForm.value.args];
    }
  } else {
    if (!mcpForm.value.url.trim()) {
      message.warning("请填写 HTTP 服务地址");

      return;
    }

    entry.url = mcpForm.value.url.trim();
    const headers: Record<string, string> = {};

    for (const pair of mcpForm.value.headersList) {
      if (pair.key.trim()) {
        headers[pair.key.trim()] = pair.value;
      }
    }

    if (Object.keys(headers).length > 0) {
      entry.headers = headers;
    }
  }

  if (mcpForm.value.allowedTools.length > 0) {
    entry.allowedTools = [...mcpForm.value.allowedTools];
  }

  if (editingMcpIndex.value === null) {
    settings.value.mcpServers.push(entry);
  } else {
    settings.value.mcpServers.splice(editingMcpIndex.value, 1, entry);
  }

  mcpModalOpen.value = false;
  message.info("已更新列表，请点击右上角「保存全部设置」应用连接");
}

function removeMcp(idx: number) {
  settings.value?.mcpServers.splice(idx, 1);
}

const findMcpStatus = (name: string): McpStatusRow | undefined =>
  mcpStatuses.value.find((s) => s.name === name);

const mcpColumns: DataTableColumns<McpServerFormRow> = [
  {
    title: "名称",
    key: "name",
    width: 140,
    render: (row) => h("span", { class: "mono" }, row.name),
  },
  {
    title: "传输",
    key: "transport",
    width: 85,
    render: (row) =>
      h(NTag, { size: "small" }, { default: () => row.transport }),
  },
  {
    title: "端点 / 命令",
    key: "endpoint",
    minWidth: 220,
    ellipsis: { tooltip: true },
    render: (row) =>
      row.transport === "http"
        ? row.url || "—"
        : `${row.command || ""} ${(row.args ?? []).join(" ")}`.trim() || "—",
  },
  {
    title: "运行状态",
    key: "status",
    width: 150,
    render: (row) => {
      if (!row.enabled) {
        return h(NTag, { size: "small" }, { default: () => "已禁用" });
      }

      const st = findMcpStatus(row.name);

      if (!st) {
        return h(
          NTag,
          { size: "small", type: "warning" },
          { default: () => "待保存生效" },
        );
      }

      if (st.connected) {
        return h(
          NTag,
          { size: "small", type: "success" },
          { default: () => `在线（${st.toolCount} 工具）` },
        );
      }

      return h(
        NTag,
        { size: "small", type: "error" },
        { default: () => st.error || "离线" },
      );
    },
  },
  {
    title: "操作",
    key: "actions",
    width: 130,
    render: (_row, index) =>
      h(
        NSpace,
        { size: 6 },
        {
          default: () => [
            h(
              NButton,
              { size: "tiny", onClick: () => openEditMcp(index) },
              { default: () => "编辑" },
            ),
            h(
              NPopconfirm,
              { onPositiveClick: () => removeMcp(index) },
              {
                trigger: () =>
                  h(
                    NButton,
                    { size: "tiny", quaternary: true, type: "error" },
                    { icon: () => h(Trash2, { size: 12 }) },
                  ),
                default: () => "从配置中移除该 MCP 服务？",
              },
            ),
          ],
        },
      ),
  },
];

const mcpToolColumns: DataTableColumns<McpToolRow> = [
  {
    title: "暴露名称",
    key: "exposedName",
    width: 220,
    render: (row) => h("span", { class: "mono" }, row.exposedName),
  },
  { title: "来源服务", key: "serverName", width: 140 },
  {
    title: "原始工具名",
    key: "toolName",
    width: 160,
    render: (row) => h("span", { class: "mono" }, row.toolName),
  },
  {
    title: "说明",
    key: "description",
    minWidth: 220,
    ellipsis: { tooltip: true },
  },
];

onMounted(() => {
  void loadSettings();
});
</script>

<template>
  <div>
    <div class="page-bar">
      <h1 class="page-title">系统设置</h1>
      <NSpace :size="8">
        <NButton :loading size="small" @click="loadSettings">
          <template #icon>
            <RefreshCw :size="14" />
          </template>
          重新加载
        </NButton>
        <NButton
          :disabled="!settings"
          :loading="saving"
          size="small"
          type="primary"
          @click="handleSave"
        >
          <template #icon>
            <Save :size="14" />
          </template>
          保存全部设置
        </NButton>
      </NSpace>
    </div>

    <NCard v-if="envSummary" class="mb-md" size="small">
      <NCollapse>
        <NCollapseItem name="env" title="环境变量摘要（只读）">
          <NDescriptions
            bordered
            :column="2"
            label-placement="left"
            size="small"
          >
            <NDescriptionsItem label="Message Gateway">
              <span class="mono">{{ envSummary.gatewayUrl || "未设置" }}</span>
            </NDescriptionsItem>
            <NDescriptionsItem label="网关账号标识">
              <span class="mono">
                {{ envSummary.gatewayAccount || "默认" }}
              </span>
            </NDescriptionsItem>
            <NDescriptionsItem label="公会内部地址">
              <span class="mono">{{ envSummary.guildApiUrl || "未设置" }}</span>
            </NDescriptionsItem>
            <NDescriptionsItem label="OIDC 发行方">
              <span class="mono">{{ envSummary.oidcIssuer || "未设置" }}</span>
            </NDescriptionsItem>
          </NDescriptions>
        </NCollapseItem>
      </NCollapse>
    </NCard>

    <NCard v-if="settings" size="small">
      <NTabs v-model:value="activeTab" type="line">
        <NTabPane name="bot" tab="基本信息">
          <NForm class="form-narrow" label-placement="top" size="small">
            <div class="form-grid-2">
              <NFormItem label="机器人 QQ 号">
                <NInput
                  v-model:value="settings.bot.botQQ"
                  placeholder="纯数字 QQ 号"
                />
              </NFormItem>
              <NFormItem label="时区">
                <NInput v-model:value="settings.bot.timezone" />
              </NFormItem>
              <NFormItem label="暂停被动应答（保留后台消息采集）">
                <NSwitch v-model:value="settings.bot.paused" />
              </NFormItem>
            </div>
            <NFormItem label="触发别名（直呼其名或昵称识别）">
              <NDynamicTags v-model:value="settings.bot.names" />
            </NFormItem>
            <NFormItem label="人设指令（Persona System Prompt）">
              <NInput
                v-model:value="settings.bot.personaPrompt"
                :rows="5"
                type="textarea"
              />
            </NFormItem>
          </NForm>
        </NTabPane>

        <NTabPane name="models" tab="模型参数">
          <NSpace :size="14" vertical>
            <NCard size="small" title="主对话模型（工具调用、长文回答）">
              <div class="form-grid-2">
                <NFormItem label="API Base URL">
                  <NInput v-model:value="settings.mainModel.baseURL" />
                </NFormItem>
                <NFormItem label="API Key">
                  <NInput
                    v-model:value="settings.mainModel.apiKey"
                    show-password-on="click"
                    type="password"
                  />
                </NFormItem>
                <NFormItem label="模型名">
                  <NInput v-model:value="settings.mainModel.model" />
                </NFormItem>
                <NFormItem label="思考强度（默认）">
                  <NSelect
                    v-model:value="settings.mainModel.thinkingEffort"
                    :options="THINKING_EFFORT_OPTIONS"
                  />
                </NFormItem>
                <NFormItem label="上下文窗口（Tokens）">
                  <NInputNumber
                    v-model:value="settings.mainModel.contextTokens"
                    class="w-full"
                    :min="8192"
                    :step="4096"
                  />
                </NFormItem>
                <NFormItem label="单轮最大输出（Tokens）">
                  <NInputNumber
                    v-model:value="settings.mainModel.maxOutputTokens"
                    class="w-full"
                    :min="256"
                    :step="512"
                  />
                </NFormItem>
                <NFormItem label="温度（Temperature）">
                  <NInputNumber
                    v-model:value="settings.mainModel.temperature"
                    class="w-full"
                    :max="2"
                    :min="0"
                    :step="0.1"
                  />
                </NFormItem>
                <NFormItem label="超时时间（毫秒）">
                  <NInputNumber
                    v-model:value="settings.mainModel.timeoutMs"
                    class="w-full"
                    :min="1000"
                    :step="5000"
                  />
                </NFormItem>
              </div>

              <NCollapse
                v-if="thinkingTasks.length > 0"
                class="task-thinking-collapse"
              >
                <NCollapseItem name="task-thinking" title="按任务覆盖思考强度">
                  <template #header-extra>
                    <NTag v-if="taskOverrideCount > 0" size="small" type="info">
                      已覆盖 {{ taskOverrideCount }} 项
                    </NTag>
                    <NText v-else class="sub-note" depth="3">全部默认</NText>
                  </template>
                  <div class="task-thinking-grid">
                    <div
                      v-for="task in thinkingTasks"
                      :key="task.key"
                      class="task-thinking-row"
                    >
                      <span class="task-thinking-label">{{ task.label }}</span>
                      <NSelect
                        class="w-145"
                        clearable
                        :options="THINKING_EFFORT_OPTIONS"
                        :placeholder="`默认 (${THINKING_SHORT_LABEL[defaultThinkingForTask(task)]})`"
                        size="small"
                        :value="
                          settings.mainModel.taskThinkingEffort[task.key] ??
                          null
                        "
                        @update:value="
                          (val: ThinkingEffort | null) =>
                            setTaskThinking(task.key, val)
                        "
                      />
                    </div>
                  </div>
                  <div v-if="taskOverrideCount > 0" class="task-thinking-foot">
                    <NButton
                      quaternary
                      size="tiny"
                      @click="resetAllTaskThinking"
                    >
                      全部恢复默认
                    </NButton>
                  </div>
                </NCollapseItem>
              </NCollapse>
            </NCard>

            <NCard size="small" title="分流小模型（无 @ 微批消息判定）">
              <div class="form-grid-2">
                <NFormItem label="API Base URL">
                  <NInput v-model:value="settings.gateModel.baseURL" />
                </NFormItem>
                <NFormItem label="API Key">
                  <NInput
                    v-model:value="settings.gateModel.apiKey"
                    show-password-on="click"
                    type="password"
                  />
                </NFormItem>
                <NFormItem label="模型名">
                  <NInput v-model:value="settings.gateModel.model" />
                </NFormItem>
                <NFormItem label="最低放行置信度">
                  <NInputNumber
                    v-model:value="settings.gateModel.minConfidence"
                    class="w-full"
                    :max="1"
                    :min="0"
                    :step="0.05"
                  />
                </NFormItem>
                <NFormItem label="微批合并窗口（毫秒）">
                  <NInputNumber
                    v-model:value="settings.gateModel.batchWindowMs"
                    class="w-full"
                    :max="10000"
                    :min="100"
                    :step="100"
                  />
                </NFormItem>
                <NFormItem label="上下文消息条数">
                  <NInputNumber
                    v-model:value="settings.gateModel.contextMessages"
                    class="w-full"
                    :max="40"
                    :min="0"
                  />
                </NFormItem>
                <NFormItem label="超时时间（毫秒）">
                  <NInputNumber
                    v-model:value="settings.gateModel.timeoutMs"
                    class="w-full"
                    :min="1000"
                    :step="1000"
                  />
                </NFormItem>
                <NFormItem label="异常时 Fail-Closed（报错时默认忽略而非乱回）">
                  <NSwitch v-model:value="settings.gateModel.failClosed" />
                </NFormItem>
              </div>
            </NCard>
          </NSpace>
        </NTabPane>

        <NTabPane name="media" tab="多模态识别">
          <NForm class="form-narrow" label-placement="top" size="small">
            <NCard class="mb-md" size="small" title="图片识别">
              <div class="form-grid-2">
                <NFormItem label="入站自动识别图片内容">
                  <NSwitch v-model:value="settings.media.autoAnalyzeImages" />
                </NFormItem>
                <NFormItem label="自动展开合并转发消息">
                  <NSwitch v-model:value="settings.media.expandForwards" />
                </NFormItem>
                <NFormItem label="视觉模型 Base URL（留空则沿用主模型）">
                  <NInput v-model:value="settings.media.visionBaseURL" />
                </NFormItem>
                <NFormItem label="视觉模型 API Key（留空则沿用主模型）">
                  <NInput
                    v-model:value="settings.media.visionApiKey"
                    show-password-on="click"
                    type="password"
                  />
                </NFormItem>
                <NFormItem label="视觉模型名称">
                  <NInput
                    v-model:value="settings.media.visionModel"
                    placeholder="留空则使用 mainModel.model"
                  />
                </NFormItem>
              </div>
            </NCard>

            <NCard size="small" title="语音转写">
              <div class="form-grid-2">
                <NFormItem label="自动转写 QQ 语音消息">
                  <NSwitch v-model:value="settings.media.autoTranscribeAudio" />
                </NFormItem>
                <NFormItem label="Whisper 模型名称">
                  <NInput v-model:value="settings.media.audioModel" />
                </NFormItem>
                <NFormItem label="语音转写 Base URL">
                  <NInput v-model:value="settings.media.audioBaseURL" />
                </NFormItem>
                <NFormItem label="语音转写 API Key">
                  <NInput
                    v-model:value="settings.media.audioApiKey"
                    show-password-on="click"
                    type="password"
                  />
                </NFormItem>
              </div>
            </NCard>
          </NForm>
        </NTabPane>

        <NTabPane name="policy" tab="门控策略">
          <NForm class="form-narrow" label-placement="top" size="small">
            <div class="form-grid-2">
              <NFormItem label="新私聊默认启用">
                <NSwitch
                  v-model:value="settings.policy.privateDefaultEnabled"
                />
              </NFormItem>
              <NFormItem label="私聊响应范围">
                <NSelect
                  v-model:value="settings.policy.privateAccessMode"
                  :options="[
                    { label: '所有私聊（默认）', value: 'all' },
                    {
                      label: '仅管理员及网协在籍成员',
                      value: 'members_and_admins',
                    },
                    {
                      label: '仅管理员（含网协管理层）',
                      value: 'admins_only',
                    },
                  ]"
                />
              </NFormItem>
              <NFormItem label="新群聊默认模式">
                <NSelect
                  v-model:value="settings.policy.groupDefaultMode"
                  :options="[
                    { label: '仅提及（mention_only）', value: 'mention_only' },
                    {
                      label: '智能观察（smart_observe）',
                      value: 'smart_observe',
                    },
                    { label: '关闭（off）', value: 'off' },
                  ]"
                />
              </NFormItem>
              <NFormItem label="管理员直连跳过小模型（@/引用/私聊）">
                <NSwitch v-model:value="settings.policy.adminBypassGate" />
              </NFormItem>
            </div>
            <NFormItem label="管理员 QQ 列表">
              <NDynamicTags v-model:value="settings.policy.adminQQs" />
            </NFormItem>
            <NFormItem
              label="允许群聊白名单（留空不限制，填写后仅监听和响应指定群号）"
            >
              <NDynamicTags v-model:value="settings.policy.allowedGroups" />
            </NFormItem>
          </NForm>
        </NTabPane>

        <NTabPane name="digest" tab="群聊摘要">
          <div v-if="envSummary" class="filter-bar mb-md">
            <NTag
              size="small"
              :type="envSummary.bunkoConfigured ? 'success' : 'default'"
            >
              Bunko 云文档：{{
                envSummary.bunkoConfigured ? "已接入" : "未配置"
              }}
            </NTag>
            <NButton
              v-if="envSummary.bunkoPublicUrl"
              :href="envSummary.bunkoPublicUrl"
              rel="noopener noreferrer"
              size="small"
              tag="a"
              target="_blank"
            >
              <template #icon>
                <ExternalLink :size="14" />
              </template>
              打开 Bunko 云文档
            </NButton>
          </div>
          <NForm class="form-narrow" label-placement="top" size="small">
            <div class="form-grid-2">
              <NFormItem label="定期生成群聊讨论摘要">
                <NSwitch v-model:value="settings.groupDigest.enabled" />
              </NFormItem>
              <NFormItem label="巡检间隔（分钟）">
                <NInputNumber
                  v-model:value="settings.groupDigest.intervalMinutes"
                  class="w-full"
                  :min="5"
                />
              </NFormItem>
              <NFormItem label="最少新增消息数阈值">
                <NInputNumber
                  v-model:value="settings.groupDigest.minMessages"
                  class="w-full"
                  :min="1"
                />
              </NFormItem>
              <NFormItem
                label="Bunko 自动记录默认目录（自动归档与群聊摘要默认写入此处，留空写根目录）"
              >
                <NSelect
                  v-if="bunkoFolders.length > 0"
                  clearable
                  filterable
                  :options="bunkoFolderSelectOptions"
                  placeholder="选择 Bunko 目录"
                  :value="settings.groupDigest.folderId"
                  @update:value="
                    (v) => (settings!.groupDigest.folderId = v ?? '')
                  "
                />
                <NInput
                  v-else
                  v-model:value="settings.groupDigest.folderId"
                  placeholder="可选 Bunko 目录 UUID（留空写根目录）"
                />
              </NFormItem>
            </div>
            <NFormItem label="纳入摘要的群号列表">
              <NDynamicTags v-model:value="settings.groupDigest.groups" />
            </NFormItem>
            <NFormItem label="摘要整理提示词">
              <NInput
                v-model:value="settings.groupDigest.prompt"
                :rows="3"
                type="textarea"
              />
            </NFormItem>
          </NForm>
        </NTabPane>

        <NTabPane name="guild" tab="公会联动">
          <div v-if="envSummary" class="filter-bar mb-md">
            <NTag
              size="small"
              :type="envSummary.guildConfigured ? 'success' : 'default'"
            >
              公会接口：{{ envSummary.guildConfigured ? "已就绪" : "未配置" }}
            </NTag>
            <NTag
              size="small"
              :type="envSummary.guildStreamConnected ? 'success' : 'default'"
            >
              实时事件流：{{
                envSummary.guildStreamConnected ? "已连接" : "未连接"
              }}
            </NTag>
            <NButton
              v-if="envSummary.guildPublicUrl"
              :href="envSummary.guildPublicUrl"
              rel="noopener noreferrer"
              size="small"
              tag="a"
              target="_blank"
            >
              <template #icon>
                <ExternalLink :size="14" />
              </template>
              打开公会看板
            </NButton>
            <NButton
              :disabled="!envSummary.guildConfigured"
              :loading="triggeringGuild === 'due'"
              size="small"
              @click="triggerGuildTask('due')"
            >
              触发到期提醒
            </NButton>
            <NButton
              :disabled="!envSummary.guildConfigured"
              :loading="triggeringGuild === 'assignments'"
              size="small"
              @click="triggerGuildTask('assignments')"
            >
              触发新指派通知
            </NButton>
            <NButton
              :disabled="
                !envSummary.guildConfigured || !envSummary.bunkoConfigured
              "
              :loading="triggeringGuild === 'weekly'"
              size="small"
              @click="triggerGuildTask('weekly')"
            >
              生成本周周报
            </NButton>
          </div>
          <NForm class="form-narrow" label-placement="top" size="small">
            <div class="form-grid-2">
              <NFormItem label="开启公会自动巡检">
                <NSwitch v-model:value="settings.guildAutomation.enabled" />
              </NFormItem>
              <NFormItem label="巡检周期（秒）">
                <NInputNumber
                  v-model:value="settings.guildAutomation.pollSeconds"
                  class="w-full"
                  :min="10"
                />
              </NFormItem>
              <NFormItem label="开启临期提醒">
                <NSwitch
                  v-model:value="settings.guildAutomation.dueReminderEnabled"
                />
              </NFormItem>
              <NFormItem label="临期提前小时数">
                <NInputNumber
                  v-model:value="settings.guildAutomation.dueAdvanceHours"
                  class="w-full"
                  :min="0.5"
                  :step="1"
                />
              </NFormItem>
              <NFormItem label="开启新指派私信提醒">
                <NSwitch
                  v-model:value="settings.guildAutomation.assignmentsEnabled"
                />
              </NFormItem>
              <NFormItem label="开启每周公会周报">
                <NSwitch
                  v-model:value="settings.guildAutomation.weeklyReportEnabled"
                />
              </NFormItem>
              <NFormItem label="Bunko 周报归档目录（留空写入工作区根目录）">
                <NSelect
                  v-if="bunkoFolders.length > 0"
                  clearable
                  filterable
                  :options="bunkoFolderSelectOptions"
                  placeholder="选择 Bunko 周报目录"
                  :value="settings.guildAutomation.weeklyFolderId"
                  @update:value="
                    (v) => (settings!.guildAutomation.weeklyFolderId = v ?? '')
                  "
                />
                <NInput
                  v-else
                  v-model:value="settings.guildAutomation.weeklyFolderId"
                  placeholder="可选 Bunko 目录 UUID（留空写根目录）"
                />
              </NFormItem>
              <NFormItem label="自定义周报触发时刻">
                <NSwitch v-model:value="customWeeklyEnabled" />
              </NFormItem>
            </div>

            <div v-if="customWeeklyEnabled" class="form-grid-2">
              <NFormItem label="每周触发日">
                <NSelect
                  v-model:value="weeklyDays"
                  multiple
                  :options="weekdayOptions"
                />
              </NFormItem>
              <NFormItem label="触发时刻（HH:mm）">
                <NInput v-model:value="weeklyTime" placeholder="20:00" />
              </NFormItem>
            </div>
          </NForm>
        </NTabPane>

        <NTabPane name="mcp" tab="MCP 服务">
          <div class="filter-bar">
            <NButton size="small" type="primary" @click="openCreateMcp">
              <template #icon>
                <Plus :size="14" />
              </template>
              新增 MCP 服务
            </NButton>
            <NText class="sub-note" depth="3">
              修改服务后请点击右上角「保存全部设置」完成热重载。
            </NText>
          </div>

          <NDataTable
            class="mb-lg"
            :columns="mcpColumns"
            :data="settings.mcpServers"
            :scroll-x="720"
            size="small"
          />

          <div class="section-title">
            已挂载工具目录（{{ mcpTools.length }}）
          </div>
          <NDataTable
            :columns="mcpToolColumns"
            :data="mcpTools"
            :pagination="{ pageSize: 10 }"
            :scroll-x="740"
            size="small"
          />
        </NTabPane>

        <NTabPane name="storage" tab="存储维护">
          <NSpace v-if="storage" :size="16" vertical>
            <NDescriptions
              bordered
              :column="3"
              label-placement="left"
              size="small"
            >
              <NDescriptionsItem label="SQLite 库文件">
                {{ formatBytes(storage.dbBytes) }}
              </NDescriptionsItem>
              <NDescriptionsItem label="媒体缓存">
                {{ storage.assetsFiles }} 个文件 /
                {{ formatBytes(storage.assetsBytes) }}
              </NDescriptionsItem>
              <NDescriptionsItem label="头像缓存">
                {{ storage.avatarsFiles }} 个文件 /
                {{ formatBytes(storage.avatarsBytes) }}
              </NDescriptionsItem>
              <NDescriptionsItem label="聊天消息">
                {{ storage.tables.messages.toLocaleString() }}
              </NDescriptionsItem>
              <NDescriptionsItem label="分流记录">
                {{ storage.tables.gateDecisions.toLocaleString() }}
              </NDescriptionsItem>
              <NDescriptionsItem label="结构化记忆">
                {{ storage.tables.memories.toLocaleString() }}
              </NDescriptionsItem>
              <NDescriptionsItem label="媒体附件">
                {{ storage.tables.messageAssets.toLocaleString() }}
              </NDescriptionsItem>
              <NDescriptionsItem label="后台任务">
                {{ storage.tables.jobs.toLocaleString() }}
              </NDescriptionsItem>
              <NDescriptionsItem label="出站投递">
                {{ storage.tables.deliveries.toLocaleString() }}
              </NDescriptionsItem>
              <NDescriptionsItem label="定时任务">
                {{ storage.tables.schedules.toLocaleString() }}
              </NDescriptionsItem>
              <NDescriptionsItem label="公会审计">
                {{ storage.tables.guildAuditLogs.toLocaleString() }}
              </NDescriptionsItem>
              <NDescriptionsItem label="AI 调用流水">
                {{ storage.tables.llmUsage.toLocaleString() }}
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
      </NTabs>
    </NCard>

    <NModal
      v-model:show="mcpModalOpen"
      class="modal-md"
      preset="card"
      :title="editingMcpIndex !== null ? '编辑 MCP 服务' : '新增 MCP 服务'"
    >
      <NForm label-placement="top" size="small">
        <div class="form-grid-2">
          <NFormItem label="服务标识符（英文/数字/连字符）">
            <NInput
              v-model:value="mcpForm.name"
              placeholder="例如 outline-docs"
            />
          </NFormItem>
          <NFormItem label="传输方式">
            <NSelect
              v-model:value="mcpForm.transport"
              :options="[
                { label: 'HTTP (Streamable HTTP)', value: 'http' },
                { label: 'stdio (子进程)', value: 'stdio' },
              ]"
            />
          </NFormItem>
        </div>

        <NFormItem label="启用状态">
          <NSwitch v-model:value="mcpForm.enabled" />
        </NFormItem>

        <template v-if="mcpForm.transport === 'stdio'">
          <NFormItem label="启动命令">
            <NInput v-model:value="mcpForm.command" placeholder="例如 npx" />
          </NFormItem>
          <NFormItem label="命令参数">
            <NDynamicTags v-model:value="mcpForm.args" />
          </NFormItem>
        </template>

        <template v-else>
          <NFormItem label="服务端 URL">
            <NInput
              v-model:value="mcpForm.url"
              placeholder="https://example.com/mcp"
            />
          </NFormItem>
          <NFormItem label="请求头（Headers）">
            <NSpace class="w-full" vertical>
              <div
                v-for="(pair, idx) in mcpForm.headersList"
                :key="idx"
                class="inline-pair-row"
              >
                <NInput v-model:value="pair.key" placeholder="Header 名" />
                <NInput
                  v-model:value="pair.value"
                  placeholder="值"
                  show-password-on="click"
                  type="password"
                />
                <NButton
                  quaternary
                  size="small"
                  type="error"
                  @click="mcpForm.headersList.splice(idx, 1)"
                >
                  <template #icon>
                    <Trash2 :size="13" />
                  </template>
                </NButton>
              </div>
              <NButton
                size="tiny"
                @click="mcpForm.headersList.push({ key: '', value: '' })"
              >
                添加 Header
              </NButton>
            </NSpace>
          </NFormItem>
        </template>

        <NFormItem label="允许暴露的工具白名单（留空则全部放行）">
          <NDynamicTags v-model:value="mcpForm.allowedTools" />
        </NFormItem>

        <NSpace justify="end">
          <NButton @click="mcpModalOpen = false">取消</NButton>
          <NButton type="primary" @click="saveMcpModal">确定</NButton>
        </NSpace>
      </NForm>
    </NModal>
  </div>
</template>

<style scoped>
.form-grid-2 {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0 14px;
}

.task-thinking-collapse {
  margin-top: 4px;
  padding-top: 8px;
  border-top: 1px solid var(--berry-border);
}

.task-thinking-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px 18px;
}

.task-thinking-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.task-thinking-label {
  font-size: 13px;
  color: var(--berry-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.task-thinking-foot {
  margin-top: 8px;
  display: flex;
  justify-content: flex-end;
}

@media (max-width: 700px) {
  .form-grid-2,
  .task-thinking-grid {
    grid-template-columns: 1fr;
  }
}
</style>
