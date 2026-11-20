import type {
  AgentServices,
  ToolContext,
  ToolSource,
} from "../../tools/types.ts";

export interface SubagentResult {
  brief: string;
  references: string[];
  mutated: boolean;
}

export interface SubagentDefinition {
  /**
   * Unique subagent identifier (used in delegate_subagent.kind and llm_usage
   * purpose `subagent:<kind>`).
   */
  readonly kind: string;
  /**
   * Short display label for logs or UI.
   */
  readonly title: string;
  /**
   * Short one-line summary used in the delegate_subagent tool description.
   */
  readonly summary: string;
  /**
   * Capability bullet rendered into the main agent's <capabilities> prompt.
   */
  readonly describeCapability: (services: AgentServices) => string;
  /**
   * Isolated subagent role instructions.
   */
  readonly systemPrompt: string | ((ctx: ToolContext) => string);
  /**
   * Static or dynamic tool sources available inside this subagent.
   */
  readonly tools: readonly ToolSource[];
  /**
   * Maximum tool-calling rounds for this subagent (defaults to 8).
   */
  readonly maxRounds?: number;
  /**
   * Optional precondition check before invoking the LLM loop. Return a
   * non-empty string to short-circuit with that brief.
   */
  readonly checkAvailability?: (ctx: ToolContext) => string | null;
}
