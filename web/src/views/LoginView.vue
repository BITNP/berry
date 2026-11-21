<script setup lang="ts">
import { NAlert, NButton, NCard, NSpace, NText } from "naive-ui";
import { computed } from "vue";
import { useRoute } from "vue-router";

import { useAuth } from "../composables/useAuth.ts";

const route = useRoute();
const auth = useAuth();

const errorMessage = computed(() => {
  switch (route.query.error) {
    case "not_admin": {
      return "当前账号缺少管理层角色（permission-management-access）或系统管理员角色（permission-system-admin），无法进入控制台。";
    }

    case "provider_unavailable": {
      return "OIDC 服务不可用或尚未配置（请检查 BERRY_OIDC_* 环境变量）。";
    }

    case "oidc_failed": {
      return "Keycloak 登录校验失败或已过期，请重试。";
    }

    default: {
      return "";
    }
  }
});

const loginHref = computed(() => {
  const target =
    typeof route.query.redirect === "string"
      ? route.query.redirect
      : typeof route.query.returnTo === "string"
        ? route.query.returnTo
        : "/overview";

  return `/api/auth/login?returnTo=${encodeURIComponent(target)}`;
});
</script>

<template>
  <main class="login-page">
    <NCard bordered class="login-card">
      <NSpace :size="16" vertical>
        <div class="login-brand">
          <span class="brand-dot" />
          <div>
            <div class="login-title">Berry 树莓娘</div>
            <NText class="sub-note" depth="3">管理控制台</NText>
          </div>
        </div>

        <NAlert v-if="errorMessage" type="error">
          {{ errorMessage }}
        </NAlert>

        <NAlert
          v-else-if="!auth.oidcConfigured && !auth.devAuthBypass"
          type="warning"
        >
          Keycloak OIDC 尚未配置，请先设置
          <code class="mono">BERRY_OIDC_ISSUER</code>
          、
          <code class="mono">BERRY_OIDC_CLIENT_ID</code>
          和
          <code class="mono">BERRY_OIDC_CLIENT_SECRET</code>
          。
        </NAlert>

        <NButton block :href="loginHref" tag="a" type="primary">
          使用 BITNP 通行证登录
        </NButton>
      </NSpace>
    </NCard>
  </main>
</template>

<style scoped>
.login-page {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 20px;
}

.login-card {
  width: min(380px, 100%);
}

.login-brand {
  display: flex;
  align-items: center;
  gap: 10px;
}

.brand-dot {
  width: 11px;
  height: 11px;
  border-radius: 999px;
  background: #be123c;
  flex-shrink: 0;
}

.login-title {
  font-size: 17px;
  font-weight: 700;
  letter-spacing: -0.02em;
}
</style>
