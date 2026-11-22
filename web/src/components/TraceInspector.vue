<script setup lang="ts">
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Code2,
  Copy,
  ExternalLink,
  Image as ImageIcon,
  MessageSquare,
  RotateCcw,
  Sparkles,
  Wrench,
} from "@lucide/vue";
import { NAlert, NButton, NImage, NTag, useMessage } from "naive-ui";
import { ref, watch } from "vue";
import { useRouter } from "vue-router";

import { apiFetch } from "../api/client.ts";
import type { AiTraceView, LlmCallRow, TraceOutcome } from "../utils/ai.ts";
import {
  formatDurationHuman,
  formatToolArguments,
  parseDialogUnits,
  parseGateDecisionsFromResponse,
  parseSubagentOutput,
  prettyMaybeJson,
  purposeMeta,
} from "../utils/ai.ts";
import { formatPercent, formatTime } from "../utils/format.ts";
import { routes } from "../utils/routes.ts";

const emit = defineEmits<{
  refresh: [];
}>();

const props = defineProps<{
  trace: AiTraceView | null;
  hideJumpToChat?: boolean;
}>();

const router = useRouter();
const message = useMessage();

const rawOpenByStep = ref<Record<number, boolean>>({});
const toolResultOpen = ref<Record<string, boolean>>({});
const retryingJobId = ref<number | null>(null);

async function retryJob(jobId: number) {
  retryingJobId.value = jobId;

  try {
    const res = await apiFetch<{ retried: boolean }>(
      `/api/admin/jobs/${jobId}/retry`,
      { method: "POST" },
    );

    if (res.retried) {
      message.success(`任务 #${jobId} 已重新入队`);
      emit("refresh");
    } else {
      message.info(`任务 #${jobId} 当前无需重试`);
    }
  } catch (err) {
    message.error(err instanceof Error ? err.message : "重试任务失败");
  } finally {
    retryingJobId.value = null;
  }
}

watch(
  () => props.trace?.id,
  () => {
    rawOpenByStep.value = {};
    toolResultOpen.value = {};
  },
);

function toggleRaw(stepId: number) {
  rawOpenByStep.value = {
    ...rawOpenByStep.value,
    [stepId]: !rawOpenByStep.value[stepId],
  };
}

function toggleToolResult(key: string) {
  toolResultOpen.value = {
    ...toolResultOpen.value,
    [key]: !toolResultOpen.value[key],
  };
}

function outcomeTagType(
  kind: TraceOutcome["kind"],
): "success" | "info" | "warning" | "error" | "default" | "primary" {
  switch (kind) {
    case "reply": {
      return "primary";
    }

    case "reaction":
    case "vision": {
      return "info";
    }

    case "memory": {
      return "success";
    }

    case "error": {
      return "error";
    }

    case "silent":
    case "ignore": {
      return "default";
    }

    default: {
      return "default";
    }
  }
}

function gateActionTag(action: string): {
  label: string;
  type: "primary" | "success" | "default";
} {
  if (action === "reply") {
    return { label: "回复", type: "primary" };
  }

  if (action === "memory") {
    return { label: "记忆", type: "success" };
  }

  return { label: "忽略", type: "default" };
}

function formatClock(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");

  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function summarizeToolArgs(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const pairs = Object.entries(parsed).map(([k, v]) => {
        const val =
          typeof v === "string"
            ? v.length > 60
              ? `"${v.slice(0, 60)}…"`
              : `"${v}"`
            : JSON.stringify(v);

        return `${k}: ${val}`;
      });

      return pairs.join(" · ");
    }
  } catch {
    // Fall back to raw text.
  }

  return raw.slice(0, 120);
}

function jumpToChat() {
  if (!props.trace?.chatKey) {
    return;
  }

  void router.push(routes.chat(props.trace.chatKey));
}

async function copyText(text: string | null | undefined, label: string) {
  if (!text) {
    return;
  }

  try {
    await navigator.clipboard.writeText(text);
    message.success(`已复制${label}`);
  } catch {
    message.error("复制失败");
  }
}

const isVisionEmpty = (step: LlmCallRow): boolean =>
  step.purpose === "vision" &&
  step.status === "ok" &&
  !(step.responseText ?? "").trim();
</script>

<template>
  <div v-if="!trace" class="ti-empty">
    <Sparkles class="ti-empty-icon" :size="20" />
    <span>选择左侧任意一条追踪记录，查看完整触发输入、AI 步骤和发出结果</span>
  </div>

  <div v-else class="ti-root">
    <!-- Top summary header -->
    <header class="ti-header">
      <div class="ti-header-main">
        <div class="ti-header-title-row">
          <span class="ti-chat-name">{{ trace.chatTitle }}</span>
          <NTag
            :bordered="false"
            size="small"
            :type="outcomeTagType(trace.outcome.kind)"
          >
            {{ trace.outcome.label }}
          </NTag>
          <NTag
            v-if="trace.hasCacheWarning"
            :bordered="false"
            size="small"
            type="warning"
          >
            缓存告警
          </NTag>
        </div>
        <div class="ti-header-meta tabular">
          <span>{{ formatTime(trace.startedAt) }}</span>
          <span class="ti-dot">·</span>
          <span>{{ trace.steps.length }} 次模型调用</span>
          <span class="ti-dot">·</span>
          <span>总耗时 {{ formatDurationHuman(trace.totalDurationMs) }}</span>
          <template v-if="trace.totalInputTokens > 0">
            <span class="ti-dot">·</span>
            <span>
              Tokens {{ trace.totalInputTokens.toLocaleString() }} /
              {{ trace.totalOutputTokens.toLocaleString() }}
            </span>
            <span v-if="trace.totalCachedTokens > 0" class="ti-cache-hit">
              (缓存
              {{
                formatPercent(trace.totalCachedTokens, trace.totalInputTokens)
              }})
            </span>
          </template>
        </div>
      </div>

      <NButton
        v-if="trace.chatKey && !hideJumpToChat"
        quaternary
        size="small"
        @click="jumpToChat"
      >
        <template #icon>
          <ExternalLink :size="13" />
        </template>
        查看会话
      </NButton>
    </header>

    <!-- Failed jobs / deliveries summary -->
    <section
      v-if="trace.failedJobs.length > 0 || trace.failedDeliveries.length > 0"
      class="ti-section"
    >
      <div class="ti-section-label">异常记录</div>

      <NAlert
        v-for="job in trace.failedJobs"
        :key="`fj-${job.id}`"
        :show-icon="false"
        type="error"
      >
        <div class="ti-fail-row">
          <div class="ti-fail-main">
            <div class="ti-fail-head">
              <NTag :bordered="false" size="tiny" type="error">
                {{ job.label }}
              </NTag>
              <span class="mono ti-muted">任务 #{{ job.id }}</span>
              <span class="tabular ti-muted">已尝试 {{ job.attempts }} 次</span>
              <span class="tabular ti-muted">
                {{ formatTime(job.updatedAt) }}
              </span>
            </div>
            <div v-if="job.summary" class="ti-fail-summary">
              {{ job.summary }}
            </div>
            <div class="ti-fail-error">{{ job.lastError }}</div>
          </div>
          <NButton
            :loading="retryingJobId === job.id"
            secondary
            size="tiny"
            type="error"
            @click="retryJob(job.id)"
          >
            <template #icon>
              <RotateCcw :size="12" />
            </template>
            重试任务
          </NButton>
        </div>
      </NAlert>

      <NAlert
        v-for="del in trace.failedDeliveries"
        :key="`fd-${del.id}`"
        :show-icon="false"
        type="error"
      >
        <div class="ti-fail-main">
          <div class="ti-fail-head">
            <NTag :bordered="false" size="tiny" type="error">
              投递 · {{ del.label }}
            </NTag>
            <span class="mono ti-muted">投递 #{{ del.id }}</span>
            <span class="tabular ti-muted">已尝试 {{ del.attempts }} 次</span>
            <span class="tabular ti-muted">
              {{ formatTime(del.updatedAt) }}
            </span>
          </div>
          <div v-if="del.summary" class="ti-fail-summary">
            {{ del.summary }}
          </div>
          <div class="ti-fail-error">{{ del.error }}</div>
        </div>
      </NAlert>
    </section>

    <!-- Causal overview: Trigger -> Outcome -->
    <section
      v-if="
        trace.quotedMessages.length > 0 ||
        trace.triggerMessages.length > 0 ||
        trace.instruction
      "
      class="ti-section"
    >
      <div class="ti-section-label">触发输入</div>

      <!-- Quoted context if any -->
      <div
        v-for="q in trace.quotedMessages"
        :key="`q-${q.id}`"
        class="ti-quote-box"
      >
        <span class="ti-quote-tag">引用</span>
        <span class="ti-quote-sender">{{ q.senderName }}</span>
        <span class="ti-quote-text">{{ q.text }}</span>
      </div>

      <!-- Triggering QQ message(s) -->
      <div
        v-for="msg in trace.triggerMessages"
        :key="`t-${msg.id}`"
        class="ti-msg-block"
      >
        <div class="ti-msg-head">
          <MessageSquare class="ti-msg-icon" :size="13" />
          <span class="ti-msg-sender">{{ msg.senderName }}</span>
          <span class="mono ti-msg-id">#{{ msg.id }}</span>
          <span class="ti-msg-time tabular">{{ formatClock(msg.sentAt) }}</span>
        </div>
        <div v-if="msg.text" class="ti-msg-body">{{ msg.text }}</div>

        <div v-if="msg.assets.length > 0" class="ti-assets">
          <div
            v-for="asset in msg.assets"
            :key="asset.id"
            class="ti-asset-item"
          >
            <NImage
              v-if="asset.kind === 'image' && asset.filePath"
              class="ti-asset-thumb"
              height="64"
              object-fit="cover"
              :src="`/api/admin/assets/${asset.id}/raw`"
              width="64"
            />
            <div v-else class="ti-asset-placeholder">
              <ImageIcon :size="16" />
            </div>
            <div class="ti-asset-detail">
              <div class="ti-asset-head">
                <NTag
                  :bordered="false"
                  size="tiny"
                  :type="
                    asset.status === 'ready'
                      ? 'success'
                      : asset.status === 'failed'
                        ? 'error'
                        : 'warning'
                  "
                >
                  {{
                    asset.status === "ready"
                      ? "已识别"
                      : asset.status === "failed"
                        ? "识别失败"
                        : "处理中"
                  }}
                </NTag>
                <span class="mono ti-muted">附件 #{{ asset.id }}</span>
              </div>
              <div v-if="asset.error" class="ti-asset-error">
                {{ asset.error }}
              </div>
              <div v-else-if="asset.transcript" class="ti-asset-transcript">
                {{ asset.transcript }}
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Schedule / Admin instruction when no QQ trigger message -->
      <div
        v-if="trace.triggerMessages.length === 0 && trace.instruction"
        class="ti-msg-block"
      >
        <div class="ti-msg-head">
          <span class="ti-msg-sender">系统指令 / 定时触发</span>
        </div>
        <div class="ti-msg-body">{{ trace.instruction }}</div>
      </div>

      <!-- Gate decisions summary -->
      <div v-if="trace.gateDecisions.length > 0" class="ti-gate-strip">
        <div v-for="g in trace.gateDecisions" :key="g.id" class="ti-gate-row">
          <NTag
            :bordered="false"
            size="tiny"
            :type="gateActionTag(g.action).type"
          >
            分流：{{ gateActionTag(g.action).label }}
          </NTag>
          <span class="tabular ti-muted">
            {{ Math.round(g.confidence * 100) }}%
          </span>
          <span class="ti-gate-reason">{{ g.reason }}</span>
        </div>
      </div>

      <!-- Actual bot replies sent to QQ -->
      <div v-if="trace.replyMessages.length > 0" class="ti-replies">
        <div class="ti-section-label">发出回复</div>
        <div
          v-for="reply in trace.replyMessages"
          :key="`r-${reply.id}`"
          class="ti-reply-block"
        >
          <div class="ti-msg-head">
            <span class="ti-reply-sender">树莓娘</span>
            <span class="ti-msg-time tabular">
              {{ formatClock(reply.sentAt) }}
            </span>
          </div>
          <div class="ti-msg-body">{{ reply.text }}</div>
        </div>
      </div>
    </section>

    <!-- Step-by-step AI timeline -->
    <section class="ti-section">
      <div class="ti-section-label">
        AI 执行步骤（{{ trace.steps.length }}）
      </div>

      <div v-if="trace.steps.length === 0" class="ti-muted ti-no-steps">
        本次消息未触发大模型调用（例如被规则直接拦截或附件下载阶段即失败）。
      </div>

      <div v-else class="ti-timeline">
        <article
          v-for="(step, idx) in trace.steps"
          :key="step.id"
          class="ti-step"
          :class="{
            'is-error': step.status === 'error' || isVisionEmpty(step),
          }"
        >
          <div class="ti-step-rail">
            <span
              class="ti-step-dot"
              :class="
                step.status === 'error' || isVisionEmpty(step)
                  ? 'dot-error'
                  : 'dot-ok'
              "
            />
            <span v-if="idx < trace.steps.length - 1" class="ti-step-line" />
          </div>

          <div class="ti-step-content">
            <div class="ti-step-head">
              <NTag
                :bordered="false"
                size="small"
                :type="purposeMeta(step.purpose).type"
              >
                {{ purposeMeta(step.purpose).label }}
              </NTag>
              <span class="mono ti-step-model">{{ step.model }}</span>
              <span class="ti-step-metrics tabular">
                <span>{{ formatDurationHuman(step.durationMs) }}</span>
                <span class="ti-dot">·</span>
                <span>
                  {{ step.inputTokens.toLocaleString() }} /
                  {{ step.outputTokens.toLocaleString() }} tok
                </span>
                <span v-if="step.cachedInputTokens > 0" class="ti-cache-hit">
                  缓存
                  {{ formatPercent(step.cachedInputTokens, step.inputTokens) }}
                </span>
                <span class="ti-dot">·</span>
                <span>{{ formatClock(step.createdAt) }}</span>
              </span>
            </div>

            <NAlert
              v-if="step.error"
              class="ti-step-alert"
              :show-icon="false"
              type="error"
            >
              {{ step.error }}
            </NAlert>
            <NAlert
              v-else-if="isVisionEmpty(step)"
              class="ti-step-alert"
              :show-icon="false"
              type="warning"
            >
              模型消耗了 {{ step.outputTokens }} 输出 Token
              但正文为空（常见于思考模型被 max_tokens 截断）
            </NAlert>
            <NAlert
              v-if="step.cacheWarning"
              class="ti-step-alert"
              :show-icon="false"
              type="warning"
            >
              {{ step.cacheWarning }}
            </NAlert>

            <!-- Tool calls rendered cleanly -->
            <div v-if="step.toolCalls.length > 0" class="ti-tools">
              <div
                v-for="(tc, tIdx) in step.toolCalls"
                :key="`${step.id}-${tc.name}-${tIdx}`"
                class="ti-tool-item"
              >
                <div class="ti-tool-head">
                  <Wrench class="ti-muted" :size="12" />
                  <span class="mono ti-tool-name">{{ tc.name }}</span>
                  <CheckCircle2
                    v-if="tc.ok !== false"
                    class="ti-icon-ok"
                    :size="13"
                  />
                  <AlertCircle v-else class="ti-icon-err" :size="13" />
                  <span
                    v-if="tc.durationMs !== undefined"
                    class="tabular ti-muted"
                  >
                    {{ formatDurationHuman(tc.durationMs) }}
                  </span>
                  <span class="ti-tool-arg-summary mono">
                    {{ summarizeToolArgs(tc.arguments) }}
                  </span>
                  <button
                    class="ti-inline-btn"
                    type="button"
                    @click="toggleToolResult(`${step.id}-${tIdx}`)"
                  >
                    <ChevronDown
                      v-if="toolResultOpen[`${step.id}-${tIdx}`]"
                      :size="13"
                    />
                    <ChevronRight v-else :size="13" />
                    详情
                  </button>
                </div>

                <div
                  v-if="toolResultOpen[`${step.id}-${tIdx}`]"
                  class="ti-tool-detail"
                >
                  <div class="ti-sublabel">参数</div>
                  <pre class="code-block">{{ formatToolArguments(tc) }}</pre>
                  <template v-if="tc.result">
                    <div class="ti-sublabel">返回</div>
                    <pre class="code-block">{{
                      prettyMaybeJson(tc.result)
                    }}</pre>
                  </template>
                </div>
              </div>
            </div>

            <!-- Structured parsed output (human-readable!) -->
            <template v-if="step.responseText && step.status === 'ok'">
              <!-- Dialog output units -->
              <template
                v-if="
                  step.purpose === 'dialog' &&
                  parseDialogUnits(step.responseText)
                "
              >
                <div
                  v-if="parseDialogUnits(step.responseText)!.length === 0"
                  class="ti-parsed-muted"
                >
                  决定静默（不向 QQ 发言）
                </div>
                <div v-else class="ti-units">
                  <div
                    v-for="(unit, uIdx) in parseDialogUnits(step.responseText)"
                    :key="uIdx"
                    class="ti-unit-row"
                  >
                    <NTag
                      :bordered="false"
                      size="tiny"
                      :type="
                        unit.kind === 'qq_reaction' ||
                        unit.kind === 'qq_poke' ||
                        unit.kind === 'qq_image'
                          ? 'info'
                          : 'primary'
                      "
                    >
                      {{
                        unit.kind === "qq_reply"
                          ? "发送回复"
                          : unit.kind === "qq_reaction"
                            ? unit.remove
                              ? "取消表情"
                              : "贴表情"
                            : unit.kind === "qq_poke"
                              ? "戳一戳"
                              : unit.kind === "qq_image"
                                ? "发送表情包"
                                : `合并转发 (${unit.itemCount ?? 0})`
                      }}
                    </NTag>
                    <span class="ti-unit-text">
                      {{
                        unit.kind === "qq_reaction"
                          ? unit.emojiId
                          : unit.kind === "qq_poke"
                            ? unit.userRef
                              ? `戳了戳 ${unit.userRef}`
                              : "戳了戳对方"
                            : unit.kind === "qq_image"
                              ? unit.stickerId
                                ? `表情包 #${unit.stickerId}`
                                : "发送图片"
                              : unit.text || unit.title
                      }}
                    </span>
                  </div>
                </div>
              </template>

              <!-- Gate decisions parsed -->
              <template
                v-else-if="
                  step.purpose === 'gate' &&
                  parseGateDecisionsFromResponse(step.responseText)
                "
              >
                <div class="ti-units">
                  <div
                    v-for="(d, dIdx) in parseGateDecisionsFromResponse(
                      step.responseText,
                    )"
                    :key="dIdx"
                    class="ti-unit-row"
                  >
                    <NTag
                      :bordered="false"
                      size="tiny"
                      :type="gateActionTag(d.action).type"
                    >
                      {{ gateActionTag(d.action).label }}
                    </NTag>
                    <span v-if="d.messageId" class="mono ti-muted">
                      #{{ d.messageId }}
                    </span>
                    <span
                      v-if="d.confidence !== undefined"
                      class="tabular ti-muted"
                    >
                      {{ Math.round(d.confidence * 100) }}%
                    </span>
                    <span class="ti-unit-text">{{ d.reason }}</span>
                  </div>
                </div>
              </template>

              <!-- Subagent brief parsed -->
              <template
                v-else-if="
                  step.purpose.startsWith('subagent') &&
                  parseSubagentOutput(step.responseText)
                "
              >
                <div class="ti-readable-text">
                  {{ parseSubagentOutput(step.responseText)!.brief }}
                </div>
              </template>

              <!-- Plain readable output (vision, etc.) -->
              <div v-else class="ti-readable-text">
                {{
                  step.responseText.replaceAll(/\*\*([^*]+)\*\*/g, "$1").trim()
                }}
              </div>
            </template>

            <!-- Collapsible raw request / response -->
            <div class="ti-step-footer">
              <button
                class="ti-inline-btn"
                type="button"
                @click="toggleRaw(step.id)"
              >
                <Code2 :size="12" />
                {{
                  rawOpenByStep[step.id] ? "收起原始报文" : "原始请求 / 响应"
                }}
              </button>
              <button
                v-if="rawOpenByStep[step.id] && step.requestPreview"
                class="ti-inline-btn"
                type="button"
                @click="copyText(step.requestPreview, '原始请求')"
              >
                <Copy :size="12" />
                复制请求
              </button>
              <button
                v-if="rawOpenByStep[step.id] && step.responseText"
                class="ti-inline-btn"
                type="button"
                @click="copyText(step.responseText, '原始响应')"
              >
                <Copy :size="12" />
                复制响应
              </button>
            </div>

            <div v-if="rawOpenByStep[step.id]" class="ti-raw-box">
              <div v-if="step.requestPreview">
                <div class="ti-sublabel">Request Preview</div>
                <pre class="code-block ti-raw-pre">{{
                  step.requestPreview
                }}</pre>
              </div>
              <div v-if="step.responseText">
                <div class="ti-sublabel">Raw Response</div>
                <pre class="code-block ti-raw-pre">{{
                  prettyMaybeJson(step.responseText)
                }}</pre>
              </div>
            </div>
          </div>
        </article>
      </div>
    </section>
  </div>
</template>

<style scoped>
.ti-empty {
  height: 100%;
  min-height: 280px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--berry-muted);
  font-size: 13px;
  padding: 24px;
  text-align: center;
}

.ti-empty-icon {
  opacity: 0.45;
}

.ti-root {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.ti-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 18px;
  border-bottom: 1px solid var(--berry-border);
}

.ti-header-main {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.ti-header-title-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.ti-chat-name {
  font-size: 15px;
  font-weight: 600;
}

.ti-header-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--berry-muted);
}

.ti-dot {
  opacity: 0.5;
}

.ti-cache-hit {
  color: #16a34a;
  font-weight: 500;
}

:global(:root[data-theme="dark"]) .ti-cache-hit {
  color: #4ade80;
}

.ti-section {
  padding: 14px 18px;
  border-bottom: 1px solid var(--berry-border);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.ti-fail-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.ti-fail-main {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.ti-fail-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  font-size: 12px;
}

.ti-fail-summary {
  font-size: 13px;
  word-break: break-word;
}

.ti-fail-error {
  font-size: 12px;
  font-family: var(--berry-mono);
  word-break: break-word;
  white-space: pre-wrap;
}

.ti-section:last-child {
  border-bottom: none;
}

.ti-section-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--berry-muted);
}

.ti-quote-box {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 6px 10px;
  border-left: 2px solid var(--berry-border);
  background: var(--berry-inset);
  border-radius: 0 4px 4px 0;
  font-size: 12px;
  color: var(--berry-muted);
}

.ti-quote-tag {
  flex-shrink: 0;
  font-weight: 600;
}

.ti-quote-sender {
  flex-shrink: 0;
  font-weight: 500;
  color: inherit;
}

.ti-quote-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ti-msg-block {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border-radius: 6px;
  background: var(--berry-inset);
  border: 1px solid var(--berry-border);
}

.ti-reply-block {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border-radius: 6px;
  border: 1px solid rgba(225, 29, 72, 0.25);
  background: rgba(225, 29, 72, 0.04);
}

.ti-msg-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}

.ti-msg-icon {
  color: var(--berry-muted);
}

.ti-msg-sender {
  font-weight: 600;
}

.ti-reply-sender {
  font-weight: 600;
  color: #e11d48;
}

:global(:root[data-theme="dark"]) .ti-reply-sender {
  color: #fb7185;
}

.ti-msg-id,
.ti-msg-time,
.ti-muted {
  font-size: 11px;
  color: var(--berry-muted);
}

.ti-msg-time {
  margin-left: auto;
}

.ti-msg-body {
  font-size: 13px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
}

.ti-assets {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 2px;
}

.ti-asset-item {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 8px;
  border-radius: 6px;
  background: var(--berry-surface);
  border: 1px solid var(--berry-border);
}

.ti-asset-thumb {
  border-radius: 4px;
  flex-shrink: 0;
  overflow: hidden;
}

.ti-asset-placeholder {
  width: 44px;
  height: 44px;
  border-radius: 4px;
  background: var(--berry-inset);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--berry-muted);
  flex-shrink: 0;
}

.ti-asset-detail {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.ti-asset-head {
  display: flex;
  align-items: center;
  gap: 6px;
}

.ti-asset-error {
  font-size: 12px;
  color: #dc2626;
}

:global(:root[data-theme="dark"]) .ti-asset-error {
  color: #f87171;
}

.ti-asset-transcript {
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}

.ti-gate-strip {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.ti-gate-row {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 12px;
}

.ti-gate-reason {
  color: var(--berry-muted);
  line-height: 1.45;
}

.ti-replies {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.ti-no-steps {
  font-size: 12px;
  padding: 4px 0;
}

.ti-timeline {
  display: flex;
  flex-direction: column;
}

.ti-step {
  display: flex;
  gap: 12px;
  padding-bottom: 16px;
}

.ti-step:last-child {
  padding-bottom: 0;
}

.ti-step-rail {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 12px;
  flex-shrink: 0;
  padding-top: 6px;
}

.ti-step-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.dot-ok {
  background: #16a34a;
}

:global(:root[data-theme="dark"]) .dot-ok {
  background: #22c55e;
}

.dot-error {
  background: #ef4444;
}

.ti-step-line {
  width: 1px;
  flex: 1;
  margin-top: 4px;
  background: var(--berry-border);
}

.ti-step-content {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.ti-step-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.ti-step-model {
  font-size: 12px;
  color: var(--berry-muted);
}

.ti-step-metrics {
  margin-left: auto;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  font-size: 11px;
  color: var(--berry-muted);
}

.ti-step-alert {
  font-size: 12px;
}

.ti-tools {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.ti-tool-item {
  border: 1px solid var(--berry-border);
  border-radius: 6px;
  background: var(--berry-inset);
  padding: 6px 10px;
}

.ti-tool-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  min-width: 0;
}

.ti-tool-name {
  font-weight: 600;
  flex-shrink: 0;
}

.ti-icon-ok {
  color: #16a34a;
  flex-shrink: 0;
}

.ti-icon-err {
  color: #ef4444;
  flex-shrink: 0;
}

.ti-tool-arg-summary {
  flex: 1;
  min-width: 0;
  font-size: 11px;
  color: var(--berry-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ti-tool-detail {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.ti-units {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.ti-unit-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 13px;
  line-height: 1.5;
}

.ti-unit-text {
  white-space: pre-wrap;
  word-break: break-word;
}

.ti-parsed-muted {
  font-size: 12px;
  color: var(--berry-muted);
}

.ti-readable-text {
  font-size: 13px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--berry-inset);
  border: 1px solid var(--berry-border);
}

.ti-step-footer {
  display: flex;
  align-items: center;
  gap: 10px;
}

.ti-inline-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 6px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--berry-muted);
  font-size: 11px;
  cursor: pointer;
  flex-shrink: 0;
  transition:
    background-color 0.15s ease,
    color 0.15s ease;
}

.ti-inline-btn:hover {
  background: var(--berry-inset);
  color: inherit;
}

.ti-raw-box {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.ti-sublabel {
  font-size: 11px;
  font-weight: 600;
  color: var(--berry-muted);
  margin-bottom: 4px;
}

.ti-raw-pre {
  max-height: 300px;
  overflow: auto;
  font-size: 11px;
}
</style>
