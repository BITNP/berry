import { computed, onMounted, ref } from "vue";

import { apiFetch } from "../api/client.ts";

export interface KnownChatItem {
  chatKey: string;
  kind: "group" | "private";
  chatId: string;
  title: string;
}

export function useChatOptions() {
  const chats = ref<KnownChatItem[]>([]);

  const chatOptions = computed(() =>
    chats.value.map((chat) => ({
      label: chat.title ? `${chat.title} (${chat.chatKey})` : chat.chatKey,
      value: chat.chatKey,
    })),
  );

  async function loadChatOptions() {
    try {
      const res = await apiFetch<{ items: KnownChatItem[] }>(
        "/api/admin/chats",
      );

      chats.value = res.items;
    } catch {
      // Non-critical autocomplete helper; ignore transient fetch failure.
    }
  }

  onMounted(() => {
    void loadChatOptions();
  });

  return {
    chats,
    chatOptions,
    loadChatOptions,
  };
}
