<script setup lang="ts">
import {
  NConfigProvider,
  NDialogProvider,
  NGlobalStyle,
  NMessageProvider,
  darkTheme,
  dateZhCN,
  zhCN,
} from "naive-ui";
import { computed } from "vue";
import { useRoute } from "vue-router";

import AppShell from "./components/AppShell.vue";
import { useAuth } from "./composables/useAuth.ts";
import { useTheme } from "./composables/useTheme.ts";
import { berryDarkTheme, berryLightTheme } from "./theme.ts";

const route = useRoute();
const auth = useAuth();
const { theme } = useTheme();

const showShell = computed(() => auth.authenticated && route.path !== "/login");
</script>

<template>
  <NConfigProvider
    :date-locale="dateZhCN"
    :locale="zhCN"
    :theme="theme === 'dark' ? darkTheme : null"
    :theme-overrides="theme === 'dark' ? berryDarkTheme : berryLightTheme"
  >
    <NGlobalStyle />
    <NMessageProvider>
      <NDialogProvider>
        <AppShell v-if="showShell">
          <RouterView />
        </AppShell>
        <RouterView v-else />
      </NDialogProvider>
    </NMessageProvider>
  </NConfigProvider>
</template>
