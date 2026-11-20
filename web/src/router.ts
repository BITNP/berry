import { createRouter, createWebHistory } from "vue-router";

import { refreshAuthStatus, useAuth } from "./composables/useAuth.ts";

const APP_TITLE = "Berry";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: "/login",
      component: () => import("./views/LoginView.vue"),
      meta: { title: "登录" },
    },
    { path: "/", redirect: "/overview" },
    {
      path: "/overview",
      component: () => import("./views/OverviewView.vue"),
      meta: { title: "概览" },
    },
    {
      path: "/ai",
      component: () => import("./views/AiCallsView.vue"),
      meta: { title: "AI 调用" },
    },
    {
      path: "/gate",
      component: () => import("./views/GateView.vue"),
      meta: { title: "消息分流" },
    },
    {
      path: "/chats",
      component: () => import("./views/ChatsView.vue"),
      meta: { title: "会话管理" },
    },
    {
      path: "/memories",
      component: () => import("./views/MemoriesView.vue"),
      meta: { title: "长期记忆" },
    },
    {
      path: "/guild",
      component: () => import("./views/GuildView.vue"),
      meta: { title: "公会联动" },
    },
    {
      path: "/docs",
      component: () => import("./views/DocsView.vue"),
      meta: { title: "资料库" },
    },
    { path: "/workspace", redirect: "/docs" },
    {
      path: "/schedules",
      component: () => import("./views/SchedulesView.vue"),
      meta: { title: "定时任务" },
    },
    {
      path: "/logs",
      component: () => import("./views/LogsView.vue"),
      meta: { title: "日志队列" },
    },
    {
      path: "/settings",
      component: () => import("./views/SettingsView.vue"),
      meta: { title: "系统设置" },
    },
    { path: "/:pathMatch(.*)*", redirect: "/overview" },
  ],
});

router.beforeEach(async (to) => {
  await refreshAuthStatus().catch(() => false);
  const auth = useAuth();

  if (to.path === "/login") {
    return auth.authenticated ? "/overview" : true;
  }

  if (!auth.authenticated) {
    return { path: "/login", query: { redirect: to.fullPath } };
  }

  return true;
});

router.afterEach((to) => {
  const title = typeof to.meta.title === "string" ? to.meta.title : "";

  document.title = title ? `${title} - ${APP_TITLE}` : APP_TITLE;
});
