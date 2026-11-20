import { chatAnalystSubagent } from "./chat-analyst.ts";
import { guildOperatorSubagent } from "./guild-operator.ts";
import { SubagentRegistry } from "./registry.ts";
import { workspaceOperatorSubagent } from "./workspace-operator.ts";

export { chatAnalystSubagent } from "./chat-analyst.ts";
export { guildOperatorSubagent } from "./guild-operator.ts";
export { SubagentRegistry } from "./registry.ts";
export type { SubagentDefinition, SubagentResult } from "./types.ts";
export { workspaceOperatorSubagent } from "./workspace-operator.ts";

export const createDefaultSubagentRegistry = (): SubagentRegistry =>
  new SubagentRegistry().register(
    chatAnalystSubagent,
    guildOperatorSubagent,
    workspaceOperatorSubagent,
  );
