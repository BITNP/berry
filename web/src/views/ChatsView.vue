<script setup lang="ts">
import {
  ChevronLeft,
  Download,
  FileText,
  Plus,
  RefreshCw,
  Search,
  Send,
  Sparkles,
} from "@lucide/vue";
import {
  NAlert,
  NAvatar,
  NButton,
  NCard,
  NDrawer,
  NDrawerContent,
  NEmpty,
  NForm,
  NFormItem,
  NInput,
  NModal,
  NRadioButton,
  NRadioGroup,
  NSelect,
  NSpace,
  NSpin,
  NSwitch,
  NTag,
  NText,
  useMessage,
} from "naive-ui";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";

import { apiFetch } from "../api/client.ts";
import ChronoVirtualList from "../components/ChronoVirtualList.vue";
import TraceInspector from "../components/TraceInspector.vue";
import { useLiveRefresh } from "../composables/useEventStream.ts";
import type { AiTraceView, MessageTraceSummary } from "../utils/ai.ts";
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
  stylePrompt?: string;
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
  traceSummary?: MessageTraceSummary;
}

const MESSAGE_PAGE_SIZE = 80;

const route = useRoute();
const router = useRouter();
const message = useMessage();

const loading = ref(false);
const syncing = ref(false);
const chats = ref<ChatRow[]>([]);
const filterText = ref(typeof route.query.q === "string" ? route.query.q : "");
const filterKind = ref<"all" | ChatKind>(
  route.query.kind === "group" || route.query.kind === "private"
    ? route.query.kind
    : "all",
);
const busyBackfill = ref<string | null>(null);
const busyDigest = ref<string | null>(null);

const isMobile = ref(window.innerWidth < 860);
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
const messageSearch = ref(
  typeof route.query.search === "string" ? route.query.search : "",
);
const loadingMessages = ref(false);
const loadingOlderMessages = ref(false);
const hasOlderMessages = ref(false);
const messages = ref<ChatMessageView[]>([]);
const injectContent = ref("");
const injecting = ref(false);

const traceDrawerOpen = ref(false);
const traceLoading = ref(false);
const traceError = ref<string | null>(null);
const activeTraceMessage = ref<ChatMessageView | null>(null);
const activeMessageTrace = ref<AiTraceView | null>(null);
let traceRequestSeq = 0;

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

async function loadChats(options: { silent?: boolean } = {}) {
  if (!options.silent) {
    loading.value = true;
  }

  try {
    const res = await apiFetch<{ items: ChatRow[] }>("/api/admin/chats");

    chats.value = res.items;
  } catch (err) {
    if (!options.silent) {
      message.error(err instanceof Error ? err.message : "加载会话列表失败");
    }
  } finally {
    if (!options.silent) {
      loading.value = false;
    }
  }
}

function syncQuery() {
  const next: Record<string, string> = {};

  if (selectedChatKey.value) {
    next.chatKey = selectedChatKey.value;
  }

  if (filterKind.value !== "all") {
    next.kind = filterKind.value;
  }

  const trimmedChatQ = filterText.value.trim();

  if (trimmedChatQ) {
    next.q = trimmedChatQ;
  }

  const trimmedSearch = messageSearch.value.trim();

  if (trimmedSearch) {
    next.search = trimmedSearch;
  }

  const currentKeys = Object.keys(route.query).filter((k) => {
    const v = route.query[k];

    return typeof v === "string" && v !== "";
  });
  const nextKeys = Object.keys(next);

  if (
    currentKeys.length !== nextKeys.length ||
    !nextKeys.every((k) => route.query[k] === next[k])
  ) {
    void router.replace({ query: next });
  }
}

async function selectChat(
  row: ChatRow,
  options: { syncQuery?: boolean; preserveSearch?: boolean } = {},
) {
  const shouldSync = options.syncQuery ?? true;
  const changed = selectedChatKey.value !== row.chatKey;

  selectedChatKey.value = row.chatKey;

  if (isMobile.value) {
    mobileShowDetail.value = true;
  }

  if (changed) {
    if (!options.preserveSearch) {
      messageSearch.value = "";
    }

    messages.value = [];
    hasOlderMessages.value = false;
  }

  if (shouldSync) {
    syncQuery();
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
    const payload =
      createForm.value.kind === "private"
        ? {
            kind: createForm.value.kind,
            chatId: createForm.value.chatId,
            title: createForm.value.title,
            enabled: createForm.value.enabled,
          }
        : createForm.value;
    const saved = await apiFetch<ChatRow>("/api/admin/chats", {
      method: "POST",
      body: JSON.stringify(payload),
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
  patch: Partial<{
    enabled: boolean;
    triggerMode: TriggerMode;
    title: string;
    stylePrompt: string;
  }>,
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
      reachedStart: boolean;
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

const styleModalOpen = ref(false);
const styleDraft = ref("");
const savingStyle = ref(false);
const generatingStyle = ref(false);

function openStyleModal(row: ChatRow) {
  styleDraft.value = row.stylePrompt ?? "";
  styleModalOpen.value = true;
}

async function handleGenerateStyle() {
  if (!activeChat.value) {
    return;
  }

  generatingStyle.value = true;

  try {
    const res = await apiFetch<{ ok: boolean; chat: ChatRow }>(
      `/api/admin/chats/${encodeURIComponent(activeChat.value.chatKey)}/style/generate`,
      { method: "POST" },
    );

    Object.assign(activeChat.value, res.chat);
    styleDraft.value = res.chat.stylePrompt ?? "";
    message.success("已从近期聊天提炼并保存群风格");
  } catch (err) {
    message.error(err instanceof Error ? err.message : "提炼群风格失败");
  } finally {
    generatingStyle.value = false;
  }
}

async function handleSaveStyle() {
  if (!activeChat.value) {
    return;
  }

  savingStyle.value = true;

  try {
    await patchChat(activeChat.value, { stylePrompt: styleDraft.value });
    styleModalOpen.value = false;
  } finally {
    savingStyle.value = false;
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

useLiveRefresh({
  events: ["message_update", "delivery_update", "job_update"],
  debounceMs: 250,
  enabled: () => activeChat.value !== null && !messageSearch.value.trim(),
  match: (_type, data) => {
    const ev = data as { chatKey?: string | null };

    return !ev.chatKey || ev.chatKey === activeChat.value!.chatKey;
  },
  refresh: () => pollLatestMessages(),
});

useLiveRefresh({
  events: ["message_update", "delivery_update"],
  debounceMs: 600,
  refresh: () => loadChats({ silent: true }),
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

function gateActionMeta(
  action: MessageTraceSummary["gateAction"],
): { label: string; type: "primary" | "success" | "default" } | null {
  if (action === "reply") {
    return { label: "分流 · 回复", type: "primary" };
  }

  if (action === "memory") {
    return { label: "分流 · 记忆", type: "success" };
  }

  if (action === "ignore") {
    return { label: "分流 · 忽略", type: "default" };
  }

  return null;
}

async function openMessageTrace(msg: ChatMessageView) {
  const reqId = ++traceRequestSeq;

  activeTraceMessage.value = msg;
  activeMessageTrace.value = null;
  traceError.value = null;
  traceDrawerOpen.value = true;
  traceLoading.value = true;

  try {
    const trace = await apiFetch<AiTraceView>(
      `/api/admin/messages/${msg.id}/trace`,
    );

    if (reqId !== traceRequestSeq) {
      return;
    }

    activeMessageTrace.value = trace;
  } catch (err) {
    if (reqId !== traceRequestSeq) {
      return;
    }

    traceError.value =
      err instanceof Error ? err.message : "加载消息 AI 追踪失败";
  } finally {
    if (reqId === traceRequestSeq) {
      traceLoading.value = false;
    }
  }
}

const collectingAssetId = ref<number | null>(null);

async function collectAssetAsSticker(assetId: number) {
  collectingAssetId.value = assetId;

  try {
    const res = await apiFetch<{ created: boolean }>(
      `/api/admin/stickers/from-asset/${assetId}`,
      { method: "POST" },
    );

    message.success(
      res.created ? "已收进表情包库并上架" : "该图片已在表情包库中",
    );
  } catch (err) {
    message.error(err instanceof Error ? err.message : "收录表情包失败");
  } finally {
    collectingAssetId.value = null;
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
let chatFilterTimer: ReturnType<typeof setTimeout> | null = null;

watch(filterKind, () => {
  syncQuery();
});

watch(filterText, () => {
  if (chatFilterTimer) {
    clearTimeout(chatFilterTimer);
  }

  chatFilterTimer = setTimeout(() => {
    syncQuery();
  }, 240);
});

watch(messageSearch, () => {
  if (!activeChat.value) {
    return;
  }

  if (searchTimer) {
    clearTimeout(searchTimer);
  }

  searchTimer = setTimeout(() => {
    syncQuery();
    void loadMessages();
  }, 260);
});

watch(
  () => route.query,
  (q) => {
    const nextKind: "all" | ChatKind =
      q.kind === "group" || q.kind === "private" ? q.kind : "all";

    if (nextKind !== filterKind.value) {
      filterKind.value = nextKind;
    }

    const nextQ = typeof q.q === "string" ? q.q : "";

    if (nextQ !== filterText.value) {
      filterText.value = nextQ;
    }

    const nextSearch = typeof q.search === "string" ? q.search : "";

    if (nextSearch !== messageSearch.value) {
      messageSearch.value = nextSearch;
    }

    const nextChatKey =
      (typeof q.chatKey === "string" && q.chatKey) ||
      (typeof q.chat === "string" && q.chat) ||
      "";

    if (nextChatKey && nextChatKey !== selectedChatKey.value) {
      const match = chats.value.find((c) => c.chatKey === nextChatKey);

      if (match) {
        void selectChat(match, { syncQuery: false, preserveSearch: true });
      }
    }
  },
);

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
      await selectChat(match, { syncQuery: false, preserveSearch: true });

      return;
    }
  }

  if (!isMobile.value && chats.value.length > 0) {
    await selectChat(chats.value[0], {
      syncQuery: false,
      preserveSearch: true,
    });
  }
});

onUnmounted(() => {
  window.removeEventListener("resize", updateViewport);

  if (searchTimer) {
    clearTimeout(searchTimer);
  }

  if (chatFilterTimer) {
    clearTimeout(chatFilterTimer);
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
                  {{
                    chat.kind === "private"
                      ? chat.enabled
                        ? "私聊"
                        : "已停用"
                      : triggerLabelMap[chat.triggerMode]
                  }}
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
                v-if="activeChat.kind === 'group'"
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
              <NButton
                v-if="activeChat.kind === 'group'"
                secondary
                size="small"
                @click="openStyleModal(activeChat)"
              >
                <template #icon>
                  <Sparkles :size="13" />
                </template>
                群风格
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
                            v-if="asset.kind === 'image' && asset.filePath"
                            class="asset-actions"
                          >
                            <NButton
                              :loading="collectingAssetId === asset.id"
                              quaternary
                              size="tiny"
                              @click="collectAssetAsSticker(asset.id)"
                            >
                              收进表情包库
                            </NButton>
                          </div>
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

                      <div v-if="msg.traceSummary?.hasTrace" class="trace-bar">
                        <NTag
                          v-if="gateActionMeta(msg.traceSummary.gateAction)"
                          size="tiny"
                          :title="msg.traceSummary.gateReason || undefined"
                          :type="
                            gateActionMeta(msg.traceSummary.gateAction)?.type
                          "
                        >
                          {{
                            gateActionMeta(msg.traceSummary.gateAction)?.label
                          }}
                        </NTag>
                        <NTag
                          v-if="msg.traceSummary.aiErrors > 0"
                          size="tiny"
                          type="error"
                        >
                          AI 异常 · {{ msg.traceSummary.aiErrors }}/{{
                            msg.traceSummary.aiCalls
                          }}
                        </NTag>
                        <span
                          v-else-if="msg.traceSummary.aiCalls > 0"
                          class="trace-bar-meta tabular"
                        >
                          AI {{ msg.traceSummary.aiCalls }} 步
                        </span>
                        <span
                          v-if="msg.traceSummary.gateReason"
                          class="trace-bar-reason"
                        >
                          {{ msg.traceSummary.gateReason }}
                        </span>
                        <button
                          class="trace-bar-btn"
                          type="button"
                          @click="openMessageTrace(msg)"
                        >
                          <Sparkles :size="12" />
                          <span>查看追踪</span>
                        </button>
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
            :placeholder="
              createForm.kind === 'private'
                ? '留空自动获取用户昵称'
                : '留空自动获取群名'
            "
          />
        </NFormItem>
        <NFormItem v-if="createForm.kind === 'group'" label="触发策略">
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

    <NModal
      v-model:show="styleModalOpen"
      preset="card"
      :style="{ width: '560px', maxWidth: '94vw' }"
      title="分群表达风格"
    >
      <NForm label-placement="top" size="small">
        <NFormItem label="风格提示（按当前群动态注入，留空沿用默认）">
          <NInput
            v-model:value="styleDraft"
            maxlength="600"
            placeholder="例如：本群技术讨论为主，回复直给简洁；偶尔接一两句轻量梗即可"
            :rows="5"
            show-count
            type="textarea"
          />
        </NFormItem>
        <NSpace justify="space-between">
          <NButton
            :loading="generatingStyle"
            secondary
            size="small"
            @click="handleGenerateStyle"
          >
            <template #icon>
              <Sparkles :size="13" />
            </template>
            从近期聊天提炼
          </NButton>
          <NSpace :size="8">
            <NButton size="small" @click="styleDraft = ''">清空</NButton>
            <NButton
              :loading="savingStyle"
              size="small"
              type="primary"
              @click="handleSaveStyle"
            >
              保存风格
            </NButton>
          </NSpace>
        </NSpace>
      </NForm>
    </NModal>

    <NDrawer
      v-model:show="traceDrawerOpen"
      placement="right"
      :width="isMobile ? '94vw' : 760"
    >
      <NDrawerContent
        closable
        :title="
          activeTraceMessage
            ? `消息追踪 · ${activeTraceMessage.senderName || activeTraceMessage.userId}`
            : '消息 AI 追踪'
        "
      >
        <div v-if="traceLoading" class="trace-drawer-state">
          <NSpin size="medium" />
        </div>
        <NAlert v-else-if="traceError" type="error">
          {{ traceError }}
        </NAlert>
        <TraceInspector
          v-else-if="activeMessageTrace"
          hide-jump-to-chat
          :trace="activeMessageTrace"
        />
        <div v-else class="trace-drawer-state">
          <NEmpty description="该消息暂无关联 AI 追踪" />
        </div>
      </NDrawerContent>
    </NDrawer>
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

.trace-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  padding-top: 6px;
  border-top: 1px dashed var(--berry-border);
  font-size: 11px;
}

.trace-bar-meta {
  color: var(--berry-muted);
}

.trace-bar-reason {
  color: var(--berry-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 340px;
}

.trace-bar-btn {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 7px;
  border: 1px solid var(--berry-border);
  border-radius: 4px;
  background: transparent;
  color: var(--berry-accent);
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  transition:
    background-color 0.14s ease,
    border-color 0.14s ease;
}

.trace-bar-btn:hover {
  background: var(--berry-inset);
  border-color: var(--berry-accent);
}

.trace-bar-btn:focus-visible {
  outline: 2px solid var(--berry-accent);
  outline-offset: 1px;
}

.trace-drawer-state {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 200px;
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
