<script setup lang="ts">
import { RotateCcw } from "@lucide/vue";
import {
  NButton,
  NCard,
  NModal,
  NPopconfirm,
  NRadioButton,
  NRadioGroup,
  NSpace,
  NSpin,
  NTag,
  NText,
  useMessage,
} from "naive-ui";
import { computed, onMounted, ref, watch } from "vue";

import { apiFetch } from "../../api/client.ts";
import { useLiveRefresh } from "../../composables/useEventStream.ts";
import { prettyMaybeJson } from "../../utils/ai.ts";
import { formatTime } from "../../utils/format.ts";
import ChronoVirtualList from "../ChronoVirtualList.vue";

interface TapeHandoffView {
  summary: string;
  confirmedFacts: string[];
  openTasks: string[];
  pendingFollowups: string[];
  sourceEntryIds: number[];
}

interface TapeEntryView {
  id: number;
  tapeId: string;
  kind: "message" | "anchor";
  turnId: string;
  chatKey: string;
  role: string;
  sidecarId: string | null;
  createdAt: number;
  message?: {
    role: string;
    content: string | null;
    tool_call_id?: string;
    tool_calls?: {
      id: string;
      function: { name: string; arguments: string };
    }[];
  };
  anchor?: {
    reason: "compact" | "reset";
    sessionId: string;
    afterMessageId?: number;
    cutoffEntryId: number;
    handoff?: TapeHandoffView;
  };
}

interface ConversationView {
  chatKey: string;
  sessionId: string;
  summary: string;
  handoff: TapeHandoffView | null;
  anchorEntryId: number | null;
  afterMessageId: number;
  updatedAt: number;
  entries: TapeEntryView[];
}

interface ContextTurnItem {
  key: string;
  index: number;
  kind: "message" | "anchor";
  role: string;
  chatKey: string;
  toolCallId?: string;
  toolNames: string[];
  sidecarId: string | null;
  anchorReason?: "compact" | "reset";
  createdAt?: number;
  body: string;
  preview: string;
  isLong: boolean;
}

const props = defineProps<{
  paused?: boolean;
}>();

const contextMode = defineModel<"active" | "full">("mode", {
  default: "active",
});

const message = useMessage();
const TURN_PREVIEW_LIMIT = 900;

const loading = ref(false);
const conversation = ref<ConversationView | null>(null);
const fullTapeEntries = ref<TapeEntryView[]>([]);
const loadingTape = ref(false);
const resettingContext = ref(false);
const expandedTurns = ref<Record<string, boolean>>({});

const sidecarModalOpen = ref(false);
const sidecarIdActive = ref<string | null>(null);
const sidecarEntries = ref<TapeEntryView[]>([]);
const loadingSidecar = ref(false);

function roleTagType(role: string): "info" | "primary" | "warning" | "default" {
  if (role === "user") {
    return "info";
  }

  if (role === "assistant") {
    return "primary";
  }

  if (role === "tool") {
    return "warning";
  }

  return "default";
}

function formatTapeEntry(entry: TapeEntryView): ContextTurnItem {
  if (entry.kind === "anchor" && entry.anchor) {
    const body = entry.anchor.handoff
      ? JSON.stringify(entry.anchor.handoff, null, 2)
      : `重置检查点（session: ${entry.anchor.sessionId}${entry.anchor.afterMessageId ? `, afterMessageId: ${entry.anchor.afterMessageId}` : ""}）`;
    const isLong = body.length > TURN_PREVIEW_LIMIT;

    return {
      key: `tape-${entry.tapeId}-${entry.id}`,
      index: entry.id,
      kind: "anchor",
      role: "anchor",
      chatKey: entry.chatKey,
      toolNames: [],
      sidecarId: null,
      anchorReason: entry.anchor.reason,
      createdAt: entry.createdAt,
      body,
      preview: isLong ? `${body.slice(0, TURN_PREVIEW_LIMIT)}\n…` : body,
      isLong,
    };
  }

  const turn = entry.message;
  const body = turn?.content
    ? prettyMaybeJson(turn.content)
    : turn?.tool_calls?.length
      ? JSON.stringify(
          turn.tool_calls.map((c) => ({
            tool: c.function.name,
            args: prettyMaybeJson(c.function.arguments),
          })),
          null,
          2,
        )
      : "(empty)";
  const isLong = body.length > TURN_PREVIEW_LIMIT;

  return {
    key: `tape-${entry.tapeId}-${entry.id}`,
    index: entry.id,
    kind: "message",
    role: entry.role,
    chatKey: entry.chatKey,
    toolCallId: turn?.tool_call_id,
    toolNames: (turn?.tool_calls ?? []).map((c) => c.function.name),
    sidecarId: entry.sidecarId,
    createdAt: entry.createdAt,
    body,
    preview: isLong ? `${body.slice(0, TURN_PREVIEW_LIMIT)}\n…` : body,
    isLong,
  };
}

const contextItems = computed<ContextTurnItem[]>(() => {
  const useFull =
    contextMode.value === "full" &&
    (fullTapeEntries.value.length > 0 || !loadingTape.value);
  const source = useFull
    ? fullTapeEntries.value
    : (conversation.value?.entries ?? []);

  return source.map(formatTapeEntry);
});

const sidecarItems = computed<ContextTurnItem[]>(() =>
  sidecarEntries.value.map(formatTapeEntry),
);

function toggleTurnExpand(key: string) {
  expandedTurns.value = {
    ...expandedTurns.value,
    [key]: !expandedTurns.value[key],
  };
}

async function loadFullTape() {
  loadingTape.value = true;

  try {
    const res = await apiFetch<{ entries: TapeEntryView[] }>(
      "/api/admin/tape?tapeId=global&limit=300",
    );

    fullTapeEntries.value = res.entries;
  } catch (err) {
    message.error(err instanceof Error ? err.message : "加载完整 Tape 失败");
  } finally {
    loadingTape.value = false;
  }
}

async function refresh() {
  loading.value = true;

  try {
    conversation.value = await apiFetch<ConversationView>(
      "/api/admin/conversation",
    );
    if (contextMode.value === "full") {
      await loadFullTape();
    }
  } catch (err) {
    message.error(err instanceof Error ? err.message : "加载全局上下文失败");
  } finally {
    loading.value = false;
  }
}

function handleContextModeChange(mode: "active" | "full") {
  contextMode.value = mode;
}

watch(contextMode, (mode) => {
  if (mode === "full") {
    loadingTape.value = true;
    void loadFullTape();
  }
});

async function openSidecar(sidecarId: string) {
  sidecarIdActive.value = sidecarId;
  sidecarModalOpen.value = true;
  loadingSidecar.value = true;
  sidecarEntries.value = [];

  try {
    const res = await apiFetch<{ entries: TapeEntryView[] }>(
      `/api/admin/tape?tapeId=${encodeURIComponent(`sidecar:${sidecarId}`)}&limit=200`,
    );

    sidecarEntries.value = res.entries;
  } catch (err) {
    message.error(err instanceof Error ? err.message : "加载子代理轨迹失败");
  } finally {
    loadingSidecar.value = false;
  }
}

async function handleResetConversation() {
  resettingContext.value = true;

  try {
    await apiFetch("/api/admin/conversation/reset", { method: "POST" });
    message.success("已追加全局上下文重置检查点");
    await refresh();
  } catch (err) {
    message.error(err instanceof Error ? err.message : "重置上下文失败");
  } finally {
    resettingContext.value = false;
  }
}

useLiveRefresh({
  events: ["conversation_update"],
  enabled: () => !props.paused,
  debounceMs: 600,
  refresh: () => refresh(),
});

onMounted(() => {
  void refresh();
});

defineExpose({ refresh, loading });
</script>

<template>
  <NCard size="small">
    <NSpace v-if="conversation" :size="12" vertical>
      <div class="filter-bar space-between">
        <NText class="mono sub-note" depth="3">
          session: {{ conversation.sessionId }} · afterMessageId:
          {{ conversation.afterMessageId }} · 更新于
          {{ formatTime(conversation.updatedAt) }}
        </NText>
        <NPopconfirm @positive-click="handleResetConversation">
          <template #trigger>
            <NButton :loading="resettingContext" size="small" type="warning">
              <template #icon>
                <RotateCcw :size="14" />
              </template>
              追加重置检查点
            </NButton>
          </template>
          将在 Tape 尾部追加重置 Anchor（历史记录不删除，可在完整 Tape
          中回放），长期记忆保留不变。确认继续？
        </NPopconfirm>
      </div>

      <div v-if="conversation.handoff" class="handoff-box">
        <div class="handoff-title">
          结构化交接摘要（Anchor #{{ conversation.anchorEntryId ?? "-" }}）
        </div>
        <div class="pre-wrap">{{ conversation.handoff.summary }}</div>
        <div
          v-if="conversation.handoff.confirmedFacts.length > 0"
          class="sub-note"
        >
          <strong>已确认事实：</strong>
          {{ conversation.handoff.confirmedFacts.join("；") }}
        </div>
        <div v-if="conversation.handoff.openTasks.length > 0" class="sub-note">
          <strong>未完成任务：</strong>
          {{ conversation.handoff.openTasks.join("；") }}
        </div>
        <div
          v-if="conversation.handoff.pendingFollowups.length > 0"
          class="sub-note"
        >
          <strong>待跟进事项：</strong>
          {{ conversation.handoff.pendingFollowups.join("；") }}
        </div>
      </div>

      <div class="context-scroll-panel">
        <div class="context-scroll-head">
          <div class="context-scroll-title">
            <span>
              {{ contextMode === "full" ? "完整 Tape 时间线" : "活跃对话轮次" }}
            </span>
            <NText class="tabular sub-note" depth="3">
              {{ contextItems.length }} 条
            </NText>
            <NSpin v-if="loadingTape" :size="12" />
          </div>
          <NRadioGroup
            size="small"
            :value="contextMode"
            @update:value="handleContextModeChange"
          >
            <NRadioButton value="active">当前活跃视图</NRadioButton>
            <NRadioButton value="full">完整 Tape</NRadioButton>
          </NRadioGroup>
        </div>

        <ChronoVirtualList
          class="context-vlist"
          :empty-text="
            loadingTape ? '正在加载完整 Tape...' : '全局上下文当前暂无短期轮次'
          "
          :item-size="54"
          :items="contextItems"
          key-field="key"
        >
          <template #default="{ item }">
            <div class="context-vlist-item">
              <div
                class="turn-box"
                :class="
                  item.kind === 'anchor'
                    ? item.anchorReason === 'reset'
                      ? 'turn-box-anchor-reset'
                      : 'turn-box-anchor-compact'
                    : ''
                "
              >
                <div class="turn-head">
                  <span class="mono turn-time">#{{ item.index }}</span>
                  <NTag
                    v-if="item.kind === 'anchor'"
                    size="tiny"
                    :type="
                      item.anchorReason === 'reset' ? 'warning' : 'success'
                    "
                  >
                    {{
                      item.anchorReason === "reset"
                        ? "anchor: reset"
                        : "anchor: compact"
                    }}
                  </NTag>
                  <NTag v-else size="tiny" :type="roleTagType(item.role)">
                    {{ item.role }}
                  </NTag>
                  <NTag v-if="item.chatKey" size="tiny" type="default">
                    {{ item.chatKey }}
                  </NTag>
                  <NTag
                    v-for="(toolName, tIdx) in item.toolNames"
                    :key="`${toolName}-${tIdx}`"
                    size="tiny"
                    type="info"
                  >
                    {{ toolName }}
                  </NTag>
                  <NButton
                    v-if="item.sidecarId"
                    secondary
                    size="tiny"
                    type="primary"
                    @click="openSidecar(item.sidecarId)"
                  >
                    Sidecar {{ item.sidecarId }}
                  </NButton>
                  <NButton
                    v-if="item.isLong"
                    class="ml-auto"
                    quaternary
                    size="tiny"
                    @click="toggleTurnExpand(item.key)"
                  >
                    {{
                      expandedTurns[item.key]
                        ? "收起"
                        : `展开全文 (${item.body.length.toLocaleString()} 字)`
                    }}
                  </NButton>
                </div>
                <pre class="code-block mt-xs">{{
                  expandedTurns[item.key] ? item.body : item.preview
                }}</pre>
              </div>
            </div>
          </template>
        </ChronoVirtualList>
      </div>
    </NSpace>

    <NModal
      v-model:show="sidecarModalOpen"
      preset="card"
      :style="{ width: '680px', maxWidth: '94vw' }"
      :title="`子代理轨迹 · ${sidecarIdActive ?? ''}`"
    >
      <div v-if="loadingSidecar" class="loading-box">
        <NSpin size="small" />
      </div>
      <NSpace v-else class="sidecar-scroll" :size="10" vertical>
        <div v-for="item in sidecarItems" :key="item.key" class="turn-box">
          <div class="turn-head">
            <span class="mono turn-time">#{{ item.index }}</span>
            <NTag size="tiny" :type="roleTagType(item.role)">
              {{ item.role }}
            </NTag>
            <NTag
              v-for="(toolName, tIdx) in item.toolNames"
              :key="`${toolName}-${tIdx}`"
              size="tiny"
              type="info"
            >
              {{ toolName }}
            </NTag>
          </div>
          <pre class="code-block mt-xs">{{ item.body }}</pre>
        </div>
      </NSpace>
    </NModal>
  </NCard>
</template>

<style scoped>
.handoff-box {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 14px;
  border-radius: 6px;
  border: 1px solid var(--berry-border);
  background: var(--berry-inset);
}

.handoff-title {
  font-size: 13px;
  font-weight: 600;
}

.context-scroll-panel {
  border: 1px solid var(--berry-border);
  border-radius: 6px;
  background: var(--berry-surface);
  overflow: hidden;
}

.context-scroll-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--berry-border);
  background: var(--berry-inset);
}

.context-scroll-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
}

.context-vlist {
  height: 520px;
}

.context-vlist-item {
  padding: 6px 10px;
}

.turn-box {
  padding: 8px 10px;
  border-radius: 6px;
  border: 1px solid var(--berry-border);
  background: var(--berry-inset);
}

.turn-box-anchor-compact {
  border-color: rgba(22, 163, 74, 0.35);
}

.turn-box-anchor-reset {
  border-color: rgba(245, 158, 11, 0.45);
}

.turn-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}

.turn-time {
  font-size: 11px;
  color: var(--berry-muted);
}

.space-between {
  justify-content: space-between;
}

.ml-auto {
  margin-left: auto;
}

.mt-xs {
  margin-top: 6px;
}

.pre-wrap {
  white-space: pre-wrap;
  word-break: break-word;
}

.loading-box {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px 16px;
}

.sidecar-scroll {
  max-height: 68vh;
  overflow-y: auto;
}
</style>
