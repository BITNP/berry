<script setup lang="ts">
import type { DataTableColumns } from "naive-ui";
import { NCard, NDataTable, NTag, NText, useMessage } from "naive-ui";
import { computed, h, onMounted, ref } from "vue";

import { apiFetch } from "../../api/client.ts";
import { useLiveRefresh } from "../../composables/useEventStream.ts";
import { formatDurationHuman, purposeMeta } from "../../utils/ai.ts";
import { formatPercent } from "../../utils/format.ts";

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

const props = defineProps<{
  paused?: boolean;
}>();

const message = useMessage();
const loading = ref(false);
const buckets = ref<UsageBucket[]>([]);

const totals30d = computed(() => {
  let calls = 0;
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;

  for (const row of buckets.value) {
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

async function refresh() {
  loading.value = true;

  try {
    const res = await apiFetch<{ buckets: UsageBucket[] }>(
      "/api/admin/usage?days=30",
    );

    buckets.value = res.buckets ?? [];
  } catch (err) {
    message.error(err instanceof Error ? err.message : "加载用量统计失败");
  } finally {
    loading.value = false;
  }
}

useLiveRefresh({
  events: ["llm_call"],
  enabled: () => !props.paused,
  debounceMs: 600,
  refresh: () => refresh(),
});

onMounted(() => {
  void refresh();
});

const columns: DataTableColumns<UsageBucket> = [
  { title: "日期", key: "day", width: 96 },
  {
    title: "用途",
    key: "purpose",
    width: 176,
    render: (row) => {
      const meta = purposeMeta(row.purpose);

      return h(
        NTag,
        { size: "small", type: meta.type, style: "max-width: 100%;" },
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
    title: "均耗时",
    key: "avgDurationMs",
    width: 82,
    align: "right",
    render: (row) =>
      h("span", { class: "tabular" }, formatDurationHuman(row.avgDurationMs)),
  },
];

defineExpose({ refresh, loading });
</script>

<template>
  <NCard size="small">
    <div class="filter-bar">
      <NText class="tabular sub-note" depth="2">
        近 30 日累计：调用 {{ totals30d.calls.toLocaleString() }} 次，合计
        {{ totals30d.totalTokens.toLocaleString() }} Tokens（输入
        {{ totals30d.inputTokens.toLocaleString() }} / 缓存命中
        {{ totals30d.cachedInputTokens.toLocaleString() }}，{{
          formatPercent(totals30d.cachedInputTokens, totals30d.inputTokens)
        }}
        / 输出 {{ totals30d.outputTokens.toLocaleString() }}）
      </NText>
    </div>
    <NDataTable
      :columns
      :data="buckets"
      :loading
      :pagination="{ pageSize: 15 }"
      :scroll-x="860"
      size="small"
    />
  </NCard>
</template>
