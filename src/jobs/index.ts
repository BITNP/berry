import type { BerryAgent } from "../agent/runner.ts";
import type { MessageGate } from "../gate/gate.ts";
import type { GuildAutomationRunner } from "../guild/automation.ts";
import type { ScheduleRunner } from "../scheduler/runner.ts";
import type { GuildTaskKind } from "../types.ts";
import { JobRegistry } from "./registry.ts";

export { JobRegistry } from "./registry.ts";

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
      execute: (job) => deps.gate.processBatch(job),
      referencedMessageIds: (payload) => payload.messageIds,
      summarize: (job, { messagesById }) => {
        const ids = job.payload.messageIds;
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
      execute: async (job) => {
        await deps.agent.invoke(job.payload, { jobId: job.id });
      },
      referencedMessageIds: (payload) => payload.triggerMessageIds,
      summarize: (job, { messagesById }) => {
        const p = job.payload;

        if (p.content) {
          const prefix =
            p.source === "schedule"
              ? "定时任务: "
              : p.source === "subagent_result"
                ? "子代理回传: "
                : "指令: ";

          return `${prefix}${p.content.slice(0, 90)}`;
        }

        const ids = p.triggerMessageIds;
        const first = ids.length > 0 ? messagesById.get(ids[0]!) : undefined;

        if (first) {
          const head = `${first.senderName}: ${first.text.slice(0, 80)}`;

          return ids.length > 1 ? `${head}（共 ${ids.length} 条）` : head;
        }

        return p.senderName ? `${p.senderName} 触发` : p.source;
      },
    })
    .register({
      kind: "memory_update",
      label: "记忆提炼",
      lane: "background",
      execute: (job) =>
        deps.agent.updateMemoryFromMessage(
          job.payload.chatKey,
          job.payload.messageId,
          { jobId: job.id },
        ),
      referencedMessageIds: (payload) => [payload.messageId],
      summarize: (job, { messagesById }) => {
        const id = job.payload.messageId;
        const msg = messagesById.get(id);

        return msg
          ? `${msg.senderName}: ${msg.text.slice(0, 80)}`
          : `消息 #${id}`;
      },
    })
    .register({
      kind: "group_digest",
      label: "群聊摘要",
      lane: "background",
      execute: (job) => deps.scheduler.runGroupDigest(job),
      summarize: (job) => {
        const { startTimeMs, endTimeMs } = job.payload;
        const hours = Math.max(
          1,
          Math.round((endTimeMs - startTimeMs) / 3_600_000),
        );

        return `近 ${hours} 小时群聊摘要`;
      },
    })
    .register({
      kind: "guild_task",
      label: "公会任务",
      lane: "background",
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
      summarize: (job) => GUILD_TASK_LABELS[job.payload.task],
    })
    .register({
      kind: "subagent_task",
      label: "后台子代理",
      lane: "background",
      execute: (job) =>
        deps.agent.runBackgroundSubagent(job.payload, { jobId: job.id }),
      referencedMessageIds: (payload) =>
        payload.triggerMessageId ? [payload.triggerMessageId] : [],
      summarize: (job) =>
        `${job.payload.kind}: ${job.payload.task.slice(0, 80)}`,
    })
    .register({
      kind: "style_distill",
      label: "群风提炼",
      lane: "background",
      execute: async (job) => {
        await deps.agent.distillChatStyle(job.payload.chatKey, {
          jobId: job.id,
        });
      },
      summarize: (job) => `提炼 ${job.payload.chatKey} 群表达风格`,
    });
