<script setup lang="ts">
import { Plus, RefreshCw, Trash2 } from "@lucide/vue";
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
  NTag,
  NText,
  useMessage,
} from "naive-ui";
import { computed, h, onMounted, ref } from "vue";

import { apiFetch } from "../api/client.ts";
import { formatTime } from "../utils/format.ts";

type MemoryScope = "global" | "chat" | "user";

interface MemoryRow {
  id: number;
  scope: MemoryScope;
  ownerId: string;
  key: string;
  summary: string;
  content: string;
  sourceMessageId: number | null;
  updatedAt: number;
}

const SCOPE_META: Record<
  MemoryScope,
  { label: string; tagType: "primary" | "info" | "default" }
> = {
  global: { label: "全局", tagType: "primary" },
  chat: { label: "群聊", tagType: "info" },
  user: { label: "成员", tagType: "default" },
};

const message = useMessage();

const loading = ref(false);
const saving = ref(false);
const items = ref<MemoryRow[]>([]);
const filterScope = ref<MemoryScope | null>(null);
const filterOwnerId = ref("");
const filterSearch = ref("");

const modalOpen = ref(false);
const isEdit = ref(false);
const form = ref<{
  scope: MemoryScope;
  ownerId: string;
  key: string;
  summary: string;
  content: string;
}>({
  scope: "chat",
  ownerId: "",
  key: "",
  summary: "",
  content: "",
});

const visibleItems = computed(() => {
  const kw = filterSearch.value.trim().toLowerCase();

  if (!kw) {
    return items.value;
  }

  return items.value.filter(
    (row) =>
      row.key.toLowerCase().includes(kw) ||
      row.summary.toLowerCase().includes(kw) ||
      row.content.toLowerCase().includes(kw) ||
      row.ownerId.toLowerCase().includes(kw),
  );
});

async function loadMemories() {
  loading.value = true;

  try {
    const qs = new URLSearchParams();

    if (filterScope.value) {
      qs.set("scope", filterScope.value);
    }

    if (filterOwnerId.value.trim()) {
      qs.set("ownerId", filterOwnerId.value.trim());
    }

    const res = await apiFetch<{ items: MemoryRow[] }>(
      `/api/admin/memories?${qs.toString()}`,
    );

    items.value = res.items;
  } catch (err) {
    message.error(err instanceof Error ? err.message : "加载记忆列表失败");
  } finally {
    loading.value = false;
  }
}

function openCreate() {
  isEdit.value = false;
  form.value = {
    scope: "chat",
    ownerId: "",
    key: "",
    summary: "",
    content: "",
  };
  modalOpen.value = true;
}

function openEdit(row: MemoryRow) {
  isEdit.value = true;
  form.value = {
    scope: row.scope,
    ownerId: row.ownerId,
    key: row.key,
    summary: row.summary,
    content: row.content,
  };
  modalOpen.value = true;
}

function handleScopeChange(scope: MemoryScope) {
  form.value.scope = scope;

  if (!isEdit.value) {
    if (scope === "global") {
      form.value.ownerId = "global";
    } else if (form.value.ownerId === "global") {
      form.value.ownerId = "";
    }
  }
}

async function handleSave() {
  const ownerId =
    form.value.scope === "global" ? "global" : form.value.ownerId.trim();

  if (!ownerId || !form.value.key.trim() || !form.value.summary.trim()) {
    message.warning("请填写归属 ID、键名和摘要");

    return;
  }

  saving.value = true;

  try {
    await apiFetch("/api/admin/memories", {
      method: "PUT",
      body: JSON.stringify({
        scope: form.value.scope,
        ownerId,
        key: form.value.key.trim(),
        summary: form.value.summary.trim(),
        content: form.value.content.trim(),
      }),
    });
    modalOpen.value = false;
    message.success("已保存记忆条目");
    await loadMemories();
  } catch (err) {
    message.error(err instanceof Error ? err.message : "保存失败");
  } finally {
    saving.value = false;
  }
}

async function handleDelete(row: MemoryRow) {
  try {
    const qs = new URLSearchParams({
      scope: row.scope,
      ownerId: row.ownerId,
      key: row.key,
    });

    await apiFetch(`/api/admin/memories?${qs.toString()}`, {
      method: "DELETE",
    });
    message.success("已删除记忆");
    await loadMemories();
  } catch (err) {
    message.error(err instanceof Error ? err.message : "删除失败");
  }
}

const columns: DataTableColumns<MemoryRow> = [
  {
    title: "范围",
    key: "scope",
    width: 90,
    render: (row) =>
      h(
        NTag,
        { size: "small", type: SCOPE_META[row.scope].tagType },
        { default: () => SCOPE_META[row.scope].label },
      ),
  },
  {
    title: "归属",
    key: "ownerId",
    width: 145,
    render: (row) => h("span", { class: "mono" }, row.ownerId),
  },
  {
    title: "键名",
    key: "key",
    width: 150,
    render: (row) => h("span", { class: "mono" }, row.key),
  },
  {
    title: "摘要",
    key: "summary",
    minWidth: 190,
    ellipsis: { tooltip: true },
  },
  {
    title: "详情",
    key: "content",
    minWidth: 220,
    ellipsis: { tooltip: true },
  },
  {
    title: "更新时间",
    key: "updatedAt",
    width: 148,
    render: (row) => h("span", { class: "tabular" }, formatTime(row.updatedAt)),
  },
  {
    title: "操作",
    key: "actions",
    width: 120,
    render: (row) =>
      h(
        NSpace,
        { size: 6 },
        {
          default: () => [
            h(
              NButton,
              {
                size: "tiny",
                secondary: true,
                onClick: () => openEdit(row),
              },
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
                    { size: "tiny", quaternary: true, type: "error" },
                    { icon: () => h(Trash2, { size: 12 }) },
                  ),
                default: () => "确定删除这条记忆？",
              },
            ),
          ],
        },
      ),
  },
];

onMounted(() => {
  void loadMemories();
});
</script>

<template>
  <div>
    <div class="page-bar">
      <NSpace align="center" :size="10">
        <h1 class="page-title">长期记忆</h1>
        <NText class="sub-note" depth="3">{{ visibleItems.length }} 条</NText>
      </NSpace>
      <NButton size="small" type="primary" @click="openCreate">
        <template #icon>
          <Plus :size="14" />
        </template>
        新增记忆
      </NButton>
    </div>

    <div class="filter-bar">
      <NSelect
        v-model:value="filterScope"
        class="w-165"
        clearable
        :options="[
          { label: '全局记忆（global）', value: 'global' },
          { label: '群聊记忆（chat）', value: 'chat' },
          { label: '成员记忆（user）', value: 'user' },
        ]"
        placeholder="全部范围"
        size="small"
      />
      <NInput
        v-model:value="filterOwnerId"
        class="w-210"
        clearable
        placeholder="归属 ID，例如 group:10248888"
        size="small"
        @keyup.enter="loadMemories"
      />
      <NInput
        v-model:value="filterSearch"
        class="w-190"
        clearable
        placeholder="关键词筛选"
        size="small"
      />
      <NButton :loading size="small" @click="loadMemories">
        <template #icon>
          <RefreshCw :size="14" />
        </template>
        查询
      </NButton>
    </div>

    <NCard size="small">
      <NDataTable
        :columns
        :data="visibleItems"
        :loading
        :pagination="{ pageSize: 20 }"
        :scroll-x="900"
        size="small"
      />
    </NCard>

    <NModal
      v-model:show="modalOpen"
      class="modal-md"
      preset="card"
      :title="isEdit ? '编辑记忆' : '新增记忆'"
    >
      <NForm label-placement="top" size="small">
        <NFormItem label="范围">
          <NSelect
            :disabled="isEdit"
            :options="[
              { label: '全局记忆（global）', value: 'global' },
              { label: '群聊记忆（chat）', value: 'chat' },
              { label: '成员记忆（user）', value: 'user' },
            ]"
            :value="form.scope"
            @update:value="handleScopeChange"
          />
        </NFormItem>
        <NFormItem
          label="归属 ID（全局固定 global，群聊用 group:群号，成员用 QQ 号）"
        >
          <NInput
            v-model:value="form.ownerId"
            :disabled="isEdit || form.scope === 'global'"
          />
        </NFormItem>
        <NFormItem label="记忆键名">
          <NInput
            v-model:value="form.key"
            :disabled="isEdit"
            placeholder="例如 alert_channel"
          />
        </NFormItem>
        <NFormItem label="一句话摘要">
          <NInput v-model:value="form.summary" />
        </NFormItem>
        <NFormItem label="完整内容">
          <NInput v-model:value="form.content" :rows="4" type="textarea" />
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
