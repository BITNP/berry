import { createRouter, createWebHistory } from "vue-router";

import { refreshAuthStatus, useAuth } from "./composables/useAuth.ts";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/login", component: () => import("./views/LoginView.vue") },
    { path: "/", redirect: "/overview" },
    { path: "/overview", component: () => import("./views/OverviewView.vue") },
    { path: "/gate", component: () => import("./views/GateView.vue") },
    { path: "/chats", component: () => import("./views/ChatsView.vue") },
    { path: "/memories", component: () => import("./views/MemoriesView.vue") },
    { path: "/guild", component: () => import("./views/GuildView.vue") },
    { path: "/docs", component: () => import("./views/DocsView.vue") },
    { path: "/workspace", redirect: "/docs" },
    {
      path: "/schedules",
      component: () => import("./views/SchedulesView.vue"),
    },
    { path: "/logs", component: () => import("./views/LogsView.vue") },
    { path: "/settings", component: () => import("./views/SettingsView.vue") },
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
