import type { H3Event } from "h3";
import {
  createError,
  getValidatedQuery,
  getValidatedRouterParams,
  readBody,
} from "h3";
import type { Static, TObject } from "typebox";
import { Type } from "typebox";
import * as Value from "typebox/value";

import type { ChatKey, ChatKind } from "../types.ts";
import { makeChatKey, parseChatKey } from "../utils/chat-key.ts";

function normalizeRecord(
  raw: unknown,
  stripBlankStrings: boolean,
): Record<string, unknown> {
  if (!raw || typeof raw !== "object") {
    return {};
  }

  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string") {
      const trimmed = value.trim();

      if (!stripBlankStrings || trimmed) {
        out[key] = trimmed;
      }
    } else if (value !== undefined) {
      out[key] = value;
    }
  }

  return out;
}

function validateSchema<S extends TObject>(
  schema: S,
  raw: unknown,
  options: {
    normalizeStrings?: "strip" | "trim";
    convert?: boolean;
    message?: string;
  } = {},
): Static<S> {
  const input = options.normalizeStrings
    ? normalizeRecord(raw, options.normalizeStrings === "strip")
    : raw && typeof raw === "object" && !Array.isArray(raw)
      ? structuredClone(raw)
      : {};
  const defaulted = Value.Default(schema, input);
  const prepared = options.convert
    ? Value.Convert(schema, defaulted)
    : defaulted;

  if (!Value.Check(schema, prepared)) {
    const details = [...Value.Errors(schema, prepared)]
      .map((err) => `${err.instancePath || "/"} ${err.message}`)
      .join("; ");

    throw new Error(options.message || details || "请求参数校验失败");
  }

  return prepared;
}

export const parseQuery = <S extends TObject>(
  event: H3Event,
  schema: S,
): Promise<Static<S>> =>
  getValidatedQuery(event, (data) =>
    validateSchema(schema, data, { normalizeStrings: "strip", convert: true }),
  );

export const parseParams = <S extends TObject>(
  event: H3Event,
  schema: S,
  message?: string,
): Promise<Static<S>> =>
  getValidatedRouterParams(
    event,
    (data) =>
      validateSchema(schema, data, {
        normalizeStrings: "trim",
        convert: true,
        message,
      }),
    { decode: true },
  );

export async function parseBody<S extends TObject>(
  event: H3Event,
  schema: S,
  message?: string,
): Promise<Static<S>> {
  const raw = (await readBody<unknown>(event)) ?? {};

  try {
    return validateSchema(schema, raw, { message });
  } catch (error) {
    throw createError({
      statusCode: 400,
      message: error instanceof Error ? error.message : "请求体校验失败",
    });
  }
}

export const idParamSchema = Type.Object({
  id: Type.Integer({ minimum: 1 }),
});

const chatKeyParamSchema = Type.Object({
  chatKey: Type.String({ minLength: 1 }),
});

export const stringIdParamSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
});

export async function parseChatKeyParam(
  event: H3Event,
): Promise<{ chatKey: ChatKey; kind: ChatKind; chatId: string }> {
  const { chatKey } = await parseParams(
    event,
    chatKeyParamSchema,
    "无效的会话标识",
  );

  try {
    const parsed = parseChatKey(chatKey);

    return {
      chatKey: makeChatKey(parsed.kind, parsed.chatId),
      kind: parsed.kind,
      chatId: parsed.chatId,
    };
  } catch {
    throw createError({ statusCode: 400, message: "无效的会话标识" });
  }
}
