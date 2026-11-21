<script setup lang="ts">
import { ArrowRight, Moon, Sun } from "@lucide/vue";
import { NAlert, NButton, NIcon } from "naive-ui";
import { computed } from "vue";
import { useRoute } from "vue-router";

import { useAuth } from "../composables/useAuth.ts";
import { useTheme } from "../composables/useTheme.ts";

const route = useRoute();
const auth = useAuth();
const { theme, toggle: toggleTheme } = useTheme();

const errorMessage = computed(() => {
  switch (route.query.error) {
    case "not_admin": {
      return "当前账号缺少网协管理层或系统管理员角色，无法进入控制台。";
    }

    case "provider_unavailable": {
      return "网协通行证服务暂不可用或尚未配置，请检查 BERRY_OIDC_* 环境变量。";
    }

    case "oidc_failed": {
      return "网协通行证登录校验失败或已过期，请重试。";
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
    <div class="login-corner">
      <NButton
        :aria-label="theme === 'dark' ? '切换浅色外观' : '切换深色外观'"
        quaternary
        size="small"
        @click="toggleTheme"
      >
        <template #icon>
          <NIcon :size="15">
            <Sun v-if="theme === 'dark'" />
            <Moon v-else />
          </NIcon>
        </template>
      </NButton>
    </div>

    <section aria-labelledby="login-heading" class="login-panel">
      <header class="login-head">
        <h1 id="login-heading" class="login-title">Berry 树莓娘</h1>
        <p class="login-subtitle">网协管理控制台</p>
      </header>

      <NAlert v-if="errorMessage" class="login-alert" show-icon type="error">
        {{ errorMessage }}
      </NAlert>

      <NAlert
        v-else-if="!auth.oidcConfigured && !auth.devAuthBypass"
        class="login-alert"
        show-icon
        type="warning"
      >
        网协通行证尚未配置，请先设置
        <code class="mono">BERRY_OIDC_ISSUER</code>
        、
        <code class="mono">BERRY_OIDC_CLIENT_ID</code>
        和
        <code class="mono">BERRY_OIDC_CLIENT_SECRET</code>
        。
      </NAlert>

      <a class="login-cta" :href="loginHref">
        <span class="login-cta-label">使用网协通行证登录</span>
        <ArrowRight class="login-cta-icon" :size="15" />
      </a>

      <p class="login-note">仅限网协管理层及系统管理员访问</p>
    </section>
  </main>
</template>

<style scoped>
.login-page {
  position: relative;
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 24px 16px;
}

.login-corner {
  position: fixed;
  top: 16px;
  right: 16px;
}

.login-panel {
  width: min(352px, 100%);
  display: flex;
  flex-direction: column;
  gap: 18px;
  padding: 28px 24px 24px;
  background: var(--berry-surface);
  border: 1px solid var(--berry-border);
  border-radius: 10px;
  box-shadow:
    0 1px 2px rgb(0 0 0 / 0.06),
    0 8px 24px rgb(0 0 0 / 0.12);
}

.login-head {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  text-align: center;
}

.login-title {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  line-height: 1.3;
  letter-spacing: -0.02em;
}

.login-subtitle {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.4;
  color: var(--berry-muted);
}

.login-alert {
  font-size: 12.5px;
}

.login-cta {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 100%;
  height: 40px;
  padding: 0 16px;
  border-radius: 7px;
  background: #e11d48;
  color: #ffffff;
  font-size: 13.5px;
  font-weight: 500;
  line-height: 1;
  text-decoration: none;
  transition:
    background-color 0.15s ease,
    transform 0.1s ease;
}

.login-cta-label {
  display: inline-flex;
  align-items: center;
  line-height: 1;
}

.login-cta-icon {
  display: block;
  flex-shrink: 0;
}

.login-cta:hover {
  background: #be123c;
  color: #ffffff;
}

.login-cta:active {
  background: #9f1239;
  transform: translateY(0.5px);
}

.login-cta:focus-visible {
  outline: 2px solid #fb7185;
  outline-offset: 2px;
}

.login-note {
  margin: -4px 0 0;
  text-align: center;
  font-size: 12px;
  line-height: 1.5;
  color: var(--berry-muted);
}

@media (prefers-reduced-motion: reduce) {
  .login-cta {
    transition: none;
  }

  .login-cta:active {
    transform: none;
  }
}
</style>
