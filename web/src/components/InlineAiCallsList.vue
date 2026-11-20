<script setup lang="ts">
import { NAlert, NCollapse, NCollapseItem, NSpin, NTag, NText } from "naive-ui";

import type { LlmCallRow } from "../utils/ai.ts";
import { prettyMaybeJson, purposeMeta } from "../utils/ai.ts";
import { formatTime } from "../utils/format.ts";

defineProps<{
  calls: LlmCallRow[];
  loading?: boolean;
  emptyText?: string;
}>();
</script>

<template>
  <div>
    <div v-if="loading && calls.length === 0" class="inline-trace-loading">
      <NSpin size="small" />
      <NText class="sub-note" depth="3">加载关联调用中…</NText>
    </div>

    <NText v-else-if="calls.length === 0" class="sub-note" depth="3">
      {{ emptyText || "该时段内暂无关联 AI 调用" }}
    </NText>

    <NCollapse v-else class="inline-trace-collapse">
      <NCollapseItem
        v-for="call in calls"
        :key="call.id"
        :name="String(call.id)"
      >
        <template #header>
          <div class="inline-trace-head">
            <NTag size="tiny" :type="purposeMeta(call.purpose).type">
              {{ purposeMeta(call.purpose).label }}
            </NTag>
            <NTag v-if="call.status === 'error'" size="tiny" type="error">
              失败
            </NTag>
            <NTag
              v-for="(tc, idx) in call.toolCalls.slice(0, 2)"
              :key="`${tc.name}-${idx}`"
              size="tiny"
              type="info"
            >
              {{ tc.name }}
            </NTag>
            <NText v-if="call.toolCalls.length > 2" class="sub-note" depth="3">
              +{{ call.toolCalls.length - 2 }}
            </NText>
          </div>
        </template>
        <template #header-extra>
          <span class="tabular sub-note">
            {{ call.durationMs }} ms /
            {{ call.inputTokens.toLocaleString() }}→{{
              call.outputTokens.toLocaleString()
            }}
          </span>
        </template>

        <div class="inline-trace-body">
          <div class="inline-trace-meta mono sub-note">
            {{ call.model }} / {{ formatTime(call.createdAt) }}
          </div>

          <NAlert
            v-if="call.error"
            class="mt-xs"
            size="small"
            title="调用失败"
            type="error"
          >
            {{ call.error }}
          </NAlert>

          <div
            v-for="(tc, idx) in call.toolCalls"
            :key="`arg-${tc.name}-${idx}`"
            class="turn-box mt-xs"
          >
            <NTag size="tiny" type="info">{{ tc.name }}</NTag>
            <pre class="code-block mt-xs">{{
              prettyMaybeJson(tc.arguments)
            }}</pre>
          </div>

          <pre v-if="call.responseText" class="code-block mt-xs">{{
            prettyMaybeJson(call.responseText)
          }}</pre>
        </div>
      </NCollapseItem>
    </NCollapse>
  </div>
</template>

<style scoped>
.inline-trace-loading {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 0;
}

.inline-trace-collapse {
  border: 1px solid var(--berry-border);
  border-radius: 6px;
  padding: 4px 10px;
}

.inline-trace-head {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.inline-trace-body {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.inline-trace-meta {
  color: var(--berry-muted);
}
</style>
