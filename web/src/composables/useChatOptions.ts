import { computed, onMounted, ref } from "vue";

import { apiFetch } from "../api/client.ts";

export interface KnownChatItem {
  chatKey: string;
  kind: "group" | "private";
  chatId: string;
  title: string;
}

export interface KnownUserItem {
  userId: string;
  name: string;
}

export function useChatOptions() {
  const chats = ref<KnownChatItem[]>([]);
  const users = ref<KnownUserItem[]>([]);

  const chatOptions = computed(() =>
    chats.value.map((chat) => ({
      label: chat.title ? `${chat.title} (${chat.chatKey})` : chat.chatKey,
      value: chat.chatKey,
    })),
  );

  const userOptions = computed(() =>
    users.value.map((user) => ({
      label:
        user.name && user.name !== user.userId
          ? `${user.name} (${user.userId})`
          : user.userId,
      value: user.userId,
    })),
  );

  async function loadChatOptions() {
    try {
      const [chatRes, userRes] = await Promise.all([
        apiFetch<{ items: KnownChatItem[] }>("/api/admin/chats"),
        apiFetch<{ items: KnownUserItem[] }>("/api/admin/users"),
      ]);

      chats.value = chatRes.items;
      users.value = userRes.items;
    } catch {
      // Non-critical autocomplete helper; ignore transient fetch failure.
    }
  }

  const chatTitleMap = computed(() => {
    const map = new Map<string, string>();

    for (const chat of chats.value) {
      if (chat.title) {
        map.set(chat.chatKey, chat.title);
      }
    }

    return map;
  });

  const chatTitle = (chatKey: string): string =>
    chatTitleMap.value.get(chatKey) ?? chatKey;

  onMounted(() => {
    void loadChatOptions();
  });

  return {
    chats,
    users,
    chatOptions,
    userOptions,
    chatTitle,
  };
}
