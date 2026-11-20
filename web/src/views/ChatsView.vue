<script setup lang="ts">
import {
  ChevronLeft,
  Download,
  FileText,
  Plus,
  RefreshCw,
  Search,
  Send,
} from "@lucide/vue";
import {
  NAvatar,
  NButton,
  NCard,
  NEmpty,
  NForm,
  NFormItem,
  NInput,
  NModal,
  NRadioButton,
  NRadioGroup,
  NSelect,
  NSpace,
  NSwitch,
  NTag,
  NText,
  useMessage,
} from "naive-ui";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";

import { apiFetch } from "../api/client.ts";
import ChronoVirtualList from "../components/ChronoVirtualList.vue";
import { useEventStream } from "../composables/useEventStream.ts";
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

const MESSAGE_PAGE_SIZE = 80;

const route = useRoute();
const router = useRouter();
const message = useMessage();

const loading = ref(false);
const syncing = ref(false);
const chats = ref<ChatRow[]>([]);
const filterText = ref("");
const filterKind = ref<"all" | ChatKind>("all");
const busyBackfill = ref<string | null>(null);
const busyDigest = ref<string | null>(null);

const isMobile = ref(typeof window !== "undefined" && window.innerWidth < 860);
const mobileShowDetail = ref(false);

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

const selectedChatKey = ref<string | null>(null);
const messageSearch = ref("");
const loadingMessages = ref(false);
const loadingOlderMessages = ref(false);
const hasOlderMessages = ref(false);
const messages = ref<ChatMessageView[]>([]);
const injectContent = ref("");
const injecting = ref(false);

const triggerOptions = [
  { label: "智能观察", value: "smart_observe" },
  { label: "仅提及", value: "mention_only" },
  { label: "关闭", value: "off" },
];

const triggerLabelMap: Record<TriggerMode, string> = {
  smart_observe: "智能观察",
  mention_only: "仅提及",
  off: "关闭",
};

const filteredChats = computed(() => {
  const kw = filterText.value.trim().toLowerCase();

  return chats.value.filter((chat) => {
    if (filterKind.value !== "all" && chat.kind !== filterKind.value) {
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

const activeChat = computed(
  () => chats.value.find((c) => c.chatKey === selectedChatKey.value) ?? null,
);

function updateViewport() {
  isMobile.value = window.innerWidth < 860;

  if (!isMobile.value) {
    mobileShowDetail.value = false;
  }
}

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

async function selectChat(row: ChatRow, syncQuery = true) {
  const changed = selectedChatKey.value !== row.chatKey;

  selectedChatKey.value = row.chatKey;

  if (isMobile.value) {
    mobileShowDetail.value = true;
  }

  if (changed) {
    messageSearch.value = "";
    messages.value = [];
    hasOlderMessages.value = false;
  }

  if (syncQuery && route.query.chatKey !== row.chatKey) {
    void router.replace({ query: { chatKey: row.chatKey } });
  }

  await loadMessages();
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
    const saved = await apiFetch<ChatRow>("/api/admin/chats", {
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

    const created = chats.value.find((c) => c.chatKey === saved.chatKey);

    if (created) {
      await selectChat(created);
    }
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

async function loadMessages() {
  if (!activeChat.value) {
    return;
  }

  const targetKey = activeChat.value.chatKey;

  loadingMessages.value = true;

  try {
    const qs = new URLSearchParams({ limit: String(MESSAGE_PAGE_SIZE) });

    if (messageSearch.value.trim()) {
      qs.set("search", messageSearch.value.trim());
    }

    const res = await apiFetch<{ items: ChatMessageView[] }>(
      `/api/admin/chats/${encodeURIComponent(targetKey)}/messages?${qs.toString()}`,
    );

    if (activeChat.value?.chatKey !== targetKey) {
      return;
    }

    messages.value = res.items;
    hasOlderMessages.value = res.items.length >= MESSAGE_PAGE_SIZE;
  } catch (err) {
    message.error(err instanceof Error ? err.message : "加载消息失败");
  } finally {
    loadingMessages.value = false;
  }
}

async function loadOlderMessages() {
  if (
    !activeChat.value ||
    loadingOlderMessages.value ||
    !hasOlderMessages.value ||
    messages.value.length === 0
  ) {
    return;
  }

  const oldest = messages.value[0];
  const targetKey = activeChat.value.chatKey;

  if (!oldest) {
    return;
  }

  loadingOlderMessages.value = true;

  try {
    const qs = new URLSearchParams({
      limit: String(MESSAGE_PAGE_SIZE),
      beforeId: String(oldest.id),
    });

    if (messageSearch.value.trim()) {
      qs.set("search", messageSearch.value.trim());
    }

    const res = await apiFetch<{ items: ChatMessageView[] }>(
      `/api/admin/chats/${encodeURIComponent(targetKey)}/messages?${qs.toString()}`,
    );

    if (activeChat.value?.chatKey !== targetKey) {
      return;
    }

    const existingIds = new Set(messages.value.map((m) => m.id));
    const older = res.items.filter((m) => !existingIds.has(m.id));

    if (older.length > 0) {
      messages.value = [...older, ...messages.value];
    }

    hasOlderMessages.value = res.items.length >= MESSAGE_PAGE_SIZE;
  } catch (err) {
    message.error(err instanceof Error ? err.message : "加载更早消息失败");
  } finally {
    loadingOlderMessages.value = false;
  }
}

async function pollLatestMessages() {
  if (
    !activeChat.value ||
    messageSearch.value.trim() ||
    loadingMessages.value
  ) {
    return;
  }

  const targetKey = activeChat.value.chatKey;

  try {
    const res = await apiFetch<{ items: ChatMessageView[] }>(
      `/api/admin/chats/${encodeURIComponent(targetKey)}/messages?limit=30`,
    );

    if (activeChat.value?.chatKey !== targetKey) {
      return;
    }

    if (messages.value.length === 0) {
      messages.value = res.items;
      hasOlderMessages.value = res.items.length >= 30;

      return;
    }

    const existingIds = new Set(messages.value.map((m) => m.id));
    const fresh = res.items.filter((m) => !existingIds.has(m.id));

    if (fresh.length > 0) {
      messages.value = [...messages.value, ...fresh];
    }
  } catch {
    // Keep existing timeline on transient SSE refresh errors.
  }
}

useEventStream((type) => {
  if (type === "delivery_update" || type === "job_update") {
    void pollLatestMessages();
  }
});

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

function handleComposerKeydown(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    void handleInject();
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

let searchTimer: ReturnType<typeof setTimeout> | null = null;

watch(messageSearch, () => {
  if (!activeChat.value) {
    return;
  }

  if (searchTimer) {
    clearTimeout(searchTimer);
  }

  searchTimer = setTimeout(() => {
    void loadMessages();
  }, 260);
});

onMounted(async () => {
  window.addEventListener("resize", updateViewport);
  await loadChats();

  const queryChat =
    (typeof route.query.chatKey === "string" && route.query.chatKey) ||
    (typeof route.query.chat === "string" && route.query.chat) ||
    "";

  if (queryChat) {
    const match = chats.value.find((c) => c.chatKey === queryChat);

    if (match) {
      await selectChat(match, false);

      return;
    }
  }

  if (!isMobile.value && chats.value.length > 0) {
    await selectChat(chats.value[0], false);
  }
});

onUnmounted(() => {
  window.removeEventListener("resize", updateViewport);

  if (searchTimer) {
    clearTimeout(searchTimer);
  }
});
</script>

<template>
  <div class="chats-page">
    <div class="chats-workspace">
      <NCard
        v-show="!isMobile || !mobileShowDetail"
        class="chats-sider"
        content-style="padding: 10px; display: flex; flex-direction: column; gap: 8px; height: 100%; min-height: 0;"
        size="small"
      >
        <div class="sider-top">
          <span class="sider-heading">会话 ({{ chats.length }})</span>
          <NSpace :size="4">
            <NButton
              :loading="syncing"
              quaternary
              size="tiny"
              @click="handleSyncGroups"
            >
              <template #icon>
                <RefreshCw :size="13" />
              </template>
              同步群
            </NButton>
            <NButton size="tiny" type="primary" @click="createModalOpen = true">
              <template #icon>
                <Plus :size="13" />
              </template>
              登记
            </NButton>
          </NSpace>
        </div>

        <NRadioGroup
          v-model:value="filterKind"
          class="kind-switch"
          size="small"
        >
          <NRadioButton value="all">全部</NRadioButton>
          <NRadioButton value="group">群聊</NRadioButton>
          <NRadioButton value="private">私聊</NRadioButton>
        </NRadioGroup>

        <NInput
          v-model:value="filterText"
          clearable
          placeholder="搜索群名、昵称或号码"
          size="small"
        >
          <template #prefix>
            <Search :size="13" />
          </template>
        </NInput>

        <div class="chat-list">
          <NEmpty
            v-if="!loading && filteredChats.length === 0"
            class="py-empty"
            description="暂无匹配会话"
          />

          <button
            v-for="chat in filteredChats"
            :key="chat.chatKey"
            class="chat-row"
            :class="{
              active: chat.chatKey === selectedChatKey,
              disabled: !chat.enabled,
            }"
            type="button"
            @click="selectChat(chat)"
          >
            <NAvatar
              class="chat-row-avatar"
              round
              :size="34"
              :src="avatarUrlForChat(chat)"
            />
            <div class="chat-row-main">
              <div class="chat-row-head">
                <span class="chat-row-title">
                  {{ chat.title || chat.chatId }}
                </span>
                <span class="chat-row-time tabular">
                  {{ formatTime(chat.updatedAt) }}
                </span>
              </div>
              <div class="chat-row-sub">
                <span class="status-dot" :class="chat.enabled ? 'on' : 'off'" />
                <span class="chat-row-mode">
                  {{ triggerLabelMap[chat.triggerMode] }}
                </span>
                <span class="mono chat-row-id">{{ chat.chatId }}</span>
              </div>
            </div>
          </button>
        </div>
      </NCard>

      <NCard
        v-show="!isMobile || mobileShowDetail"
        class="chats-main"
        content-style="padding: 0; display: flex; flex-direction: column; height: 100%; min-height: 0;"
        size="small"
      >
        <template v-if="activeChat">
          <div class="chat-header">
            <div class="chat-header-left">
              <NButton
                v-if="isMobile"
                quaternary
                size="small"
                @click="mobileShowDetail = false"
              >
                <template #icon>
                  <ChevronLeft :size="16" />
                </template>
              </NButton>
              <NAvatar round :size="32" :src="avatarUrlForChat(activeChat)" />
              <div class="chat-header-meta">
                <div class="chat-header-title">
                  {{ activeChat.title || activeChat.chatId }}
                </div>
                <div class="mono chat-header-key">{{ activeChat.chatKey }}</div>
              </div>
            </div>

            <div class="chat-header-controls">
              <NSpace align="center" :size="6">
                <NText class="sub-note" depth="3">启用</NText>
                <NSwitch
                  size="small"
                  :value="activeChat.enabled"
                  @update:value="
                    (val: boolean) => patchChat(activeChat!, { enabled: val })
                  "
                />
              </NSpace>
              <NSelect
                class="w-115"
                :options="triggerOptions"
                size="small"
                :value="activeChat.triggerMode"
                @update:value="
                  (val: TriggerMode) =>
                    patchChat(activeChat!, { triggerMode: val })
                "
              />
              <NButton
                :loading="busyBackfill === activeChat.chatKey"
                secondary
                size="small"
                @click="handleBackfill(activeChat)"
              >
                <template #icon>
                  <Download :size="13" />
                </template>
                补录更早
              </NButton>
              <NButton
                v-if="activeChat.kind === 'group'"
                :loading="busyDigest === activeChat.chatKey"
                secondary
                size="small"
                @click="handleDigest(activeChat)"
              >
                <template #icon>
                  <FileText :size="13" />
                </template>
                生成摘要
              </NButton>
            </div>
          </div>

          <div class="chat-search-bar">
            <NInput
              v-model:value="messageSearch"
              clearable
              placeholder="搜索当前会话消息内容或发送者"
              size="small"
              @keyup.enter="loadMessages"
            >
              <template #prefix>
                <Search :size="13" />
              </template>
            </NInput>
            <NButton
              :loading="loadingMessages"
              size="small"
              @click="loadMessages"
            >
              <template #icon>
                <RefreshCw :size="13" />
              </template>
              刷新
            </NButton>
          </div>

          <div class="chat-stream-wrap">
            <ChronoVirtualList
              class="chat-stream-shell"
              empty-text="暂无消息记录"
              :has-older="hasOlderMessages"
              :item-size="52"
              :items="messages"
              key-field="id"
              :loading-older="loadingOlderMessages"
              @load-older="loadOlderMessages"
            >
              <template #default="{ item: msg }">
                <div class="timeline-row">
                  <div class="timeline-item" :class="{ bot: msg.isBot }">
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
              </template>
            </ChronoVirtualList>
          </div>

          <div class="chat-composer">
            <NInput
              v-model:value="injectContent"
              :autosize="{ minRows: 1, maxRows: 4 }"
              placeholder="向该会话下发管理指令唤醒树莓娘（Ctrl+Enter 发送）"
              size="small"
              type="textarea"
              @keydown="handleComposerKeydown"
            />
            <NButton
              :disabled="!injectContent.trim()"
              :loading="injecting"
              size="small"
              type="primary"
              @click="handleInject"
            >
              <template #icon>
                <Send :size="13" />
              </template>
              发送指令
            </NButton>
          </div>
        </template>

        <div v-else class="chat-empty-wrap">
          <NEmpty description="从左侧选择一个会话查看消息并管理配置" />
        </div>
      </NCard>
    </div>

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
  </div>
</template>

<style scoped>
.chats-page {
  height: calc(100vh - 88px);
  min-height: 480px;
}

.chats-workspace {
  display: grid;
  grid-template-columns: 296px minmax(0, 1fr);
  gap: 12px;
  height: 100%;
  min-height: 0;
}

.chats-sider,
.chats-main {
  height: 100%;
  min-height: 0;
  overflow: hidden;
}

.sider-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.sider-heading {
  font-size: 14px;
  font-weight: 600;
}

.kind-switch {
  display: flex;
  width: 100%;
}

.kind-switch :deep(.n-radio-button) {
  flex: 1;
  text-align: center;
}

.chat-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-right: 2px;
}

.chat-row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 9px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
  transition:
    background-color 0.14s ease,
    border-color 0.14s ease;
}

.chat-row:hover {
  background: var(--berry-inset);
}

.chat-row.active {
  background: var(--berry-inset);
  border-color: var(--berry-accent);
}

.chat-row.disabled {
  opacity: 0.62;
}

.chat-row-avatar {
  flex-shrink: 0;
}

.chat-row-main {
  flex: 1;
  min-width: 0;
}

.chat-row-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 6px;
}

.chat-row-title {
  font-size: 13px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chat-row-time {
  font-size: 11px;
  color: var(--berry-muted);
  flex-shrink: 0;
}

.chat-row-sub {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 2px;
  font-size: 11px;
  color: var(--berry-muted);
}

.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  flex-shrink: 0;
}

.status-dot.on {
  background: #18a058;
}

.status-dot.off {
  background: var(--berry-muted);
}

.chat-row-mode {
  flex-shrink: 0;
}

.chat-row-id {
  margin-left: auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chat-header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--berry-border);
  flex-shrink: 0;
}

.chat-header-left {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.chat-header-meta {
  min-width: 0;
}

.chat-header-title {
  font-size: 15px;
  font-weight: 600;
  line-height: 1.25;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chat-header-key {
  font-size: 11px;
  color: var(--berry-muted);
}

.chat-header-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.chat-search-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--berry-border);
  flex-shrink: 0;
}

.chat-stream-wrap {
  flex: 1;
  min-height: 0;
  padding: 8px 14px 0;
  display: flex;
  flex-direction: column;
}

.chat-stream-shell {
  flex: 1;
  min-height: 0;
  height: 100%;
}

.chat-composer {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding: 10px 14px;
  border-top: 1px solid var(--berry-border);
  background: var(--berry-surface);
  flex-shrink: 0;
}

.chat-empty-wrap {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}

.timeline-row {
  padding-bottom: 10px;
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
}

.asset-note {
  margin-top: 6px;
  font-size: 12px;
  line-height: 1.5;
}

.reaction-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}

@media (max-width: 859px) {
  .chats-page {
    height: calc(100vh - 82px);
  }

  .chats-workspace {
    grid-template-columns: 1fr;
  }

  .chat-header {
    padding: 8px 10px;
  }

  .chat-search-bar,
  .chat-stream-wrap,
  .chat-composer {
    padding-left: 10px;
    padding-right: 10px;
  }
}
</style>
