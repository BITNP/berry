import { bunkoOperatorSubagent } from "./bunko-operator.ts";
import { chatAnalystSubagent } from "./chat-analyst.ts";
import { codeAnalystSubagent } from "./code-analyst.ts";
import { guildOperatorSubagent } from "./guild-operator.ts";
import { mcpOperatorSubagent } from "./mcp-operator.ts";
import { SubagentRegistry } from "./registry.ts";

export {
  ASYNC_SUBAGENT_MAX_DURATION_MS,
  SubagentRegistry,
} from "./registry.ts";
export type { SubagentDefinition, SubagentResult } from "./types.ts";

export const createDefaultSubagentRegistry = (): SubagentRegistry =>
  new SubagentRegistry().register(
    chatAnalystSubagent,
    codeAnalystSubagent,
    guildOperatorSubagent,
    bunkoOperatorSubagent,
    mcpOperatorSubagent,
  );
