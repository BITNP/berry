import type { AgentTool } from "../agent/loop.ts";
import type { ModelIds } from "../agent/model-ids.ts";
import type { SubagentKind } from "../agent/subagents.ts";
import { runSubagent } from "../agent/subagents.ts";
import type { RuntimeSettings } from "../config/settings.ts";
import type { MessageGatewayClient } from "../gateway/client.ts";
import type { GuildInternalClient } from "../guild/client.ts";
import type { IdentityDirectory } from "../identity/keycloak.ts";
import type { KnowledgeBase } from "../knowledge/files.ts";
import type { McpHub } from "../mcp/hub.ts";
import type { MediaProcessor } from "../media/processor.ts";
import type { Store } from "../store/index.ts";
import type { ChatKey, MemoryScope, ScheduleSpec } from "../types.ts";
import { parseChatKey } from "../types.ts";

export function buildMainTools(options: {
  chatKey: ChatKey;
  senderQQ: string | null;
  actorSubject: string | null;
  actorName: string | null;
  actorIsAdmin: boolean;
  triggerMessageId: number | null;
  settings: RuntimeSettings;
  store: Store;
  gateway: MessageGatewayClient;
  media: MediaProcessor;
  knowledge: KnowledgeBase;
  directory: IdentityDirectory;
  guild: GuildInternalClient;
  mcp: McpHub;
  ids: ModelIds;
}): AgentTool[] {
  const {
    chatKey,
    senderQQ,
    actorSubject,
    actorName,
    actorIsAdmin,
    triggerMessageId,
    settings,
    store,
    gateway,
    media,
    knowledge,
    directory,
    guild,
    mcp,
    ids,
  } = options;
  const parsedChat = parseChatKey(chatKey);

  return [
    {
      name: "delegate_subagent",
      description:
        "委派隔离的零历史任务子代理完成检索或执行操作，只返回精炼结论，避免污染全局主上下文。kind 可选：chat_analyst（查各群聊/本人私聊记录、媒体识图转写、QQ 通讯录）、guild_operator（查询或代理创建/更新公会节点、发布评论、解析成员身份）、workspace_operator（检索知识库、读写记事本与调用外部 MCP 工具）。",
      parameters: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            enum: ["chat_analyst", "guild_operator", "workspace_operator"],
          },
          task: {
            type: "string",
            minLength: 1,
          },
        },
        required: ["kind", "task"],
        additionalProperties: false,
      },
      execute: (args) =>
        runSubagent({
          kind: args.kind as SubagentKind,
          task: String(args.task ?? ""),
          chatKey,
          senderQQ,
          actorSubject,
          actorName,
          actorIsAdmin,
          settings,
          store,
          gateway,
          media,
          knowledge,
          directory,
          guild,
          mcp,
          ids,
        }),
    },
    {
      name: "memory_manage",
      description:
        "读取、保存或删除长期记忆。scope 可选 global（全局共识/设定）、chat（指定或当前会话记忆）、user（特定成员偏好）。",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["read", "upsert", "delete"] },
          scope: { type: "string", enum: ["global", "chat", "user"] },
          targetRef: { type: "string" },
          userRef: { type: "string" },
          key: { type: "string" },
          summary: { type: "string" },
          content: { type: "string" },
        },
        required: ["action", "scope", "key"],
        additionalProperties: false,
      },
      execute: async (args) => {
        const scope = args.scope as MemoryScope;
        let ownerId = "global";

        if (scope === "chat") {
          ownerId = args.targetRef
            ? ids.resolveTargetChatKey(String(args.targetRef))
            : chatKey;
        } else if (scope === "user") {
          ownerId = args.userRef
            ? ids.resolveUser(String(args.userRef))
            : (senderQQ ?? "");
        }

        if (!ownerId) {
          throw new Error("缺少有效的归属引用");
        }

        const key = String(args.key ?? "").trim();

        if (!key) {
          throw new Error("key 不能为空");
        }

        if (args.action === "read") {
          return {
            mutated: false,
            memory: await store.memories.get(scope, ownerId, key),
          };
        }

        if (args.action === "delete") {
          return {
            mutated: true,
            deleted: await store.memories.remove(scope, ownerId, key),
          };
        }

        return {
          mutated: true,
          memory: await store.memories.upsert({
            scope,
            ownerId,
            key,
            summary: String(args.summary ?? "").slice(0, 200),
            content: String(args.content ?? ""),
            sourceMessageId: triggerMessageId,
          }),
        };
      },
    },
    {
      name: "schedule_manage",
      description:
        "列出、创建、更新或删除持久化定时任务（once/interval/daily/weekly/monthly/yearly）。可用 targetRef 指定投递群或私聊。",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["list", "create", "update", "delete"],
          },
          id: { type: "string" },
          title: { type: "string" },
          content: { type: "string" },
          schedule: { type: "object" },
          enabled: { type: "boolean" },
          targetRef: { type: "string" },
          targetCurrentChat: { type: "boolean" },
        },
        required: ["action"],
        additionalProperties: false,
      },
      execute: async (args) => {
        switch (args.action) {
          case "list": {
            return { mutated: false, tasks: await store.schedules.list() };
          }

          case "create": {
            let kind: "group" | "private" | "" = "";
            let chatId = "";

            if (typeof args.targetRef === "string" && args.targetRef.trim()) {
              const resolved = parseChatKey(
                ids.resolveTargetChatKey(args.targetRef),
              );

              kind = resolved.kind;
              chatId = resolved.chatId;
            } else if (args.targetCurrentChat !== false) {
              kind = parsedChat.kind;
              chatId = parsedChat.chatId;
            }

            const task = await store.schedules.create(
              {
                title: String(args.title ?? ""),
                content: String(args.content ?? ""),
                schedule: args.schedule as ScheduleSpec,
                kind,
                chatId,
              },
              settings.bot.timezone,
            );

            return { mutated: true, task };
          }

          case "update": {
            const task = await store.schedules.update(
              String(args.id ?? ""),
              {
                ...(args.title === undefined
                  ? {}
                  : { title: String(args.title) }),
                ...(args.content === undefined
                  ? {}
                  : { content: String(args.content) }),
                ...(args.schedule === undefined
                  ? {}
                  : { schedule: args.schedule as ScheduleSpec }),
                ...(typeof args.enabled === "boolean"
                  ? { enabled: args.enabled }
                  : {}),
              },
              settings.bot.timezone,
            );

            return { mutated: task !== null, updated: task !== null, task };
          }

          case "delete": {
            const deleted = await store.schedules.remove(String(args.id ?? ""));

            return { mutated: deleted, deleted };
          }

          default: {
            throw new Error(
              `Unsupported schedule action: ${String(args.action)}`,
            );
          }
        }
      },
    },
  ];
}
