<script setup lang="ts">
import { Copy, Download, Pause, Play, RefreshCw, Trash2 } from "@lucide/vue";
import {
  NButton,
  NCard,
  NInput,
  NPopconfirm,
  NSelect,
  NSpace,
  NSwitch,
  NText,
  useMessage,
} from "naive-ui";
import { computed, onMounted, ref } from "vue";

import { apiFetch } from "../api/client.ts";
import ChronoVirtualList from "../components/ChronoVirtualList.vue";
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

interface LogMetaChip {
  key: string;
  value: string;
  kind: "str" | "num" | "bool-true" | "bool-false" | "err";
}

const MAX_LOG_ITEMS = 2000;

const message = useMessage();

const loadingLogs = ref(false);
const entries = ref<LogEntryView[]>([]);
const scopes = ref<string[]>([]);
const filterLevel = ref<LogLevel | null>(null);
const filterScope = ref<string | null>(null);
const filterSearch = ref("");
const autoScroll = ref(true);
const expandedLogIds = ref<Record<number, boolean>>({});

const levelPriority: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const levelShort: Record<LogLevel, string> = {
  debug: "DEBUG",
  info: "INFO",
  warn: "WARN",
  error: "ERROR",
};

const logLevelCounts = computed(() => {
  let error = 0;
  let warn = 0;

  for (const entry of entries.value) {
    if (entry.level === "error") {
      error++;
    } else if (entry.level === "warn") {
      warn++;
    }
  }

  return { error, warn };
});

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

function scopeTone(scope: string): string {
  if (scope === "berry" || scope === "main") {
    return "berry";
  }

  if (scope === "agent" || scope.startsWith("llm")) {
    return "cyan";
  }

  if (scope.startsWith("gate")) {
    return "green";
  }

  if (scope.startsWith("gateway")) {
    return "blue";
  }

  if (scope.startsWith("guild")) {
    return "amber";
  }

  const tones = ["cyan", "purple", "blue", "green", "amber"];
  let hash = 0;

  for (let i = 0; i < scope.length; i++) {
    hash = (hash * 31 + scope.charCodeAt(i)) | 0;
  }

  return tones[Math.abs(hash) % tones.length];
}

function formatLogClock(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const frac = String(d.getMilliseconds()).padStart(3, "0");

  return `${hh}:${mm}:${ss}.${frac}`;
}

function logMetaChips(ctx: Record<string, unknown>): LogMetaChip[] {
  const chips: LogMetaChip[] = [];

  for (const [key, val] of Object.entries(ctx)) {
    if (val === undefined) {
      continue;
    }

    if (key === "error" || key === "err") {
      const text = typeof val === "string" ? val : JSON.stringify(val);

      chips.push({
        key,
        value: text.length > 96 ? `${text.slice(0, 96)}…` : text,
        kind: "err",
      });

      continue;
    }

    if (typeof val === "number") {
      chips.push({ key, value: String(val), kind: "num" });
    } else if (typeof val === "boolean") {
      chips.push({
        key,
        value: String(val),
        kind: val ? "bool-true" : "bool-false",
      });
    } else if (typeof val === "string") {
      chips.push({
        key,
        value: val.length > 72 ? `${val.slice(0, 72)}…` : val,
        kind: "str",
      });
    } else {
      const raw = JSON.stringify(val);

      chips.push({
        key,
        value: raw.length > 72 ? `${raw.slice(0, 72)}…` : raw,
        kind: "str",
      });
    }
  }

  return chips;
}

function toggleLogExpand(id: number) {
  expandedLogIds.value = {
    ...expandedLogIds.value,
    [id]: !expandedLogIds.value[id],
  };
}

async function copyLogEntry(entry: LogEntryView) {
  const line = `${new Date(entry.time).toISOString()} ${entry.level.toUpperCase()} [${entry.scope}] ${entry.message}${Object.keys(entry.context).length > 0 ? `\n${JSON.stringify(entry.context, null, 2)}` : ""}`;

  try {
    await navigator.clipboard.writeText(line);
    message.success("已复制日志条目");
  } catch {
    message.error("复制失败");
  }
}

async function loadLogs() {
  loadingLogs.value = true;

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
  } catch (err) {
    message.error(err instanceof Error ? err.message : "加载日志失败");
  } finally {
    loadingLogs.value = false;
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

const { paused: streamPaused, togglePause } = useEventStream(
  (type, data) => {
    if (type === "log") {
      const entry = data as LogEntryView;

      entries.value.push(entry);

      if (entries.value.length > MAX_LOG_ITEMS) {
        entries.value.splice(0, entries.value.length - MAX_LOG_ITEMS);
      }

      if (entry.scope && !scopes.value.includes(entry.scope)) {
        scopes.value = [...scopes.value, entry.scope].sort();
      }
    }
  },
  {
    onReconnect: () => {
      void loadLogs();
    },
  },
);

onMounted(() => {
  void loadLogs();
});
</script>

<template>
  <div>
    <div class="page-bar">
      <NSpace align="center" :size="10">
        <h2 class="page-title">系统日志</h2>
        <NText class="sub-note tabular" depth="3">
          {{ visibleEntries.length }} 条
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
          导出
        </NButton>
        <NPopconfirm @positive-click="handleClear">
          <template #trigger>
            <NButton quaternary size="small">
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

    <NCard size="small">
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
        <NButton :loading="loadingLogs" size="small" @click="loadLogs">
          <template #icon>
            <RefreshCw :size="14" />
          </template>
          刷新
        </NButton>
        <NButton
          v-if="logLevelCounts.error > 0"
          :secondary="filterLevel !== 'error'"
          size="tiny"
          type="error"
          @click="filterLevel = filterLevel === 'error' ? null : 'error'"
        >
          ERROR {{ logLevelCounts.error }}
        </NButton>
        <NButton
          v-if="logLevelCounts.warn > 0"
          :secondary="filterLevel !== 'warn'"
          size="tiny"
          type="warning"
          @click="filterLevel = filterLevel === 'warn' ? null : 'warn'"
        >
          WARN {{ logLevelCounts.warn }}
        </NButton>
        <NSpace align="center" class="ml-auto" :size="6">
          <NSwitch v-model:value="autoScroll" size="small" />
          <NText class="sub-note" depth="2">自动滚动</NText>
        </NSpace>
      </div>

      <ChronoVirtualList
        class="log-console"
        empty-text="当前筛选下暂无日志"
        :follow-bottom="autoScroll"
        :item-size="24"
        :items="visibleEntries"
        key-field="id"
        surface="console"
      >
        <template #default="{ item: entry }">
          <div
            class="log-entry"
            :class="[
              `lvl-${entry.level}`,
              {
                expandable: Object.keys(entry.context).length > 0,
                expanded: Boolean(expandedLogIds[entry.id]),
              },
            ]"
            @click="
              Object.keys(entry.context).length > 0 && toggleLogExpand(entry.id)
            "
          >
            <div class="log-line">
              <span class="log-time tabular" :title="formatTime(entry.time)">
                {{ formatLogClock(entry.time) }}
              </span>
              <span class="log-lvl" :class="`lvl-${entry.level}`">
                {{ levelShort[entry.level] }}
              </span>
              <span class="log-scope" :class="`tone-${scopeTone(entry.scope)}`">
                {{ entry.scope }}
              </span>
              <span class="log-msg">{{ entry.message }}</span>
              <span
                v-if="Object.keys(entry.context).length > 0"
                class="log-chips"
              >
                <span
                  v-for="chip in logMetaChips(entry.context)"
                  :key="chip.key"
                  class="log-chip"
                  :class="`kind-${chip.kind}`"
                >
                  <span class="log-chip-k">{{ chip.key }}=</span>
                  <span class="log-chip-v">{{ chip.value }}</span>
                </span>
              </span>
              <button
                aria-label="复制日志"
                class="log-copy-btn"
                title="复制日志"
                type="button"
                @click.stop="copyLogEntry(entry)"
              >
                <Copy :size="12" />
              </button>
            </div>

            <pre
              v-if="
                expandedLogIds[entry.id] &&
                Object.keys(entry.context).length > 0
              "
              class="log-detail"
              @click.stop
              >{{ JSON.stringify(entry.context, null, 2) }}</pre>
          </div>
        </template>
      </ChronoVirtualList>
    </NCard>
  </div>
</template>

<style scoped>
.log-console {
  height: calc(100vh - 210px);
  min-height: 360px;
}

.log-entry {
  border-left: 2px solid transparent;
  border-radius: 3px;
  padding: 2px 6px;
  margin-bottom: 1px;
  transition: background-color 0.12s ease;
}

.log-entry.expandable {
  cursor: pointer;
}

.log-entry:hover {
  background: rgb(148 163 184 / 0.08);
}

.log-entry.lvl-debug {
  opacity: 0.72;
}

.log-entry.lvl-warn {
  border-left-color: #f59e0b;
  background: rgb(245 158 11 / 0.06);
}

.log-entry.lvl-warn:hover {
  background: rgb(245 158 11 / 0.11);
}

.log-entry.lvl-error {
  border-left-color: #ef4444;
  background: rgb(239 68 68 / 0.09);
}

.log-entry.lvl-error:hover {
  background: rgb(239 68 68 / 0.15);
}

.log-line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 7px;
  min-height: 22px;
}

.log-time {
  color: #64748b;
  font-size: 11px;
  flex-shrink: 0;
}

.log-lvl {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 48px;
  padding: 0 5px;
  border-radius: 3px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.04em;
  line-height: 17px;
  flex-shrink: 0;
}

.log-lvl.lvl-debug {
  color: var(--berry-muted);
  background: rgb(148 163 184 / 0.14);
}

.log-lvl.lvl-info {
  color: #22d3ee;
  background: rgb(34 211 238 / 0.12);
}

.log-lvl.lvl-warn {
  color: #fbbf24;
  background: rgb(245 158 11 / 0.16);
}

.log-lvl.lvl-error {
  color: #fff;
  background: #dc2626;
}

.log-scope {
  display: inline-flex;
  align-items: center;
  padding: 0 6px;
  border-radius: 3px;
  font-size: 11px;
  font-weight: 600;
  line-height: 18px;
  flex-shrink: 0;
}

.log-scope.tone-berry {
  color: #f472b6;
  background: rgb(244 114 182 / 0.12);
}

.log-scope.tone-cyan {
  color: #38bdf8;
  background: rgb(56 189 248 / 0.12);
}

.log-scope.tone-blue {
  color: #60a5fa;
  background: rgb(96 165 250 / 0.12);
}

.log-scope.tone-green {
  color: #4ade80;
  background: rgb(74 222 128 / 0.12);
}

.log-scope.tone-amber {
  color: #fbbf24;
  background: rgb(251 191 36 / 0.12);
}

.log-scope.tone-purple {
  color: #c084fc;
  background: rgb(192 132 252 / 0.12);
}

.log-msg {
  color: #e2e8f0;
  word-break: break-word;
}

.log-entry.lvl-error .log-msg {
  color: #f87171;
  font-weight: 600;
}

.log-entry.lvl-warn .log-msg {
  color: #fbbf24;
}

.log-chips {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 5px;
}

.log-chip {
  display: inline-flex;
  align-items: baseline;
  padding: 0 5px;
  border-radius: 3px;
  background: rgb(148 163 184 / 0.09);
  font-size: 11px;
  line-height: 18px;
}

.log-chip-k {
  color: #94a3b8;
}

.log-chip-v {
  color: #e2e8f0;
  word-break: break-all;
}

.log-chip.kind-num .log-chip-v {
  color: #fbbf24;
}

.log-chip.kind-bool-true .log-chip-v {
  color: #4ade80;
}

.log-chip.kind-bool-false .log-chip-v {
  color: #f87171;
}

.log-chip.kind-err {
  background: rgb(239 68 68 / 0.14);
}

.log-chip.kind-err .log-chip-v {
  color: #fca5a5;
}

.log-copy-btn {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--berry-muted);
  opacity: 0;
  cursor: pointer;
  transition:
    opacity 0.12s ease,
    background-color 0.12s ease,
    color 0.12s ease;
}

.log-entry:hover .log-copy-btn {
  opacity: 0.85;
}

.log-copy-btn:hover {
  opacity: 1;
  color: #f8fafc;
  background: rgb(148 163 184 / 0.16);
}

.log-detail {
  margin: 4px 0 4px 42px;
  padding: 6px 10px;
  border-radius: 4px;
  border: 1px solid #1f2430;
  background: #131822;
  color: #cbd5e1;
  font-size: 11px;
  line-height: 1.5;
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
