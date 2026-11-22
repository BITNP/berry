import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import type { Static, TSchema } from "typebox";

import type { RuntimeSettings, ThinkingEffort } from "../config/settings.ts";
import type { Store } from "../store/index.ts";
import type { LlmToolCallSummary, TurnMessage } from "../types.ts";
import { Logger } from "../utils/logger.ts";
import { errorMessage } from "../utils/time.ts";
import type { DialogCacheGuard } from "./cache-guard.ts";
import { completeChat, parseModelJson, validateModelJson } from "./llm.ts";

export type { ThinkingEffort };

export interface AgentTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  mutating?: boolean;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
}

export interface ToolLoopResult<T> {
  text: string;
  structured: T;
  turnMessages: TurnMessage[];
  mutated: boolean;
  lastPromptTokens: number;
}

export async function runChatToolLoop<S extends TSchema>(options: {
  purpose: string;
  chatKey: string | null;
  jobId?: number | null;
  messageIds?: number[];
  settings: RuntimeSettings;
  store: Store;
  systemPrompt: string;
  history: TurnMessage[];
  userContent: string;
  tools: AgentTool[];
  maxRounds: number;
  maxDurationMs?: number;
  outputSchema?: S;
  maxTokens?: number;
  temperature?: number;
  thinkingEffort?: ThinkingEffort;
  cacheGuard?: DialogCacheGuard;
  cacheSessionKey?: string;
  onBeforeToolBatch?: (completedHistory: TurnMessage[]) => void;
}): Promise<ToolLoopResult<Static<S>>> {
  const logger = new Logger(`llm:${options.purpose}`);
  const cfg = options.settings.mainModel;

  if (!cfg.apiKey || !cfg.model) {
    throw new Error("主模型未配置 API Key 或模型名称");
  }

  const toolMap = new Map(options.tools.map((tool) => [tool.name, tool]));
  const openAITools: ChatCompletionTool[] = options.tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: options.systemPrompt },
    ...options.history,
    { role: "user", content: options.userContent },
  ];

  const turnMessages: TurnMessage[] = [];
  let mutated = false;
  let corrections = 0;
  let prevLoggedLen = 0;
  let lastPromptTokens = 0;

  const thinkingEffort = options.thinkingEffort ?? "none";
  const startedAt = Date.now();
  let wrappedUp = false;

  for (let round = 0; round < options.maxRounds; round++) {
    const overTimeBudget =
      options.maxDurationMs !== undefined &&
      round > 0 &&
      Date.now() - startedAt >= options.maxDurationMs;
    const isFinalRound =
      (round === options.maxRounds - 1 || overTimeBudget) &&
      openAITools.length > 0;

    if (isFinalRound && round > 0 && !wrappedUp) {
      wrappedUp = true;
      messages.push({
        role: "user",
        content: overTimeBudget
          ? "已达到本次执行的时长预算，不再继续调用工具。请直接基于已获取的数据给出最终 JSON 答复。"
          : "已达到工具调用上限，不再继续调用工具。请直接基于已获取的数据给出最终 JSON 答复。",
      });
    }

    const deltaCount = messages.length - prevLoggedLen;

    logger.debug("LLM request delta", {
      chatKey: options.chatKey,
      round: round + 1,
      totalMessages: messages.length,
      deltaCount,
    });
    prevLoggedLen = messages.length;

    const toolsForRound =
      !isFinalRound && openAITools.length > 0 ? openAITools : undefined;
    const cacheCheck =
      options.cacheGuard && options.cacheSessionKey
        ? options.cacheGuard.inspect({
            purpose: options.purpose,
            sessionKey: options.cacheSessionKey,
            chatKey: options.chatKey,
            messages,
            tools: toolsForRound,
            transientUserIndex: options.history.length,
          })
        : null;

    let recordedCallId: number | null = null;
    const completion = await completeChat({
      apiKey: cfg.apiKey,
      baseURL: cfg.baseURL,
      model: cfg.model,
      timeoutMs: cfg.timeoutMs,
      maxRetries: 2,
      store: options.store,
      timeZone: options.settings.bot.timezone,
      purpose: options.purpose,
      chatKey: options.chatKey,
      jobId: options.jobId,
      messageIds: options.messageIds,
      cacheCheck,
      onRecorded: (callId) => {
        recordedCallId = callId;
      },
      params: {
        messages,
        temperature: options.temperature ?? cfg.temperature,
        max_tokens: options.maxTokens ?? cfg.maxOutputTokens,
        ...(toolsForRound ? { tools: toolsForRound } : {}),
        ...(thinkingEffort === "none"
          ? {}
          : { reasoning_effort: thinkingEffort }),
      },
    });

    const choice = completion.choices[0];

    if (typeof completion.usage?.prompt_tokens === "number") {
      lastPromptTokens = completion.usage.prompt_tokens;
    }

    if (!choice?.message) {
      throw new Error("模型未返回有效回复");
    }

    const assistantText = choice.message.content ?? "";
    const functionCalls = (choice.message.tool_calls ?? []).filter(
      (call) => call.type === "function",
    );

    if (functionCalls.length > 0) {
      // Snapshot completed main messages before appending the in-flight assistant tool_calls turn,
      // so any forked subagent gets valid OpenAI history without dangling unresolved tool calls.
      options.onBeforeToolBatch?.(messages.slice(1) as TurnMessage[]);

      const assistantTurn: TurnMessage = {
        role: "assistant",
        content: assistantText || null,
        tool_calls: functionCalls,
      };

      messages.push(assistantTurn);
      turnMessages.push(assistantTurn);

      const executedToolCalls: LlmToolCallSummary[] = [];

      for (const call of functionCalls) {
        const tool = toolMap.get(call.function.name);
        const toolStarted = performance.now();
        let toolOk = false;
        let resultPayload: unknown;

        if (tool) {
          try {
            const parsedArgs = parseToolArguments(call.function.arguments);
            const result = await tool.execute(parsedArgs);

            if (
              tool.mutating ||
              (result &&
                typeof result === "object" &&
                (result as { mutated?: unknown }).mutated === true)
            ) {
              mutated = true;
            }

            toolOk = true;
            resultPayload = { ok: true, result };
          } catch (error) {
            resultPayload = { ok: false, error: errorMessage(error) };
            logger.warn("Tool execution failed", {
              tool: call.function.name,
              error: errorMessage(error),
            });
          }
        } else {
          resultPayload = {
            ok: false,
            error: `Unknown tool: ${call.function.name}`,
          };
        }

        const resultText = JSON.stringify(resultPayload);
        const toolTurn: TurnMessage = {
          role: "tool",
          tool_call_id: call.id,
          content: resultText,
        };

        executedToolCalls.push({
          id: call.id,
          name: call.function.name,
          arguments: call.function.arguments,
          ok: toolOk,
          result: resultText,
          durationMs: Math.round(performance.now() - toolStarted),
        });
        messages.push(toolTurn);
        turnMessages.push(toolTurn);
      }

      if (recordedCallId !== null) {
        await options.store.usage
          .updateToolCalls(recordedCallId, executedToolCalls)
          .catch(() => undefined);
      }

      continue;
    }

    const validation = options.outputSchema
      ? validateModelJson(options.outputSchema, assistantText)
      : { ok: true as const, value: undefined as Static<S> };

    if (validation.ok) {
      turnMessages.push({ role: "assistant", content: assistantText });

      return {
        text: assistantText,
        structured: validation.value,
        turnMessages,
        mutated,
        lastPromptTokens,
      };
    }

    if (corrections >= 2) {
      throw new Error(`模型输出连续两次校验失败：${validation.issue}`);
    }

    corrections++;
    messages.push(
      { role: "assistant", content: assistantText },
      {
        role: "user",
        content: `上一次输出未通过格式校验（第 ${corrections}/2 次纠正）：${validation.issue}。请只输出符合协议的纯 JSON 对象，不要附加额外说明或代码围栏。`,
      },
    );
  }

  throw new Error(`工具调用轮次超过上限（${options.maxRounds}）`);
}

function parseToolArguments(raw: string): Record<string, unknown> {
  if (!raw.trim()) {
    return {};
  }

  const parsed = parseModelJson(raw);

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Tool arguments must be a JSON object");
  }

  return parsed as Record<string, unknown>;
}
