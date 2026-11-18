<script setup lang="ts">
import { Play, Plus, RefreshCw, Trash2 } from "@lucide/vue";
import type { DataTableColumns } from "naive-ui";
import {
  NButton,
  NCard,
  NDataTable,
  NForm,
  NFormItem,
  NInput,
  NInputNumber,
  NModal,
  NPopconfirm,
  NSelect,
  NSpace,
  NSwitch,
  NTag,
  useMessage,
} from "naive-ui";
import { computed, h, onMounted, ref } from "vue";

import { apiFetch } from "../api/client.ts";
import type { ScheduleSpecView } from "../utils/format.ts";
import { formatScheduleLabel, formatTime } from "../utils/format.ts";

interface ScheduleRow {
  id: string;
  title: string;
  chatKey: string;
  kind: "group" | "private" | "";
  chatId: string;
  content: string;
  schedule: ScheduleSpecView;
  enabled: boolean;
  nextRunAt: number | null;
  lastRunAt: number | null;
  createdAt: number;
  updatedAt: number;
}

interface ChatOptionRow {
  chatKey: string;
  kind: "group" | "private";
  chatId: string;
  title: string;
}

const message = useMessage();

const loading = ref(false);
const saving = ref(false);
const items = ref<ScheduleRow[]>([]);
const chats = ref<ChatOptionRow[]>([]);
const runningId = ref<string | null>(null);

const modalOpen = ref(false);
const editingId = ref<string | null>(null);

const form = ref({
  title: "",
  kind: "group",
  chatId: "",
  content: "",
  enabled: true,
  specKind: "daily",
  onceAt: "",
  everyDays: 0,
  everyHours: 0,
  everyMinutes: 30,
  everySeconds: 0,
  time: "09:30",
  weekdays: ["mon"] as string[],
  daysOfMonth: [1] as number[],
  month: 1,
  day: 1,
});

const weekdayOptions = [
  { label: "周一", value: "mon" },
  { label: "周二", value: "tue" },
  { label: "周三", value: "wed" },
  { label: "周四", value: "thu" },
  { label: "周五", value: "fri" },
  { label: "周六", value: "sat" },
  { label: "周日", value: "sun" },
];

const dayOfMonthOptions = Array.from({ length: 31 }, (_, i) => ({
  label: `${i + 1} 日`,
  value: i + 1,
}));

const specKindOptions = [
  { label: "单次执行（once）", value: "once" },
  { label: "固定间隔（interval）", value: "interval" },
  { label: "每天（daily）", value: "daily" },
  { label: "每周（weekly）", value: "weekly" },
  { label: "每月（monthly）", value: "monthly" },
  { label: "每年（yearly）", value: "yearly" },
];

const chatSelectOptions = computed(() =>
  chats.value.map((c) => ({
    label: `${c.title || c.chatId} (${c.chatKey})`,
    value: c.chatKey,
  })),
);

const selectedChatKey = computed({
  get: () =>
    form.value.kind && form.value.chatId
      ? `${form.value.kind}:${form.value.chatId}`
      : null,
  set: (val: string | null) => {
    if (!val) {
      form.value.kind = "";
      form.value.chatId = "";

      return;
    }

    const idx = val.indexOf(":");

    if (idx > 0) {
      const k = val.slice(0, idx);

      form.value.kind = k === "private" ? "private" : "group";
      form.value.chatId = val.slice(idx + 1);
    }
  },
});

async function loadData() {
  loading.value = true;

  try {
    const [schedRes, chatRes] = await Promise.all([
      apiFetch<{ items: ScheduleRow[] }>("/api/admin/schedules"),
      apiFetch<{ items: ChatOptionRow[] }>("/api/admin/chats"),
    ]);

    items.value = schedRes.items;
    chats.value = chatRes.items;
  } catch (err) {
    message.error(err instanceof Error ? err.message : "加载定时任务失败");
  } finally {
    loading.value = false;
  }
}

function openCreate() {
  editingId.value = null;
  form.value = {
    title: "",
    kind: "group",
    chatId: chats.value[0]?.chatId ?? "",
    content: "",
    enabled: true,
    specKind: "daily",
    onceAt: new Date(Date.now() + 3_600_000).toISOString().slice(0, 19),
    everyDays: 0,
    everyHours: 0,
    everyMinutes: 30,
    everySeconds: 0,
    time: "09:30",
    weekdays: ["mon"],
    daysOfMonth: [1],
    month: 1,
    day: 1,
  };
  modalOpen.value = true;
}

function openEdit(row: ScheduleRow) {
  editingId.value = row.id;
  const s = row.schedule;

  form.value = {
    title: row.title,
    kind: row.kind,
    chatId: row.chatId,
    content: row.content,
    enabled: row.enabled,
    specKind: s.kind,
    onceAt: s.at ?? "",
    everyDays: s.everyDays ?? 0,
    everyHours: s.everyHours ?? 0,
    everyMinutes: s.everyMinutes ?? 0,
    everySeconds: s.everySeconds ?? 0,
    time: s.time ?? "09:30",
    weekdays: s.weekdays?.length ? [...s.weekdays] : ["mon"],
    daysOfMonth: s.daysOfMonth?.length ? [...s.daysOfMonth] : [1],
    month: s.month ?? 1,
    day: s.day ?? 1,
  };
  modalOpen.value = true;
}

function buildScheduleSpec(): ScheduleSpecView | null {
  switch (form.value.specKind) {
    case "once": {
      if (!form.value.onceAt.trim()) {
        message.warning("请填写单次触发时间");

        return null;
      }

      return { kind: "once", at: form.value.onceAt.trim() };
    }

    case "interval": {
      const spec: ScheduleSpecView = { kind: "interval" };

      if (form.value.everyDays > 0) {
        spec.everyDays = form.value.everyDays;
      }

      if (form.value.everyHours > 0) {
        spec.everyHours = form.value.everyHours;
      }

      if (form.value.everyMinutes > 0) {
        spec.everyMinutes = form.value.everyMinutes;
      }

      if (form.value.everySeconds > 0) {
        spec.everySeconds = form.value.everySeconds;
      }

      if (
        !spec.everyDays &&
        !spec.everyHours &&
        !spec.everyMinutes &&
        !spec.everySeconds
      ) {
        message.warning("固定间隔至少设置一个大于 0 的时间单位");

        return null;
      }

      return spec;
    }

    case "daily": {
      return { kind: "daily", time: form.value.time.trim() || "09:00" };
    }

    case "weekly": {
      if (form.value.weekdays.length === 0) {
        message.warning("每周任务请至少选择一个星期");

        return null;
      }

      return {
        kind: "weekly",
        weekdays: form.value.weekdays,
        time: form.value.time.trim() || "09:00",
      };
    }

    case "monthly": {
      if (form.value.daysOfMonth.length === 0) {
        message.warning("每月任务请至少选择一天");

        return null;
      }

      return {
        kind: "monthly",
        daysOfMonth: form.value.daysOfMonth,
        time: form.value.time.trim() || "09:00",
      };
    }

    case "yearly": {
      return {
        kind: "yearly",
        month: form.value.month,
        day: form.value.day,
        time: form.value.time.trim() || "09:00",
      };
    }

    default: {
      return null;
    }
  }
}

async function handleSave() {
  if (!form.value.title.trim() || !form.value.content.trim()) {
    message.warning("请填写任务标题和触发指令");

    return;
  }

  const spec = buildScheduleSpec();

  if (!spec) {
    return;
  }

  saving.value = true;

  try {
    const payload = {
      title: form.value.title.trim(),
      kind: form.value.kind,
      chatId: form.value.chatId.trim(),
      content: form.value.content.trim(),
      enabled: form.value.enabled,
      schedule: spec,
    };

    if (editingId.value) {
      await apiFetch(
        `/api/admin/schedules/${encodeURIComponent(editingId.value)}`,
        {
          method: "PATCH",
          body: JSON.stringify(payload),
        },
      );
    } else {
      await apiFetch("/api/admin/schedules", {
        method: "POST",
        body: JSON.stringify(payload),
      });
    }

    modalOpen.value = false;
    message.success("定时任务已保存");
    await loadData();
  } catch (err) {
    message.error(err instanceof Error ? err.message : "保存定时任务失败");
  } finally {
    saving.value = false;
  }
}

async function toggleEnabled(row: ScheduleRow, val: boolean) {
  try {
    const updated = await apiFetch<ScheduleRow>(
      `/api/admin/schedules/${encodeURIComponent(row.id)}`,
      {
        method: "PATCH",
        body: JSON.stringify({ enabled: val }),
      },
    );

    Object.assign(row, updated);
  } catch (err) {
    message.error(err instanceof Error ? err.message : "更新状态失败");
  }
}

async function handleRunNow(row: ScheduleRow) {
  runningId.value = row.id;

  try {
    await apiFetch(`/api/admin/schedules/${encodeURIComponent(row.id)}/run`, {
      method: "POST",
    });
    message.success(`任务「${row.title}」已立即入队`);
  } catch (err) {
    message.error(err instanceof Error ? err.message : "触发失败");
  } finally {
    runningId.value = null;
  }
}

async function handleDelete(row: ScheduleRow) {
  try {
    await apiFetch(`/api/admin/schedules/${encodeURIComponent(row.id)}`, {
      method: "DELETE",
    });
    message.success("已删除定时任务");
    await loadData();
  } catch (err) {
    message.error(err instanceof Error ? err.message : "删除失败");
  }
}

const columns: DataTableColumns<ScheduleRow> = [
  { title: "标题", key: "title", minWidth: 130, ellipsis: { tooltip: true } },
  {
    title: "目标会话",
    key: "chatKey",
    width: 132,
    ellipsis: { tooltip: true },
    render: (row) =>
      row.chatKey
        ? h("span", { class: "mono" }, row.chatKey)
        : h(NTag, { size: "small" }, { default: () => "全局" }),
  },
  {
    title: "周期规则",
    key: "schedule",
    minWidth: 125,
    render: (row) => formatScheduleLabel(row.schedule),
  },
  {
    title: "启用",
    key: "enabled",
    width: 64,
    render: (row) =>
      h(NSwitch, {
        size: "small",
        value: row.enabled,
        onUpdateValue: (val: boolean) => {
          void toggleEnabled(row, val);
        },
      }),
  },
  {
    title: "下次触发",
    key: "nextRunAt",
    width: 132,
    render: (row) => h("span", { class: "tabular" }, formatTime(row.nextRunAt)),
  },
  {
    title: "上次触发",
    key: "lastRunAt",
    width: 132,
    render: (row) => h("span", { class: "tabular" }, formatTime(row.lastRunAt)),
  },
  {
    title: "操作",
    key: "actions",
    width: 170,
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
                loading: runningId.value === row.id,
                onClick: () => {
                  void handleRunNow(row);
                },
              },
              {
                icon: () => h(Play, { size: 12 }),
                default: () => "立即执行",
              },
            ),
            h(
              NButton,
              { size: "tiny", onClick: () => openEdit(row) },
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
                default: () => "确定删除该定时任务？",
              },
            ),
          ],
        },
      ),
  },
];

onMounted(() => {
  void loadData();
});
</script>

<template>
  <div>
    <div class="page-bar">
      <h1 class="page-title">定时任务</h1>
      <NSpace :size="8">
        <NButton :loading size="small" @click="loadData">
          <template #icon>
            <RefreshCw :size="14" />
          </template>
          刷新
        </NButton>
        <NButton size="small" type="primary" @click="openCreate">
          <template #icon>
            <Plus :size="14" />
          </template>
          新建定时任务
        </NButton>
      </NSpace>
    </div>

    <NCard size="small">
      <NDataTable
        :columns
        :data="items"
        :loading
        :pagination="{ pageSize: 20 }"
        :scroll-x="800"
        size="small"
      />
    </NCard>

    <NModal
      v-model:show="modalOpen"
      class="modal-md"
      preset="card"
      :title="editingId ? '编辑定时任务' : '新建定时任务'"
    >
      <NForm label-placement="top" size="small">
        <NFormItem label="任务名称">
          <NInput
            v-model:value="form.title"
            placeholder="例如 周五服务器巡检提醒"
          />
        </NFormItem>

        <NFormItem label="快速绑定已登记会话">
          <NSelect
            v-model:value="selectedChatKey"
            clearable
            :options="chatSelectOptions"
            placeholder="可选，也可在下方手动填写类型和号码"
          />
        </NFormItem>

        <NSpace :size="12">
          <NFormItem class="w-150" label="目标类型">
            <NSelect
              v-model:value="form.kind"
              :options="[
                { label: '群聊', value: 'group' },
                { label: '私聊', value: 'private' },
                { label: '未绑定', value: '' },
              ]"
            />
          </NFormItem>
          <NFormItem class="w-220" label="群号 / QQ 号">
            <NInput v-model:value="form.chatId" placeholder="例如 10248888" />
          </NFormItem>
          <NFormItem label="启用">
            <NSwitch v-model:value="form.enabled" />
          </NFormItem>
        </NSpace>

        <NFormItem label="周期类型">
          <NSelect v-model:value="form.specKind" :options="specKindOptions" />
        </NFormItem>

        <NFormItem
          v-if="form.specKind === 'once'"
          label="触发时间（ISO / 本地日期时间）"
        >
          <NInput
            v-model:value="form.onceAt"
            placeholder="例如 2026-11-20T20:00:00"
          />
        </NFormItem>

        <NFormItem v-if="form.specKind === 'interval'" label="间隔周期">
          <NSpace :size="10" wrap>
            <NInputNumber v-model:value="form.everyDays" class="w-110" :min="0">
              <template #suffix>天</template>
            </NInputNumber>
            <NInputNumber
              v-model:value="form.everyHours"
              class="w-115"
              :min="0"
            >
              <template #suffix>小时</template>
            </NInputNumber>
            <NInputNumber
              v-model:value="form.everyMinutes"
              class="w-115"
              :min="0"
            >
              <template #suffix>分钟</template>
            </NInputNumber>
            <NInputNumber
              v-model:value="form.everySeconds"
              class="w-110"
              :min="0"
            >
              <template #suffix>秒</template>
            </NInputNumber>
          </NSpace>
        </NFormItem>

        <NFormItem v-if="form.specKind === 'weekly'" label="每周几触发">
          <NSelect
            v-model:value="form.weekdays"
            multiple
            :options="weekdayOptions"
          />
        </NFormItem>

        <NFormItem v-if="form.specKind === 'monthly'" label="每月日期">
          <NSelect
            v-model:value="form.daysOfMonth"
            multiple
            :options="dayOfMonthOptions"
          />
        </NFormItem>

        <NSpace v-if="form.specKind === 'yearly'" :size="12">
          <NFormItem label="月份">
            <NInputNumber
              v-model:value="form.month"
              class="w-120"
              :max="12"
              :min="1"
            />
          </NFormItem>
          <NFormItem label="日期">
            <NInputNumber
              v-model:value="form.day"
              class="w-120"
              :max="31"
              :min="1"
            />
          </NFormItem>
        </NSpace>

        <NFormItem
          v-if="
            ['daily', 'weekly', 'monthly', 'yearly'].includes(form.specKind)
          "
          label="触发时刻（HH:mm）"
        >
          <NInput v-model:value="form.time" class="w-140" placeholder="09:30" />
        </NFormItem>

        <NFormItem label="触发指令（交给主 Agent 执行的提示）">
          <NInput
            v-model:value="form.content"
            placeholder="例如：提醒大家今晚 19:30 巡检服务器负载并汇报异常"
            :rows="3"
            type="textarea"
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
