<script setup lang="ts">
import { Plus, RefreshCw, Sparkles, Trash2 } from "@lucide/vue";
import type { DataTableColumns } from "naive-ui";
import {
  NButton,
  NCard,
  NDataTable,
  NForm,
  NFormItem,
  NInput,
  NModal,
  NPopconfirm,
  NSelect,
  NSpace,
  NSwitch,
  NTag,
  NText,
  useMessage,
} from "naive-ui";
import { h, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";

import { apiFetch } from "../api/client.ts";
import { useChatOptions } from "../composables/useChatOptions.ts";
import { formatTime } from "../utils/format.ts";

interface ImpressionRow {
  userId: string;
  displayName: string;
  impression: string;
  source: "manual" | "auto";
  locked: boolean;
  updatedAt: number;
}

const route = useRoute();
const router = useRouter();
const message = useMessage();
const { userOptions } = useChatOptions();

const loading = ref(false);
const saving = ref(false);
const refreshingId = ref<string | null>(null);
const items = ref<ImpressionRow[]>([]);
const filterSearch = ref(
  typeof route.query.q === "string" ? route.query.q : "",
);
const pickRefreshUserId = ref<string | null>(null);

async function loadImpressions() {
  loading.value = true;

  try {
    const params = new URLSearchParams();

    if (filterSearch.value.trim()) {
      params.set("search", filterSearch.value.trim());
    }

    const qs = params.toString();
    const res = await apiFetch<{ items: ImpressionRow[] }>(
      `/api/admin/impressions${qs ? `?${qs}` : ""}`,
    );

    items.value = res.items;
  } catch (err) {
    message.error(err instanceof Error ? err.message : "加载成员印象失败");
  } finally {
    loading.value = false;
  }
}

const modalOpen = ref(false);
const isEdit = ref(false);
const form = ref({
  userId: "",
  impression: "",
  locked: true,
});

function openCreate() {
  isEdit.value = false;
  form.value = { userId: "", impression: "", locked: true };
  modalOpen.value = true;
}

function openEdit(row: ImpressionRow) {
  isEdit.value = true;
  form.value = {
    userId: row.userId,
    impression: row.impression,
    locked: row.locked,
  };
  modalOpen.value = true;
}

async function handleSave() {
  const uid = form.value.userId.trim();

  if (!uid || !form.value.impression.trim()) {
    message.warning("请填写成员 QQ 号和印象内容");

    return;
  }

  saving.value = true;

  try {
    await apiFetch(`/api/admin/impressions/${encodeURIComponent(uid)}`, {
      method: "PUT",
      body: JSON.stringify({
        impression: form.value.impression.trim(),
        locked: form.value.locked,
      }),
    });
    modalOpen.value = false;
    message.success("成员印象已保存");
    await loadImpressions();
  } catch (err) {
    message.error(err instanceof Error ? err.message : "保存失败");
  } finally {
    saving.value = false;
  }
}

async function handleRefresh(userId: string) {
  refreshingId.value = userId;

  try {
    await apiFetch(
      `/api/admin/impressions/${encodeURIComponent(userId)}/refresh`,
      {
        method: "POST",
      },
    );
    message.success("已提炼最新成员印象");
    await loadImpressions();
  } catch (err) {
    message.error(err instanceof Error ? err.message : "提炼成员印象失败");
  } finally {
    refreshingId.value = null;
  }
}

async function handleDelete(row: ImpressionRow) {
  try {
    await apiFetch(`/api/admin/impressions/${encodeURIComponent(row.userId)}`, {
      method: "DELETE",
    });
    message.success("已删除印象卡");
    await loadImpressions();
  } catch (err) {
    message.error(err instanceof Error ? err.message : "删除失败");
  }
}

const columns: DataTableColumns<ImpressionRow> = [
  {
    title: "成员",
    key: "userId",
    width: 220,
    ellipsis: { tooltip: true },
    render: (row) => {
      const name = row.displayName.trim();
      const hasDistinctName = Boolean(name && name !== row.userId);

      return h("span", [
        h("span", { class: "mono tabular" }, row.userId),
        ...(hasDistinctName ? [" ", name] : []),
      ]);
    },
  },
  {
    title: "一句话印象",
    key: "impression",
    minWidth: 260,
    ellipsis: { tooltip: true },
  },
  {
    title: "来源",
    key: "source",
    width: 110,
    render: (row) =>
      h(NSpace, { size: 4, wrap: false }, () => [
        h(
          NTag,
          {
            size: "tiny",
            bordered: false,
            type: row.source === "manual" ? "primary" : "info",
          },
          { default: () => (row.source === "manual" ? "人工" : "自动") },
        ),
        ...(row.locked
          ? [
              h(
                NTag,
                { size: "tiny", bordered: false, type: "warning" },
                { default: () => "锁定" },
              ),
            ]
          : []),
      ]),
  },
  {
    title: "更新时间",
    key: "updatedAt",
    width: 115,
    render: (row) => formatTime(row.updatedAt),
  },
  {
    title: "操作",
    key: "actions",
    width: 165,
    render: (row) =>
      h(NSpace, { size: 4, wrap: false }, () => [
        h(
          NButton,
          {
            size: "tiny",
            secondary: true,
            loading: refreshingId.value === row.userId,
            onClick: () => {
              void handleRefresh(row.userId);
            },
          },
          {
            icon: () => h(Sparkles, { size: 12 }),
            default: () => "重提",
          },
        ),
        h(
          NButton,
          { size: "tiny", secondary: true, onClick: () => openEdit(row) },
          { default: () => "编辑" },
        ),
        h(
          NPopconfirm,
          {
            onPositiveClick: () => {
              void handleDelete(row);
            },
          },
          {
            trigger: () =>
              h(
                NButton,
                {
                  "size": "tiny",
                  "quaternary": true,
                  "type": "error",
                  "aria-label": "删除",
                },
                { icon: () => h(Trash2, { size: 13 }) },
              ),
            default: () => "确定删除这条成员印象？",
          },
        ),
      ]),
  },
];

function handleSearch() {
  const q = filterSearch.value.trim();

  void router.replace({ query: q ? { q } : {} });
  void loadImpressions();
}

watch(
  () => route.query.q,
  (q) => {
    const next = typeof q === "string" ? q : "";

    if (next !== filterSearch.value) {
      filterSearch.value = next;
      void loadImpressions();
    }
  },
);

onMounted(() => {
  void loadImpressions();
});
</script>

<template>
  <div>
    <div class="page-bar">
      <NSpace align="center" :size="10">
        <h1 class="page-title">成员印象</h1>
        <NText class="sub-note tabular" depth="3">{{ items.length }} 人</NText>
      </NSpace>
      <NButton size="small" type="primary" @click="openCreate">
        <template #icon>
          <Plus :size="14" />
        </template>
        新增印象
      </NButton>
    </div>

    <div class="filter-bar">
      <NInput
        v-model:value="filterSearch"
        class="w-220"
        clearable
        placeholder="搜 QQ 号 / 姓名 / 昵称 / 印象"
        size="small"
        @clear="handleSearch"
        @keyup.enter="handleSearch"
      />
      <NButton :loading size="small" @click="handleSearch">
        <template #icon>
          <RefreshCw :size="14" />
        </template>
        查询
      </NButton>
      <NSelect
        v-model:value="pickRefreshUserId"
        class="w-220"
        clearable
        filterable
        :options="userOptions"
        placeholder="选成员从发言提炼"
        size="small"
        tag
      />
      <NButton
        :disabled="!pickRefreshUserId"
        :loading="
          Boolean(pickRefreshUserId && refreshingId === pickRefreshUserId)
        "
        secondary
        size="small"
        @click="pickRefreshUserId && handleRefresh(pickRefreshUserId)"
      >
        <template #icon>
          <Sparkles :size="13" />
        </template>
        提炼印象
      </NButton>
    </div>

    <NCard size="small">
      <NDataTable
        :columns
        :data="items"
        :loading
        :pagination="{ pageSize: 20 }"
        :scroll-x="850"
        size="small"
      />
    </NCard>

    <NModal
      v-model:show="modalOpen"
      class="modal-md"
      preset="card"
      :title="isEdit ? '编辑成员印象' : '新增成员印象'"
    >
      <NForm label-placement="top" size="small">
        <NFormItem label="成员 QQ">
          <NSelect
            v-model:value="form.userId"
            :disabled="isEdit"
            filterable
            :options="userOptions"
            placeholder="选择已知成员或直接输入 QQ 号"
            tag
          />
        </NFormItem>
        <NFormItem label="一句话印象（不超过 120 字）">
          <NInput
            v-model:value="form.impression"
            maxlength="120"
            placeholder="例如：爱开玩笑测试我，偶尔问正经技术问题"
            :rows="3"
            show-count
            type="textarea"
          />
        </NFormItem>
        <NFormItem label="锁定（后台自动更新不覆盖人工修改）">
          <NSwitch v-model:value="form.locked" />
        </NFormItem>
        <NSpace justify="end">
          <NButton @click="modalOpen = false">取消</NButton>
          <NButton :loading="saving" type="primary" @click="handleSave">
            保存
          </NButton>
        </NSpace>
      </NForm>
    </NModal>
  </div>
</template>
