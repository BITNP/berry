import type { BerryAgent } from "../agent/runner.ts";
import type { MessageGate } from "../gate/gate.ts";
import type { GuildAutomationRunner } from "../guild/automation.ts";
import type { ScheduleRunner } from "../scheduler/runner.ts";
import type { GuildTaskKind, JobActionLink } from "../types.ts";
import { JobRegistry, defaultChatLinks } from "./registry.ts";

export type {
  DescribedJobMeta,
  JobDefinition,
  JobSummaryContext,
} from "./registry.ts";
export { JobRegistry, defaultChatLinks } from "./registry.ts";

const GUILD_TASK_LABELS: Record<GuildTaskKind, string> = {
  due: "公会到期提醒",
  assignments: "公会新指派通知",
  weekly: "生成公会周报",
};

export const createDefaultJobRegistry = (deps: {
  gate: MessageGate;
  agent: BerryAgent;
  scheduler: ScheduleRunner;
  guildAutomation: GuildAutomationRunner;
}): JobRegistry =>
  new JobRegistry()
    .register({
      kind: "gate_batch",
      label: "消息分流",
      lane: "gate",
      tagType: "default",
      execute: (job) => deps.gate.processBatch(job),
      referencedMessageIds: (payload) => payload.messageIds ?? [],
      summarize: (job, { messagesById }) => {
        const ids = job.payload.messageIds ?? [];
        const first = ids.length > 0 ? messagesById.get(ids[0]!) : undefined;

        if (!first) {
          return `${ids.length} 条候选消息`;
        }

        const head = `${first.senderName}: ${first.text.slice(0, 80)}`;

        return ids.length > 1 ? `${head}（共 ${ids.length} 条）` : head;
      },
    })
    .register({
      kind: "invoke",
      label: "对话应答",
      lane: "dialog",
      tagType: "primary",
      execute: async (job) => {
        await deps.agent.invoke(job.payload);
      },
      referencedMessageIds: (payload) => payload.triggerMessageIds ?? [],
      summarize: (job, { messagesById }) => {
        const p = job.payload;

        if (p.content) {
          const prefix = p.source === "schedule" ? "定时任务: " : "指令: ";

          return `${prefix}${p.content.slice(0, 90)}`;
        }

        const ids = p.triggerMessageIds ?? [];
        const first = ids.length > 0 ? messagesById.get(ids[0]!) : undefined;

        if (first) {
          const head = `${first.senderName}: ${first.text.slice(0, 80)}`;

          return ids.length > 1 ? `${head}（共 ${ids.length} 条）` : head;
        }

        return p.senderName ? `${p.senderName} 触发` : (p.source ?? "对话应答");
      },
    })
    .register({
      kind: "memory_update",
      label: "记忆提炼",
      lane: "background",
      tagType: "success",
      execute: (job) =>
        deps.agent.updateMemoryFromMessage(
          job.payload.chatKey,
          job.payload.messageId,
        ),
      referencedMessageIds: (payload) =>
        typeof payload.messageId === "number" ? [payload.messageId] : [],
      summarize: (job, { messagesById }) => {
        const id = job.payload.messageId;
        const msg = typeof id === "number" ? messagesById.get(id) : undefined;

        return msg
          ? `${msg.senderName}: ${msg.text.slice(0, 80)}`
          : `消息 #${String(id ?? "")}`;
      },
      links: (job) => [
        ...defaultChatLinks(job.chatKey),
        { label: "查看长期记忆", to: "/memories" },
      ],
    })
    .register({
      kind: "group_digest",
      label: "群聊摘要",
      lane: "background",
      tagType: "info",
      execute: (job) => deps.scheduler.runGroupDigest(job),
      summarize: (job) => {
        const { startTimeMs, endTimeMs } = job.payload;

        if (startTimeMs && endTimeMs) {
          const hours = Math.max(
            1,
            Math.round((endTimeMs - startTimeMs) / 3_600_000),
          );

          return `近 ${hours} 小时群聊摘要`;
        }

        return "群聊讨论摘要";
      },
      links: (job) => [
        { label: "查看摘要笔记", to: "/docs?tab=notebooks" },
        ...defaultChatLinks(job.chatKey),
      ],
    })
    .register({
      kind: "guild_task",
      label: "公会任务",
      lane: "background",
      tagType: "warning",
      execute: async (job) => {
        const { task } = job.payload;

        if (task === "due") {
          await deps.guildAutomation.runDueReminders();
        } else if (task === "assignments") {
          await deps.guildAutomation.runAssignments();
        } else {
          await deps.guildAutomation.runWeeklyReport();
        }
      },
      summarize: (job) =>
        GUILD_TASK_LABELS[job.payload.task] ?? job.payload.task,
      links: (job): JobActionLink[] => {
        const items: JobActionLink[] = [
          { label: "前往公会联动", to: "/guild" },
        ];

        if (job.payload.task === "weekly") {
          items.push(
            { label: "查看周报笔记", to: "/docs?tab=notebooks" },
            { label: "查看周报 AI 调用", to: "/ai?purpose=report" },
          );
        }

        return items;
      },
    });
