import { jsonrepair } from "jsonrepair";
import OpenAI from "openai";
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
} from "openai/resources/chat/completions";
import type { Static, TSchema } from "typebox";
import * as Value from "typebox/value";

import type { Store } from "../store/index.ts";
import { errorMessage } from "../utils/time.ts";

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
  params: Omit<ChatCompletionCreateParamsNonStreaming, "model" | "stream">;
}): Promise<ChatCompletion> {
  const started = performance.now();
  const client = new OpenAI({
    apiKey: options.apiKey,
    baseURL: options.baseURL,
    timeout: options.timeoutMs,
    maxRetries: options.maxRetries ?? 1,
  });

  const completion = await client.chat.completions.create({
    model: options.model,
    ...options.params,
  } as ChatCompletionCreateParamsNonStreaming);

  const usage = completion.usage;

  await options.store.usage.record({
    purpose: options.purpose,
    model: options.model,
    chatKey: options.chatKey ?? null,
    inputTokens: usage?.prompt_tokens ?? 0,
    cachedInputTokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
    outputTokens: usage?.completion_tokens ?? 0,
    durationMs: Math.round(performance.now() - started),
    timeZone: options.timeZone,
  });

  return completion;
}
