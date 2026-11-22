<script setup lang="ts">
import { RefreshCw } from "@lucide/vue";
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
  NSelect,
  NSpace,
  NTag,
  useMessage,
} from "naive-ui";
import { computed, h, onMounted, ref } from "vue";

import { apiFetch } from "../api/client.ts";
import { useChatOptions } from "../composables/useChatOptions.ts";
import { useLiveRefresh } from "../composables/useEventStream.ts";
import type { LlmCallRow } from "../utils/ai.ts";
import { formatTime } from "../utils/format.ts";
import InlineAiCallsList from "./InlineAiCallsList.vue";

interface DeliveryRow {
  id: number;
  chatKey: string;
  kind: string;
  payload: Record<string, unknown>;
  status: "queued" | "retrying" | "sent" | "failed";
  attempts: number;
  error: string | null;
  onebotMessageId: string | null;
  createdAt: number;
  updatedAt: number;
}

const emit = defineEmits<{
  "update:summary": [payload: { total: number; failed: number }];
}>();

const props = defineProps<{
  paused?: boolean;
}>();

const message = useMessage();
const { chatOptions, chatTitle } = useChatOptions();

const loading = ref(false);
const deliveries = ref<DeliveryRow[]>([]);
const filterStatus = ref<DeliveryRow["status"] | null>(null);
const filterChatKey = ref<string | null>(null);
const selectedDelivery = ref<DeliveryRow | null>(null);
const drawerOpen = ref(false);
const callsLoading = ref(false);
const relatedCalls = ref<LlmCallRow[]>([]);

const pausedRef = computed(() => Boolean(props.paused));

const visibleDeliveries = computed(() =>
  deliveries.value.filter((d) => {
    if (filterStatus.value && d.status !== filterStatus.value) {
      return false;
    }

    if (filterChatKey.value && d.chatKey !== filterChatKey.value) {
      return false;
    }

    return true;
  }),
);

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

    return `${verb} #${String(payload.emojiId ?? "")} -> ${String(payload.messageId ?? "")}`;
  }

  return JSON.stringify(payload);
}

const deliveryKindLabel: Record<string, string> = {
  qq_reply: "文本回复",
  qq_forward: "合并转发",
  qq_reaction: "表情回应",
};

const deliveryStatusLabel: Record<
  DeliveryRow["status"],
  { text: string; type: "default" | "warning" | "success" | "error" }
> = {
  queued: { text: "待投递", type: "default" },
  retrying: { text: "重试中", type: "warning" },
  sent: { text: "已送达", type: "success" },
  failed: { text: "失败", type: "error" },
};

const columns: DataTableColumns<DeliveryRow> = [
  { title: "ID", key: "id", width: 64 },
  {
    title: "会话",
    key: "chatKey",
    width: 180,
    ellipsis: { tooltip: true },
    render: (row) => h("span", null, chatTitle(row.chatKey)),
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

async function loadDeliveries() {
  loading.value = true;

  try {
    const res = await apiFetch<{ items: DeliveryRow[] }>(
      "/api/admin/deliveries",
    );

    deliveries.value = res.items;
    emit("update:summary", {
      total: res.items.length,
      failed: res.items.filter((d) => d.status === "failed").length,
    });

    if (selectedDelivery.value) {
      const updated = res.items.find(
        (item) => item.id === selectedDelivery.value?.id,
      );

      if (updated) {
        selectedDelivery.value = updated;
      }
    }
  } catch (err) {
    message.error(err instanceof Error ? err.message : "加载出站记录失败");
  } finally {
    loading.value = false;
  }
}

async function openDeliveryDetail(row: DeliveryRow) {
  const targetId = row.id;

  selectedDelivery.value = row;
  drawerOpen.value = true;
  callsLoading.value = true;
  relatedCalls.value = [];

  try {
    const qs = new URLSearchParams({ chatKey: row.chatKey, limit: "20" });
    const res = await apiFetch<{ items: LlmCallRow[] }>(
      `/api/admin/llm-calls?${qs.toString()}`,
    );

    if (selectedDelivery.value?.id !== targetId) {
      return;
    }

    relatedCalls.value = res.items
      .filter(
        (c) =>
          c.createdAt <= row.createdAt + 2000 &&
          c.createdAt >= row.createdAt - 30_000,
      )
      .reverse();
  } catch {
    // Non-critical lookup.
  } finally {
    if (selectedDelivery.value?.id === targetId) {
      callsLoading.value = false;
    }
  }
}

useLiveRefresh({
  events: ["delivery_update"],
  debounceMs: 250,
  paused: pausedRef,
  refresh: () => loadDeliveries(),
});

onMounted(() => {
  void loadDeliveries();
});

defineExpose({ refresh: loadDeliveries });
</script>

<template>
  <div>
    <div class="filter-bar">
      <NSelect
        v-model:value="filterStatus"
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
        v-model:value="filterChatKey"
        class="w-240"
        clearable
        filterable
        :options="chatOptions"
        placeholder="筛选会话（名称/群号）"
        size="small"
        tag
      />
      <NButton :loading size="small" @click="loadDeliveries">
        <template #icon>
          <RefreshCw :size="14" />
        </template>
        刷新
      </NButton>
    </div>

    <NDataTable
      class="clickable-table"
      :columns
      :data="visibleDeliveries"
      :loading
      :pagination="{ pageSize: 15 }"
      :row-props="
        (row: DeliveryRow) => ({
          onClick: () => openDeliveryDetail(row),
        })
      "
      :scroll-x="840"
      size="small"
    />

    <NDrawer v-model:show="drawerOpen" class="drawer-safe" :width="600">
      <NDrawerContent
        v-if="selectedDelivery"
        closable
        :title="`出站投递 #${selectedDelivery.id}`"
      >
        <NSpace :size="12" vertical>
          <NAlert v-if="selectedDelivery.error" title="投递失败" type="error">
            {{ selectedDelivery.error }}
          </NAlert>
          <NDescriptions
            bordered
            :column="2"
            label-placement="left"
            size="small"
          >
            <NDescriptionsItem label="会话">
              {{ chatTitle(selectedDelivery.chatKey) }}
            </NDescriptionsItem>
            <NDescriptionsItem label="类型">
              {{
                deliveryKindLabel[selectedDelivery.kind] ??
                selectedDelivery.kind
              }}
            </NDescriptionsItem>
            <NDescriptionsItem label="状态">
              <NTag
                size="small"
                :type="deliveryStatusLabel[selectedDelivery.status].type"
              >
                {{ deliveryStatusLabel[selectedDelivery.status].text }}
              </NTag>
            </NDescriptionsItem>
            <NDescriptionsItem label="尝试 / 消息 ID">
              <span class="mono">
                {{ selectedDelivery.attempts }} 次 ·
                {{ selectedDelivery.onebotMessageId || "—" }}
              </span>
            </NDescriptionsItem>
          </NDescriptions>

          <div>
            <div class="section-title">投递正文</div>
            <pre class="code-block">{{
              summarizePayload(
                selectedDelivery.payload,
                selectedDelivery.kind,
              ) || "—"
            }}</pre>
          </div>

          <div>
            <div class="section-title">
              关联 AI 调用（{{ relatedCalls.length }}）
            </div>
            <InlineAiCallsList :calls="relatedCalls" :loading="callsLoading" />
          </div>

          <NCollapse class="drawer-collapse">
            <NCollapseItem name="raw" title="原始投递载荷（JSON）">
              <pre class="code-block">{{
                JSON.stringify(selectedDelivery.payload, null, 2)
              }}</pre>
            </NCollapseItem>
          </NCollapse>
        </NSpace>
      </NDrawerContent>
    </NDrawer>
  </div>
</template>
