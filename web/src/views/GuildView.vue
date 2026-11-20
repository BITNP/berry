<script setup lang="ts">
import { ExternalLink, RefreshCw, Search } from "@lucide/vue";
import type { DataTableColumns } from "naive-ui";
import {
  NAlert,
  NButton,
  NCard,
  NDataTable,
  NDescriptions,
  NDescriptionsItem,
  NDrawer,
  NDrawerContent,
  NInput,
  NSpace,
  NTabPane,
  NTabs,
  NTag,
  useMessage,
} from "naive-ui";
import { computed, h, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";

import { apiFetch } from "../api/client.ts";
import { useEventStream } from "../composables/useEventStream.ts";
import { formatTime } from "../utils/format.ts";

interface CursorRow {
  name: string;
  value: string;
  updatedAt: number;
}

interface GuildStatus {
  apiConfigured: boolean;
  streamConnected: boolean;
  publicUrl: string;
  cursors: CursorRow[];
}

interface GuildAuditRow {
  id: number;
  chatKey: string;
  qqUserId: string;
  actorSubject: string;
  actorName: string;
  action:
    | "create_node"
    | "update_node"
    | "move_node"
    | "replace_members"
    | "create_comment";
  nodeId: number | null;
  targetTitle: string;
  requestJson: string;
  responseJson: string;
  error: string | null;
  createdAt: number;
}

interface DirectoryUserRow {
  subject: string;
  username: string;
  name: string;
  qq: string | null;
  enabled: boolean;
  permissions: {
    systemAdmin: boolean;
    manager: boolean;
    accessDepartments: string[];
    managedDepartments: string[];
  };
}

interface GuildJobRow {
  id: number;
  kind: string;
  chatKey: string;
  payload: { task?: "due" | "assignments" | "weekly" };
  state: "pending" | "running" | "done" | "failed";
  lastError: string | null;
  updatedAt: number;
}

const GUILD_TABS = new Set(["audit", "cursors", "directory"]);
const GUILD_TASK_LABELS: Record<"due" | "assignments" | "weekly", string> = {
  due: "到期提醒",
  assignments: "新指派通知",
  weekly: "生成周报",
};

const route = useRoute();
const router = useRouter();
const message = useMessage();

const loading = ref(false);
const activeTab = ref(
  typeof route.query.tab === "string" && GUILD_TABS.has(route.query.tab)
    ? route.query.tab
    : "audit",
);
const status = ref<GuildStatus | null>(null);
const auditLogs = ref<GuildAuditRow[]>([]);
const guildJobs = ref<GuildJobRow[]>([]);
const triggering = ref<string | null>(null);

const activeGuildJobs = computed(() =>
  guildJobs.value.filter((j) => j.state === "pending" || j.state === "running"),
);

const activeJobFor = (
  task: "due" | "assignments" | "weekly",
): GuildJobRow | null =>
  activeGuildJobs.value.find(
    (j) => j.payload?.task === task || j.chatKey === `guild:${task}`,
  ) ?? null;

function taskLabelForJob(job: GuildJobRow): string {
  const key =
    job.payload?.task ??
    (job.chatKey.replace(/^guild:/, "") as "due" | "assignments" | "weekly");

  return GUILD_TASK_LABELS[key] ?? job.chatKey;
}

const detailOpen = ref(false);
const selectedAudit = ref<GuildAuditRow | null>(null);

const memberQuery = ref("");
const directoryEnabled = ref(true);
const searchingMembers = ref(false);
const members = ref<DirectoryUserRow[]>([]);

const actionLabels: Record<GuildAuditRow["action"], string> = {
  create_node: "新建节点",
  update_node: "更新节点",
  move_node: "移动节点",
  replace_members: "调整人员",
  create_comment: "添加评论",
};

async function loadGuildJobs() {
  try {
    const res = await apiFetch<{ items: GuildJobRow[] }>(
      "/api/admin/jobs?kind=guild_task&limit=20",
    );

    guildJobs.value = res.items;
  } catch {
    // Keep last known job list on transient error.
  }
}

async function loadGuild() {
  loading.value = true;

  try {
    const [st, logs] = await Promise.all([
      apiFetch<GuildStatus>("/api/admin/guild/status"),
      apiFetch<{ items: GuildAuditRow[] }>("/api/admin/guild/audit-logs"),
      loadGuildJobs(),
    ]);

    status.value = st;
    auditLogs.value = logs.items;
  } catch (err) {
    message.error(err instanceof Error ? err.message : "加载公会数据失败");
  } finally {
    loading.value = false;
  }
}

async function triggerTask(task: "due" | "assignments" | "weekly") {
  triggering.value = task;

  try {
    const res = await apiFetch<{
      queued: boolean;
      alreadyActive: boolean;
      jobId: number;
      state: string;
    }>(`/api/admin/guild/trigger/${task}`, { method: "POST" });
    const label = GUILD_TASK_LABELS[task];

    if (res.alreadyActive) {
      message.info(`「${label}」已在后台执行中（任务 #${res.jobId}）`);
    } else {
      message.success(
        `已加入后台任务队列（#${res.jobId} · ${label}），离开页面不影响执行`,
      );
    }

    await loadGuildJobs();
  } catch (err) {
    message.error(err instanceof Error ? err.message : "提交后台任务失败");
  } finally {
    triggering.value = null;
  }
}

async function searchMembers() {
  searchingMembers.value = true;

  try {
    const res = await apiFetch<{ enabled: boolean; items: DirectoryUserRow[] }>(
      `/api/admin/identity/lookup?q=${encodeURIComponent(memberQuery.value.trim())}`,
    );

    directoryEnabled.value = res.enabled;
    members.value = res.items;
  } catch (err) {
    message.error(err instanceof Error ? err.message : "查询目录失败");
  } finally {
    searchingMembers.value = false;
  }
}

function formatJsonBlock(raw: string): string {
  if (!raw) {
    return "—";
  }

  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function openAuditDetail(row: GuildAuditRow) {
  selectedAudit.value = row;
  detailOpen.value = true;
}

const auditColumns: DataTableColumns<GuildAuditRow> = [
  {
    title: "时间",
    key: "createdAt",
    width: 148,
    render: (row) => h("span", { class: "tabular" }, formatTime(row.createdAt)),
  },
  {
    title: "发起成员",
    key: "actorName",
    width: 165,
    render: (row) => `${row.actorName || "未知"} (${row.qqUserId})`,
  },
  {
    title: "操作",
    key: "action",
    width: 100,
    render: (row) =>
      h(
        NTag,
        { size: "small" },
        { default: () => actionLabels[row.action] || row.action },
      ),
  },
  {
    title: "目标节点",
    key: "targetTitle",
    minWidth: 190,
    ellipsis: { tooltip: true },
    render: (row) =>
      row.nodeId ? `#${row.nodeId} ${row.targetTitle}` : row.targetTitle || "—",
  },
  {
    title: "结果",
    key: "error",
    width: 85,
    render: (row) =>
      h(
        NTag,
        { size: "small", type: row.error ? "error" : "success" },
        { default: () => (row.error ? "失败" : "成功") },
      ),
  },
  {
    title: "详情",
    key: "ops",
    width: 72,
    render: (row) =>
      h(
        NButton,
        { size: "tiny", quaternary: true, onClick: () => openAuditDetail(row) },
        { default: () => "查看" },
      ),
  },
];

const memberColumns: DataTableColumns<DirectoryUserRow> = [
  { title: "姓名", key: "name", width: 120 },
  {
    title: "用户名",
    key: "username",
    width: 140,
    render: (row) => h("span", { class: "mono" }, row.username),
  },
  {
    title: "QQ 号",
    key: "qq",
    width: 130,
    render: (row) => h("span", { class: "mono" }, row.qq || "未绑定"),
  },
  {
    title: "权限",
    key: "permissions",
    minWidth: 170,
    render: (row) => {
      const tags: ReturnType<typeof h>[] = [];

      if (row.permissions.systemAdmin) {
        tags.push(
          h(
            NTag,
            { size: "tiny", type: "primary" },
            { default: () => "系统管理员" },
          ),
        );
      }

      if (row.permissions.manager) {
        tags.push(
          h(
            NTag,
            { size: "tiny", type: "info" },
            { default: () => "部门主管" },
          ),
        );
      }

      for (const dept of row.permissions.accessDepartments) {
        tags.push(h(NTag, { size: "tiny" }, { default: () => dept }));
      }

      return h(NSpace, { size: 4, wrap: true }, { default: () => tags });
    },
  },
  {
    title: "Subject",
    key: "subject",
    minWidth: 210,
    ellipsis: { tooltip: true },
    render: (row) => h("span", { class: "mono" }, row.subject),
  },
];

const cursorColumns: DataTableColumns<CursorRow> = [
  {
    title: "游标键",
    key: "name",
    width: 240,
    render: (row) => h("span", { class: "mono" }, row.name),
  },
  {
    title: "当前值",
    key: "value",
    minWidth: 220,
    render: (row) => h("span", { class: "mono" }, row.value),
  },
  {
    title: "更新时间",
    key: "updatedAt",
    width: 160,
    render: (row) => h("span", { class: "tabular" }, formatTime(row.updatedAt)),
  },
];

useEventStream((type, data) => {
  if (type === "guild_audit") {
    void loadGuild();
  }

  if (type === "job_update" && data && typeof data === "object") {
    const ev = data as { kind?: string; state?: string; chatKey?: string };

    if (ev.kind === "guild_task") {
      void loadGuildJobs();

      if (ev.state === "done" || ev.state === "failed") {
        const taskKey = (ev.chatKey ?? "").replace(/^guild:/, "") as
          "due" | "assignments" | "weekly";
        const label = GUILD_TASK_LABELS[taskKey] ?? "公会任务";

        if (ev.state === "done") {
          message.success(`后台任务「${label}」已完成`);
        } else {
          message.error(`后台任务「${label}」执行失败，可在日志队列查看原因`);
        }

        void loadGuild();
      }
    }
  }
});

watch(activeTab, (tab) => {
  if (route.query.tab !== tab) {
    void router.replace({ query: { ...route.query, tab } });
  }
});

watch(
  () => route.query.tab,
  (tab) => {
    if (typeof tab === "string" && GUILD_TABS.has(tab)) {
      activeTab.value = tab;
    }
  },
);

onMounted(() => {
  void loadGuild();
  void searchMembers();
});
</script>

<template>
  <div>
    <div class="page-bar">
      <h1 class="page-title">公会协作</h1>
      <NSpace :size="8" wrap>
        <NButton
          v-if="status?.publicUrl"
          :href="status.publicUrl"
          secondary
          size="small"
          tag="a"
          target="_blank"
        >
          <template #icon>
            <ExternalLink :size="14" />
          </template>
          打开公会看板
        </NButton>
        <NButton
          :disabled="Boolean(activeJobFor('due'))"
          :loading="triggering === 'due'"
          size="small"
          @click="triggerTask('due')"
        >
          {{ activeJobFor("due") ? "到期提醒（后台中）" : "到期提醒" }}
        </NButton>
        <NButton
          :disabled="Boolean(activeJobFor('assignments'))"
          :loading="triggering === 'assignments'"
          size="small"
          @click="triggerTask('assignments')"
        >
          {{
            activeJobFor("assignments") ? "新指派通知（后台中）" : "新指派通知"
          }}
        </NButton>
        <NButton
          :disabled="Boolean(activeJobFor('weekly'))"
          :loading="triggering === 'weekly'"
          size="small"
          @click="triggerTask('weekly')"
        >
          {{ activeJobFor("weekly") ? "生成周报（后台中）" : "生成周报" }}
        </NButton>
        <NButton :loading size="small" @click="loadGuild">
          <template #icon>
            <RefreshCw :size="14" />
          </template>
          刷新
        </NButton>
      </NSpace>
    </div>

    <div v-if="status" class="metric-strip">
      <div class="metric-cell">
        <span class="metric-label">内部写接口（guild-go）</span>
        <span class="metric-value">
          {{ status.apiConfigured ? "已就绪" : "未配置" }}
        </span>
      </div>
      <div class="metric-cell">
        <span class="metric-label">实时事件流（SSE）</span>
        <span class="metric-value">
          {{ status.streamConnected ? "已连接" : "未连接" }}
        </span>
      </div>
      <div class="metric-cell">
        <span class="metric-label">近期审计记录</span>
        <span class="metric-value">{{ auditLogs.length }}</span>
      </div>
      <div class="metric-cell">
        <span class="metric-label">巡检游标数</span>
        <span class="metric-value">{{ status.cursors.length }}</span>
      </div>
    </div>

    <NAlert v-if="activeGuildJobs.length > 0" class="mb-md" type="info">
      <div class="feed-row-top">
        <span>
          后台任务运行中（离开或刷新页面不影响）：
          {{
            activeGuildJobs
              .map(
                (j) =>
                  `${taskLabelForJob(j)} #${j.id}（${j.state === "running" ? "执行中" : "排队中"}）`,
              )
              .join("、")
          }}
        </span>
        <NSpace :size="8">
          <NButton
            quaternary
            size="tiny"
            @click="router.push('/logs?tab=jobs')"
          >
            查看任务队列
          </NButton>
          <NButton quaternary size="tiny" @click="router.push('/ai')">
            查看 AI 调用
          </NButton>
        </NSpace>
      </div>
    </NAlert>

    <NCard size="small">
      <NTabs v-model:value="activeTab" type="line">
        <NTabPane name="audit" tab="操作审计">
          <NDataTable
            :columns="auditColumns"
            :data="auditLogs"
            :loading
            :pagination="{ pageSize: 20 }"
            :scroll-x="880"
            size="small"
          />
        </NTabPane>

        <NTabPane name="directory" tab="成员查验">
          <NAlert v-if="!directoryEnabled" class="mb-sm" type="warning">
            Keycloak Admin 环境变量（
            <code class="mono">BERRY_KEYCLOAK_ADMIN_URL</code>
            等）尚未配置，当前无法检索成员 QQ 映射。
          </NAlert>
          <div class="filter-bar">
            <NInput
              v-model:value="memberQuery"
              class="w-240"
              clearable
              placeholder="输入姓名、用户名或 QQ 号"
              size="small"
              @keyup.enter="searchMembers"
            />
            <NButton
              :loading="searchingMembers"
              size="small"
              @click="searchMembers"
            >
              <template #icon>
                <Search :size="14" />
              </template>
              查询成员
            </NButton>
          </div>
          <NDataTable
            :columns="memberColumns"
            :data="members"
            :loading="searchingMembers"
            :pagination="{ pageSize: 15 }"
            :scroll-x="780"
            size="small"
          />
        </NTabPane>

        <NTabPane name="cursors" tab="同步游标">
          <NDataTable
            :columns="cursorColumns"
            :data="status?.cursors ?? []"
            :scroll-x="620"
            size="small"
          />
        </NTabPane>
      </NTabs>
    </NCard>

    <NDrawer v-model:show="detailOpen" class="drawer-safe" :width="500">
      <NDrawerContent v-if="selectedAudit" closable title="审计详情">
        <NDescriptions bordered :column="1" label-placement="left" size="small">
          <NDescriptionsItem label="时间">
            {{ formatTime(selectedAudit.createdAt) }}
          </NDescriptionsItem>
          <NDescriptionsItem label="发起人">
            {{ selectedAudit.actorName }} (QQ {{ selectedAudit.qqUserId }})
          </NDescriptionsItem>
          <NDescriptionsItem label="Subject">
            <span class="mono">{{ selectedAudit.actorSubject }}</span>
          </NDescriptionsItem>
          <NDescriptionsItem label="会话来源">
            <span class="mono">{{ selectedAudit.chatKey || "—" }}</span>
          </NDescriptionsItem>
          <NDescriptionsItem label="操作">
            {{ actionLabels[selectedAudit.action] }} · 节点 #{{
              selectedAudit.nodeId ?? "—"
            }}
          </NDescriptionsItem>
        </NDescriptions>

        <NAlert v-if="selectedAudit.error" class="mt-md" type="error">
          {{ selectedAudit.error }}
        </NAlert>

        <div class="section-title">请求参数</div>
        <pre class="code-block">{{
          formatJsonBlock(selectedAudit.requestJson)
        }}</pre>

        <div class="section-title">响应载荷</div>
        <pre class="code-block">{{
          formatJsonBlock(selectedAudit.responseJson)
        }}</pre>
      </NDrawerContent>
    </NDrawer>
  </div>
</template>
