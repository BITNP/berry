<script setup lang="ts">
import { Code, ExternalLink, Eye, RefreshCw } from "@lucide/vue";
import {
  NButton,
  NCard,
  NEmpty,
  NInput,
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
  path: string;
  sizeBytes: number;
  updatedAt: number;
}

const message = useMessage();

const loadingList = ref(false);
const loadingDoc = ref(false);
const files = ref<DocFileRow[]>([]);
const bunkoConfigured = ref(false);
const bunkoWorkspaceUrl = ref("");
const searchText = ref("");

const selectedFile = ref<DocFileRow | null>(null);
const content = ref("");
const showRaw = ref(false);

const filteredFiles = computed(() => {
  const kw = searchText.value.trim().toLowerCase();

  return files.value.filter((f) => !kw || f.path.toLowerCase().includes(kw));
});

async function loadFiles() {
  loadingList.value = true;

  try {
    const res = await apiFetch<{
      items: DocFileRow[];
      bunkoConfigured: boolean;
      bunkoWorkspaceUrl: string;
    }>("/api/admin/docs");

    files.value = res.items;
    bunkoConfigured.value = res.bunkoConfigured;
    bunkoWorkspaceUrl.value = res.bunkoWorkspaceUrl;

    if (selectedFile.value) {
      const exists = res.items.some((f) => f.path === selectedFile.value?.path);

      if (!exists) {
        selectedFile.value = null;
        content.value = "";
      }
    }
  } catch (err) {
    message.error(err instanceof Error ? err.message : "加载知识库目录失败");
  } finally {
    loadingList.value = false;
  }
}

async function selectFile(file: DocFileRow) {
  loadingDoc.value = true;
  selectedFile.value = file;
  showRaw.value = false;

  try {
    const qs = new URLSearchParams({ path: file.path });
    const res = await apiFetch<{ path: string; content: string }>(
      `/api/admin/docs/content?${qs.toString()}`,
    );

    content.value = res.content;
  } catch (err) {
    message.error(err instanceof Error ? err.message : "读取文档失败");
  } finally {
    loadingDoc.value = false;
  }
}

onMounted(async () => {
  await loadFiles();

  const first = files.value[0];

  if (first) {
    await selectFile(first);
  }
});
</script>

<template>
  <div>
    <div class="page-bar">
      <NSpace align="center" :size="10">
        <h1 class="page-title">只读知识库</h1>
        <NTag size="small" :type="bunkoConfigured ? 'success' : 'default'">
          {{ bunkoConfigured ? "Bunko 云文档已接入" : "Bunko 云文档未配置" }}
        </NTag>
      </NSpace>
      <NSpace :size="8">
        <NButton
          v-if="bunkoWorkspaceUrl"
          :href="bunkoWorkspaceUrl"
          rel="noopener noreferrer"
          size="small"
          tag="a"
          target="_blank"
        >
          <template #icon>
            <ExternalLink :size="14" />
          </template>
          打开 Bunko 云文档
        </NButton>
        <NButton :loading="loadingList" size="small" @click="loadFiles">
          <template #icon>
            <RefreshCw :size="14" />
          </template>
          刷新目录
        </NButton>
      </NSpace>
    </div>

    <div class="docs-grid">
      <NCard class="docs-sidebar" size="small">
        <NInput
          v-model:value="searchText"
          class="mb-sm"
          clearable
          placeholder="筛选文件名"
          size="small"
        />

        <NEmpty
          v-if="filteredFiles.length === 0"
          class="my-lg"
          description="本地 knowledge/ 暂无只读文档"
        />

        <div class="file-list">
          <button
            v-for="file in filteredFiles"
            :key="file.path"
            class="file-item"
            :class="{ active: selectedFile?.path === file.path }"
            type="button"
            @click="selectFile(file)"
          >
            <div class="file-path mono">{{ file.path }}</div>
            <div class="file-meta tabular">
              {{ formatBytes(file.sizeBytes) }} /
              {{ formatTime(file.updatedAt) }}
            </div>
          </button>
        </div>
      </NCard>

      <NCard class="docs-viewer" size="small">
        <template v-if="selectedFile">
          <div class="viewer-header">
            <NSpace align="center" :size="8">
              <NTag size="small" type="info">只读知识库</NTag>
              <NText class="mono" strong>{{ selectedFile.path }}</NText>
            </NSpace>

            <NButton size="small" @click="showRaw = !showRaw">
              <template #icon>
                <Code v-if="!showRaw" :size="14" />
                <Eye v-else :size="14" />
              </template>
              {{ showRaw ? "渲染预览" : "查看源码" }}
            </NButton>
          </div>

          <pre v-if="showRaw" class="code-block">{{ content }}</pre>
          <MarkdownPreview v-else :source="content" />
        </template>

        <NEmpty
          v-else
          class="py-empty"
          description="从左侧选择一份只读知识库文档；协作文档、周报及摘要已统一迁移至 Bunko 云文档"
        />
      </NCard>
    </div>
  </div>
</template>

<style scoped>
.mb-sm {
  margin-bottom: 10px;
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
