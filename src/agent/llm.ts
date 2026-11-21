import { jsonrepair } from "jsonrepair";
import OpenAI from "openai";
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";
import type { Static, TSchema } from "typebox";
import * as Value from "typebox/value";

import type { Store } from "../store/index.ts";
import type { LlmToolCallSummary } from "../types.ts";
import { errorMessage } from "../utils/time.ts";
import type { CacheCheckHandle } from "./cache-guard.ts";

function summarizeMessageContent(
  content: ChatCompletionMessageParam["content"],
): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) => {
      if (part.type === "text") {
        return part.text;
      }

      if (part.type === "image_url") {
        return "[image]";
      }

      return `[${part.type}]`;
    })
    .join("\n");
}

function buildRequestPreview(
  messages: ChatCompletionMessageParam[],
): string | null {
  if (messages.length === 0) {
    return null;
  }

  const nonSystem = messages.filter((m) => m.role !== "system");
  const tail = nonSystem.slice(-6);
  const chunks: string[] = [];

  if (nonSystem.length > tail.length) {
    chunks.push(`…（前略 ${nonSystem.length - tail.length} 条上下文）`);
  }

  for (const msg of tail) {
    const header =
      msg.role === "tool" ? `[tool:${msg.tool_call_id}]` : `[${msg.role}]`;
    const body = summarizeMessageContent(msg.content);
    const calls =
      msg.role === "assistant" && msg.tool_calls?.length
        ? msg.tool_calls
            .map((c) =>
              c.type === "function"
                ? `call ${c.function.name}(${c.function.arguments.slice(0, 400)})`
                : `[${c.type}]`,
            )
            .join("\n")
        : "";
    const text = [body, calls].filter(Boolean).join("\n");

    chunks.push(`${header}\n${text.slice(0, 3000)}`);
  }

  return chunks.join("\n\n").slice(0, 12_000);
}

export function parseModelJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return JSON.parse(jsonrepair(raw));
  }
}

export function validateModelJson<S extends TSchema>(
  schema: S,
  raw: string,
): { ok: true; value: Static<S> } | { ok: false; issue: string } {
  let parsed: unknown;

  try {
    parsed = parseModelJson(raw);
  } catch (error) {
    return {
      ok: false,
      issue: `JSON 解析失败: ${errorMessage(error)}`,
    };
  }

  if (!Value.Check(schema, parsed)) {
    const errs = [...Value.Errors(schema, parsed)]
      .map((err) => `${err.instancePath || "/"} ${err.message}`)
      .join("; ");

    return { ok: false, issue: errs || "Schema validation failed" };
  }

  return { ok: true, value: parsed };
}

export async function completeChat(options: {
  apiKey: string;
  baseURL: string;
  model: string;
  timeoutMs: number;
  maxRetries?: number;
  store: Store;
  timeZone: string;
  purpose: string;
  chatKey?: string | null;
  cacheCheck?: CacheCheckHandle | null;
  params: Omit<ChatCompletionCreateParamsNonStreaming, "model" | "stream">;
}): Promise<ChatCompletion> {
  const started = performance.now();
  const requestPreview = buildRequestPreview(options.params.messages);
  const client = new OpenAI({
    apiKey: options.apiKey,
    baseURL: options.baseURL,
    timeout: options.timeoutMs,
    maxRetries: options.maxRetries ?? 1,
  });

  try {
    const completion = await client.chat.completions.create({
      model: options.model,
      ...options.params,
    } as ChatCompletionCreateParamsNonStreaming);

    const usage = completion.usage;
    const message = completion.choices[0]?.message;
    const toolCalls: LlmToolCallSummary[] = (message?.tool_calls ?? [])
      .filter((call) => call.type === "function")
      .map((call) => ({
        name: call.function.name,
        arguments: call.function.arguments.slice(0, 4000),
      }));
    const inputTokens = usage?.prompt_tokens ?? 0;
    const cachedInputTokens = usage?.prompt_tokens_details?.cached_tokens ?? 0;
    const cacheWarning =
      options.cacheCheck?.commit({
        inputTokens,
        cachedInputTokens,
      }) ?? null;

    await options.store.usage.record({
      purpose: options.purpose,
      model: options.model,
      chatKey: options.chatKey ?? null,
      status: "ok",
      inputTokens,
      cachedInputTokens,
      outputTokens: usage?.completion_tokens ?? 0,
      durationMs: Math.round(performance.now() - started),
      requestPreview,
      responseText: message?.content ?? null,
      toolCalls,
      cacheWarning,
      timeZone: options.timeZone,
    });

    return completion;
  } catch (error) {
    await options.store.usage
      .record({
        purpose: options.purpose,
        model: options.model,
        chatKey: options.chatKey ?? null,
        status: "error",
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        durationMs: Math.round(performance.now() - started),
        requestPreview,
        error: errorMessage(error),
        timeZone: options.timeZone,
      })
      .catch(() => undefined);

    throw error;
  }
}
