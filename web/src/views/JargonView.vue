<script setup lang="ts">
import { Check, Plus, RefreshCw, Sparkles, Trash2 } from "@lucide/vue";
import type { DataTableColumns } from "naive-ui";
import {
  NButton,
  NCard,
  NDataTable,
  NDynamicTags,
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
import { computed, h, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";

import { apiFetch } from "../api/client.ts";
import { useChatOptions } from "../composables/useChatOptions.ts";
import { formatTime } from "../utils/format.ts";

type JargonStatus = "approved" | "pending";

interface JargonRow {
  id: number;
  term: string;
  aliases: string[];
  meaning: string;
  status: JargonStatus;
  source: "manual" | "auto";
  createdAt: number;
  updatedAt: number;
}

const route = useRoute();
const router = useRouter();
const message = useMessage();
const { chats } = useChatOptions();

const parseStatus = (raw: unknown): JargonStatus | null =>
  raw === "approved" || raw === "pending" ? raw : null;

const loading = ref(false);
const saving = ref(false);
const distilling = ref(false);
const items = ref<JargonRow[]>([]);
const filterStatus = ref<JargonStatus | null>(parseStatus(route.query.status));
const filterSearch = ref(
  typeof route.query.q === "string" ? route.query.q : "",
);
const distillChatKey = ref<string | null>(null);

const groupOptions = computed(() =>
  chats.value
    .filter((c) => c.kind === "group")
    .map((c) => ({
      label: c.title ? `${c.title} (${c.chatKey})` : c.chatKey,
      value: c.chatKey,
    })),
);

async function loadJargon() {
  loading.value = true;

  try {
    const params = new URLSearchParams();

    if (filterStatus.value) {
      params.set("status", filterStatus.value);
    }

    if (filterSearch.value.trim()) {
      params.set("search", filterSearch.value.trim());
    }

    const qs = params.toString();
    const res = await apiFetch<{ items: JargonRow[] }>(
      `/api/admin/jargon${qs ? `?${qs}` : ""}`,
    );

    items.value = res.items;
  } catch (err) {
    message.error(err instanceof Error ? err.message : "加载黑话词典失败");
  } finally {
    loading.value = false;
  }
}

const modalOpen = ref(false);
const editingId = ref<number | null>(null);
const form = ref({
  term: "",
  aliases: [] as string[],
  meaning: "",
  status: "approved",
});

function openCreate() {
  editingId.value = null;
  form.value = {
    term: "",
    aliases: [],
    meaning: "",
    status: "approved",
  };
  modalOpen.value = true;
}

function openEdit(row: JargonRow) {
  editingId.value = row.id;
  form.value = {
    term: row.term,
    aliases: [...row.aliases],
    meaning: row.meaning,
    status: row.status,
  };
  modalOpen.value = true;
}

async function handleSave() {
  if (!form.value.term.trim() || !form.value.meaning.trim()) {
    message.warning("请填写词条和释义");

    return;
  }

  saving.value = true;

  try {
    if (editingId.value === null) {
      await apiFetch("/api/admin/jargon", {
        method: "POST",
        body: JSON.stringify(form.value),
      });
    } else {
      await apiFetch(`/api/admin/jargon/${editingId.value}`, {
        method: "PATCH",
        body: JSON.stringify(form.value),
      });
    }

    modalOpen.value = false;
    message.success("黑话词条已保存");
    await loadJargon();
  } catch (err) {
    message.error(err instanceof Error ? err.message : "保存词条失败");
  } finally {
    saving.value = false;
  }
}

async function handleApprove(row: JargonRow) {
  try {
    await apiFetch(`/api/admin/jargon/${row.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "approved" }),
    });
    message.success(`已启用词条「${row.term}」`);
    await loadJargon();
  } catch (err) {
    message.error(err instanceof Error ? err.message : "审核失败");
  }
}

async function handleDelete(row: JargonRow) {
  try {
    await apiFetch(`/api/admin/jargon/${row.id}`, { method: "DELETE" });
    message.success("词条已删除");
    await loadJargon();
  } catch (err) {
    message.error(err instanceof Error ? err.message : "删除失败");
  }
}

async function handleDistill() {
  const target = distillChatKey.value ?? groupOptions.value[0]?.value;

  if (!target) {
    message.warning("请先选择要提炼黑话的群聊");

    return;
  }

  distilling.value = true;

  try {
    const res = await apiFetch<{
      ok: boolean;
      inserted: number;
      totalExtracted: number;
    }>("/api/admin/jargon/distill", {
      method: "POST",
      body: JSON.stringify({ chatKey: target }),
    });

    message.success(
      `提炼完成：识别 ${res.totalExtracted} 条，新增 ${res.inserted} 条`,
    );
    await loadJargon();
  } catch (err) {
    message.error(err instanceof Error ? err.message : "提炼黑话失败");
  } finally {
    distilling.value = false;
  }
}

const columns: DataTableColumns<JargonRow> = [
  {
    title: "词条",
    key: "term",
    width: 140,
    render: (row) => h("span", { class: "mono" }, row.term),
  },
  {
    title: "别名",
    key: "aliases",
    width: 150,
    ellipsis: { tooltip: true },
    render: (row) => (row.aliases.length > 0 ? row.aliases.join("、") : "—"),
  },
  {
    title: "释义",
    key: "meaning",
    minWidth: 260,
    ellipsis: { tooltip: true },
  },
  {
    title: "状态",
    key: "status",
    width: 90,
    render: (row) =>
      h(
        NTag,
        {
          size: "tiny",
          bordered: false,
          type: row.status === "approved" ? "success" : "warning",
        },
        { default: () => (row.status === "approved" ? "已启用" : "待审核") },
      ),
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
    width: 150,
    render: (row) =>
      h(NSpace, { size: 4, wrap: false }, () => [
        ...(row.status === "pending"
          ? [
              h(
                NButton,
                {
                  size: "tiny",
                  secondary: true,
                  type: "success",
                  onClick: () => {
                    void handleApprove(row);
                  },
                },
                {
                  icon: () => h(Check, { size: 12 }),
                  default: () => "通过",
                },
              ),
            ]
          : []),
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
            default: () => "确定删除这条黑话？",
          },
        ),
      ]),
  },
];

function syncQuery() {
  const nextQuery: Record<string, string> = {};

  if (filterStatus.value) {
    nextQuery.status = filterStatus.value;
  }

  if (filterSearch.value.trim()) {
    nextQuery.q = filterSearch.value.trim();
  }

  void router.replace({ query: nextQuery });
}

function handleSearch() {
  syncQuery();
  void loadJargon();
}

watch(filterStatus, () => {
  syncQuery();
  void loadJargon();
});

watch(
  () => route.query,
  (q) => {
    const nextStatus = parseStatus(q.status);
    const nextSearch = typeof q.q === "string" ? q.q : "";

    if (nextStatus !== filterStatus.value) {
      filterStatus.value = nextStatus;
    }

    if (nextSearch !== filterSearch.value) {
      filterSearch.value = nextSearch;
      void loadJargon();
    }
  },
);

onMounted(() => {
  void loadJargon();
});
</script>

<template>
  <div>
    <div class="page-bar">
      <NSpace align="center" :size="10">
        <h1 class="page-title">群内黑话</h1>
        <NText class="sub-note tabular" depth="3">
          {{ items.length }} 条 · 全局生效
        </NText>
      </NSpace>
      <NButton size="small" type="primary" @click="openCreate">
        <template #icon>
          <Plus :size="14" />
        </template>
        新增词条
      </NButton>
    </div>

    <div class="filter-bar">
      <NSelect
        v-model:value="filterStatus"
        class="w-120"
        clearable
        :options="[
          { label: '已启用', value: 'approved' },
          { label: '待审核', value: 'pending' },
        ]"
        placeholder="全部状态"
        size="small"
      />
      <NInput
        v-model:value="filterSearch"
        class="w-190"
        clearable
        placeholder="搜词条/别名/释义"
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
        v-model:value="distillChatKey"
        class="w-200"
        clearable
        filterable
        :options="groupOptions"
        placeholder="选群提炼黑话"
        size="small"
      />
      <NButton
        :loading="distilling"
        secondary
        size="small"
        @click="handleDistill"
      >
        <template #icon>
          <Sparkles :size="13" />
        </template>
        提炼黑话
      </NButton>
    </div>

    <NCard size="small">
      <NDataTable
        :columns
        :data="items"
        :loading
        :pagination="{ pageSize: 20 }"
        :scroll-x="760"
        size="small"
      />
    </NCard>

    <NModal
      v-model:show="modalOpen"
      class="modal-md"
      preset="card"
      :title="editingId === null ? '新增黑话词条' : '编辑黑话词条'"
    >
      <NForm label-placement="top" size="small">
        <NFormItem label="词条">
          <NInput
            v-model:value="form.term"
            maxlength="48"
            placeholder="例如：群呆唯、炼丹、小登"
          />
        </NFormItem>
        <NFormItem label="别名 / 触发词（可选）">
          <NDynamicTags v-model:value="form.aliases" />
        </NFormItem>
        <NFormItem label="释义">
          <NInput
            v-model:value="form.meaning"
            maxlength="240"
            placeholder="一句说清在群里的具体含义"
            :rows="3"
            show-count
            type="textarea"
          />
        </NFormItem>
        <NFormItem label="状态">
          <NSelect
            v-model:value="form.status"
            :options="[
              { label: '已启用（命中即注入）', value: 'approved' },
              { label: '待审核（暂不注入）', value: 'pending' },
            ]"
          />
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
