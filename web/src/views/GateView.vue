<script setup lang="ts">
import { FlaskConical, Pause, Play, RefreshCw } from "@lucide/vue";
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
import { useRouter } from "vue-router";

import { apiFetch } from "../api/client.ts";
import { useEventStream } from "../composables/useEventStream.ts";
import { formatTime } from "../utils/format.ts";

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

const router = useRouter();
const message = useMessage();

const loading = ref(false);
const items = ref<GateDecisionRow[]>([]);
const total = ref(0);
const filterAction = ref<string | null>(null);
const filterStage = ref<string | null>(null);
const filterChatKey = ref("");
const filterSearch = ref("");

const selectedRow = ref<GateDecisionRow | null>(null);
const detailOpen = ref(false);

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

const { paused: streamPaused, togglePause } = useEventStream((type) => {
  if (type === "gate_decision") {
    void loadDecisions();
  }
});

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

    if (filterChatKey.value.trim()) {
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

function openDetail(row: GateDecisionRow) {
  selectedRow.value = row;
  detailOpen.value = true;
}

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
    width: 126,
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
    minWidth: 130,
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
    render: (row) => stageLabelMap[row.stage] || row.stage,
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
  {
    title: "操作",
    key: "ops",
    width: 62,
    render: (row) =>
      h(
        NButton,
        { size: "tiny", quaternary: true, onClick: () => openDetail(row) },
        { default: () => "详情" },
      ),
  },
];

let filterTimer: ReturnType<typeof setTimeout> | null = null;

watch([filterAction, filterStage], () => {
  void loadDecisions();
});

watch([filterChatKey, filterSearch], () => {
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
    <div class="page-bar">
      <NSpace align="center" :size="10">
        <h1 class="page-title">消息分流</h1>
        <NText class="sub-note" depth="3">共 {{ total }} 条</NText>
      </NSpace>
      <NSpace :size="8">
        <NButton size="small" @click="togglePause">
          <template #icon>
            <Play v-if="streamPaused" :size="14" />
            <Pause v-else :size="14" />
          </template>
          {{ streamPaused ? "恢复实时流" : "暂停实时流" }}
        </NButton>
        <NButton size="small" type="primary" @click="dryRunOpen = true">
          <template #icon>
            <FlaskConical :size="14" />
          </template>
          沙盒试跑
        </NButton>
      </NSpace>
    </div>

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
      <NInput
        v-model:value="filterChatKey"
        class="w-200"
        clearable
        placeholder="会话键，例如 group:10248888"
        size="small"
        @keyup.enter="loadDecisions"
      />
      <NInput
        v-model:value="filterSearch"
        class="w-220"
        clearable
        placeholder="搜索消息正文或判断原因"
        size="small"
        @keyup.enter="loadDecisions"
      />
      <NButton :loading size="small" @click="loadDecisions">
        <template #icon>
          <RefreshCw :size="14" />
        </template>
        查询
      </NButton>
    </div>

    <NCard size="small">
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
        :scroll-x="840"
        size="small"
      />
    </NCard>

    <NDrawer v-model:show="detailOpen" class="drawer-safe" :width="440">
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
            · {{ selectedRow.durationMs }} ms
          </NDescriptionsItem>
        </NDescriptions>

        <div class="section-title">消息内容</div>
        <pre class="code-block">{{ selectedRow.messageText || "—" }}</pre>

        <div class="section-title">判断理由</div>
        <pre class="code-block">{{ selectedRow.reason }}</pre>

        <NButton
          block
          class="mt-lg"
          secondary
          size="small"
          @click="
            detailOpen = false;
            router.push({
              path: '/ai',
              query: { chatKey: selectedRow.chatKey },
            });
          "
        >
          查看该会话 AI 调用
        </NButton>
      </NDrawerContent>
    </NDrawer>

    <NDrawer v-model:show="dryRunOpen" class="drawer-safe" :width="460">
      <NDrawerContent closable title="小模型分流沙盒">
        <NForm label-placement="top" size="small">
          <NFormItem label="模拟会话标识">
            <NInput v-model:value="dryRunForm.chatKey" />
          </NFormItem>
          <NFormItem label="群触发模式">
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
              <NSpace align="center" :size="6">
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
                {{ dryRunResult.model }} · {{ dryRunResult.durationMs }} ms
              </NText>
            </NSpace>
            <div>{{ dryRunResult.result.reason }}</div>
          </NSpace>
        </NCard>
      </NDrawerContent>
    </NDrawer>
  </div>
</template>
