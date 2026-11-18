<script setup lang="ts">
import { Download, Pause, Play, RefreshCw, Trash2 } from "@lucide/vue";
import {
  NButton,
  NCard,
  NEmpty,
  NInput,
  NPopconfirm,
  NSelect,
  NSpace,
  NSwitch,
  NTag,
  NText,
  useMessage,
} from "naive-ui";
import { computed, nextTick, onMounted, ref } from "vue";

import { apiFetch } from "../api/client.ts";
import { useEventStream } from "../composables/useEventStream.ts";
import { formatTime } from "../utils/format.ts";

type LogLevel = "debug" | "info" | "warn" | "error";

interface LogEntryView {
  id: number;
  time: number;
  level: LogLevel;
  scope: string;
  message: string;
  context: Record<string, unknown>;
}

const MAX_LOG_ITEMS = 2000;

const message = useMessage();

const loading = ref(false);
const entries = ref<LogEntryView[]>([]);
const scopes = ref<string[]>([]);
const filterLevel = ref<LogLevel | null>(null);
const filterScope = ref<string | null>(null);
const filterSearch = ref("");
const autoScroll = ref(true);
const consoleRef = ref<HTMLElement | null>(null);

const levelPriority: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const levelTagType: Record<LogLevel, "default" | "info" | "warning" | "error"> =
  {
    debug: "default",
    info: "info",
    warn: "warning",
    error: "error",
  };

const scopeOptions = computed(() =>
  scopes.value.map((s) => ({ label: s, value: s })),
);

const visibleEntries = computed(() => {
  const minPrio = filterLevel.value ? levelPriority[filterLevel.value] : 0;
  const kw = filterSearch.value.trim().toLowerCase();

  return entries.value.filter((entry) => {
    if (levelPriority[entry.level] < minPrio) {
      return false;
    }

    if (filterScope.value && entry.scope !== filterScope.value) {
      return false;
    }

    if (!kw) {
      return true;
    }

    const ctxText = JSON.stringify(entry.context).toLowerCase();

    return (
      entry.message.toLowerCase().includes(kw) ||
      entry.scope.toLowerCase().includes(kw) ||
      ctxText.includes(kw)
    );
  });
});

function scrollToBottom() {
  if (!autoScroll.value || !consoleRef.value) {
    return;
  }

  void nextTick(() => {
    if (consoleRef.value) {
      consoleRef.value.scrollTop = consoleRef.value.scrollHeight;
    }
  });
}

const { paused: streamPaused, togglePause } = useEventStream((type, data) => {
  if (type !== "log" || !data || typeof data !== "object") {
    return;
  }

  const entry = data as LogEntryView;

  entries.value.push(entry);

  if (entries.value.length > MAX_LOG_ITEMS) {
    entries.value.splice(0, entries.value.length - MAX_LOG_ITEMS);
  }

  if (entry.scope && !scopes.value.includes(entry.scope)) {
    scopes.value = [...scopes.value, entry.scope].sort();
  }

  scrollToBottom();
});

async function loadLogs() {
  loading.value = true;

  try {
    const qs = new URLSearchParams({ limit: "400" });

    if (filterLevel.value) {
      qs.set("level", filterLevel.value);
    }

    if (filterScope.value) {
      qs.set("scope", filterScope.value);
    }

    if (filterSearch.value.trim()) {
      qs.set("search", filterSearch.value.trim());
    }

    const res = await apiFetch<{
      items: LogEntryView[];
      latestId: number;
      scopes: string[];
    }>(`/api/admin/logs?${qs.toString()}`);

    entries.value = res.items;
    scopes.value = res.scopes;
    scrollToBottom();
  } catch (err) {
    message.error(err instanceof Error ? err.message : "加载日志失败");
  } finally {
    loading.value = false;
  }
}

async function handleClear() {
  try {
    await apiFetch("/api/admin/logs/clear", { method: "POST" });
    entries.value = [];
    message.success("已清空内存日志缓冲");
  } catch (err) {
    message.error(err instanceof Error ? err.message : "清空日志失败");
  }
}

function handleExport() {
  const lines = visibleEntries.value.map((entry) => {
    const ctx =
      Object.keys(entry.context).length > 0
        ? ` ${JSON.stringify(entry.context)}`
        : "";

    return `${new Date(entry.time).toISOString()} ${entry.level.toUpperCase()} [${entry.scope}] ${entry.message}${ctx}`;
  });
  const blob = new Blob([lines.join("\n")], {
    type: "text/plain;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");

  anchor.href = url;
  anchor.download = `berry-${new Date().toISOString().slice(0, 19).replaceAll(":", "-")}.log`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function formatContext(ctx: Record<string, unknown>): string {
  if (!ctx || Object.keys(ctx).length === 0) {
    return "";
  }

  return Object.entries(ctx)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" ");
}

onMounted(() => {
  void loadLogs();
});
</script>

<template>
  <div>
    <div class="page-bar">
      <NSpace align="center" :size="10">
        <h1 class="page-title">运行日志</h1>
        <NText class="sub-note" depth="3">
          显示 {{ visibleEntries.length }} 条（Pino 内存环已自动脱敏）
        </NText>
      </NSpace>
      <NSpace :size="8" wrap>
        <NButton size="small" @click="togglePause">
          <template #icon>
            <Play v-if="streamPaused" :size="14" />
            <Pause v-else :size="14" />
          </template>
          {{ streamPaused ? "恢复实时流" : "暂停实时流" }}
        </NButton>
        <NButton size="small" @click="handleExport">
          <template #icon>
            <Download :size="14" />
          </template>
          导出 .log
        </NButton>
        <NPopconfirm @positive-click="handleClear">
          <template #trigger>
            <NButton quaternary size="small" type="warning">
              <template #icon>
                <Trash2 :size="14" />
              </template>
              清空缓冲
            </NButton>
          </template>
          仅清空后台实时缓冲视图，不影响标准输出。确认继续？
        </NPopconfirm>
      </NSpace>
    </div>

    <div class="filter-bar">
      <NSelect
        v-model:value="filterLevel"
        class="w-135"
        clearable
        :options="[
          { label: 'DEBUG 以上', value: 'debug' },
          { label: 'INFO 以上', value: 'info' },
          { label: 'WARN 以上', value: 'warn' },
          { label: '仅 ERROR', value: 'error' },
        ]"
        placeholder="全部级别"
        size="small"
      />
      <NSelect
        v-model:value="filterScope"
        class="w-155"
        clearable
        filterable
        :options="scopeOptions"
        placeholder="全部模块"
        size="small"
      />
      <NInput
        v-model:value="filterSearch"
        class="w-240"
        clearable
        placeholder="过滤消息、模块或附带字段"
        size="small"
        @keyup.enter="loadLogs"
      />
      <NButton :loading size="small" @click="loadLogs">
        <template #icon>
          <RefreshCw :size="14" />
        </template>
        刷新
      </NButton>
      <NSpace align="center" class="ml-auto" :size="6">
        <NSwitch v-model:value="autoScroll" size="small" />
        <NText class="sub-note" depth="2">自动滚动到底部</NText>
      </NSpace>
    </div>

    <NCard size="small">
      <div ref="consoleRef" class="log-console">
        <NEmpty
          v-if="visibleEntries.length === 0"
          class="py-empty"
          description="当前筛选下暂无日志"
        />
        <div
          v-for="entry in visibleEntries"
          :key="entry.id"
          class="log-line"
          :class="`lvl-${entry.level}`"
        >
          <span class="log-time tabular">{{ formatTime(entry.time) }}</span>
          <NTag class="log-lvl" size="tiny" :type="levelTagType[entry.level]">
            {{ entry.level.toUpperCase() }}
          </NTag>
          <span class="log-scope mono">[{{ entry.scope }}]</span>
          <span class="log-msg">{{ entry.message }}</span>
          <span
            v-if="Object.keys(entry.context).length > 0"
            class="log-ctx mono"
          >
            {{ formatContext(entry.context) }}
          </span>
        </div>
      </div>
    </NCard>
  </div>
</template>

<style scoped>
.log-console {
  max-height: 68vh;
  overflow-y: auto;
  font-family: var(--berry-mono);
  font-size: 12px;
  line-height: 1.6;
  background: var(--berry-inset);
  border: 1px solid var(--berry-border);
  border-radius: 6px;
  padding: 8px 10px;
}

.log-line {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
  padding: 3px 4px;
  border-bottom: 1px dashed var(--berry-border);
}

.log-line:last-child {
  border-bottom: none;
}

.log-time {
  color: var(--berry-muted);
  font-size: 11px;
  flex-shrink: 0;
}

.log-lvl {
  flex-shrink: 0;
}

.log-scope {
  color: var(--berry-muted);
  flex-shrink: 0;
}

.log-msg {
  word-break: break-word;
}

.log-ctx {
  color: var(--berry-muted);
  font-size: 11px;
  word-break: break-all;
}
</style>
