<script setup lang="ts">
import { Code, Eye, FilePlus, RefreshCw, Save, Trash2 } from "@lucide/vue";
import {
  NButton,
  NCard,
  NEmpty,
  NForm,
  NFormItem,
  NInput,
  NModal,
  NPopconfirm,
  NRadioButton,
  NRadioGroup,
  NSpace,
  NTag,
  NText,
  useMessage,
} from "naive-ui";
import { computed, onMounted, ref } from "vue";

import { apiFetch } from "../api/client.ts";
import MarkdownPreview from "../components/MarkdownPreview.vue";
import { formatBytes, formatTime } from "../utils/format.ts";

interface DocFileRow {
  scope: "knowledge" | "notebook";
  path: string;
  sizeBytes: number;
  updatedAt: number;
}

const message = useMessage();

const loadingList = ref(false);
const loadingDoc = ref(false);
const saving = ref(false);
const files = ref<DocFileRow[]>([]);
const activeScope = ref<"knowledge" | "notebook">("knowledge");
const searchText = ref("");

const selectedFile = ref<DocFileRow | null>(null);
const content = ref("");
const dirty = ref(false);
const notebookMode = ref<"edit" | "preview">("edit");
const showKnowledgeRaw = ref(false);

const newModalOpen = ref(false);
const newPath = ref("");

const filteredFiles = computed(() => {
  const kw = searchText.value.trim().toLowerCase();

  return files.value.filter((f) => {
    if (f.scope !== activeScope.value) {
      return false;
    }

    return !kw || f.path.toLowerCase().includes(kw);
  });
});

async function loadFiles() {
  loadingList.value = true;

  try {
    const res = await apiFetch<{ items: DocFileRow[] }>("/api/admin/docs");

    files.value = res.items;

    if (selectedFile.value) {
      const exists = res.items.some(
        (f) =>
          f.scope === selectedFile.value?.scope &&
          f.path === selectedFile.value?.path,
      );

      if (!exists) {
        selectedFile.value = null;
        content.value = "";
        dirty.value = false;
      }
    }
  } catch (err) {
    message.error(err instanceof Error ? err.message : "加载文件目录失败");
  } finally {
    loadingList.value = false;
  }
}

async function selectFile(file: DocFileRow) {
  loadingDoc.value = true;
  selectedFile.value = file;
  showKnowledgeRaw.value = false;

  try {
    const qs = new URLSearchParams({
      scope: file.scope,
      path: file.path,
    });
    const res = await apiFetch<{
      scope: "knowledge" | "notebook";
      path: string;
      content: string;
    }>(`/api/admin/docs/content?${qs.toString()}`);

    content.value = res.content;
    dirty.value = false;
  } catch (err) {
    message.error(err instanceof Error ? err.message : "读取文档失败");
  } finally {
    loadingDoc.value = false;
  }
}

async function handleSave() {
  if (selectedFile.value?.scope !== "notebook") {
    return;
  }

  saving.value = true;

  try {
    await apiFetch("/api/admin/docs/content", {
      method: "PUT",
      body: JSON.stringify({
        path: selectedFile.value.path,
        content: content.value,
      }),
    });
    dirty.value = false;
    message.success("笔记已保存");
    await loadFiles();
  } catch (err) {
    message.error(err instanceof Error ? err.message : "保存失败");
  } finally {
    saving.value = false;
  }
}

async function handleDelete() {
  if (selectedFile.value?.scope !== "notebook") {
    return;
  }

  try {
    await apiFetch(
      `/api/admin/docs/content?path=${encodeURIComponent(selectedFile.value.path)}`,
      { method: "DELETE" },
    );
    selectedFile.value = null;
    content.value = "";
    dirty.value = false;
    message.success("笔记已删除");
    await loadFiles();
  } catch (err) {
    message.error(err instanceof Error ? err.message : "删除失败");
  }
}

async function handleCreateNote() {
  const path = newPath.value.trim().replace(/^\/+/, "");

  if (!path) {
    message.warning("请填写笔记相对路径");

    return;
  }

  const normalized = path.endsWith(".md") ? path : `${path}.md`;

  saving.value = true;

  try {
    await apiFetch("/api/admin/docs/content", {
      method: "PUT",
      body: JSON.stringify({
        path: normalized,
        content: `# ${normalized.replace(/\.md$/, "")}\n\n`,
      }),
    });
    newModalOpen.value = false;
    newPath.value = "";
    activeScope.value = "notebook";
    await loadFiles();
    const target = files.value.find(
      (f) => f.scope === "notebook" && f.path === normalized,
    );

    if (target) {
      await selectFile(target);
    }

    message.success("已创建笔记");
  } catch (err) {
    message.error(err instanceof Error ? err.message : "创建失败");
  } finally {
    saving.value = false;
  }
}

onMounted(async () => {
  await loadFiles();

  const first = files.value.find((f) => f.scope === activeScope.value);

  if (first) {
    await selectFile(first);
  }
});
</script>

<template>
  <div>
    <div class="page-bar">
      <h1 class="page-title">资料库</h1>
      <NSpace :size="8">
        <NButton :loading="loadingList" size="small" @click="loadFiles">
          <template #icon>
            <RefreshCw :size="14" />
          </template>
          刷新目录
        </NButton>
        <NButton size="small" type="primary" @click="newModalOpen = true">
          <template #icon>
            <FilePlus :size="14" />
          </template>
          新建笔记
        </NButton>
      </NSpace>
    </div>

    <div class="docs-grid">
      <NCard class="docs-sidebar" size="small">
        <NRadioGroup
          v-model:value="activeScope"
          class="scope-switch"
          size="small"
        >
          <NRadioButton class="scope-btn" value="knowledge">
            只读知识库
          </NRadioButton>
          <NRadioButton class="scope-btn" value="notebook">
            树莓娘笔记
          </NRadioButton>
        </NRadioGroup>

        <NInput
          v-model:value="searchText"
          class="my-sm"
          clearable
          placeholder="筛选文件名"
          size="small"
        />

        <NEmpty
          v-if="filteredFiles.length === 0"
          class="my-lg"
          description="当前分类暂无文档"
        />

        <div class="file-list">
          <button
            v-for="file in filteredFiles"
            :key="`${file.scope}:${file.path}`"
            class="file-item"
            :class="{
              active:
                selectedFile?.scope === file.scope &&
                selectedFile?.path === file.path,
            }"
            type="button"
            @click="selectFile(file)"
          >
            <div class="file-path mono">{{ file.path }}</div>
            <div class="file-meta tabular">
              {{ formatBytes(file.sizeBytes) }} ·
              {{ formatTime(file.updatedAt) }}
            </div>
          </button>
        </div>
      </NCard>

      <NCard class="docs-viewer" size="small">
        <template v-if="selectedFile">
          <div class="viewer-header">
            <NSpace align="center" :size="8">
              <NTag
                size="small"
                :type="selectedFile.scope === 'knowledge' ? 'info' : 'primary'"
              >
                {{
                  selectedFile.scope === "knowledge"
                    ? "只读知识库"
                    : "树莓娘笔记"
                }}
              </NTag>
              <NText class="mono" strong>{{ selectedFile.path }}</NText>
              <NTag v-if="dirty" size="tiny" type="warning">未保存</NTag>
            </NSpace>

            <NSpace :size="8">
              <NButton
                v-if="selectedFile.scope === 'knowledge'"
                size="small"
                @click="showKnowledgeRaw = !showKnowledgeRaw"
              >
                <template #icon>
                  <Code v-if="!showKnowledgeRaw" :size="14" />
                  <Eye v-else :size="14" />
                </template>
                {{ showKnowledgeRaw ? "渲染预览" : "查看源码" }}
              </NButton>

              <template v-if="selectedFile.scope === 'notebook'">
                <NButton
                  size="small"
                  @click="
                    notebookMode = notebookMode === 'edit' ? 'preview' : 'edit'
                  "
                >
                  <template #icon>
                    <Eye v-if="notebookMode === 'edit'" :size="14" />
                    <Code v-else :size="14" />
                  </template>
                  {{ notebookMode === "edit" ? "预览" : "编辑" }}
                </NButton>
                <NButton
                  :loading="saving"
                  size="small"
                  type="primary"
                  @click="handleSave"
                >
                  <template #icon>
                    <Save :size="14" />
                  </template>
                  保存
                </NButton>
                <NPopconfirm @positive-click="handleDelete">
                  <template #trigger>
                    <NButton quaternary size="small" type="error">
                      <template #icon>
                        <Trash2 :size="14" />
                      </template>
                    </NButton>
                  </template>
                  确定删除笔记 {{ selectedFile.path }} ？
                </NPopconfirm>
              </template>
            </NSpace>
          </div>

          <div v-if="selectedFile.scope === 'knowledge'">
            <pre v-if="showKnowledgeRaw" class="code-block">{{ content }}</pre>
            <MarkdownPreview v-else :source="content" />
          </div>

          <div v-else>
            <NInput
              v-if="notebookMode === 'edit'"
              v-model:value="content"
              :autosize="{ minRows: 16, maxRows: 32 }"
              class="mono"
              type="textarea"
              @update:value="dirty = true"
            />
            <MarkdownPreview v-else :source="content" />
          </div>
        </template>

        <NEmpty
          v-else
          class="py-empty"
          description="从左侧选择一份文档或新建笔记"
        />
      </NCard>
    </div>

    <NModal
      v-model:show="newModalOpen"
      class="modal-sm"
      preset="card"
      title="新建笔记"
    >
      <NForm label-placement="top" size="small">
        <NFormItem label="文件相对路径（存储在 data/notebooks 下）">
          <NInput
            v-model:value="newPath"
            placeholder="例如 meeting-notes/2026-11.md"
            @keyup.enter="handleCreateNote"
          />
        </NFormItem>
        <NSpace justify="end">
          <NButton @click="newModalOpen = false">取消</NButton>
          <NButton :loading="saving" type="primary" @click="handleCreateNote">
            创建
          </NButton>
        </NSpace>
      </NForm>
    </NModal>
  </div>
</template>

<style scoped>
.scope-switch {
  display: flex;
  width: 100%;
}

.scope-btn {
  flex: 1;
  text-align: center;
}

.docs-grid {
  display: grid;
  grid-template-columns: 290px minmax(0, 1fr);
  gap: 14px;
  align-items: start;
}

.file-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 68vh;
  overflow-y: auto;
}

.file-item {
  width: 100%;
  text-align: left;
  padding: 8px 10px;
  border-radius: 6px;
  border: 1px solid transparent;
  background: transparent;
  color: inherit;
  cursor: pointer;
}

.file-item:hover {
  background: var(--berry-inset);
}

.file-item.active {
  background: var(--berry-inset);
  border-color: var(--berry-border);
}

.file-path {
  font-size: 12px;
  font-weight: 600;
  word-break: break-all;
}

.file-meta {
  font-size: 11px;
  color: var(--berry-muted);
  margin-top: 2px;
}

.viewer-header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding-bottom: 12px;
  margin-bottom: 12px;
  border-bottom: 1px solid var(--berry-border);
}

@media (max-width: 860px) {
  .docs-grid {
    grid-template-columns: 1fr;
  }
}
</style>
