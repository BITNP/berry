<script setup lang="ts">
import { Plus, Trash2 } from "@lucide/vue";
import type { DataTableColumns } from "naive-ui";
import {
  NButton,
  NCard,
  NDataTable,
  NDynamicTags,
  NForm,
  NFormItem,
  NInput,
  NModal,
  NPopconfirm,
  NSelect,
  NSpace,
  NSwitch,
  NTag,
  NText,
  useMessage,
} from "naive-ui";
import { h, ref } from "vue";

export interface McpServerFormRow {
  name: string;
  enabled: boolean;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  allowedTools?: string[];
}

export interface McpStatusRow {
  name: string;
  transport: string;
  connected: boolean;
  toolCount: number;
  error?: string;
}

export interface McpToolRow {
  exposedName: string;
  serverName: string;
  toolName: string;
  description: string;
}

const props = defineProps<{
  statuses: McpStatusRow[];
  tools: McpToolRow[];
}>();

const servers = defineModel<McpServerFormRow[]>("servers", { required: true });

const message = useMessage();
const modalOpen = ref(false);
const editingIndex = ref<number | null>(null);
const form = ref<{
  name: string;
  enabled: boolean;
  transport: "stdio" | "http";
  command: string;
  args: string[];
  url: string;
  headersList: { key: string; value: string }[];
  allowedTools: string[];
}>({
  name: "",
  enabled: true,
  transport: "http",
  command: "",
  args: [],
  url: "",
  headersList: [],
  allowedTools: [],
});

function openCreate() {
  editingIndex.value = null;
  form.value = {
    name: "",
    enabled: true,
    transport: "http",
    command: "",
    args: [],
    url: "",
    headersList: [],
    allowedTools: [],
  };
  modalOpen.value = true;
}

function openEdit(idx: number) {
  const row = servers.value[idx];

  if (!row) {
    return;
  }

  editingIndex.value = idx;
  form.value = {
    name: row.name,
    enabled: row.enabled,
    transport: row.transport,
    command: row.command ?? "",
    args: [...(row.args ?? [])],
    url: row.url ?? "",
    headersList: Object.entries(row.headers ?? {}).map(([key, value]) => ({
      key,
      value,
    })),
    allowedTools: [...(row.allowedTools ?? [])],
  };
  modalOpen.value = true;
}

function saveModal() {
  const name = form.value.name.trim();

  if (!/^[\w-]+$/.test(name)) {
    message.warning("服务名称仅允许字母、数字、下划线或连字符");

    return;
  }

  const entry: McpServerFormRow = {
    name,
    enabled: form.value.enabled,
    transport: form.value.transport,
  };

  if (form.value.transport === "stdio") {
    if (!form.value.command.trim()) {
      message.warning("请填写 stdio 启动命令");

      return;
    }

    entry.command = form.value.command.trim();
    if (form.value.args.length > 0) {
      entry.args = [...form.value.args];
    }
  } else {
    if (!form.value.url.trim()) {
      message.warning("请填写 HTTP 服务地址");

      return;
    }

    entry.url = form.value.url.trim();
    const headers: Record<string, string> = {};

    for (const pair of form.value.headersList) {
      if (pair.key.trim()) {
        headers[pair.key.trim()] = pair.value;
      }
    }

    if (Object.keys(headers).length > 0) {
      entry.headers = headers;
    }
  }

  if (form.value.allowedTools.length > 0) {
    entry.allowedTools = [...form.value.allowedTools];
  }

  if (editingIndex.value === null) {
    servers.value = [...servers.value, entry];
  } else {
    servers.value = servers.value.map((item, idx) =>
      idx === editingIndex.value ? entry : item,
    );
  }

  modalOpen.value = false;
  message.info("已更新列表，请点击右上角「保存全部设置」应用连接");
}

function removeServer(idx: number) {
  servers.value = servers.value.filter((_item, i) => i !== idx);
}

const findStatus = (name: string) =>
  props.statuses.find((s) => s.name === name);

const serverColumns: DataTableColumns<McpServerFormRow> = [
  {
    title: "名称",
    key: "name",
    width: 140,
    render: (row) => h("span", { class: "mono" }, row.name),
  },
  {
    title: "传输",
    key: "transport",
    width: 85,
    render: (row) =>
      h(NTag, { size: "small" }, { default: () => row.transport }),
  },
  {
    title: "端点 / 命令",
    key: "endpoint",
    minWidth: 220,
    ellipsis: { tooltip: true },
    render: (row) =>
      row.transport === "http"
        ? row.url || "—"
        : `${row.command || ""} ${(row.args ?? []).join(" ")}`.trim() || "—",
  },
  {
    title: "运行状态",
    key: "status",
    width: 150,
    render: (row) => {
      if (!row.enabled) {
        return h(NTag, { size: "small" }, { default: () => "已禁用" });
      }

      const st = findStatus(row.name);

      if (!st) {
        return h(
          NTag,
          { size: "small", type: "warning" },
          { default: () => "待保存生效" },
        );
      }

      if (st.connected) {
        return h(
          NTag,
          { size: "small", type: "success" },
          { default: () => `在线（${st.toolCount} 工具）` },
        );
      }

      return h(
        NTag,
        { size: "small", type: "error" },
        { default: () => st.error || "离线" },
      );
    },
  },
  {
    title: "操作",
    key: "actions",
    width: 112,
    render: (_row, index) =>
      h("div", { class: "table-actions" }, [
        h(
          NButton,
          { size: "tiny", quaternary: true, onClick: () => openEdit(index) },
          { default: () => "编辑" },
        ),
        h(
          NPopconfirm,
          { onPositiveClick: () => removeServer(index) },
          {
            trigger: () =>
              h(
                NButton,
                {
                  "size": "tiny",
                  "quaternary": true,
                  "type": "error",
                  "aria-label": "移除",
                  "title": "移除",
                },
                { icon: () => h(Trash2, { size: 13 }) },
              ),
            default: () => "从配置中移除该 MCP 服务？",
          },
        ),
      ]),
  },
];

const toolColumns: DataTableColumns<McpToolRow> = [
  {
    title: "暴露名称",
    key: "exposedName",
    width: 220,
    render: (row) => h("span", { class: "mono" }, row.exposedName),
  },
  { title: "来源服务", key: "serverName", width: 140 },
  {
    title: "原始工具名",
    key: "toolName",
    width: 160,
    render: (row) => h("span", { class: "mono" }, row.toolName),
  },
  {
    title: "说明",
    key: "description",
    minWidth: 220,
    ellipsis: { tooltip: true },
  },
];
</script>

<template>
  <div class="mcp-stack">
    <NCard size="small" :title="`已配置服务（${servers.length}）`">
      <template #header-extra>
        <NSpace align="center" :size="10">
          <NText class="sub-note" depth="3">保存全部设置后热重载</NText>
          <NButton size="small" type="primary" @click="openCreate">
            <template #icon>
              <Plus :size="14" />
            </template>
            新增 MCP 服务
          </NButton>
        </NSpace>
      </template>

      <NDataTable
        :columns="serverColumns"
        :data="servers"
        :scroll-x="720"
        size="small"
      />
    </NCard>

    <NCard size="small" :title="`已挂载工具目录（${tools.length}）`">
      <NDataTable
        :columns="toolColumns"
        :data="tools"
        :pagination="{ pageSize: 10 }"
        :scroll-x="740"
        size="small"
      />
    </NCard>

    <NModal
      v-model:show="modalOpen"
      class="modal-md"
      preset="card"
      :title="editingIndex !== null ? '编辑 MCP 服务' : '新增 MCP 服务'"
    >
      <NForm label-placement="top" size="small">
        <div class="form-grid-2">
          <NFormItem label="服务标识符（英文/数字/连字符）">
            <NInput v-model:value="form.name" placeholder="例如 outline-docs" />
          </NFormItem>
          <NFormItem label="传输方式">
            <NSelect
              v-model:value="form.transport"
              :options="[
                { label: 'HTTP (Streamable HTTP)', value: 'http' },
                { label: 'stdio (子进程)', value: 'stdio' },
              ]"
            />
          </NFormItem>
        </div>

        <NFormItem label="启用状态">
          <NSwitch v-model:value="form.enabled" />
        </NFormItem>

        <template v-if="form.transport === 'stdio'">
          <NFormItem label="启动命令">
            <NInput v-model:value="form.command" placeholder="例如 npx" />
          </NFormItem>
          <NFormItem label="命令参数">
            <NDynamicTags v-model:value="form.args" />
          </NFormItem>
        </template>

        <template v-else>
          <NFormItem label="服务端 URL">
            <NInput
              v-model:value="form.url"
              placeholder="https://example.com/mcp"
            />
          </NFormItem>
          <NFormItem label="请求头（Headers）">
            <NSpace class="w-full" vertical>
              <div
                v-for="(pair, idx) in form.headersList"
                :key="idx"
                class="inline-pair-row"
              >
                <NInput v-model:value="pair.key" placeholder="Header 名" />
                <NInput
                  v-model:value="pair.value"
                  placeholder="值"
                  show-password-on="click"
                  type="password"
                />
                <NButton
                  quaternary
                  size="small"
                  type="error"
                  @click="form.headersList.splice(idx, 1)"
                >
                  <template #icon>
                    <Trash2 :size="13" />
                  </template>
                </NButton>
              </div>
              <NButton
                size="tiny"
                @click="form.headersList.push({ key: '', value: '' })"
              >
                添加 Header
              </NButton>
            </NSpace>
          </NFormItem>
        </template>

        <NFormItem label="允许暴露的工具白名单（留空则全部放行）">
          <NDynamicTags v-model:value="form.allowedTools" />
        </NFormItem>

        <NSpace justify="end">
          <NButton @click="modalOpen = false">取消</NButton>
          <NButton type="primary" @click="saveModal">确定</NButton>
        </NSpace>
      </NForm>
    </NModal>
  </div>
</template>

<style scoped>
.mcp-stack {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.form-grid-2 {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0 14px;
}

@media (max-width: 700px) {
  .form-grid-2 {
    grid-template-columns: 1fr;
  }
}
</style>
