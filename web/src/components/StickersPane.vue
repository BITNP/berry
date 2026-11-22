<script setup lang="ts">
import { Check, RefreshCw, Trash2 } from "@lucide/vue";
import type { DataTableColumns } from "naive-ui";
import {
  NButton,
  NCard,
  NDataTable,
  NDynamicTags,
  NForm,
  NFormItem,
  NImage,
  NInput,
  NModal,
  NPopconfirm,
  NSelect,
  NSpace,
  NSwitch,
  NTag,
  useMessage,
} from "naive-ui";
import { h, onMounted, ref, watch } from "vue";

import { apiFetch } from "../api/client.ts";
import { formatTime } from "../utils/format.ts";

type StickerStatus = "approved" | "pending";

interface StickerRow {
  id: number;
  sha256: string;
  filePath: string;
  mimeType: string;
  meaning: string;
  tags: string[];
  sourceChatKey: string;
  status: StickerStatus;
  enabled: boolean;
  useCount: number;
  createdAt: number;
  updatedAt: number;
}

const message = useMessage();

const loading = ref(false);
const saving = ref(false);
const items = ref<StickerRow[]>([]);
const filterStatus = ref<StickerStatus | null>(null);
const filterSearch = ref("");

async function loadStickers() {
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
    const res = await apiFetch<{ items: StickerRow[] }>(
      `/api/admin/stickers${qs ? `?${qs}` : ""}`,
    );

    items.value = res.items;
  } catch (err) {
    message.error(err instanceof Error ? err.message : "加载表情包库失败");
  } finally {
    loading.value = false;
  }
}

const modalOpen = ref(false);
const editingId = ref<number | null>(null);
const form = ref({
  meaning: "",
  tags: [] as string[],
  status: "approved",
  enabled: true,
});

function openEdit(row: StickerRow) {
  editingId.value = row.id;
  form.value = {
    meaning: row.meaning,
    tags: [...row.tags],
    status: row.status,
    enabled: row.enabled,
  };
  modalOpen.value = true;
}

async function handleSave() {
  if (editingId.value === null) {
    return;
  }

  saving.value = true;

  try {
    await apiFetch(`/api/admin/stickers/${editingId.value}`, {
      method: "PATCH",
      body: JSON.stringify(form.value),
    });
    modalOpen.value = false;
    message.success("表情包已更新");
    await loadStickers();
  } catch (err) {
    message.error(err instanceof Error ? err.message : "更新失败");
  } finally {
    saving.value = false;
  }
}

async function patchSticker(
  row: StickerRow,
  patch: Partial<{ status: StickerStatus; enabled: boolean }>,
) {
  try {
    const updated = await apiFetch<StickerRow>(
      `/api/admin/stickers/${row.id}`,
      {
        method: "PATCH",
        body: JSON.stringify(patch),
      },
    );

    Object.assign(row, updated);
    message.success("已更新");
  } catch (err) {
    message.error(err instanceof Error ? err.message : "更新失败");
  }
}

async function handleDelete(row: StickerRow) {
  try {
    await apiFetch(`/api/admin/stickers/${row.id}`, { method: "DELETE" });
    message.success("已删除表情包");
    await loadStickers();
  } catch (err) {
    message.error(err instanceof Error ? err.message : "删除失败");
  }
}

const columns: DataTableColumns<StickerRow> = [
  {
    title: "预览",
    key: "preview",
    width: 72,
    render: (row) =>
      h(NImage, {
        src: `/api/admin/stickers/${row.id}/file`,
        width: 48,
        height: 48,
        objectFit: "contain",
        style: "border-radius: 6px; background: var(--bg-soft);",
      }),
  },
  {
    title: "识图含义",
    key: "meaning",
    minWidth: 220,
    ellipsis: { tooltip: true },
  },
  {
    title: "情绪标签",
    key: "tags",
    width: 180,
    render: (row) =>
      h(NSpace, { size: 4 }, () =>
        row.tags.map((tag) =>
          h(NTag, { size: "tiny", bordered: false }, { default: () => tag }),
        ),
      ),
  },
  {
    title: "审核",
    key: "status",
    width: 85,
    render: (row) =>
      h(
        NTag,
        {
          size: "tiny",
          bordered: false,
          type: row.status === "approved" ? "success" : "warning",
        },
        { default: () => (row.status === "approved" ? "已通过" : "待审核") },
      ),
  },
  {
    title: "启用",
    key: "enabled",
    width: 70,
    render: (row) =>
      h(NSwitch, {
        size: "small",
        value: row.enabled,
        onUpdateValue: (val: boolean) => {
          void patchSticker(row, { enabled: val });
        },
      }),
  },
  {
    title: "使用",
    key: "useCount",
    width: 65,
  },
  {
    title: "收录时间",
    key: "updatedAt",
    width: 115,
    render: (row) => formatTime(row.updatedAt),
  },
  {
    title: "操作",
    key: "actions",
    width: 155,
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
                    void patchSticker(row, { status: "approved" });
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
            default: () => "确定删除这张表情包？",
          },
        ),
      ]),
  },
];

watch(filterStatus, () => {
  void loadStickers();
});

onMounted(() => {
  void loadStickers();
});
</script>

<template>
  <div>
    <div class="filter-bar">
      <NSelect
        v-model:value="filterStatus"
        class="w-130"
        clearable
        :options="[
          { label: '已通过', value: 'approved' },
          { label: '待审核', value: 'pending' },
        ]"
        placeholder="全部审核状态"
        size="small"
      />
      <NInput
        v-model:value="filterSearch"
        class="w-200"
        clearable
        placeholder="搜含义或情绪标签"
        size="small"
        @keyup.enter="loadStickers"
      />
      <NButton :loading size="small" @click="loadStickers">
        <template #icon>
          <RefreshCw :size="14" />
        </template>
        刷新
      </NButton>
    </div>

    <NCard size="small">
      <NDataTable
        :columns
        :data="items"
        :loading
        :pagination="{ pageSize: 20 }"
        :scroll-x="920"
        size="small"
      />
    </NCard>

    <NModal
      v-model:show="modalOpen"
      class="modal-md"
      preset="card"
      title="编辑表情包"
    >
      <NForm label-placement="top" size="small">
        <NFormItem label="含义描述">
          <NInput
            v-model:value="form.meaning"
            maxlength="200"
            :rows="3"
            show-count
            type="textarea"
          />
        </NFormItem>
        <NFormItem label="情绪标签">
          <NDynamicTags v-model:value="form.tags" />
        </NFormItem>
        <NFormItem label="审核状态">
          <NSelect
            v-model:value="form.status"
            :options="[
              { label: '已通过', value: 'approved' },
              { label: '待审核', value: 'pending' },
            ]"
          />
        </NFormItem>
        <NFormItem label="启用">
          <NSwitch v-model:value="form.enabled" />
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
