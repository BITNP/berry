<script setup lang="ts">
import {
  NButton,
  NCard,
  NForm,
  NFormItem,
  NInput,
  NModal,
  NSelect,
  NSpace,
  NSwitch,
  NTag,
  NText,
  useMessage,
} from "naive-ui";
import { ref } from "vue";

import { apiFetch } from "../../api/client.ts";
import { useChatOptions } from "../../composables/useChatOptions.ts";

interface DryRunResponse {
  result: {
    messageId: number;
    action: "reply" | "memory" | "ignore";
    confidence: number;
    reason: string;
  };
  model: string;
  durationMs: number;
}

const emit = defineEmits<{ done: [] }>();
const show = defineModel<boolean>("show", { required: true });
const message = useMessage();
const { chatOptions } = useChatOptions();

const busy = ref(false);
const result = ref<DryRunResponse | null>(null);
const form = ref({
  chatKey: "group:10248888",
  triggerMode: "smart_observe",
  senderName: "测试群友",
  userId: "10001",
  mentionedBot: false,
  quotedBot: false,
  text: "树莓娘，能帮忙查一下上周公会看板上还有哪些没做完吗？",
  recentContextText: "硅草: 今天服务器刚部署完\n王润泽: 周末例会定在周日晚上",
});

const actionMap: Record<
  DryRunResponse["result"]["action"],
  { text: string; type: "success" | "info" | "default" }
> = {
  reply: { text: "回复", type: "success" },
  memory: { text: "记入记忆", type: "info" },
  ignore: { text: "忽略", type: "default" },
};

async function handleRun() {
  if (!form.value.text.trim()) {
    message.warning("请输入待测试的消息内容");

    return;
  }

  busy.value = true;

  try {
    result.value = await apiFetch<DryRunResponse>(
      "/api/admin/gate-decisions/dry-run",
      {
        method: "POST",
        body: JSON.stringify({
          chatKey: form.value.chatKey.trim() || "group:100000",
          triggerMode: form.value.triggerMode,
          senderName: form.value.senderName.trim() || "测试群友",
          userId: form.value.userId.trim() || "10001",
          mentionedBot: form.value.mentionedBot,
          quotedBot: form.value.quotedBot,
          text: form.value.text.trim(),
          recentContext: form.value.recentContextText
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean),
        }),
      },
    );
    emit("done");
  } catch (err) {
    message.error(err instanceof Error ? err.message : "分流试跑失败");
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <NModal
    v-model:show="show"
    preset="card"
    :style="{ width: '520px', maxWidth: '94vw' }"
    title="小模型分流试跑"
  >
    <NForm label-placement="top" size="small">
      <NFormItem label="模拟会话标识">
        <NSelect
          v-model:value="form.chatKey"
          filterable
          :options="chatOptions"
          placeholder="选择已有会话或输入 group:群号"
          tag
        />
      </NFormItem>
      <NFormItem v-if="!form.chatKey.startsWith('private:')" label="群触发模式">
        <NSelect
          v-model:value="form.triggerMode"
          :options="[
            { label: '智能观察（smart_observe）', value: 'smart_observe' },
            { label: '仅提及（mention_only）', value: 'mention_only' },
          ]"
        />
      </NFormItem>
      <NFormItem label="发送者">
        <NSpace class="w-full">
          <NInput
            v-model:value="form.senderName"
            class="w-190"
            placeholder="昵称"
          />
          <NInput
            v-model:value="form.userId"
            class="w-190"
            placeholder="QQ 号"
          />
        </NSpace>
      </NFormItem>
      <NFormItem label="标记">
        <NSpace :size="20">
          <NSpace
            v-if="!form.chatKey.startsWith('private:')"
            align="center"
            :size="6"
          >
            <NSwitch v-model:value="form.mentionedBot" size="small" />
            <span>@ 树莓娘</span>
          </NSpace>
          <NSpace align="center" :size="6">
            <NSwitch v-model:value="form.quotedBot" size="small" />
            <span>引用机器人消息</span>
          </NSpace>
        </NSpace>
      </NFormItem>
      <NFormItem label="模拟近期群聊上下文（每行一条）">
        <NInput
          v-model:value="form.recentContextText"
          :rows="3"
          type="textarea"
        />
      </NFormItem>
      <NFormItem label="待判定消息">
        <NInput v-model:value="form.text" :rows="3" type="textarea" />
      </NFormItem>
      <NButton block :loading="busy" type="primary" @click="handleRun">
        执行分类测试
      </NButton>
    </NForm>

    <NCard v-if="result" class="mt-lg" size="small" title="判定结果">
      <NSpace :size="8" vertical>
        <NSpace align="center" :size="8">
          <NTag size="small" :type="actionMap[result.result.action].type">
            {{ actionMap[result.result.action].text }}
          </NTag>
          <NText class="tabular">
            置信度 {{ Math.round(result.result.confidence * 100) }}%
          </NText>
          <NText class="mono sub-note" depth="3">
            {{ result.model }} / {{ result.durationMs }} ms
          </NText>
        </NSpace>
        <div>{{ result.result.reason }}</div>
      </NSpace>
    </NCard>
  </NModal>
</template>
