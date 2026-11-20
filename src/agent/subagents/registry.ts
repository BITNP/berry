import { Type } from "typebox";

import type {
  AgentServices,
  DynamicToolSource,
  ToolContext,
} from "../../tools/types.ts";
import { defineTool, resolveTools } from "../../tools/types.ts";
import { runChatToolLoop } from "../loop.ts";
import type { SubagentDefinition, SubagentResult } from "./types.ts";

const subagentOutputSchema = Type.Object(
  {
    brief: Type.String({ minLength: 1, maxLength: 16_000 }),
    references: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: false },
);

const DEFAULT_SUBAGENT_MAX_ROUNDS = 32;
const SUBAGENT_OUTPUT_SUFFIX =
  '完成检索或操作后，最终只输出一个 JSON 对象：{"brief":"准确清晰的结论（完整覆盖关键事实即可，避免照搬大段原始日志）","references":["可选引用来源、节点URL或m_*句柄"]}';

export class SubagentRegistry {
  #definitions = new Map<string, SubagentDefinition>();

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
  ): Promise<SubagentResult> {
    const def = this.#definitions.get(kind);

    if (!def) {
      throw new Error(`Unknown subagent kind: ${kind}`);
    }

    const blockedBrief = def.checkAvailability?.(ctx);

    if (blockedBrief) {
      return {
        brief: blockedBrief,
        references: [],
        mutated: false,
      };
    }

    const settings = ctx.services.getSettings();
    const tools = resolveTools(def.tools, ctx);
    const rolePrompt =
      typeof def.systemPrompt === "function"
        ? def.systemPrompt(ctx)
        : def.systemPrompt;
    const thinkingEffort =
      def.thinkingEffort ??
      (settings.mainModel.thinkingEffort === "none" ? "none" : "low");

    const result = await runChatToolLoop({
      purpose: `subagent:${def.kind}`,
      chatKey: ctx.actor.chatKey,
      settings,
      store: ctx.services.store,
      systemPrompt: `${rolePrompt}\n${SUBAGENT_OUTPUT_SUFFIX}`,
      history: [],
      userContent: JSON.stringify({ task }),
      tools,
      maxRounds: def.maxRounds ?? DEFAULT_SUBAGENT_MAX_ROUNDS,
      outputSchema: subagentOutputSchema,
      thinkingEffort,
    });

    return {
      brief: result.structured.brief,
      references: result.structured.references ?? [],
      mutated: result.mutated,
    };
  }

  public describeCapabilities(services: AgentServices): string[] {
    const defs = this.list();

    if (defs.length === 0) {
      return [];
    }

    return [
      "- delegate_subagent(kind, task): 隔离执行具体任务并返回 brief：",
      ...defs.map(
        (def) => `  * ${def.kind}: ${def.describeCapability(services)}`,
      ),
    ];
  }

  public asDelegateToolSource(): DynamicToolSource {
    return {
      id: "delegate_subagent",
      describeCapability: (services) => this.describeCapabilities(services),
      resolve: (ctx) => {
        const defs = this.list();

        if (defs.length === 0) {
          return [];
        }

        const kindSummary = defs
          .map((def) => `${def.kind}（${def.summary}）`)
          .join("、");

        const delegateTool = defineTool({
          name: "delegate_subagent",
          description: `委派隔离的零历史任务子代理完成检索或执行操作，只返回精炼结论，避免污染全局主上下文。kind 可选：${kindSummary}。`,
          parameters: Type.Object(
            {
              kind: Type.String({ enum: defs.map((def) => def.kind) }),
              task: Type.String({ minLength: 1 }),
            },
            { additionalProperties: false },
          ),
          execute: (args, runCtx) => this.run(args.kind, args.task, runCtx),
        });

        return [delegateTool.bind(ctx)];
      },
    };
  }
}
