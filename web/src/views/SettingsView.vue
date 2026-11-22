<script setup lang="ts">
import { ExternalLink, RefreshCw, Save } from "@lucide/vue";
import {
  NButton,
  NCard,
  NCollapse,
  NCollapseItem,
  NDescriptions,
  NDescriptionsItem,
  NDynamicTags,
  NForm,
  NFormItem,
  NInput,
  NInputNumber,
  NSelect,
  NSpace,
  NSwitch,
  NTabPane,
  NTabs,
  NTag,
  NText,
  useMessage,
} from "naive-ui";
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";

import { apiFetch } from "../api/client.ts";
import type {
  McpServerFormRow,
  McpStatusRow,
  McpToolRow,
} from "../components/settings/McpSettingsPane.vue";
import McpSettingsPane from "../components/settings/McpSettingsPane.vue";
import type { StorageSummary } from "../components/settings/StorageMaintenancePane.vue";
import StorageMaintenancePane from "../components/settings/StorageMaintenancePane.vue";

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

interface RuntimeSettingsView {
  bot: {
    botQQ: string;
    names: string[];
    personaPrompt: string;
    timezone: string;
    paused: boolean;
    replyPaceMinMs: number;
    replyPaceMaxMs: number;
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
    cooldownWindowMinutes: number;
    proactiveSoftLimit: number;
    cooldownMinConfidence: number;
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
  bunko: {
    autoRecordFolderId: string;
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
  social: {
    styleDistillEnabled: boolean;
    styleDistillIntervalHours: number;
    styleDistillMinMessages: number;
    jargonLearnEnabled: boolean;
    jargonIntervalHours: number;
    jargonMinMessages: number;
    jargonAutoApprove: boolean;
    impressionUpdateEnabled: boolean;
    impressionIntervalHours: number;
    impressionMinMessages: number;
    stickerCollectEnabled: boolean;
    stickerAutoApprove: boolean;
    stickerMaxCount: number;
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

const VALID_TABS = new Set([
  "bot",
  "digest",
  "guild",
  "mcp",
  "media",
  "models",
  "policy",
  "social",
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
const triggeringGuild = ref<"due" | "assignments" | "weekly" | null>(null);

const customWeeklyEnabled = ref(false);
const weeklyDays = ref<string[]>(["sun"]);
const weeklyTime = ref("20:00");

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
              <NFormItem label="多气泡最小间隔（毫秒，0 关闭）">
                <NInputNumber
                  v-model:value="settings.bot.replyPaceMinMs"
                  class="w-full"
                  :max="5000"
                  :min="0"
                  :step="100"
                />
              </NFormItem>
              <NFormItem label="多气泡最大间隔（毫秒）">
                <NInputNumber
                  v-model:value="settings.bot.replyPaceMaxMs"
                  class="w-full"
                  :max="8000"
                  :min="0"
                  :step="100"
                />
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
                <NFormItem label="主动插话冷却窗口（分钟）">
                  <NInputNumber
                    v-model:value="settings.gateModel.cooldownWindowMinutes"
                    class="w-full"
                    :max="60"
                    :min="1"
                  />
                </NFormItem>
                <NFormItem label="主动插话软阈值（0 关闭）">
                  <NInputNumber
                    v-model:value="settings.gateModel.proactiveSoftLimit"
                    class="w-full"
                    :max="50"
                    :min="0"
                  />
                </NFormItem>
                <NFormItem label="冷却期非 @ 最低置信度">
                  <NInputNumber
                    v-model:value="settings.gateModel.cooldownMinConfidence"
                    class="w-full"
                    :max="1"
                    :min="0"
                    :step="0.05"
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

        <NTabPane name="digest" tab="文库与摘要">
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
            <NFormItem
              label="树莓娘自动记录默认目录（非主动要求记录的内容默认写入此处）"
            >
              <NSelect
                v-if="bunkoFolders.length > 0"
                clearable
                filterable
                :options="bunkoFolderSelectOptions"
                placeholder="选择 Bunko 目录（留空写根目录）"
                :value="settings.bunko.autoRecordFolderId"
                @update:value="
                  (v) => (settings!.bunko.autoRecordFolderId = v ?? '')
                "
              />
              <NInput
                v-else
                v-model:value="settings.bunko.autoRecordFolderId"
                placeholder="可选 Bunko 目录 UUID（留空写根目录）"
              />
            </NFormItem>
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
              <NFormItem label="群聊摘要目标目录（留空写入工作区根目录）">
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

        <NTabPane name="social" tab="拟人互动">
          <NForm class="form-narrow" label-placement="top" size="small">
            <NCard class="mb-md" size="small" title="分群表达风格提炼">
              <div class="form-grid-2">
                <NFormItem label="后台定时提炼群聊风格">
                  <NSwitch
                    v-model:value="settings.social.styleDistillEnabled"
                  />
                </NFormItem>
                <NFormItem label="提炼周期（小时）">
                  <NInputNumber
                    v-model:value="settings.social.styleDistillIntervalHours"
                    class="w-full"
                    :max="168"
                    :min="1"
                  />
                </NFormItem>
                <NFormItem label="周期内最少新增消息数">
                  <NInputNumber
                    v-model:value="settings.social.styleDistillMinMessages"
                    class="w-full"
                    :max="500"
                    :min="10"
                  />
                </NFormItem>
              </div>
            </NCard>

            <NCard class="mb-md" size="small" title="群内黑话词典提炼">
              <div class="form-grid-2">
                <NFormItem label="后台自动提炼群内黑话">
                  <NSwitch v-model:value="settings.social.jargonLearnEnabled" />
                </NFormItem>
                <NFormItem label="自动审核通过（关闭则需人工审核）">
                  <NSwitch v-model:value="settings.social.jargonAutoApprove" />
                </NFormItem>
                <NFormItem label="提炼周期（小时）">
                  <NInputNumber
                    v-model:value="settings.social.jargonIntervalHours"
                    class="w-full"
                    :max="168"
                    :min="1"
                  />
                </NFormItem>
                <NFormItem label="周期内最少新增消息数">
                  <NInputNumber
                    v-model:value="settings.social.jargonMinMessages"
                    class="w-full"
                    :max="500"
                    :min="10"
                  />
                </NFormItem>
              </div>
            </NCard>

            <NCard class="mb-md" size="small" title="成员轻量印象卡">
              <div class="form-grid-2">
                <NFormItem label="后台低频更新成员印象">
                  <NSwitch
                    v-model:value="settings.social.impressionUpdateEnabled"
                  />
                </NFormItem>
                <NFormItem label="更新周期（小时）">
                  <NInputNumber
                    v-model:value="settings.social.impressionIntervalHours"
                    class="w-full"
                    :max="168"
                    :min="1"
                  />
                </NFormItem>
                <NFormItem label="周期内最少发言条数">
                  <NInputNumber
                    v-model:value="settings.social.impressionMinMessages"
                    class="w-full"
                    :max="200"
                    :min="3"
                  />
                </NFormItem>
              </div>
            </NCard>

            <NCard class="mb-md" size="small" title="表情包库自动收集">
              <div class="form-grid-2">
                <NFormItem label="自动收集群内表情包">
                  <NSwitch
                    v-model:value="settings.social.stickerCollectEnabled"
                  />
                </NFormItem>
                <NFormItem label="自动审核通过（关闭则需人工审核）">
                  <NSwitch v-model:value="settings.social.stickerAutoApprove" />
                </NFormItem>
                <NFormItem label="自动收集上限（张）">
                  <NInputNumber
                    v-model:value="settings.social.stickerMaxCount"
                    class="w-full"
                    :max="2000"
                    :min="10"
                  />
                </NFormItem>
              </div>
            </NCard>
          </NForm>
        </NTabPane>

        <NTabPane name="mcp" tab="MCP 服务">
          <McpSettingsPane
            v-model:servers="settings.mcpServers"
            :statuses="mcpStatuses"
            :tools="mcpTools"
          />
        </NTabPane>

        <NTabPane name="storage" tab="存储维护">
          <StorageMaintenancePane :storage @purged="loadSettings" />
        </NTabPane>
      </NTabs>
    </NCard>
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
