<script setup lang="ts">
import { Plus, RefreshCw, Trash2 } from "@lucide/vue";
import type { DataTableColumns } from "naive-ui";
import {
  NButton,
  NCard,
  NDataTable,
  NDatePicker,
  NForm,
  NFormItem,
  NInput,
  NModal,
  NPopconfirm,
  NSelect,
  NSpace,
  NTag,
  NText,
  useMessage,
} from "naive-ui";
import { computed, h, onMounted, ref, watch } from "vue";

import { apiFetch } from "../api/client.ts";
import { useChatOptions } from "../composables/useChatOptions.ts";
import { useLiveRefresh } from "../composables/useEventStream.ts";
import { formatTime } from "../utils/format.ts";

type MemoryScope = "global" | "chat" | "user";

interface MemoryRow {
  id: number;
  scope: MemoryScope;
  ownerId: string;
  key: string;
  summary: string;
  content: string;
  sourceMessageId: number | null;
  expiresAt: number | null;
  updatedAt: number;
}

const SCOPE_META: Record<
  MemoryScope,
  { label: string; tagType: "primary" | "info" | "default" }
> = {
  global: { label: "全局", tagType: "primary" },
  chat: { label: "群聊", tagType: "info" },
  user: { label: "成员", tagType: "default" },
};

const message = useMessage();
const { chats, users, chatOptions, userOptions } = useChatOptions();

const loading = ref(false);
const saving = ref(false);
const items = ref<MemoryRow[]>([]);
const filterScope = ref<MemoryScope | null>(null);
const filterOwnerId = ref<string | null>(null);
const filterSearch = ref("");

const chatTitleByKey = computed(
  () => new Map(chats.value.map((c) => [c.chatKey, c.title])),
);
const userNameById = computed(
  () => new Map(users.value.map((u) => [u.userId, u.name])),
);

function formatOwner(scope: MemoryScope, ownerId: string): string {
  if (scope === "global" || ownerId === "global") {
    return "全局";
  }

  if (scope === "chat") {
    const title = chatTitleByKey.value.get(ownerId);

    return title ? `${title} (${ownerId})` : ownerId;
  }

  const name = userNameById.value.get(ownerId);

  return name && name !== ownerId ? `${name} (${ownerId})` : ownerId;
}

const ownerFilterOptions = computed(() => {
  if (filterScope.value === "global") {
    return [{ label: "全局 (global)", value: "global" }];
  }

  if (filterScope.value === "chat") {
    return chatOptions.value;
  }

  if (filterScope.value === "user") {
    return userOptions.value;
  }

  return [
    { label: "全局 (global)", value: "global" },
    ...chatOptions.value,
    ...userOptions.value,
  ];
});

const modalOpen = ref(false);
const isEdit = ref(false);
const form = ref<{
  scope: MemoryScope;
  ownerId: string | null;
  key: string;
  summary: string;
  content: string;
  expiresAt: number | null;
}>({
  scope: "chat",
  ownerId: null,
  key: "",
  summary: "",
  content: "",
  expiresAt: null,
});

const visibleItems = computed(() => {
  const kw = filterSearch.value.trim().toLowerCase();

  if (!kw) {
    return items.value;
  }

  return items.value.filter(
    (row) =>
      row.key.toLowerCase().includes(kw) ||
      row.summary.toLowerCase().includes(kw) ||
      row.content.toLowerCase().includes(kw) ||
      row.ownerId.toLowerCase().includes(kw) ||
      formatOwner(row.scope, row.ownerId).toLowerCase().includes(kw),
  );
});

async function loadMemories() {
  loading.value = true;

  try {
    const qs = new URLSearchParams();

    if (filterScope.value) {
      qs.set("scope", filterScope.value);
    }

    if (filterOwnerId.value?.trim()) {
      qs.set("ownerId", filterOwnerId.value.trim());
    }

    const res = await apiFetch<{ items: MemoryRow[] }>(
      `/api/admin/memories?${qs.toString()}`,
    );

    items.value = res.items;
  } catch (err) {
    message.error(err instanceof Error ? err.message : "加载记忆列表失败");
  } finally {
    loading.value = false;
  }
}

useLiveRefresh({
  events: ["memory_update"],
  debounceMs: 300,
  refresh: () => loadMemories(),
});

function openCreate() {
  isEdit.value = false;
  form.value = {
    scope: filterScope.value ?? "chat",
    ownerId: filterScope.value === "global" ? "global" : null,
    key: "",
    summary: "",
    content: "",
    expiresAt: null,
  };
  modalOpen.value = true;
}

function openEdit(row: MemoryRow) {
  isEdit.value = true;
  form.value = {
    scope: row.scope,
    ownerId: row.ownerId,
    key: row.key,
    summary: row.summary,
    content: row.content,
    expiresAt: row.expiresAt ?? null,
  };
  modalOpen.value = true;
}

function handleScopeChange(scope: MemoryScope) {
  form.value.scope = scope;

  if (!isEdit.value) {
    form.value.ownerId = scope === "global" ? "global" : null;
  }
}

function normalizeOwnerId(scope: MemoryScope, raw: string | null): string {
  if (scope === "global") {
    return "global";
  }

  const trimmed = (raw ?? "").trim();

  if (!trimmed) {
    return "";
  }

  if (scope === "chat") {
    return /^\d+$/.test(trimmed) ? `group:${trimmed}` : trimmed;
  }

  return trimmed.startsWith("private:")
    ? trimmed.slice("private:".length)
    : trimmed;
}

async function handleSave() {
  const ownerId = normalizeOwnerId(form.value.scope, form.value.ownerId);

  if (!ownerId || !form.value.key.trim() || !form.value.summary.trim()) {
    message.warning(
      form.value.scope === "global"
        ? "请填写键名和摘要"
        : form.value.scope === "user"
          ? "请选择或输入目标成员，并填写键名和摘要"
          : "请选择或输入目标会话，并填写键名和摘要",
    );

    return;
  }

  saving.value = true;

  try {
    await apiFetch("/api/admin/memories", {
      method: "PUT",
      body: JSON.stringify({
        scope: form.value.scope,
        ownerId,
        key: form.value.key.trim(),
        summary: form.value.summary.trim(),
        content: form.value.content.trim(),
        expiresAt: form.value.expiresAt,
      }),
    });
    modalOpen.value = false;
    message.success("已保存记忆条目");
    await loadMemories();
  } catch (err) {
    message.error(err instanceof Error ? err.message : "保存失败");
  } finally {
    saving.value = false;
  }
}

async function handleDelete(row: MemoryRow) {
  try {
    const qs = new URLSearchParams({
      scope: row.scope,
      ownerId: row.ownerId,
      key: row.key,
    });

    await apiFetch(`/api/admin/memories?${qs.toString()}`, {
      method: "DELETE",
    });
    message.success("已删除记忆");
    await loadMemories();
  } catch (err) {
    message.error(err instanceof Error ? err.message : "删除失败");
  }
}

const columns: DataTableColumns<MemoryRow> = [
  {
    title: "范围",
    key: "scope",
    width: 90,
    render: (row) =>
      h(
        NTag,
        { size: "small", type: SCOPE_META[row.scope].tagType },
        { default: () => SCOPE_META[row.scope].label },
      ),
  },
  {
    title: "归属",
    key: "ownerId",
    width: 196,
    ellipsis: { tooltip: true },
    render: (row) => formatOwner(row.scope, row.ownerId),
  },
  {
    title: "键名",
    key: "key",
    width: 150,
    render: (row) => h("span", { class: "mono" }, row.key),
  },
  {
    title: "摘要",
    key: "summary",
    minWidth: 190,
    ellipsis: { tooltip: true },
  },
  {
    title: "详情",
    key: "content",
    minWidth: 220,
    ellipsis: { tooltip: true },
  },
  {
    title: "有效期",
    key: "expiresAt",
    width: 148,
    render: (row) =>
      row.expiresAt
        ? h("span", { class: "tabular" }, formatTime(row.expiresAt))
        : h(NText, { depth: 3 }, { default: () => "永久" }),
  },
  {
    title: "更新时间",
    key: "updatedAt",
    width: 148,
    render: (row) => h("span", { class: "tabular" }, formatTime(row.updatedAt)),
  },
  {
    title: "操作",
    key: "actions",
    width: 120,
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
                onClick: () => openEdit(row),
              },
              { default: () => "编辑" },
            ),
            h(
              NPopconfirm,
              {
                onPositiveClick: () => {
                  void handleDelete(row);
                },
              },
              {
                trigger: () =>
                  h(
                    NButton,
                    { size: "tiny", quaternary: true, type: "error" },
                    { icon: () => h(Trash2, { size: 12 }) },
                  ),
                default: () => "确定删除这条记忆？",
              },
            ),
          ],
        },
      ),
  },
];

watch([filterScope, filterOwnerId], () => {
  void loadMemories();
});

onMounted(() => {
  void loadMemories();
});
</script>

<template>
  <div>
    <div class="page-bar">
      <NSpace align="center" :size="10">
        <h1 class="page-title">长期记忆</h1>
        <NText class="sub-note" depth="3">{{ visibleItems.length }} 条</NText>
      </NSpace>
      <NButton size="small" type="primary" @click="openCreate">
        <template #icon>
          <Plus :size="14" />
        </template>
        新增记忆
      </NButton>
    </div>

    <div class="filter-bar">
      <NSelect
        v-model:value="filterScope"
        class="w-165"
        clearable
        :options="[
          { label: '全局记忆（global）', value: 'global' },
          { label: '群聊记忆（chat）', value: 'chat' },
          { label: '成员记忆（user）', value: 'user' },
        ]"
        placeholder="全部范围"
        size="small"
      />
      <NSelect
        v-model:value="filterOwnerId"
        class="w-240"
        clearable
        filterable
        :options="ownerFilterOptions"
        placeholder="选择或输入归属（支持群名/QQ）"
        size="small"
        tag
      />
      <NInput
        v-model:value="filterSearch"
        class="w-190"
        clearable
        placeholder="关键词筛选"
        size="small"
      />
      <NButton :loading size="small" @click="loadMemories">
        <template #icon>
          <RefreshCw :size="14" />
        </template>
        查询
      </NButton>
    </div>

    <NCard size="small">
      <NDataTable
        :columns
        :data="visibleItems"
        :loading
        :pagination="{ pageSize: 20 }"
        :scroll-x="900"
        size="small"
      />
    </NCard>

    <NModal
      v-model:show="modalOpen"
      class="modal-md"
      preset="card"
      :title="isEdit ? '编辑记忆' : '新增记忆'"
    >
      <NForm label-placement="top" size="small">
        <NFormItem label="范围">
          <NSelect
            :disabled="isEdit"
            :options="[
              { label: '全局记忆（global）', value: 'global' },
              { label: '群聊记忆（chat）', value: 'chat' },
              { label: '成员记忆（user）', value: 'user' },
            ]"
            :value="form.scope"
            @update:value="handleScopeChange"
          />
        </NFormItem>
        <NFormItem
          v-if="form.scope !== 'global'"
          :label="form.scope === 'user' ? '目标成员' : '目标会话'"
        >
          <NSelect
            v-if="!isEdit && form.scope === 'chat'"
            v-model:value="form.ownerId"
            clearable
            filterable
            :options="chatOptions"
            placeholder="搜索群名/私聊，或直接输入群号"
            tag
          />
          <NSelect
            v-else-if="!isEdit && form.scope === 'user'"
            v-model:value="form.ownerId"
            clearable
            filterable
            :options="userOptions"
            placeholder="搜索昵称/QQ 号，或直接输入新 QQ 号"
            tag
          />
          <NInput
            v-else
            disabled
            :value="formatOwner(form.scope, form.ownerId ?? '')"
          />
        </NFormItem>
        <NFormItem label="记忆键名">
          <NInput
            v-model:value="form.key"
            :disabled="isEdit"
            placeholder="例如 alert_channel"
          />
        </NFormItem>
        <NFormItem label="一句话摘要">
          <NInput v-model:value="form.summary" />
        </NFormItem>
        <NFormItem label="完整内容">
          <NInput v-model:value="form.content" :rows="4" type="textarea" />
        </NFormItem>
        <NFormItem label="过期时间（留空则永久有效）">
          <NDatePicker
            v-model:value="form.expiresAt"
            class="w-full"
            clearable
            placeholder="可选，到期后自动失效并清理"
            type="datetime"
          />
        </NFormItem>
        <NSpace justify="end">
          <NButton @click="modalOpen = false">取消</NButton>
          <NButton :loading="saving" type="primary" @click="handleSave">
            保存
          </NButton>
        </NSpace>
      </NForm>
    </NModal>
  </div>
</template>
