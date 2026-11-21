import type {
  AgentServices,
  ToolContext,
  ToolEntry,
} from "../../tools/types.ts";
import type { ThinkingEffort } from "../loop.ts";

export interface SubagentResult {
  brief: string;
  references: string[];
  mutated: boolean;
  sidecarId?: string;
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
   * Tools and providers available inside this subagent.
   */
  readonly tools: readonly ToolEntry[];
  /**
   * Maximum tool-calling rounds for this subagent (defaults to 32).
   */
  readonly maxRounds?: number;
  /**
   * Optional thinking effort override for this subagent. Defaults to "low" when
   * mainModel.thinkingEffort is enabled, otherwise "none".
   */
  readonly thinkingEffort?: ThinkingEffort;
  /**
   * Optional service-level availability check. When false, the subagent is
   * omitted from <capabilities> and delegate_subagent.kind.
   */
  readonly available?: (services: AgentServices) => boolean;
  /**
   * Optional per-request precondition check before invoking the LLM loop.
   * Return a non-empty string to short-circuit with that brief.
   */
  readonly checkAvailability?: (ctx: ToolContext) => string | null;
}
