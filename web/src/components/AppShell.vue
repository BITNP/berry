<script setup lang="ts">
import {
  Activity,
  BookOpen,
  Brain,
  Clock,
  Cpu,
  GitBranch,
  LayoutDashboard,
  LogOut,
  Menu,
  MessagesSquare,
  Moon,
  Pause,
  Play,
  ScrollText,
  SlidersHorizontal,
  Sun,
} from "@lucide/vue";
import type { MenuOption } from "naive-ui";
import {
  NAvatar,
  NButton,
  NDrawer,
  NDrawerContent,
  NIcon,
  NLayout,
  NLayoutContent,
  NLayoutHeader,
  NLayoutSider,
  NMenu,
  NTag,
  NTooltip,
  useMessage,
} from "naive-ui";
import type { Component } from "vue";
import { computed, h, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";

import { apiFetch } from "../api/client.ts";
import { logout, useAuth } from "../composables/useAuth.ts";
import { useEventStream } from "../composables/useEventStream.ts";
import { useTheme } from "../composables/useTheme.ts";

interface ShellStatus {
  workerRunning: boolean;
  botPaused: boolean;
  botQQ: string;
  botAccount: { user_id: string; nickname: string } | null;
  gatewayHealth: { configured: boolean; reachable: boolean };
  gatewayStreamConnected: boolean;
  pendingJobs: number;
}

const route = useRoute();
const router = useRouter();
const auth = useAuth();
const message = useMessage();
const { theme, toggle: toggleTheme } = useTheme();

const isMobile = ref(false);
const mobileDrawerOpen = ref(false);
const togglingPause = ref(false);
const status = ref<ShellStatus | null>(null);

const { connected: sseConnected } = useEventStream((type) => {
  if (type === "job_update" || type === "delivery_update") {
    void loadStatus();
  }
});

const renderIcon = (icon: Component) => () =>
  h(NIcon, null, { default: () => h(icon, { size: 16 }) });

const menuOptions: MenuOption[] = [
  {
    type: "group",
    label: "监控",
    key: "grp-monitor",
    children: [
      { key: "/overview", label: "概览", icon: renderIcon(LayoutDashboard) },
      { key: "/ai", label: "AI 调用", icon: renderIcon(Cpu) },
      { key: "/gate", label: "分流", icon: renderIcon(Activity) },
      { key: "/logs", label: "日志队列", icon: renderIcon(ScrollText) },
    ],
  },
  {
    type: "group",
    label: "协作",
    key: "grp-collab",
    children: [
      { key: "/chats", label: "会话", icon: renderIcon(MessagesSquare) },
      { key: "/memories", label: "记忆", icon: renderIcon(Brain) },
      { key: "/guild", label: "公会", icon: renderIcon(GitBranch) },
      { key: "/docs", label: "资料库", icon: renderIcon(BookOpen) },
      { key: "/schedules", label: "定时", icon: renderIcon(Clock) },
      { key: "/settings", label: "设置", icon: renderIcon(SlidersHorizontal) },
    ],
  },
];

const routeTitles: Record<string, string> = {
  "/overview": "概览",
  "/ai": "AI 调用",
  "/gate": "消息分流",
  "/chats": "会话管理",
  "/memories": "长期记忆",
  "/guild": "公会联动",
  "/docs": "资料库",
  "/schedules": "定时任务",
  "/logs": "日志队列",
  "/settings": "系统设置",
};

const activeMenuKey = computed(() => route.path);
const currentTitle = computed(() => routeTitles[route.path] ?? "控制台");

const botAvatarUrl = computed(() =>
  status.value?.botQQ ? `/api/admin/avatars/user/${status.value.botQQ}` : "",
);

const botDisplayName = computed(() => {
  const acc = status.value?.botAccount;

  if (acc?.nickname) {
    return `${acc.nickname} (${acc.user_id})`;
  }

  return status.value?.botQQ ? `QQ ${status.value.botQQ}` : "Berry";
});

function updateViewport() {
  isMobile.value = window.innerWidth < 860;

  if (!isMobile.value) {
    mobileDrawerOpen.value = false;
  }
}

async function loadStatus() {
  try {
    status.value = await apiFetch<ShellStatus>("/api/admin/overview");
  } catch {
    // Keep last status on transient failures.
  }
}

function handleStatusEvent() {
  void loadStatus();
}

async function handleSelectMenu(key: string) {
  mobileDrawerOpen.value = false;

  if (key !== route.path) {
    await router.push(key);
  }
}

function handleMobileMenuClick(event: MouseEvent) {
  const target = event.target as HTMLElement | null;

  if (target?.closest(".n-menu-item-content")) {
    mobileDrawerOpen.value = false;
  }
}

watch(
  () => route.fullPath,
  () => {
    mobileDrawerOpen.value = false;
  },
);

async function handleToggleBotPause() {
  if (!status.value || togglingPause.value) {
    return;
  }

  togglingPause.value = true;

  try {
    const nextPaused = !status.value.botPaused;
    const res = await apiFetch<{ botPaused: boolean }>("/api/admin/bot/state", {
      method: "POST",
      body: JSON.stringify({ paused: nextPaused }),
    });

    status.value.botPaused = res.botPaused;
    message.success(
      res.botPaused ? "已暂停被动应答（仍持续记录消息）" : "已恢复自动应答",
    );
    window.dispatchEvent(new CustomEvent("berry:status-changed"));
  } catch (err) {
    message.error(err instanceof Error ? err.message : "切换状态失败");
  } finally {
    togglingPause.value = false;
  }
}

async function handleLogout() {
  await logout();
  await router.replace("/login");
}

let statusTimer: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  updateViewport();
  window.addEventListener("resize", updateViewport);
  window.addEventListener("berry:status-changed", handleStatusEvent);
  void loadStatus();
  statusTimer = setInterval(() => {
    void loadStatus();
  }, 30_000);
});

onUnmounted(() => {
  window.removeEventListener("resize", updateViewport);
  window.removeEventListener("berry:status-changed", handleStatusEvent);

  if (statusTimer) {
    clearInterval(statusTimer);
  }
});
</script>

<template>
  <NLayout class="layout-root" has-sider>
    <NLayoutSider
      v-if="!isMobile"
      bordered
      :native-scrollbar="false"
      :width="196"
    >
      <div class="sider-inner">
        <div class="brand-header">
          <span class="brand-dot" />
          <span class="brand-name">Berry</span>
          <span class="brand-sub">树莓娘</span>
        </div>

        <NMenu
          :indent="0"
          :options="menuOptions"
          :root-indent="16"
          :value="activeMenuKey"
          @update:value="handleSelectMenu"
        />

        <div class="sider-footer">
          <div class="user-card">
            <NAvatar
              v-if="auth.user?.avatar"
              round
              :size="28"
              :src="auth.user.avatar"
            />
            <NAvatar v-else round :size="28">
              {{ (auth.user?.name || "A").slice(0, 1).toUpperCase() }}
            </NAvatar>
            <div class="user-meta">
              <div class="user-name">{{ auth.user?.name || "管理员" }}</div>
              <div class="user-role">
                {{ auth.devAuthBypass ? "开发免登" : "系统管理员" }}
              </div>
            </div>
          </div>
          <NButton block quaternary size="small" @click="handleLogout">
            <template #icon>
              <LogOut :size="14" />
            </template>
            退出登录
          </NButton>
        </div>
      </div>
    </NLayoutSider>

    <NDrawer
      v-model:show="mobileDrawerOpen"
      :auto-focus="false"
      placement="left"
      :width="220"
    >
      <NDrawerContent
        body-content-style="padding: 10px 8px;"
        title="Berry 树莓娘"
      >
        <div @click="handleMobileMenuClick">
          <NMenu
            :indent="0"
            :options="menuOptions"
            :root-indent="16"
            :value="activeMenuKey"
            @update:value="handleSelectMenu"
          />
        </div>
        <template #footer>
          <div class="drawer-footer-col">
            <div class="user-name sub-note">
              {{ auth.user?.name || "管理员" }}
            </div>
            <NButton block size="small" @click="handleLogout">
              <template #icon>
                <LogOut :size="14" />
              </template>
              退出登录
            </NButton>
          </div>
        </template>
      </NDrawerContent>
    </NDrawer>

    <NLayout class="layout-main">
      <NLayoutHeader bordered class="shell-header">
        <div class="header-left">
          <NButton
            v-if="isMobile"
            aria-label="打开导航"
            quaternary
            size="small"
            @click="mobileDrawerOpen = true"
          >
            <template #icon>
              <Menu :size="16" />
            </template>
          </NButton>
          <span class="header-title">{{ currentTitle }}</span>
        </div>

        <div class="header-right">
          <div v-if="status" class="bot-chip">
            <NAvatar v-if="botAvatarUrl" round :size="22" :src="botAvatarUrl" />
            <span class="bot-label">{{ botDisplayName }}</span>
            <NTag size="small" :type="status.botPaused ? 'warning' : 'success'">
              {{ status.botPaused ? "已暂停" : "运行中" }}
            </NTag>
            <NButton
              :loading="togglingPause"
              secondary
              size="tiny"
              :type="status.botPaused ? 'primary' : 'default'"
              @click="handleToggleBotPause"
            >
              <template #icon>
                <Play v-if="status.botPaused" :size="12" />
                <Pause v-else :size="12" />
              </template>
              {{ status.botPaused ? "恢复" : "暂停" }}
            </NButton>
          </div>

          <NTooltip v-if="status">
            <template #trigger>
              <NTag
                size="small"
                :type="
                  status.gatewayHealth.reachable
                    ? status.gatewayStreamConnected
                      ? 'success'
                      : 'warning'
                    : 'error'
                "
              >
                <span
                  class="dot"
                  :class="
                    status.gatewayHealth.reachable
                      ? status.gatewayStreamConnected
                        ? 'ok'
                        : 'warn'
                      : ''
                  "
                />
                网关
              </NTag>
            </template>
            {{
              status.gatewayHealth.reachable
                ? status.gatewayStreamConnected
                  ? "Message Gateway 在线，事件流已连接"
                  : "Message Gateway 在线，事件流未连接"
                : status.gatewayHealth.configured
                  ? "Message Gateway 不可达"
                  : "未配置 Gateway URL"
            }}
          </NTooltip>

          <NTooltip>
            <template #trigger>
              <span class="sse-badge" :class="{ on: sseConnected }">
                <span class="dot" :class="{ ok: sseConnected }" />
                <span v-if="!isMobile">实时流</span>
              </span>
            </template>
            {{ sseConnected ? "SSE 事件流已连接" : "SSE 重连中" }}
          </NTooltip>

          <NTooltip>
            <template #trigger>
              <NButton
                aria-label="切换明暗主题"
                quaternary
                size="small"
                @click="toggleTheme"
              >
                <template #icon>
                  <Sun v-if="theme === 'dark'" :size="15" />
                  <Moon v-else :size="15" />
                </template>
              </NButton>
            </template>
            {{ theme === "dark" ? "切换到浅色外观" : "切换到深色外观" }}
          </NTooltip>
        </div>
      </NLayoutHeader>

      <NLayoutContent class="shell-main" :native-scrollbar="false">
        <div class="content-container">
          <slot />
        </div>
      </NLayoutContent>
    </NLayout>
  </NLayout>
</template>

<style scoped>
.layout-root {
  min-height: 100vh;
}

.layout-main {
  min-width: 0;
}

.drawer-footer-col {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.sider-inner {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  padding: 10px 8px;
}

.brand-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px 12px;
}

.brand-dot {
  width: 9px;
  height: 9px;
  border-radius: 999px;
  background: #be123c;
  flex-shrink: 0;
}

.brand-name {
  font-size: 15px;
  font-weight: 700;
  letter-spacing: -0.02em;
}

.brand-sub {
  font-size: 12px;
  color: var(--berry-muted);
}

.sider-footer {
  margin-top: auto;
  padding-top: 10px;
  border-top: 1px solid var(--berry-border);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.user-card {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 6px;
}

.user-meta {
  min-width: 0;
}

.user-name {
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.user-role {
  font-size: 11px;
  color: var(--berry-muted);
}

.shell-header {
  height: 48px;
  padding: 0 18px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex-shrink: 0;
}

.header-title {
  font-size: 14px;
  font-weight: 600;
  white-space: nowrap;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 10px;
}

.bot-chip {
  display: flex;
  align-items: center;
  gap: 7px;
  padding-right: 4px;
}

.bot-label {
  font-size: 12px;
  font-weight: 500;
  max-width: 170px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sse-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: var(--berry-muted);
}

.dot {
  display: inline-block;
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: #b91c1c;
  margin-right: 4px;
}

.dot.ok {
  background: #15803d;
}

.dot.warn {
  background: #d97706;
}

.sse-badge .dot {
  margin-right: 0;
}

.shell-main {
  min-height: calc(100vh - 48px);
}

.content-container {
  max-width: 1600px;
  margin: 0 auto;
  padding: 18px 20px 32px;
}

@media (max-width: 640px) {
  .bot-label {
    display: none;
  }

  .shell-header {
    padding: 0 12px;
  }

  .content-container {
    padding: 14px 12px 24px;
  }
}
</style>
