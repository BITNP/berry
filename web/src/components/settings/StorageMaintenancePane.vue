<script setup lang="ts">
import { HardDrive, Trash2 } from "@lucide/vue";
import {
  NAlert,
  NButton,
  NCard,
  NDescriptions,
  NDescriptionsItem,
  NInputNumber,
  NPopconfirm,
  NSpace,
  NSwitch,
  NTag,
  NText,
  useMessage,
} from "naive-ui";
import { computed, ref, watch } from "vue";

import { apiFetch } from "../../api/client.ts";
import { formatBytes } from "../../utils/format.ts";

export type PurgeScope =
  "llm_traces" | "archived_tape" | "runtime_logs" | "messages";

export interface StoragePolicyForm {
  autoPurgeEnabled: boolean;
  llmTracesRetentionDays: number;
  archivedTapeRetentionDays: number;
  runtimeLogsRetentionDays: number;
}

export interface StorageSummary {
  dbBytes: number;
  dbMainBytes: number;
  dbWalBytes: number;
  assetsFiles: number;
  assetsBytes: number;
  avatarsFiles: number;
  avatarsBytes: number;
  tables: {
    messages: number;
    gateDecisions: number;
    conversations: number;
    tapeEntries: number;
    memories: number;
    messageAssets: number;
    jobs: number;
    deliveries: number;
    schedules: number;
    guildAuditLogs: number;
    llmUsage: number;
  };
  tableBytes: {
    messages: number;
    gateDecisions: number;
    tapeEntries: number;
    memories: number;
    messageAssets: number;
    jobs: number;
    deliveries: number;
    schedules: number;
    guildAuditLogs: number;
    llmUsage: number;
  };
}

interface PurgeResult {
  olderThanDays: number;
  scopes: PurgeScope[];
  deletedMessages: number;
  deletedDecisions: number;
  deletedJobs: number;
  deletedDeliveries: number;
  deletedAssetRows: number;
  deletedExpiredMemories: number;
  trimmedLlmUsage: number;
  deletedTapeEntries: number;
  dbFreedBytes: number;
  freedBytes: number;
}

const emit = defineEmits<{ purged: [] }>();

const props = defineProps<{
  storage: StorageSummary | null;
}>();

const policy = defineModel<StoragePolicyForm>("policy", { required: true });

const message = useMessage();

const purgingScope = ref<PurgeScope | null>(null);
const compacting = ref(false);
const lastPurge = ref<PurgeResult | null>(null);

const manualDays = ref<Record<PurgeScope, number>>({
  llm_traces: policy.value.llmTracesRetentionDays || 7,
  archived_tape: policy.value.archivedTapeRetentionDays || 7,
  runtime_logs: policy.value.runtimeLogsRetentionDays || 14,
  messages: 90,
});

watch(
  () => [
    policy.value.llmTracesRetentionDays,
    policy.value.archivedTapeRetentionDays,
    policy.value.runtimeLogsRetentionDays,
  ],
  ([llm, tape, logs]) => {
    manualDays.value.llm_traces = llm;
    manualDays.value.archived_tape = tape;
    manualDays.value.runtime_logs = logs;
  },
);

function formatStat(count: number, bytes?: number): string {
  const countText = count.toLocaleString();

  return bytes && bytes > 0
    ? `${countText} 条 · ${formatBytes(bytes)}`
    : `${countText} 条`;
}

const runtimeLogCount = computed(() => {
  const t = props.storage?.tables;

  return t ? t.gateDecisions + t.jobs + t.deliveries : 0;
});

const runtimeLogBytes = computed(() => {
  const b = props.storage?.tableBytes;

  return b ? b.gateDecisions + b.jobs + b.deliveries : 0;
});

const messageTotalBytes = computed(() => {
  const b = props.storage?.tableBytes;

  return b ? b.messages + b.messageAssets : 0;
});

function summarizePurge(res: PurgeResult): string {
  const parts: string[] = [];

  if (res.trimmedLlmUsage > 0) {
    parts.push(`裁剪 ${res.trimmedLlmUsage} 条 AI 调用报文`);
  }

  if (res.deletedTapeEntries > 0) {
    parts.push(`删除 ${res.deletedTapeEntries} 条归档记录带`);
  }

  const logTotal =
    res.deletedDecisions +
    res.deletedJobs +
    res.deletedDeliveries +
    res.deletedExpiredMemories;

  if (logTotal > 0) {
    parts.push(
      `删除 ${res.deletedDecisions} 条分流、${res.deletedJobs} 条任务、${res.deletedDeliveries} 条投递`,
    );
  }

  if (res.deletedMessages > 0 || res.deletedAssetRows > 0) {
    parts.push(
      `删除 ${res.deletedMessages} 条聊天消息、${res.deletedAssetRows} 条媒体索引`,
    );
  }

  const detail =
    parts.length > 0 ? parts.join("；") : "没有超过保留期的可清理记录";

  return `${detail}；释放磁盘 ${formatBytes(res.freedBytes)}`;
}

async function handlePurge(scope: PurgeScope) {
  purgingScope.value = scope;

  try {
    const res = await apiFetch<PurgeResult>("/api/admin/storage/purge", {
      method: "POST",
      body: JSON.stringify({
        olderThanDays: manualDays.value[scope],
        scopes: [scope],
      }),
    });

    lastPurge.value = res;
    message.success(`清理完成：${summarizePurge(res)}`);
    emit("purged");
  } catch (err) {
    message.error(err instanceof Error ? err.message : "存储清理失败");
  } finally {
    purgingScope.value = null;
  }
}

async function handleCompact() {
  compacting.value = true;

  try {
    const res = await apiFetch<{
      beforeBytes: number;
      afterBytes: number;
      freedBytes: number;
    }>("/api/admin/storage/compact", { method: "POST" });

    message.success(
      `数据库压缩完成：${formatBytes(res.beforeBytes)} → ${formatBytes(res.afterBytes)}（释放 ${formatBytes(res.freedBytes)}）`,
    );
    emit("purged");
  } catch (err) {
    message.error(err instanceof Error ? err.message : "压缩数据库失败");
  } finally {
    compacting.value = false;
  }
}
</script>

<template>
  <div v-if="storage" class="storage-stack">
    <NCard size="small" title="存储概览">
      <template #header-extra>
        <NButton
          :loading="compacting"
          secondary
          size="tiny"
          @click="handleCompact"
        >
          <template #icon>
            <HardDrive :size="13" />
          </template>
          压缩数据库
        </NButton>
      </template>

      <NDescriptions bordered :column="3" label-placement="left" size="small">
        <NDescriptionsItem label="SQLite 库文件">
          {{ formatBytes(storage.dbBytes) }}
          <NText v-if="storage.dbWalBytes > 0" depth="3">
            （主库 {{ formatBytes(storage.dbMainBytes) }} / WAL
            {{ formatBytes(storage.dbWalBytes) }}）
          </NText>
        </NDescriptionsItem>
        <NDescriptionsItem label="媒体缓存">
          {{ storage.assetsFiles }} 个文件 /
          {{ formatBytes(storage.assetsBytes) }}
        </NDescriptionsItem>
        <NDescriptionsItem label="头像缓存">
          {{ storage.avatarsFiles }} 个文件 /
          {{ formatBytes(storage.avatarsBytes) }}
        </NDescriptionsItem>
        <NDescriptionsItem label="结构化记忆">
          {{
            formatStat(storage.tables.memories, storage.tableBytes?.memories)
          }}
        </NDescriptionsItem>
        <NDescriptionsItem label="定时任务">
          {{
            formatStat(storage.tables.schedules, storage.tableBytes?.schedules)
          }}
        </NDescriptionsItem>
        <NDescriptionsItem label="公会审计">
          {{
            formatStat(
              storage.tables.guildAuditLogs,
              storage.tableBytes?.guildAuditLogs,
            )
          }}
        </NDescriptionsItem>
      </NDescriptions>
    </NCard>

    <NCard size="small" title="分类清理与保留策略">
      <template #header-extra>
        <NSpace align="center" :size="8">
          <NText class="auto-purge-label" depth="2">
            每日自动清理运行期数据（不碰本地消息）
          </NText>
          <NSwitch v-model:value="policy.autoPurgeEnabled" size="small" />
        </NSpace>
      </template>

      <div class="scope-list">
        <div class="scope-row">
          <div class="scope-info">
            <div class="scope-title">
              <span>AI 调用记录</span>
              <NText class="tabular" depth="3">
                {{
                  formatStat(
                    storage.tables.llmUsage,
                    storage.tableBytes?.llmUsage,
                  )
                }}
              </NText>
            </div>
            <NText class="scope-desc" depth="3">
              清空超期的请求预览、回复原文及工具调用报文；完整保留每日 Token
              和次数统计。
            </NText>
          </div>

          <div class="scope-policy">
            <NText depth="3">自动保留</NText>
            <NInputNumber
              v-model:value="policy.llmTracesRetentionDays"
              class="w-84"
              :disabled="!policy.autoPurgeEnabled"
              :max="365"
              :min="1"
              size="small"
            />
            <NText depth="3">天</NText>
          </div>

          <div class="scope-action">
            <NInputNumber
              v-model:value="manualDays.llm_traces"
              class="w-84"
              :max="3650"
              :min="1"
              size="small"
            />
            <NText depth="3">天前</NText>
            <NPopconfirm @positive-click="handlePurge('llm_traces')">
              <template #trigger>
                <NButton
                  :loading="purgingScope === 'llm_traces'"
                  secondary
                  size="small"
                  type="warning"
                >
                  <template #icon>
                    <Trash2 :size="13" />
                  </template>
                  清理
                </NButton>
              </template>
              清空超过 {{ manualDays.llm_traces }} 天的 AI
              调用报文并压缩数据库（保留 Token 统计，不删聊天消息）？
            </NPopconfirm>
          </div>
        </div>

        <div class="scope-row">
          <div class="scope-info">
            <div class="scope-title">
              <span>归档对话记录带</span>
              <NText class="tabular" depth="3">
                {{
                  formatStat(
                    storage.tables.tapeEntries,
                    storage.tableBytes?.tapeEntries,
                  )
                }}
              </NText>
            </div>
            <NText class="scope-desc" depth="3">
              删除超期子代理侧轨及当前锚点之前的旧全局上下文；不碰活跃对话。
            </NText>
          </div>

          <div class="scope-policy">
            <NText depth="3">自动保留</NText>
            <NInputNumber
              v-model:value="policy.archivedTapeRetentionDays"
              class="w-84"
              :disabled="!policy.autoPurgeEnabled"
              :max="365"
              :min="1"
              size="small"
            />
            <NText depth="3">天</NText>
          </div>

          <div class="scope-action">
            <NInputNumber
              v-model:value="manualDays.archived_tape"
              class="w-84"
              :max="3650"
              :min="1"
              size="small"
            />
            <NText depth="3">天前</NText>
            <NPopconfirm @positive-click="handlePurge('archived_tape')">
              <template #trigger>
                <NButton
                  :loading="purgingScope === 'archived_tape'"
                  secondary
                  size="small"
                  type="warning"
                >
                  <template #icon>
                    <Trash2 :size="13" />
                  </template>
                  清理
                </NButton>
              </template>
              删除超过 {{ manualDays.archived_tape }}
              天的子代理侧轨及已归档旧上下文并压缩数据库（不碰活跃对话和聊天消息）？
            </NPopconfirm>
          </div>
        </div>

        <div class="scope-row">
          <div class="scope-info">
            <div class="scope-title">
              <span>分流 / 任务 / 投递日志</span>
              <NText class="tabular" depth="3">
                {{ formatStat(runtimeLogCount, runtimeLogBytes) }}
              </NText>
            </div>
            <NText class="scope-desc" depth="3">
              删除超期分流决策（{{
                storage.tables.gateDecisions.toLocaleString()
              }}）、已完成任务（{{
                storage.tables.jobs.toLocaleString()
              }}）、已结束投递（{{
                storage.tables.deliveries.toLocaleString()
              }}）及过期记忆。
            </NText>
          </div>

          <div class="scope-policy">
            <NText depth="3">自动保留</NText>
            <NInputNumber
              v-model:value="policy.runtimeLogsRetentionDays"
              class="w-84"
              :disabled="!policy.autoPurgeEnabled"
              :max="365"
              :min="1"
              size="small"
            />
            <NText depth="3">天</NText>
          </div>

          <div class="scope-action">
            <NInputNumber
              v-model:value="manualDays.runtime_logs"
              class="w-84"
              :max="3650"
              :min="1"
              size="small"
            />
            <NText depth="3">天前</NText>
            <NPopconfirm @positive-click="handlePurge('runtime_logs')">
              <template #trigger>
                <NButton
                  :loading="purgingScope === 'runtime_logs'"
                  secondary
                  size="small"
                  type="warning"
                >
                  <template #icon>
                    <Trash2 :size="13" />
                  </template>
                  清理
                </NButton>
              </template>
              删除超过 {{ manualDays.runtime_logs }}
              天的分流决策、已完成任务、已结束投递及过期记忆并压缩数据库（不删聊天消息）？
            </NPopconfirm>
          </div>
        </div>

        <div class="scope-row scope-row-protected">
          <div class="scope-info">
            <div class="scope-title">
              <span>本地聊天消息及关联媒体</span>
              <NText class="tabular" depth="3">
                {{ formatStat(storage.tables.messages, messageTotalBytes) }}
              </NText>
            </div>
            <NText class="scope-desc" depth="3">
              默认永久保留，绝不自动清理；手动清理时仍会自动保护长期记忆引用的消息、活跃任务及表情包库文件（含
              {{ storage.tables.messageAssets.toLocaleString() }} 条媒体索引）。
            </NText>
          </div>

          <div class="scope-policy">
            <NTag :bordered="false" size="small" type="success">
              不自动清理
            </NTag>
          </div>

          <div class="scope-action">
            <NInputNumber
              v-model:value="manualDays.messages"
              class="w-84"
              :max="3650"
              :min="1"
              size="small"
            />
            <NText depth="3">天前</NText>
            <NPopconfirm @positive-click="handlePurge('messages')">
              <template #trigger>
                <NButton
                  :loading="purgingScope === 'messages'"
                  secondary
                  size="small"
                  type="error"
                >
                  <template #icon>
                    <Trash2 :size="13" />
                  </template>
                  手动清理
                </NButton>
              </template>
              确定手动删除超过 {{ manualDays.messages }}
              天的本地聊天消息、关联媒体索引及孤立缓存文件？长期记忆引用的消息和表情包库文件会自动保留。
            </NPopconfirm>
          </div>
        </div>
      </div>

      <NText class="save-hint" depth="3">
        修改上方「每日自动清理」开关或自动保留天数后，请点击页面右上角「保存设置」生效；右侧「清理」按钮立即执行。
      </NText>

      <NAlert v-if="lastPurge" class="mt-md" type="success">
        本次清理（保留最近 {{ lastPurge.olderThanDays }} 天）：{{
          summarizePurge(lastPurge)
        }}。
      </NAlert>
    </NCard>
  </div>
</template>

<style scoped>
.storage-stack {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.scope-list {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--berry-border);
  border-radius: 8px;
  overflow: hidden;
}

.scope-row {
  display: grid;
  grid-template-columns: minmax(260px, 1fr) auto auto;
  align-items: center;
  gap: 12px 18px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--berry-border);
}

.scope-row:last-child {
  border-bottom: none;
}

.scope-row-protected {
  background: var(--berry-inset);
}

.scope-info {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.scope-title {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
}

.scope-desc {
  font-size: 12px;
  line-height: 1.45;
}

.scope-policy,
.scope-action {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  white-space: nowrap;
}

.w-84 {
  width: 84px;
}

.auto-purge-label {
  font-size: 12px;
}

.save-hint {
  display: block;
  margin-top: 10px;
  font-size: 12px;
}

@media (max-width: 860px) {
  .scope-row {
    grid-template-columns: 1fr;
    gap: 8px;
  }
}
</style>
