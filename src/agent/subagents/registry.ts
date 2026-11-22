import { randomUUID } from "node:crypto";

import { Type } from "typebox";

import { resolveThinkingEffort } from "../../config/settings.ts";
import { resolveAccessRole } from "../../identity/permissions.ts";
import { defineTool, defineToolProvider } from "../../tools/define.ts";
import { resolveTools } from "../../tools/registry.ts";
import type {
  AgentServices,
  ToolContext,
  ToolProvider,
} from "../../tools/types.ts";
import type { JobPayloads } from "../../types.ts";
import { parseChatKey } from "../../utils/chat-key.ts";
import { Logger } from "../../utils/logger.ts";
import { errorMessage } from "../../utils/time.ts";
import { runChatToolLoop } from "../loop.ts";
import { ModelIds } from "../model-ids.ts";
import type { SubagentDefinition, SubagentResult } from "./types.ts";

const subagentOutputSchema = Type.Object(
  {
    brief: Type.String({ minLength: 1, maxLength: 16_000 }),
    references: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: false },
);

const DEFAULT_SUBAGENT_MAX_ROUNDS = 10;
const DEFAULT_SUBAGENT_MAX_DURATION_MS = 60_000;

export const ASYNC_SUBAGENT_MAX_DURATION_MS = 180_000;

const MAX_FORK_HISTORY_MESSAGES = 30;
const SUBAGENT_OUTPUT_SUFFIX =
  '完成检索或操作后，最终只输出一个 JSON 对象：{"brief":"准确清晰的结论（完整覆盖关键事实即可，避免照搬大段原始日志）","references":["可选引用来源、节点URL或m_*句柄"]}';

export class SubagentRegistry {
  #definitions = new Map<string, SubagentDefinition>();
  #logger = new Logger("subagent");

  public register(...definitions: SubagentDefinition[]): this {
    for (const def of definitions) {
      const kind = def.kind.trim();

      if (!kind) {
        throw new Error("Subagent kind must be non-empty");
      }

      if (this.#definitions.has(kind)) {
        throw new Error(`Duplicate subagent registration: ${kind}`);
      }

      this.#definitions.set(kind, def);
    }

    return this;
  }

  public get(kind: string): SubagentDefinition | undefined {
    return this.#definitions.get(kind);
  }

  public list(): SubagentDefinition[] {
    return [...this.#definitions.values()];
  }

  public async run(
    kind: string,
    task: string,
    ctx: ToolContext,
    options?: { fork?: boolean; maxDurationMs?: number },
  ): Promise<SubagentResult> {
    const resolved = this.#resolveAvailable(kind, ctx);

    if ("blocked" in resolved) {
      return resolved.blocked;
    }

    const { def } = resolved;
    const settings = ctx.services.getSettings();
    const tools = resolveTools(def.tools, ctx);
    const rolePrompt =
      typeof def.systemPrompt === "function"
        ? def.systemPrompt(ctx)
        : def.systemPrompt;
    const thinkingEffort = resolveThinkingEffort(
      settings,
      `subagent:${def.kind}`,
      def.thinkingEffort,
    );
    const forkedHistory =
      options?.fork && ctx.getForkHistory
        ? trimForkHistory(ctx.getForkHistory(), MAX_FORK_HISTORY_MESSAGES)
        : [];
    const forked = forkedHistory.length > 0;

    const result = await runChatToolLoop({
      purpose: `subagent:${def.kind}`,
      chatKey: ctx.actor.chatKey,
      jobId: ctx.trace?.jobId ?? null,
      messageIds: ctx.trace?.messageIds,
      settings,
      store: ctx.services.store,
      systemPrompt: `${rolePrompt}\n${SUBAGENT_OUTPUT_SUFFIX}`,
      history: forkedHistory,
      userContent: JSON.stringify(
        forked ? { task, forkedFromMain: true } : { task },
      ),
      tools,
      maxRounds: def.maxRounds ?? DEFAULT_SUBAGENT_MAX_ROUNDS,
      maxDurationMs:
        options?.maxDurationMs ??
        def.maxDurationMs ??
        DEFAULT_SUBAGENT_MAX_DURATION_MS,
      outputSchema: subagentOutputSchema,
      thinkingEffort,
    });

    const sidecarId = `sc_${randomUUID().slice(0, 8)}`;

    await ctx.services.store.conversations.appendSidecar(
      sidecarId,
      {
        chatKey: ctx.actor.chatKey,
        kind: def.kind,
        task,
        forked,
      },
      result.turnMessages,
    );

    return {
      brief: result.structured.brief,
      references: result.structured.references ?? [],
      mutated: result.mutated,
      sidecarId,
    };
  }

  public async runBackground(
    services: AgentServices,
    payload: JobPayloads["subagent_task"],
    options?: { jobId?: number | null },
  ): Promise<void> {
    const { store, directory } = services;
    const settings = services.getSettings();
    const [allChats, recentSenders, identityUser] = await Promise.all([
      store.chats.list(),
      store.messages.recentSenderIds(500),
      payload.senderId
        ? directory.byQQ(payload.senderId).catch(() => null)
        : Promise.resolve(null),
    ]);
    const ids = new ModelIds().seedChats(allChats).seedUsers(recentSenders);
    const role = resolveAccessRole({
      userId: payload.senderId,
      adminQQs: settings.policy.adminQQs,
      permissions: identityUser?.permissions,
    });
    const toolContext: ToolContext = {
      services,
      actor: {
        chatKey: payload.chatKey,
        senderQQ: payload.senderId,
        actorSubject: identityUser?.subject ?? null,
        actorName: identityUser?.name ?? payload.senderName,
        role,
        triggerMessageId: payload.triggerMessageId,
      },
      ids,
      ...(payload.forkHistory?.length
        ? { getForkHistory: () => payload.forkHistory! }
        : {}),
      trace: {
        jobId: options?.jobId ?? null,
        messageIds: payload.triggerMessageId ? [payload.triggerMessageId] : [],
      },
    };

    let resultEnvelope: Record<string, unknown>;

    try {
      const result = await this.run(payload.kind, payload.task, toolContext, {
        fork: payload.fork,
        maxDurationMs: ASYNC_SUBAGENT_MAX_DURATION_MS,
      });

      resultEnvelope = {
        ok: true,
        kind: payload.kind,
        task: payload.task,
        brief: result.brief,
        references: result.references,
        ...(result.sidecarId ? { sidecarId: result.sidecarId } : {}),
      };
    } catch (error) {
      const message = errorMessage(error);

      this.#logger.warn("Background subagent failed", {
        kind: payload.kind,
        chatKey: payload.chatKey,
        error: message,
      });
      resultEnvelope = {
        ok: false,
        kind: payload.kind,
        task: payload.task,
        error: message,
      };
    }

    await store.jobs.coalesceInvoke({
      source: "subagent_result",
      chatKey: payload.chatKey,
      kind: payload.chatKind,
      chatId: payload.chatId,
      triggerMessageIds: payload.triggerMessageId
        ? [payload.triggerMessageId]
        : [],
      senderId: payload.senderId ?? undefined,
      senderName: payload.senderName ?? undefined,
      content: `后台子代理 ${payload.kind} 已执行完毕，请结合以下结果直接回复原发言人（不要重复派发同一任务）：\n${JSON.stringify(resultEnvelope)}`,
    });
    services.wakeWorker?.();
  }

  public describeCapabilities(services: AgentServices): string[] {
    const defs = this.#availableDefs(services);

    if (defs.length === 0) {
      return [];
    }

    return [
      "- delegate_subagent(kind, task, fork?, background?): 委派子代理执行多步检索或外部操作并返回 brief + sidecarId（传 fork=true 可从主上下文当前视图直接派生；预计耗时较长的重度检索/跨多群或大跨度历史分析可传 background=true 放到后台异步执行，主对话先简短告知对方稍等并立刻释放通道，后台完成后自动回传结论）：",
      ...defs.map(
        (def) => `  * ${def.kind}: ${def.describeCapability(services)}`,
      ),
    ];
  }

  public asDelegateToolProvider(): ToolProvider {
    return defineToolProvider({
      id: "delegate_subagent",
      describe: (services) => this.describeCapabilities(services),
      resolve: (ctx) => {
        const defs = this.#availableDefs(ctx.services);

        if (defs.length === 0) {
          return [];
        }

        const kindSummary = defs
          .map((def) => `${def.kind}（${def.summary}）`)
          .join("、");

        const delegateTool = defineTool({
          name: "delegate_subagent",
          description: `委派任务子代理完成多步检索或外部操作，执行轨迹存入独立 Sidecar Tape，只把精炼结论及 sidecarId 返回主上下文。当任务依赖主对话已有上下文时可传 fork=true；预计耗时较长的深度历史检索或大批量分析可传 background=true 转后台异步执行，主线先回复“我去查一下”后不阻塞当前会话，完成后自动回传结果。kind 可选：${kindSummary}。`,
          parameters: Type.Object(
            {
              kind: Type.String({ enum: defs.map((def) => def.kind) }),
              task: Type.String({ minLength: 1 }),
              fork: Type.Optional(Type.Boolean()),
              background: Type.Optional(Type.Boolean()),
            },
            { additionalProperties: false },
          ),
          execute: async (args, runCtx) => {
            if (!args.background) {
              return this.run(args.kind, args.task, runCtx, {
                fork: args.fork,
              });
            }

            const resolved = this.#resolveAvailable(args.kind, runCtx);

            if ("blocked" in resolved) {
              return resolved.blocked;
            }

            const { def } = resolved;
            const parsed = parseChatKey(runCtx.actor.chatKey);
            const forkHistory =
              args.fork && runCtx.getForkHistory
                ? trimForkHistory(
                    runCtx.getForkHistory(),
                    MAX_FORK_HISTORY_MESSAGES,
                  )
                : undefined;

            await runCtx.services.store.jobs.enqueue(
              "subagent_task",
              `subagent:${def.kind}:${runCtx.actor.chatKey}:${Date.now()}:${randomUUID().slice(0, 6)}`,
              runCtx.actor.chatKey,
              {
                kind: def.kind,
                task: args.task,
                chatKey: runCtx.actor.chatKey,
                chatKind: parsed.kind,
                chatId: parsed.chatId,
                senderId: runCtx.actor.senderQQ,
                senderName: runCtx.actor.actorName,
                triggerMessageId: runCtx.actor.triggerMessageId ?? null,
                fork: Boolean(args.fork),
                ...(forkHistory?.length ? { forkHistory } : {}),
              },
            );
            runCtx.services.wakeWorker?.();

            return {
              queued: true,
              background: true,
              kind: def.kind,
              brief:
                "已在后台启动该子代理任务，完成后会自动把结论回传给你。请先用一句简短自然的话告诉对方正在查询/整理，随后结束本轮回复以释放对话通道。",
              references: [],
              mutated: false,
            };
          },
        });

        return [delegateTool.bind(ctx)];
      },
    });
  }

  #resolveAvailable(
    kind: string,
    ctx: ToolContext,
  ): { def: SubagentDefinition } | { blocked: SubagentResult } {
    const def = this.#definitions.get(kind);

    if (!def) {
      throw new Error(`Unknown subagent kind: ${kind}`);
    }

    if (def.available && !def.available(ctx.services)) {
      return {
        blocked: {
          brief: `${def.title}当前未启用或未配置。`,
          references: [],
          mutated: false,
        },
      };
    }

    const blockedBrief = def.checkAvailability?.(ctx);

    if (blockedBrief) {
      return {
        blocked: {
          brief: blockedBrief,
          references: [],
          mutated: false,
        },
      };
    }

    return { def };
  }

  #availableDefs(services: AgentServices): SubagentDefinition[] {
    return this.list().filter(
      (def) => !def.available || def.available(services),
    );
  }
}

function trimForkHistory<T extends { role: string }>(
  history: T[],
  maxMessages: number,
): T[] {
  if (history.length <= maxMessages) {
    return history;
  }

  let start = history.length - maxMessages;

  // Never start a forked slice on a dangling `tool` or `assistant` turn; advance to the next `user` turn.
  while (start < history.length && history[start]!.role !== "user") {
    start++;
  }

  return start < history.length ? history.slice(start) : [];
}
