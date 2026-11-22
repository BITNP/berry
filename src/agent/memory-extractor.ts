import { resolveThinkingEffort } from "../config/settings.ts";
import { renderMessageTextForModel } from "../gateway/segments.ts";
import { resolveAccessRole } from "../identity/permissions.ts";
import { memoryManageTool } from "../tools/index.ts";
import type { AgentServices } from "../tools/types.ts";
import type { ChatKey } from "../types.ts";
import { formatDateTime } from "../utils/time.ts";
import { runChatToolLoop } from "./loop.ts";
import { ModelIds } from "./model-ids.ts";

export async function extractMemoryFromMessage(
  services: AgentServices,
  chatKey: ChatKey,
  messageId: number,
  options?: { jobId?: number | null },
): Promise<void> {
  const { store, directory } = services;
  const settings = services.getSettings();
  const message = await store.messages.get(messageId);

  if (message?.recalledAt !== null) {
    return;
  }

  const conversation = await store.conversations.open();

  if (message.id <= conversation.afterMessageId) {
    return;
  }

  const [context, memoryIndex, identityUser, allChats] = await Promise.all([
    store.messages.recent(chatKey, 12, {
      beforeId: message.id,
      afterId: conversation.afterMessageId,
    }),
    store.memories.index(chatKey, message.userId),
    directory.byQQ(message.userId).catch(() => null),
    store.chats.list(),
  ]);
  const role = resolveAccessRole({
    userId: message.userId,
    adminQQs: settings.policy.adminQQs,
    permissions: identityUser?.permissions,
  });
  const currentChat = allChats.find((c) => c.chatKey === chatKey) ?? null;
  const ids = new ModelIds()
    .seedChats(allChats)
    .seedUsers(context.map((item) => item.userId));
  const userRef = ids.userRef(message.userId);
  const chatRef = currentChat
    ? currentChat.kind === "group"
      ? ids.groupRef(currentChat.chatId)
      : ids.userRef(currentChat.chatId)
    : undefined;
  const knownGroups = allChats
    .filter((c) => c.kind === "group")
    .map((c) => ({
      targetRef: ids.groupRef(c.chatId),
      title: c.title,
    }));
  const memoryTool = memoryManageTool.bind({
    services,
    actor: {
      chatKey,
      senderQQ: message.userId,
      actorSubject: identityUser?.subject ?? null,
      actorName: identityUser?.name ?? message.senderName,
      role,
      triggerMessageId: message.id,
    },
    ids,
  });

  await runChatToolLoop({
    purpose: "memory_update",
    chatKey,
    jobId: options?.jobId ?? null,
    messageIds: [messageId],
    settings,
    store,
    systemPrompt: [
      "你是树莓娘的静默记忆助手，只负责维护每轮自动注入上下文的轻量长期记忆（不是知识库），不向群聊发言。",
      "【允许写入的 4 类轻量记忆】：1) 树莓娘行为/发言/群活跃度或互动规则；2) 成员称呼/外号/QQ身份映射、群别称（如“网协大群”对应哪个群）；3) 成员或管理员稳定个人偏好；4) 极简且有时效的短期提醒/排期（必须设置 ttlDays 或 expiresAt）。",
      '【严禁写入的知识库内容】：项目架构设计、技术方案讨论、功能脑暴/优化待办、工作流程规范（SOP）、漏洞或故障跟进、会议纪要、协作空间说明等长篇参考资料属于 Bunko 知识库或公会看板，宁缺毋滥，遇到此类内容直接跳过不写并输出 {"done":true}。',
      '【精准归属与去重】：针对某一个群的规则必须写 scope="chat" 并传 knownGroups 中对应群的 targetRef（禁止误写成 scope="global"）；针对特定人的称呼或偏好用 scope="user" 并传 userRef；已有同类主题时复用原 key 覆盖更新；summary 一句话说清核心，content 保持精炼不堆砌流水账。结束后输出 {"done":true}。',
    ].join("\n"),
    history: [],
    userContent: JSON.stringify({
      now: formatDateTime(Date.now(), settings.bot.timezone),
      chat: {
        kind:
          currentChat?.kind ??
          (chatKey.startsWith("group:") ? "group" : "private"),
        ...(chatRef ? { targetRef: chatRef } : {}),
        title: currentChat?.title ?? "",
      },
      ...(knownGroups.length > 0 ? { knownGroups } : {}),
      sourceMessage: {
        userRef,
        senderName: message.senderName,
        text: renderMessageTextForModel(message, {
          botQQ: settings.bot.botQQ,
          botName: settings.bot.names[0],
          ids,
        }),
      },
      recentContext: context.map((m) => ({
        userRef: ids.userRef(m.userId),
        senderName: m.senderName,
        text: renderMessageTextForModel(m, {
          botQQ: settings.bot.botQQ,
          botName: settings.bot.names[0],
          ids,
        }).slice(0, 400),
      })),
      memoryIndex,
    }),
    tools: [memoryTool],
    maxRounds: 6,
    thinkingEffort: resolveThinkingEffort(settings, "memory_update"),
  });
}
