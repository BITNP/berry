import type { ChatKey, ChatKind } from "../types.ts";

export const makeChatKey = (kind: ChatKind, chatId: string): ChatKey =>
  `${kind}:${chatId}`;

export function parseChatKey(chatKey: string): {
  kind: ChatKind;
  chatId: string;
} {
  const index = chatKey.indexOf(":");

  if (index <= 0) {
    throw new Error(`Invalid chatKey: ${chatKey}`);
  }

  const kind = chatKey.slice(0, index);
  const chatId = chatKey.slice(index + 1);

  if ((kind !== "group" && kind !== "private") || !chatId) {
    throw new Error(`Invalid chatKey: ${chatKey}`);
  }

  return { kind, chatId };
}
