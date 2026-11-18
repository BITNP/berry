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
import { h, onMounted, ref } from "vue";

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

const message = useMessage();

const loading = ref(false);
const activeTab = ref("audit");
const status = ref<GuildStatus | null>(null);
const auditLogs = ref<GuildAuditRow[]>([]);
const triggering = ref<string | null>(null);

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

async function loadGuild() {
  loading.value = true;

  try {
    const [st, logs] = await Promise.all([
      apiFetch<GuildStatus>("/api/admin/guild/status"),
      apiFetch<{ items: GuildAuditRow[] }>("/api/admin/guild/audit-logs"),
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
    await apiFetch(`/api/admin/guild/trigger/${task}`, { method: "POST" });
    message.success("任务已触发执行");
    await loadGuild();
  } catch (err) {
    message.error(err instanceof Error ? err.message : "触发失败");
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

useEventStream((type) => {
  if (type === "guild_audit") {
    void loadGuild();
  }
});

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
          :loading="triggering === 'due'"
          size="small"
          @click="triggerTask('due')"
        >
          到期提醒
        </NButton>
        <NButton
          :loading="triggering === 'assignments'"
          size="small"
          @click="triggerTask('assignments')"
        >
          新指派通知
        </NButton>
        <NButton
          :loading="triggering === 'weekly'"
          size="small"
          @click="triggerTask('weekly')"
        >
          生成周报
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
      <NDrawerContent v-if="selectedAudit" title="审计详情">
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
