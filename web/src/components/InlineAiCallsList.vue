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

function formatClock(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");

  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

const formatDuration = (ms: number): string =>
  ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms}ms`;

function briefPreview(call: LlmCallRow): string {
  if (call.error) {
    return call.error.replaceAll(/\s+/g, " ").trim().slice(0, 60);
  }

  if (!call.responseText) {
    return "";
  }

  const trimmed = call.responseText.trim();

  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const parsed = JSON.parse(trimmed) as {
        units?: { kind?: string; text?: string; emojiId?: string }[];
        brief?: string;
        decisions?: { action?: string; reason?: string }[];
      };

      if (Array.isArray(parsed.units)) {
        if (parsed.units.length === 0) {
          return "静默（不发言）";
        }

        const first = parsed.units[0];

        if (first?.text) {
          return first.text.replaceAll(/\s+/g, " ").trim().slice(0, 60);
        }

        if (first?.kind === "qq_reaction") {
          return `表情回应 ${first.emojiId ?? ""}`.trim();
        }
      }

      if (typeof parsed.brief === "string" && parsed.brief.trim()) {
        return parsed.brief.replaceAll(/\s+/g, " ").trim().slice(0, 60);
      }

      if (Array.isArray(parsed.decisions) && parsed.decisions.length > 0) {
        const first = parsed.decisions[0];

        return `${first?.action ?? ""} ${first?.reason ?? ""}`
          .replaceAll(/\s+/g, " ")
          .trim()
          .slice(0, 60);
      }
    } catch {
      // Fall back to raw text slice below.
    }
  }

  return trimmed.replaceAll(/\s+/g, " ").slice(0, 60);
}
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
            <NTag
              :bordered="false"
              size="tiny"
              :type="purposeMeta(call.purpose).type"
            >
              {{ purposeMeta(call.purpose).label }}
            </NTag>
            <NTag
              v-if="call.status === 'error'"
              :bordered="false"
              size="tiny"
              type="error"
            >
              失败
            </NTag>
            <NTag
              v-for="(tc, idx) in call.toolCalls.slice(0, 2)"
              :key="`${tc.name}-${idx}`"
              :bordered="false"
              size="tiny"
              type="info"
            >
              {{ tc.name }}
            </NTag>
            <span v-if="call.toolCalls.length > 2" class="inline-trace-more">
              +{{ call.toolCalls.length - 2 }}
            </span>
            <span
              v-else-if="call.toolCalls.length === 0 && briefPreview(call)"
              class="inline-trace-preview"
            >
              {{ briefPreview(call) }}
            </span>
          </div>
        </template>
        <template #header-extra>
          <span class="inline-trace-stats tabular">
            <span class="inline-trace-clock">
              {{ formatClock(call.createdAt) }}
            </span>
            <span>{{ formatDuration(call.durationMs) }}</span>
            <span class="inline-trace-tokens">
              {{ call.inputTokens.toLocaleString() }}→{{
                call.outputTokens.toLocaleString()
              }}
            </span>
          </span>
        </template>

        <div class="inline-trace-body">
          <div class="inline-trace-meta mono sub-note">
            <span>{{ call.model }}</span>
            <span>{{ formatTime(call.createdAt) }}</span>
            <span v-if="call.cachedInputTokens > 0" class="tabular">
              缓存命中 {{ call.cachedInputTokens.toLocaleString() }}
            </span>
          </div>

          <NAlert v-if="call.error" size="small" title="调用失败" type="error">
            {{ call.error }}
          </NAlert>

          <div
            v-for="(tc, idx) in call.toolCalls"
            :key="`arg-${tc.name}-${idx}`"
            class="turn-box"
          >
            <NTag :bordered="false" size="tiny" type="info">{{ tc.name }}</NTag>
            <pre class="code-block mt-xs">{{
              prettyMaybeJson(tc.arguments)
            }}</pre>
          </div>

          <pre v-if="call.responseText" class="code-block">{{
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
  background: var(--berry-surface);
  overflow: hidden;
}

.inline-trace-collapse :deep(.n-collapse-item) {
  margin: 0 !important;
  border-top: 1px solid var(--berry-border) !important;
}

.inline-trace-collapse :deep(.n-collapse-item:first-child) {
  border-top: none !important;
}

.inline-trace-collapse :deep(.n-collapse-item__header) {
  padding: 9px 12px !important;
  align-items: center !important;
  transition: background-color 0.14s ease;
}

.inline-trace-collapse :deep(.n-collapse-item__header:hover) {
  background: var(--berry-inset);
}

.inline-trace-collapse :deep(.n-collapse-item__header-main) {
  min-width: 0;
  flex: 1;
  gap: 6px;
}

.inline-trace-collapse :deep(.n-collapse-item__header-extra) {
  flex-shrink: 0;
  margin-left: 10px;
}

.inline-trace-collapse :deep(.n-collapse-item__content-wrapper) {
  border-top: 1px dashed var(--berry-border);
  background: var(--berry-inset);
}

.inline-trace-collapse :deep(.n-collapse-item__content-inner) {
  padding: 10px 12px !important;
}

.inline-trace-head {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  flex: 1;
}

.inline-trace-preview {
  font-size: 12px;
  color: var(--berry-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
  flex: 1;
}

.inline-trace-more {
  font-size: 11px;
  color: var(--berry-muted);
  flex-shrink: 0;
}

.inline-trace-stats {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--berry-muted);
  white-space: nowrap;
}

.inline-trace-clock {
  opacity: 0.72;
}

.inline-trace-tokens {
  color: var(--n-text-color, inherit);
}

.inline-trace-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.inline-trace-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 12px;
  color: var(--berry-muted);
}
</style>
