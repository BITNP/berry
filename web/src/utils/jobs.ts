import type { RouteLocationRaw } from "vue-router";

import { routes } from "./routes.ts";

export type JobLane = "gate" | "dialog" | "background";

export type JobTagType =
  "default" | "primary" | "info" | "success" | "warning" | "error";

export interface JobActionLink {
  label: string;
  to: RouteLocationRaw;
}

const JOB_TAG_BY_KIND: Record<string, JobTagType> = {
  gate_batch: "default",
  invoke: "primary",
  subagent_task: "info",
  memory_update: "success",
  group_digest: "info",
  guild_task: "warning",
};

export function jobTagType(kind: string, lane?: JobLane): JobTagType {
  const exact = JOB_TAG_BY_KIND[kind];

  if (exact) {
    return exact;
  }

  if (lane === "dialog") {
    return "primary";
  }

  if (lane === "gate") {
    return "default";
  }

  return "info";
}

const isRealChatKey = (chatKey: string): boolean =>
  chatKey.startsWith("group:") || chatKey.startsWith("private:");

function defaultChatLinks(chatKey: string): JobActionLink[] {
  if (!isRealChatKey(chatKey)) {
    return [];
  }

  return [
    { label: "查看该会话 AI 调用", to: routes.aiCalls({ chatKey }) },
    { label: "查看会话消息", to: routes.chat(chatKey) },
  ];
}

export function jobActionLinks(job: {
  kind: string;
  chatKey: string;
  payload: Record<string, unknown>;
}): JobActionLink[] {
  switch (job.kind) {
    case "gate_batch": {
      if (!isRealChatKey(job.chatKey)) {
        return [];
      }

      return [
        {
          label: "查看分流记录",
          to: routes.aiCalls({ tab: "gate", chatKey: job.chatKey }),
        },
        { label: "查看会话记录", to: routes.chat(job.chatKey) },
      ];
    }

    case "memory_update": {
      return [
        ...defaultChatLinks(job.chatKey),
        { label: "查看长期记忆", to: routes.memories() },
      ];
    }

    case "group_digest": {
      return [
        { label: "群聊摘要设置", to: routes.settings("digest") },
        ...defaultChatLinks(job.chatKey),
      ];
    }

    case "guild_task": {
      const items: JobActionLink[] = [
        { label: "公会联动设置", to: routes.settings("guild") },
      ];

      if (job.payload.task === "weekly") {
        items.push({
          label: "查看周报 AI 调用",
          to: routes.aiCalls({ purpose: "report" }),
        });
      }

      return items;
    }

    default: {
      return defaultChatLinks(job.chatKey);
    }
  }
}
