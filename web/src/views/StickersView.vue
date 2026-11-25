<script setup lang="ts">
import { Check, RefreshCw, Trash2, Upload } from "@lucide/vue";
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
  NText,
  useMessage,
} from "naive-ui";
import { h, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";

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
  reviewedBy: string | null;
  reviewedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

const route = useRoute();
const router = useRouter();
const message = useMessage();

const parseStatus = (raw: unknown): StickerStatus | null =>
  raw === "approved" || raw === "pending" ? raw : null;

const loading = ref(false);
const saving = ref(false);
const items = ref<StickerRow[]>([]);
const filterStatus = ref<StickerStatus | null>(parseStatus(route.query.status));
const filterSearch = ref(
  typeof route.query.q === "string" ? route.query.q : "",
);

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

const uploadModalOpen = ref(false);
const uploading = ref(false);
const fileInputRef = ref<HTMLInputElement | null>(null);
const uploadForm = ref({
  dataUrl: "",
  filename: "",
  meaning: "",
  tags: [] as string[],
  status: "approved",
  enabled: true,
});

function openUpload() {
  uploadForm.value = {
    dataUrl: "",
    filename: "",
    meaning: "",
    tags: [],
    status: "approved",
    enabled: true,
  };
  if (fileInputRef.value) {
    fileInputRef.value.value = "";
  }

  uploadModalOpen.value = true;
}

function readPickedFile(file: File | undefined) {
  if (!file) {
    return;
  }

  if (file.size > 8 * 1024 * 1024) {
    message.warning("图片大小不能超过 8 MB");

    return;
  }

  const reader = new FileReader();

  reader.addEventListener("load", () => {
    if (typeof reader.result === "string") {
      uploadForm.value.dataUrl = reader.result;
      uploadForm.value.filename = file.name || "clipboard-image.png";
    }
  });
  reader.readAsDataURL(file);
}

function handleFileChange(event: Event) {
  const input = event.target as HTMLInputElement;

  readPickedFile(input.files?.[0]);
}

function handleDrop(event: DragEvent) {
  readPickedFile(event.dataTransfer?.files[0]);
}

function extractClipboardImage(event: ClipboardEvent): File | null {
  const items = event.clipboardData?.items;

  if (items) {
    for (const item of items) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const file = item.getAsFile();

        if (file) {
          return file;
        }
      }
    }
  }

  const files = event.clipboardData?.files;

  if (files) {
    for (const file of files) {
      if (file.type.startsWith("image/")) {
        return file;
      }
    }
  }

  return null;
}

function handlePaste(event: ClipboardEvent) {
  if (modalOpen.value) {
    return;
  }

  const image = extractClipboardImage(event);

  if (!image) {
    return;
  }

  event.preventDefault();
  if (!uploadModalOpen.value) {
    openUpload();
  }

  readPickedFile(image);
}

async function handleUpload() {
  if (!uploadForm.value.dataUrl) {
    message.warning("请先选择一张图片");

    return;
  }

  uploading.value = true;

  try {
    const res = await apiFetch<{ created: boolean }>(
      "/api/admin/stickers/upload",
      {
        method: "POST",
        body: JSON.stringify(uploadForm.value),
      },
    );

    uploadModalOpen.value = false;
    message.success(
      res.created ? "已上传并上架表情包" : "表情包已存在，已更新信息",
    );
    await loadStickers();
  } catch (err) {
    message.error(err instanceof Error ? err.message : "上传失败");
  } finally {
    uploading.value = false;
  }
}

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
    title: "审核人",
    key: "reviewedBy",
    width: 110,
    ellipsis: { tooltip: true },
    render: (row) => {
      if (!row.reviewedBy) {
        return h(NText, { depth: 3 }, { default: () => "—" });
      }

      return row.reviewedAt
        ? h(
            "span",
            { title: `${row.reviewedBy} · ${formatTime(row.reviewedAt)}` },
            row.reviewedBy,
          )
        : row.reviewedBy;
    },
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
  void loadStickers();
}

watch(filterStatus, () => {
  syncQuery();
  void loadStickers();
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
      void loadStickers();
    }
  },
);

onMounted(() => {
  window.addEventListener("paste", handlePaste);
  void loadStickers();
});

onUnmounted(() => {
  window.removeEventListener("paste", handlePaste);
});
</script>

<template>
  <div>
    <div class="page-bar">
      <NSpace align="center" :size="10">
        <h1 class="page-title">表情包库</h1>
        <NText class="sub-note tabular" depth="3">{{ items.length }} 张</NText>
      </NSpace>
      <NButton size="small" type="primary" @click="openUpload">
        <template #icon>
          <Upload :size="14" />
        </template>
        上传表情包
      </NButton>
    </div>

    <div class="filter-bar">
      <NSelect
        v-model:value="filterStatus"
        class="w-135"
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
        class="w-220"
        clearable
        placeholder="搜含义 / 标签 / 审核人"
        size="small"
        @clear="handleSearch"
        @keyup.enter="handleSearch"
      />
      <NButton :loading size="small" @click="handleSearch">
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
        :scroll-x="1030"
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

    <NModal
      v-model:show="uploadModalOpen"
      class="modal-md"
      preset="card"
      title="上传表情包"
    >
      <NForm label-placement="top" size="small">
        <NFormItem label="图片文件（PNG / JPG / GIF / WebP，最大 8 MB）">
          <div
            class="upload-dropzone"
            @click="fileInputRef?.click()"
            @dragover.prevent
            @drop.prevent="handleDrop"
          >
            <input
              ref="fileInputRef"
              accept="image/png,image/jpeg,image/gif,image/webp"
              class="hidden-file-input"
              type="file"
              @change="handleFileChange"
            />
            <img
              v-if="uploadForm.dataUrl"
              alt="表情包预览"
              class="upload-preview"
              :src="uploadForm.dataUrl"
            />
            <div class="upload-meta">
              <NText strong>
                {{
                  uploadForm.filename || "点击选择、拖拽或直接 Ctrl+V 粘贴图片"
                }}
              </NText>
              <NText class="sub-note" depth="3">
                {{
                  uploadForm.dataUrl
                    ? "点击、拖拽或 Ctrl+V 可替换图片"
                    : "支持在弹窗内或表情包库页面直接粘贴剪贴板图片"
                }}
              </NText>
            </div>
          </div>
        </NFormItem>
        <NFormItem label="含义描述">
          <NInput
            v-model:value="uploadForm.meaning"
            maxlength="180"
            placeholder="例如：「回应了你的消息」整活梗图，留空默认使用文件名"
            :rows="2"
            show-count
            type="textarea"
          />
        </NFormItem>
        <NFormItem label="情绪标签">
          <NDynamicTags v-model:value="uploadForm.tags" />
        </NFormItem>
        <NSpace :size="20">
          <NFormItem label="审核状态">
            <NSelect
              v-model:value="uploadForm.status"
              class="w-135"
              :options="[
                { label: '已通过', value: 'approved' },
                { label: '待审核', value: 'pending' },
              ]"
            />
          </NFormItem>
          <NFormItem label="立即启用">
            <NSwitch v-model:value="uploadForm.enabled" />
          </NFormItem>
        </NSpace>
        <NSpace justify="end">
          <NButton @click="uploadModalOpen = false">取消</NButton>
          <NButton
            :disabled="!uploadForm.dataUrl"
            :loading="uploading"
            type="primary"
            @click="handleUpload"
          >
            上传并上架
          </NButton>
        </NSpace>
      </NForm>
    </NModal>
  </div>
</template>

<style scoped>
.upload-dropzone {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px 16px;
  border: 1px dashed var(--berry-border);
  border-radius: 8px;
  background: var(--berry-inset);
  cursor: pointer;
  transition: border-color 0.15s ease;
}

.upload-dropzone:hover {
  border-color: var(--berry-accent, #e11d48);
}

.hidden-file-input {
  display: none;
}

.upload-preview {
  width: 64px;
  height: 64px;
  object-fit: contain;
  border-radius: 6px;
  background: var(--berry-surface);
  flex-shrink: 0;
}

.upload-meta {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
</style>
