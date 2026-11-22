<script setup lang="ts">
import { Trash2 } from "@lucide/vue";
import {
  NAlert,
  NButton,
  NCard,
  NDescriptions,
  NDescriptionsItem,
  NInputNumber,
  NPopconfirm,
  NText,
  useMessage,
} from "naive-ui";
import { ref } from "vue";

import { apiFetch } from "../../api/client.ts";
import { formatBytes } from "../../utils/format.ts";

export interface StorageSummary {
  dbBytes: number;
  assetsFiles: number;
  assetsBytes: number;
  avatarsFiles: number;
  avatarsBytes: number;
  tables: {
    messages: number;
    gateDecisions: number;
    conversations: number;
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
  deletedMessages: number;
  deletedDecisions: number;
  deletedJobs: number;
  deletedDeliveries: number;
  deletedAssetRows: number;
  freedBytes: number;
}

const emit = defineEmits<{ purged: [] }>();

defineProps<{
  storage: StorageSummary | null;
}>();

const message = useMessage();

const purging = ref(false);
const purgeDays = ref(30);
const lastPurge = ref<PurgeResult | null>(null);

async function handlePurge() {
  purging.value = true;

  try {
    const res = await apiFetch<PurgeResult>("/api/admin/storage/purge", {
      method: "POST",
      body: JSON.stringify({ olderThanDays: purgeDays.value }),
    });

    lastPurge.value = res;
    message.success(
      `清理完成：删除 ${res.deletedMessages} 条消息、释放 ${formatBytes(res.freedBytes)}`,
    );
    emit("purged");
  } catch (err) {
    message.error(err instanceof Error ? err.message : "存储清理失败");
  } finally {
    purging.value = false;
  }
}
</script>

<template>
  <div v-if="storage" class="storage-stack">
    <NCard size="small" title="存储概览">
      <NDescriptions bordered :column="3" label-placement="left" size="small">
        <NDescriptionsItem label="SQLite 库文件">
          {{ formatBytes(storage.dbBytes) }}
        </NDescriptionsItem>
        <NDescriptionsItem label="媒体缓存">
          {{ storage.assetsFiles }} 个文件 /
          {{ formatBytes(storage.assetsBytes) }}
        </NDescriptionsItem>
        <NDescriptionsItem label="头像缓存">
          {{ storage.avatarsFiles }} 个文件 /
          {{ formatBytes(storage.avatarsBytes) }}
        </NDescriptionsItem>
        <NDescriptionsItem label="聊天消息">
          {{ storage.tables.messages.toLocaleString() }}
        </NDescriptionsItem>
        <NDescriptionsItem label="分流记录">
          {{ storage.tables.gateDecisions.toLocaleString() }}
        </NDescriptionsItem>
        <NDescriptionsItem label="结构化记忆">
          {{ storage.tables.memories.toLocaleString() }}
        </NDescriptionsItem>
        <NDescriptionsItem label="媒体附件">
          {{ storage.tables.messageAssets.toLocaleString() }}
        </NDescriptionsItem>
        <NDescriptionsItem label="后台任务">
          {{ storage.tables.jobs.toLocaleString() }}
        </NDescriptionsItem>
        <NDescriptionsItem label="出站投递">
          {{ storage.tables.deliveries.toLocaleString() }}
        </NDescriptionsItem>
        <NDescriptionsItem label="定时任务">
          {{ storage.tables.schedules.toLocaleString() }}
        </NDescriptionsItem>
        <NDescriptionsItem label="公会审计">
          {{ storage.tables.guildAuditLogs.toLocaleString() }}
        </NDescriptionsItem>
        <NDescriptionsItem label="AI 调用流水">
          {{ storage.tables.llmUsage.toLocaleString() }}
        </NDescriptionsItem>
      </NDescriptions>
    </NCard>

    <NCard size="small" title="过期数据清理">
      <div class="purge-row">
        <NText depth="2">保留最近天数</NText>
        <NInputNumber
          v-model:value="purgeDays"
          class="w-110"
          :max="3650"
          :min="1"
          size="small"
        />
        <NPopconfirm @positive-click="handlePurge">
          <template #trigger>
            <NButton :loading="purging" size="small" type="warning">
              <template #icon>
                <Trash2 :size="14" />
              </template>
              清理过期数据
            </NButton>
          </template>
          将删除超过 {{ purgeDays }}
          天的未受保护历史消息、分流记录、已完成任务及孤立媒体文件；被长期记忆引用的消息会自动保留。确认继续？
        </NPopconfirm>
      </div>

      <NAlert v-if="lastPurge" class="mt-md" type="success">
        本次清理范围：超过 {{ lastPurge.olderThanDays }} 天；共清理
        {{ lastPurge.deletedMessages }} 条消息、{{
          lastPurge.deletedDecisions
        }}
        条分流日志、{{ lastPurge.deletedJobs }} 条任务、{{
          lastPurge.deletedDeliveries
        }}
        条投递、{{ lastPurge.deletedAssetRows }} 条媒体记录，释放磁盘
        {{ formatBytes(lastPurge.freedBytes) }}。
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

.purge-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}
</style>
