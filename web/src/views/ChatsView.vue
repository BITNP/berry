<script setup lang="ts">
import { Download, FileText, Plus, RefreshCw, Send } from "@lucide/vue";
import type { DataTableColumns } from "naive-ui";
import {
  NAlert,
  NAvatar,
  NButton,
  NCard,
  NDataTable,
  NDrawer,
  NDrawerContent,
  NEmpty,
  NForm,
  NFormItem,
  NInput,
  NModal,
  NSelect,
  NSpace,
  NSwitch,
  NTabPane,
  NTabs,
  NTag,
  NText,
  useMessage,
} from "naive-ui";
import { computed, h, onMounted, ref } from "vue";
import { useRouter } from "vue-router";

import { apiFetch } from "../api/client.ts";
import { formatTime } from "../utils/format.ts";

type ChatKind = "group" | "private";
type TriggerMode = "off" | "mention_only" | "smart_observe";

interface ChatRow {
  chatKey: string;
  kind: ChatKind;
  chatId: string;
  title: string;
  enabled: boolean;
  triggerMode: TriggerMode;
  createdAt: number;
  updatedAt: number;
}

interface MessageAssetView {
  id: number;
  messageId: number;
  kind: "image" | "audio" | "forward" | "file";
  rawUrl: string;
  filePath: string | null;
  mimeType: string;
  transcript: string | null;
  status: "pending" | "ready" | "failed";
  error: string | null;
}

interface ReactionAggregateView {
  emojiId: string;
  emojiName: string;
  count: number;
  userIds: string[];
}

interface ChatMessageView {
  id: number;
  onebotMessageId: string;
  userId: string;
  senderName: string;
  text: string;
  isBot: boolean;
  mentionedBot: boolean;
  recalledAt: number | null;
  sentAt: number;
  assets: MessageAssetView[];
  reactions: ReactionAggregateView[];
}

const router = useRouter();
const message = useMessage();

const loading = ref(false);
const syncing = ref(false);
const chats = ref<ChatRow[]>([]);
const filterText = ref("");
const filterKind = ref<ChatKind | null>(null);
const busyBackfill = ref<string | null>(null);
const busyDigest = ref<string | null>(null);

const createModalOpen = ref(false);
const creating = ref(false);
const createForm = ref<{
  kind: ChatKind;
  chatId: string;
  title: string;
  enabled: boolean;
  triggerMode: TriggerMode;
}>({
  kind: "group",
  chatId: "",
  title: "",
  enabled: true,
  triggerMode: "mention_only",
});

const drawerOpen = ref(false);
const drawerTab = ref("messages");
const activeChat = ref<ChatRow | null>(null);
const messageSearch = ref("");
const loadingMessages = ref(false);
const messages = ref<ChatMessageView[]>([]);
const injectContent = ref("");
const injecting = ref(false);

const triggerOptions = [
  { label: "智能观察", value: "smart_observe" },
  { label: "仅提及", value: "mention_only" },
  { label: "关闭", value: "off" },
];

const filteredChats = computed(() => {
  const kw = filterText.value.trim().toLowerCase();

  return chats.value.filter((chat) => {
    if (filterKind.value && chat.kind !== filterKind.value) {
      return false;
    }

    if (!kw) {
      return true;
    }

    return (
      chat.title.toLowerCase().includes(kw) ||
      chat.chatId.includes(kw) ||
      chat.chatKey.toLowerCase().includes(kw)
    );
  });
});

const isNarrowViewport = computed(
  () => typeof window !== "undefined" && window.innerWidth < 740,
);

function avatarUrlForChat(row: ChatRow): string {
  const kind = row.kind === "group" ? "group" : "user";

  return `/api/admin/avatars/${kind}/${row.chatId}`;
}

async function loadChats() {
  loading.value = true;

  try {
    const res = await apiFetch<{ items: ChatRow[] }>("/api/admin/chats");

    chats.value = res.items;
  } catch (err) {
    message.error(err instanceof Error ? err.message : "加载会话列表失败");
  } finally {
    loading.value = false;
  }
}

async function handleSyncGroups() {
  syncing.value = true;

  try {
    const res = await apiFetch<{ synced: number; items: ChatRow[] }>(
      "/api/admin/chats/sync",
      { method: "POST" },
    );

    chats.value = res.items;
    message.success(`已从网关同步 ${res.synced} 个群`);
  } catch (err) {
    message.error(err instanceof Error ? err.message : "同步群列表失败");
  } finally {
    syncing.value = false;
  }
}

async function handleCreateChat() {
  if (!createForm.value.chatId.trim()) {
    message.warning("请填写 QQ 号或群号");

    return;
  }

  creating.value = true;

  try {
    await apiFetch("/api/admin/chats", {
      method: "POST",
      body: JSON.stringify(createForm.value),
    });
    createModalOpen.value = false;
    createForm.value = {
      kind: "group",
      chatId: "",
      title: "",
      enabled: true,
      triggerMode: "mention_only",
    };
    message.success("已保存会话");
    await loadChats();
  } catch (err) {
    message.error(err instanceof Error ? err.message : "登记会话失败");
  } finally {
    creating.value = false;
  }
}

async function patchChat(
  row: ChatRow,
  patch: Partial<{ enabled: boolean; triggerMode: TriggerMode; title: string }>,
) {
  try {
    const updated = await apiFetch<ChatRow>(
      `/api/admin/chats/${encodeURIComponent(row.chatKey)}`,
      {
        method: "PATCH",
        body: JSON.stringify(patch),
      },
    );

    Object.assign(row, updated);
    message.success("会话配置已更新");
  } catch (err) {
    message.error(err instanceof Error ? err.message : "更新会话失败");
    await loadChats();
  }
}

async function handleBackfill(row: ChatRow) {
  busyBackfill.value = row.chatKey;

  try {
    const res = await apiFetch<{
      total: number;
      imported: number;
      reachedStart?: boolean;
    }>(`/api/admin/chats/${encodeURIComponent(row.chatKey)}/backfill`, {
      method: "POST",
      body: JSON.stringify({ count: 200 }),
    });

    message.success(
      res.imported === 0 && res.reachedStart
        ? "已到历史起点，没有更早的消息可补录"
        : `历史补录完成：新增 ${res.imported} / 拉取 ${res.total} 条`,
    );

    if (activeChat.value?.chatKey === row.chatKey) {
      await loadMessages();
    }
  } catch (err) {
    message.error(err instanceof Error ? err.message : "历史补录失败");
  } finally {
    busyBackfill.value = null;
  }
}

async function handleDigest(row: ChatRow) {
  busyDigest.value = row.chatKey;

  try {
    await apiFetch(
      `/api/admin/chats/${encodeURIComponent(row.chatKey)}/digest`,
      {
        method: "POST",
        body: JSON.stringify({ lookbackHours: 24 }),
      },
    );
    message.success("群聊摘要任务已入队");
  } catch (err) {
    message.error(err instanceof Error ? err.message : "提交摘要任务失败");
  } finally {
    busyDigest.value = null;
  }
}

async function openChatDrawer(row: ChatRow) {
  activeChat.value = row;
  drawerTab.value = "messages";
  messageSearch.value = "";
  drawerOpen.value = true;
  await loadMessages();
}

function goToGlobalContext() {
  drawerOpen.value = false;
  void router.push({ path: "/overview", query: { tab: "context" } });
}

async function loadMessages() {
  if (!activeChat.value) {
    return;
  }

  loadingMessages.value = true;

  try {
    const qs = new URLSearchParams({ limit: "80" });

    if (messageSearch.value.trim()) {
      qs.set("search", messageSearch.value.trim());
    }

    const res = await apiFetch<{ items: ChatMessageView[] }>(
      `/api/admin/chats/${encodeURIComponent(activeChat.value.chatKey)}/messages?${qs.toString()}`,
    );

    messages.value = res.items;
  } catch (err) {
    message.error(err instanceof Error ? err.message : "加载消息失败");
  } finally {
    loadingMessages.value = false;
  }
}

async function handleInject() {
  if (!activeChat.value || !injectContent.value.trim()) {
    message.warning("请输入指令内容");

    return;
  }

  injecting.value = true;

  try {
    await apiFetch(
      `/api/admin/chats/${encodeURIComponent(activeChat.value.chatKey)}/inject`,
      {
        method: "POST",
        body: JSON.stringify({ content: injectContent.value.trim() }),
      },
    );
    injectContent.value = "";
    message.success("指令已进入执行队列");
  } catch (err) {
    message.error(err instanceof Error ? err.message : "下发失败");
  } finally {
    injecting.value = false;
  }
}

function assetKindLabel(kind: MessageAssetView["kind"]): string {
  switch (kind) {
    case "image": {
      return "图片识别";
    }

    case "audio": {
      return "语音转写";
    }

    case "forward": {
      return "合并转发";
    }

    default: {
      return "附件";
    }
  }
}

const columns: DataTableColumns<ChatRow> = [
  {
    title: "会话",
    key: "title",
    minWidth: 185,
    render: (row) =>
      h("div", { style: "display:flex;align-items:center;gap:10px;" }, [
        h(NAvatar, { round: true, size: 30, src: avatarUrlForChat(row) }),
        h("div", { style: "min-width:0;" }, [
          h(
            "div",
            { style: "font-weight:600;line-height:1.3;" },
            row.title || row.chatId,
          ),
          h(
            "div",
            { class: "mono", style: "font-size:11px;opacity:0.65;" },
            row.chatKey,
          ),
        ]),
      ]),
  },
  {
    title: "类型",
    key: "kind",
    width: 68,
    render: (row) =>
      h(
        NTag,
        { size: "small" },
        { default: () => (row.kind === "group" ? "群聊" : "私聊") },
      ),
  },
  {
    title: "启用",
    key: "enabled",
    width: 68,
    render: (row) =>
      h(NSwitch, {
        size: "small",
        value: row.enabled,
        onUpdateValue: (val: boolean) => {
          void patchChat(row, { enabled: val });
        },
      }),
  },
  {
    title: "触发策略",
    key: "triggerMode",
    width: 132,
    render: (row) =>
      h(NSelect, {
        size: "small",
        value: row.triggerMode,
        options: triggerOptions,
        onUpdateValue: (val: TriggerMode) => {
          void patchChat(row, { triggerMode: val });
        },
      }),
  },
  {
    title: "最近更新",
    key: "updatedAt",
    width: 132,
    render: (row) => h("span", { class: "tabular" }, formatTime(row.updatedAt)),
  },
  {
    title: "操作",
    key: "actions",
    width: 224,
    render: (row) =>
      h(
        NSpace,
        { size: 6 },
        {
          default: () => [
            h(
              NButton,
              {
                size: "tiny",
                secondary: true,
                onClick: () => {
                  void openChatDrawer(row);
                },
              },
              { default: () => "查看记录" },
            ),
            row.kind === "group"
              ? h(
                  NButton,
                  {
                    size: "tiny",
                    loading: busyBackfill.value === row.chatKey,
                    onClick: () => {
                      void handleBackfill(row);
                    },
                  },
                  {
                    icon: () => h(Download, { size: 12 }),
                    default: () => "补录",
                  },
                )
              : null,
            row.kind === "group"
              ? h(
                  NButton,
                  {
                    size: "tiny",
                    loading: busyDigest.value === row.chatKey,
                    onClick: () => {
                      void handleDigest(row);
                    },
                  },
                  {
                    icon: () => h(FileText, { size: 12 }),
                    default: () => "摘要",
                  },
                )
              : null,
          ],
        },
      ),
  },
];

onMounted(() => {
  void loadChats();
});
</script>

<template>
  <div>
    <div class="page-bar">
      <h1 class="page-title">会话管理</h1>
      <NSpace :size="8">
        <NButton :loading="syncing" size="small" @click="handleSyncGroups">
          <template #icon>
            <RefreshCw :size="14" />
          </template>
          从网关同步群列表
        </NButton>
        <NButton size="small" type="primary" @click="createModalOpen = true">
          <template #icon>
            <Plus :size="14" />
          </template>
          登记会话
        </NButton>
      </NSpace>
    </div>

    <div class="filter-bar">
      <NSelect
        v-model:value="filterKind"
        class="w-125"
        clearable
        :options="[
          { label: '群聊', value: 'group' },
          { label: '私聊', value: 'private' },
        ]"
        placeholder="全部类型"
        size="small"
      />
      <NInput
        v-model:value="filterText"
        class="w-220"
        clearable
        placeholder="按名称或号码筛选"
        size="small"
      />
    </div>

    <NCard size="small">
      <NDataTable
        :columns
        :data="filteredChats"
        :loading
        :pagination="{ pageSize: 20 }"
        :scroll-x="810"
        size="small"
      />
    </NCard>

    <NModal
      v-model:show="createModalOpen"
      class="modal-sm"
      preset="card"
      title="登记会话"
    >
      <NForm label-placement="top" size="small">
        <NFormItem label="类型">
          <NSelect
            v-model:value="createForm.kind"
            :options="[
              { label: '群聊', value: 'group' },
              { label: '私聊', value: 'private' },
            ]"
          />
        </NFormItem>
        <NFormItem label="群号 / QQ 号">
          <NInput
            v-model:value="createForm.chatId"
            placeholder="例如 10248888"
          />
        </NFormItem>
        <NFormItem label="显示名称">
          <NInput
            v-model:value="createForm.title"
            placeholder="例如 BITNP 技术部工作群"
          />
        </NFormItem>
        <NFormItem label="触发策略">
          <NSelect
            v-model:value="createForm.triggerMode"
            :options="triggerOptions"
          />
        </NFormItem>
        <NFormItem label="启用状态">
          <NSwitch v-model:value="createForm.enabled" />
        </NFormItem>
        <NSpace justify="end">
          <NButton @click="createModalOpen = false">取消</NButton>
          <NButton :loading="creating" type="primary" @click="handleCreateChat">
            保存
          </NButton>
        </NSpace>
      </NForm>
    </NModal>

    <NDrawer v-model:show="drawerOpen" :width="isNarrowViewport ? '100%' : 680">
      <NDrawerContent
        v-if="activeChat"
        :title="`${activeChat.title || activeChat.chatId} (${activeChat.chatKey})`"
      >
        <NTabs v-model:value="drawerTab" type="line">
          <NTabPane name="messages" tab="消息记录">
            <div class="filter-bar">
              <NInput
                v-model:value="messageSearch"
                class="w-240"
                clearable
                placeholder="搜索群聊消息文本"
                size="small"
                @keyup.enter="loadMessages"
              />
              <NButton
                :loading="loadingMessages"
                size="small"
                @click="loadMessages"
              >
                检索
              </NButton>
            </div>

            <NEmpty
              v-if="!loadingMessages && messages.length === 0"
              description="暂无消息记录"
            />

            <div class="timeline-list">
              <div
                v-for="msg in messages"
                :key="msg.id"
                class="timeline-item"
                :class="{ bot: msg.isBot }"
              >
                <NAvatar
                  round
                  :size="28"
                  :src="`/api/admin/avatars/user/${msg.userId}`"
                />
                <div class="timeline-body">
                  <div class="timeline-meta">
                    <span class="sender-name">
                      {{ msg.senderName || msg.userId }}
                    </span>
                    <span class="mono sender-id">{{ msg.userId }}</span>
                    <NTag v-if="msg.isBot" size="tiny" type="primary">
                      树莓娘
                    </NTag>
                    <NTag v-if="msg.mentionedBot" size="tiny" type="info">
                      @提及
                    </NTag>
                    <NTag v-if="msg.recalledAt" size="tiny" type="warning">
                      已撤回
                    </NTag>
                    <span class="tabular msg-time">
                      {{ formatTime(msg.sentAt) }}
                    </span>
                  </div>

                  <div class="msg-text">{{ msg.text }}</div>

                  <div v-if="msg.assets.length > 0" class="asset-list">
                    <div
                      v-for="asset in msg.assets"
                      :key="asset.id"
                      class="asset-card"
                    >
                      <a
                        v-if="asset.kind === 'image' && asset.filePath"
                        :href="`/api/admin/assets/${asset.id}/raw`"
                        rel="noreferrer"
                        target="_blank"
                      >
                        <img
                          alt="消息图片"
                          class="asset-image"
                          loading="lazy"
                          :src="`/api/admin/assets/${asset.id}/raw`"
                        />
                      </a>
                      <div
                        v-if="asset.transcript || asset.error"
                        class="asset-note"
                      >
                        <NTag class="mr-xs" size="tiny">
                          {{ assetKindLabel(asset.kind) }}
                        </NTag>
                        <NText v-if="asset.transcript">
                          {{ asset.transcript }}
                        </NText>
                        <NText v-else-if="asset.error" type="error">
                          {{ asset.error }}
                        </NText>
                      </div>
                    </div>
                  </div>

                  <div v-if="msg.reactions.length > 0" class="reaction-row">
                    <NTag
                      v-for="reaction in msg.reactions"
                      :key="reaction.emojiId"
                      round
                      size="small"
                    >
                      {{ reaction.emojiName }} × {{ reaction.count }}
                    </NTag>
                  </div>
                </div>
              </div>
            </div>
          </NTabPane>

          <NTabPane name="conversation" tab="全局上下文">
            <NSpace :size="12" vertical>
              <NAlert title="全局单上下文模式" type="info">
                树莓娘在全局单一连续上下文中跨群聊、私聊及定时任务协同工作，各会话通过输入信封的
                chat、speaker
                区分来源；历史查阅及外部操作统一委派子代理，避免主上下文污染。
              </NAlert>
              <div>
                <NButton size="small" type="primary" @click="goToGlobalContext">
                  前往运行概览查看全局上下文
                </NButton>
              </div>
            </NSpace>
          </NTabPane>

          <NTabPane name="inject" tab="测试指令">
            <NSpace :size="12" vertical>
              <NText depth="2">
                直接向当前会话投递一条管理指令，唤醒主 Agent
                执行并在群内或私聊作答。
              </NText>
              <NInput
                v-model:value="injectContent"
                placeholder="例如：汇总本周尚未完成的公会子节点并提醒负责人"
                :rows="4"
                type="textarea"
              />
              <NButton
                :loading="injecting"
                type="primary"
                @click="handleInject"
              >
                <template #icon>
                  <Send :size="14" />
                </template>
                提交执行
              </NButton>
            </NSpace>
          </NTabPane>
        </NTabs>
      </NDrawerContent>
    </NDrawer>
  </div>
</template>

<style scoped>
.timeline-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.timeline-item {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--berry-border);
  border-radius: 6px;
  background: var(--berry-surface);
}

.timeline-item.bot {
  background: var(--berry-inset);
}

.timeline-body {
  flex: 1;
  min-width: 0;
}

.timeline-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
}

.sender-name {
  font-weight: 600;
}

.sender-id {
  font-size: 11px;
  color: var(--berry-muted);
}

.msg-time {
  margin-left: auto;
  font-size: 11px;
  color: var(--berry-muted);
}

.msg-text {
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.55;
}

.asset-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 8px;
}

.asset-card {
  padding: 8px;
  border-radius: 6px;
  border: 1px solid var(--berry-border);
  background: var(--berry-inset);
}

.asset-image {
  display: block;
  max-width: 240px;
  max-height: 180px;
  border-radius: 4px;
  object-fit: contain;
  margin-bottom: 6px;
}

.asset-note {
  font-size: 12px;
  line-height: 1.5;
}

.reaction-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}
</style>
