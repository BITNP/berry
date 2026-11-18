import { jsonrepair } from "jsonrepair";
import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

import type { RuntimeSettings } from "../config/settings.ts";
import type { Store } from "../store/index.ts";
import type { ToolCallRecord, TurnMessage } from "../types.ts";
import { Logger } from "../utils/logger.ts";
import { errorMessage } from "../utils/time.ts";

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
}

function toOpenAIMessage(msg: TurnMessage): ChatCompletionMessageParam {
  if (msg.role === "user") {
    return { role: "user", content: msg.content };
  }

  if (msg.role === "assistant") {
    return {
      role: "assistant",
      content: msg.content,
      ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}),
    };
  }

  return {
    role: "tool",
    tool_call_id: msg.tool_call_id,
    content: msg.content,
  };
}

export async function runChatToolLoop<T>(options: {
  purpose: "dialog" | "subagent" | "memory_update" | "compaction";
  chatKey: string | null;
  settings: RuntimeSettings;
  store: Store;
  systemPrompt: string;
  history: TurnMessage[];
  userContent: string;
  tools: AgentTool[];
  maxRounds: number;
  validateFinal: (
    text: string,
  ) => { ok: true; value: T } | { ok: false; issue: string };
  maxTokens?: number;
  temperature?: number;
}): Promise<ToolLoopResult<T>> {
  const logger = new Logger(`llm:${options.purpose}`);
  const cfg = options.settings.mainModel;

  if (!cfg.apiKey || !cfg.model) {
    throw new Error("主模型未配置 API Key 或模型名称");
  }

  const client = new OpenAI({
    apiKey: cfg.apiKey,
    baseURL: cfg.baseURL,
    timeout: cfg.timeoutMs,
    maxRetries: 2,
  });

  const toolMap = new Map(options.tools.map((tool) => [tool.name, tool]));
  const openAITools = options.tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));

  const userMsg: TurnMessage = {
    role: "user",
    content: options.userContent,
    timestamp: Date.now(),
  };
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: options.systemPrompt },
    ...options.history.map(toOpenAIMessage),
    toOpenAIMessage(userMsg),
  ];

  const turnMessages: TurnMessage[] = [];
  let mutated = false;
  let corrections = 0;
  let prevLoggedLen = 0;

  for (let round = 0; round < options.maxRounds; round++) {
    // Log only newly appended messages since the previous round.
    const delta = messages.slice(prevLoggedLen);

    logger.debug("LLM request delta", {
      chatKey: options.chatKey,
      round: round + 1,
      totalMessages: messages.length,
      deltaCount: delta.length,
    });
    prevLoggedLen = messages.length;

    const started = performance.now();
    const requestParams: Record<string, unknown> = {
      model: cfg.model,
      messages,
      temperature: options.temperature ?? cfg.temperature,
      max_tokens: options.maxTokens ?? cfg.maxOutputTokens,
      ...(openAITools.length > 0 ? { tools: openAITools } : {}),
      ...(cfg.thinkingEffort === "none"
        ? {}
        : { reasoning_effort: cfg.thinkingEffort }),
    };

    const response = await client.chat.completions.create(
      requestParams as unknown as Parameters<
        typeof client.chat.completions.create
      >[0],
    );

    const completion = response as OpenAI.Chat.Completions.ChatCompletion;
    const durationMs = Math.round(performance.now() - started);
    const usage = completion.usage;

    await options.store.usage.record({
      purpose: options.purpose,
      model: cfg.model,
      chatKey: options.chatKey,
      inputTokens: usage?.prompt_tokens ?? 0,
      cachedInputTokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
      outputTokens: usage?.completion_tokens ?? 0,
      durationMs,
      timeZone: options.settings.bot.timezone,
    });

    const choice = completion.choices[0];

    if (!choice?.message) {
      throw new Error("模型未返回有效回复");
    }

    const assistantText = choice.message.content ?? "";
    const rawToolCalls = choice.message.tool_calls ?? [];

    if (rawToolCalls.length > 0) {
      const normalizedCalls: ToolCallRecord[] = rawToolCalls
        .filter((call) => call.type === "function")
        .map((call) => ({
          id: call.id,
          type: "function" as const,
          function: {
            name: call.function.name,
            arguments: call.function.arguments || "{}",
          },
        }));

      const assistantTurn: TurnMessage = {
        role: "assistant",
        content: assistantText || null,
        tool_calls: normalizedCalls,
        timestamp: Date.now(),
      };

      messages.push(toOpenAIMessage(assistantTurn));
      turnMessages.push(assistantTurn);

      for (const call of normalizedCalls) {
        const tool = toolMap.get(call.function.name);
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

        const toolTurn: TurnMessage = {
          role: "tool",
          tool_call_id: call.id,
          name: call.function.name,
          content: JSON.stringify(resultPayload),
          timestamp: Date.now(),
        };

        messages.push(toOpenAIMessage(toolTurn));
        turnMessages.push(toolTurn);
      }

      continue;
    }

    const validation = options.validateFinal(assistantText);

    if (validation.ok) {
      const finalAssistant: TurnMessage = {
        role: "assistant",
        content: assistantText,
        timestamp: Date.now(),
      };

      turnMessages.push(finalAssistant);

      return {
        text: assistantText,
        structured: validation.value,
        turnMessages,
        mutated,
      };
    }

    if (corrections >= 2) {
      throw new Error(`模型输出连续两次校验失败：${validation.issue}`);
    }

    corrections++;
    const invalidAssistant: TurnMessage = {
      role: "assistant",
      content: assistantText,
      timestamp: Date.now(),
    };
    const retryPrompt: TurnMessage = {
      role: "user",
      content: `上一次输出未通过格式校验（第 ${corrections}/2 次纠正）：${validation.issue}。请只输出符合协议的纯 JSON 对象，不要附加额外说明或代码围栏。`,
      timestamp: Date.now(),
    };

    messages.push(
      toOpenAIMessage(invalidAssistant),
      toOpenAIMessage(retryPrompt),
    );
    turnMessages.push(invalidAssistant, retryPrompt);
  }

  throw new Error(`工具调用轮次超过上限（${options.maxRounds}）`);
}

function parseToolArguments(raw: string): Record<string, unknown> {
  if (!raw.trim()) {
    return {};
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = JSON.parse(jsonrepair(raw));
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Tool arguments must be a JSON object");
  }

  return parsed as Record<string, unknown>;
}
