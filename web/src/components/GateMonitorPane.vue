<script setup lang="ts">
import type { DataTableColumns } from "naive-ui";
import {
  NButton,
  NCard,
  NDataTable,
  NDescriptions,
  NDescriptionsItem,
  NDrawer,
  NDrawerContent,
  NForm,
  NFormItem,
  NInput,
  NSelect,
  NSpace,
  NSwitch,
  NTag,
  NText,
  useMessage,
} from "naive-ui";
import { h, onMounted, ref, watch } from "vue";

import { apiFetch } from "../api/client.ts";
import { useChatOptions } from "../composables/useChatOptions.ts";
import { useLiveRefresh } from "../composables/useEventStream.ts";
import type { LlmCallRow } from "../utils/ai.ts";
import { formatTime } from "../utils/format.ts";
import InlineAiCallsList from "./InlineAiCallsList.vue";

interface GateDecisionRow {
  id: number;
  chatKey: string;
  messageId: number | null;
  action: "reply" | "memory" | "ignore";
  stage: "l0_rule" | "l1_classifier" | "dry_run";
  confidence: number;
  reason: string;
  model: string;
  durationMs: number;
  createdAt: number;
  senderName: string | null;
  userId: string | null;
  messageText: string | null;
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

const emit = defineEmits<{
  "inspectChatCalls": [chatKey: string];
  "update:total": [total: number];
}>();

const props = defineProps<{
  chatKey?: string | null;
  paused?: boolean;
}>();

const message = useMessage();
const { chatOptions } = useChatOptions();

const loading = ref(false);
const items = ref<GateDecisionRow[]>([]);
const total = ref(0);
const filterAction = ref<string | null>(null);
const filterStage = ref<string | null>(null);
const filterChatKey = ref<string | null>(props.chatKey ?? null);
const filterSearch = ref("");

const selectedRow = ref<GateDecisionRow | null>(null);
const detailOpen = ref(false);
const relatedCalls = ref<LlmCallRow[]>([]);
const loadingRelatedCalls = ref(false);

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

const actionOptions = [
  { label: "回复（reply）", value: "reply" },
  { label: "记忆（memory）", value: "memory" },
  { label: "忽略（ignore）", value: "ignore" },
];

const stageOptions = [
  { label: "规则直判（l0_rule）", value: "l0_rule" },
  { label: "小模型分流（l1_classifier）", value: "l1_classifier" },
  { label: "沙盒试跑（dry_run）", value: "dry_run" },
];

const actionTagMap: Record<
  GateDecisionRow["action"],
  { text: string; type: "success" | "info" | "default" }
> = {
  reply: { text: "回复", type: "success" },
  memory: { text: "记入记忆", type: "info" },
  ignore: { text: "忽略", type: "default" },
};

const stageLabelMap: Record<GateDecisionRow["stage"], string> = {
  l0_rule: "规则直判",
  l1_classifier: "小模型分流",
  dry_run: "沙盒试跑",
};

async function loadDecisions() {
  loading.value = true;

  try {
    const params = new URLSearchParams();

    if (filterAction.value) {
      params.set("action", filterAction.value);
    }

    if (filterStage.value) {
      params.set("stage", filterStage.value);
    }

    if (filterChatKey.value?.trim()) {
      params.set("chatKey", filterChatKey.value.trim());
    }

    if (filterSearch.value.trim()) {
      params.set("search", filterSearch.value.trim());
    }

    params.set("limit", "100");

    const res = await apiFetch<{ items: GateDecisionRow[]; total: number }>(
      `/api/admin/gate-decisions?${params.toString()}`,
    );

    items.value = res.items;
    total.value = res.total;
    emit("update:total", res.total);
  } catch (err) {
    message.error(err instanceof Error ? err.message : "加载分流记录失败");
  } finally {
    loading.value = false;
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
    await loadDecisions();
  } catch (err) {
    message.error(err instanceof Error ? err.message : "沙盒试跑失败");
  } finally {
    dryRunBusy.value = false;
  }
}

async function loadRelatedCalls(
  row: GateDecisionRow,
  options: { silent?: boolean } = {},
) {
  const targetId = row.id;

  if (!options.silent) {
    loadingRelatedCalls.value = true;
    relatedCalls.value = [];
  }

  try {
    const qs = new URLSearchParams({
      chatKey: row.chatKey,
      limit: "20",
    });
    const res = await apiFetch<{ items: LlmCallRow[] }>(
      `/api/admin/llm-calls?${qs.toString()}`,
    );

    if (selectedRow.value?.id !== targetId) {
      return;
    }

    const startMs = row.createdAt - 1000;
    const endMs = row.createdAt + 60_000;
    const chronological = res.items
      .filter((c) => c.createdAt >= startMs && c.createdAt <= endMs)
      .reverse();
    const picked: LlmCallRow[] = [];

    for (const call of chronological) {
      if (picked.length > 0 && call.purpose === "gate") {
        break;
      }

      picked.push(call);
    }

    relatedCalls.value = picked;
  } catch {
    if (!options.silent && selectedRow.value?.id === targetId) {
      relatedCalls.value = [];
    }
  } finally {
    if (!options.silent && selectedRow.value?.id === targetId) {
      loadingRelatedCalls.value = false;
    }
  }
}

useLiveRefresh({
  events: ["gate_decision"],
  debounceMs: 250,
  enabled: () => !props.paused,
  refresh: () => loadDecisions(),
});

useLiveRefresh({
  events: ["llm_call"],
  debounceMs: 250,
  enabled: () =>
    !props.paused && detailOpen.value && selectedRow.value !== null,
  match: (_type, data) => {
    const ev = data as { chatKey?: string | null };

    return !ev.chatKey || ev.chatKey === selectedRow.value!.chatKey;
  },
  refresh: async () => {
    if (selectedRow.value) {
      await loadRelatedCalls(selectedRow.value, { silent: true });
    }
  },
});

function openDetail(row: GateDecisionRow) {
  selectedRow.value = row;
  detailOpen.value = true;
  void loadRelatedCalls(row);
}

function openDryRun() {
  dryRunOpen.value = true;
}

defineExpose({
  loadDecisions,
  openDryRun,
});

const columns: DataTableColumns<GateDecisionRow> = [
  {
    title: "时间",
    key: "createdAt",
    width: 132,
    render: (row) => h("span", { class: "tabular" }, formatTime(row.createdAt)),
  },
  {
    title: "会话",
    key: "chatKey",
    width: 176,
    ellipsis: { tooltip: true },
    render: (row) => h("span", { class: "mono" }, row.chatKey),
  },
  {
    title: "发送者",
    key: "senderName",
    width: 108,
    ellipsis: { tooltip: true },
    render: (row) =>
      row.senderName
        ? `${row.senderName}${row.userId ? ` (${row.userId})` : ""}`
        : row.userId || "—",
  },
  {
    title: "消息内容",
    key: "messageText",
    minWidth: 140,
    ellipsis: { tooltip: true },
    render: (row) => row.messageText || "（演练或关联消息已清理）",
  },
  {
    title: "动作",
    key: "action",
    width: 78,
    render: (row) => {
      const cfg = actionTagMap[row.action];

      return h(
        NTag,
        { size: "small", type: cfg.type },
        { default: () => cfg.text },
      );
    },
  },
  {
    title: "阶段",
    key: "stage",
    width: 90,
    render: (row) => stageLabelMap[row.stage],
  },
  {
    title: "置信度",
    key: "confidence",
    width: 66,
    align: "right",
    render: (row) =>
      h("span", { class: "tabular" }, `${Math.round(row.confidence * 100)}%`),
  },
  {
    title: "判断原因",
    key: "reason",
    minWidth: 120,
    ellipsis: { tooltip: true },
  },
  {
    title: "耗时",
    key: "durationMs",
    width: 82,
    align: "right",
    render: (row) => h("span", { class: "tabular" }, `${row.durationMs} ms`),
  },
];

let filterTimer: ReturnType<typeof setTimeout> | null = null;

watch(
  () => props.chatKey,
  (next) => {
    if (next !== undefined && next !== filterChatKey.value) {
      filterChatKey.value = next ?? null;
    }
  },
);

watch([filterAction, filterStage, filterChatKey], () => {
  void loadDecisions();
});

watch(filterSearch, () => {
  if (filterTimer) {
    clearTimeout(filterTimer);
  }

  filterTimer = setTimeout(() => {
    void loadDecisions();
  }, 240);
});

onMounted(() => {
  void loadDecisions();
});
</script>

<template>
  <div>
    <div class="filter-bar">
      <NSelect
        v-model:value="filterAction"
        class="w-145"
        clearable
        :options="actionOptions"
        placeholder="全部动作"
        size="small"
      />
      <NSelect
        v-model:value="filterStage"
        class="w-175"
        clearable
        :options="stageOptions"
        placeholder="全部阶段"
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
        placeholder="搜索消息正文或判断原因"
        size="small"
        @keyup.enter="loadDecisions"
      />
    </div>

    <NDataTable
      class="clickable-table"
      :columns
      :data="items"
      :loading
      :pagination="{ pageSize: 20 }"
      :row-props="
        (row: GateDecisionRow) => ({
          onClick: () => openDetail(row),
        })
      "
      :scroll-x="900"
      size="small"
    />

    <NDrawer v-model:show="detailOpen" class="drawer-safe" :width="520">
      <NDrawerContent v-if="selectedRow" closable title="判定详情">
        <NDescriptions bordered :column="1" label-placement="left" size="small">
          <NDescriptionsItem label="记录编号">
            {{ selectedRow.id }}
          </NDescriptionsItem>
          <NDescriptionsItem label="判定时间">
            {{ formatTime(selectedRow.createdAt) }}
          </NDescriptionsItem>
          <NDescriptionsItem label="会话">
            <span class="mono">{{ selectedRow.chatKey }}</span>
          </NDescriptionsItem>
          <NDescriptionsItem label="发送者">
            {{ selectedRow.senderName || "—" }}
            {{ selectedRow.userId ? `(${selectedRow.userId})` : "" }}
          </NDescriptionsItem>
          <NDescriptionsItem label="动作">
            <NTag size="small" :type="actionTagMap[selectedRow.action].type">
              {{ actionTagMap[selectedRow.action].text }}
            </NTag>
          </NDescriptionsItem>
          <NDescriptionsItem label="阶段">
            {{ stageLabelMap[selectedRow.stage] }}
          </NDescriptionsItem>
          <NDescriptionsItem label="置信度">
            {{ Math.round(selectedRow.confidence * 100) }}%
          </NDescriptionsItem>
          <NDescriptionsItem label="模型 / 耗时">
            <span class="mono">{{ selectedRow.model || "rule" }}</span>
            / {{ selectedRow.durationMs }} ms
          </NDescriptionsItem>
        </NDescriptions>

        <div class="section-title">消息内容</div>
        <pre class="code-block">{{ selectedRow.messageText || "—" }}</pre>

        <div class="section-title">判断理由</div>
        <pre class="code-block">{{ selectedRow.reason }}</pre>

        <div class="section-title">
          关联 AI 调用（{{ relatedCalls.length }}）
        </div>
        <InlineAiCallsList
          :calls="relatedCalls"
          empty-text="该判定后未触发 AI 调用"
          :loading="loadingRelatedCalls"
        />

        <NButton
          block
          class="mt-lg"
          quaternary
          size="small"
          @click="
            detailOpen = false;
            emit('inspectChatCalls', selectedRow.chatKey);
          "
        >
          在调用明细中筛选该会话
        </NButton>
      </NDrawerContent>
    </NDrawer>

    <NDrawer v-model:show="dryRunOpen" class="drawer-safe" :width="460">
      <NDrawerContent closable title="小模型分流沙盒">
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
                :type="actionTagMap[dryRunResult.result.action].type"
              >
                {{ actionTagMap[dryRunResult.result.action].text }}
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
      </NDrawerContent>
    </NDrawer>
  </div>
</template>
