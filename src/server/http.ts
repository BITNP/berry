import type { H3Event } from "h3";
import { createError, getRouterParam } from "h3";

export function queryString(
  query: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = query[key];

  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();

  return trimmed || undefined;
}

export function optionalQueryInt(
  query: Record<string, unknown>,
  key: string,
): number | undefined {
  const raw = queryString(query, key);

  if (!raw || !/^-?\d+$/.test(raw)) {
    return undefined;
  }

  const parsed = Number.parseInt(raw, 10);

  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export const queryInt = (
  query: Record<string, unknown>,
  key: string,
  fallback: number,
): number => optionalQueryInt(query, key) ?? fallback;

export const pickEnum = <const T extends readonly string[]>(
  value: unknown,
  allowed: T,
): T[number] | undefined =>
  typeof value === "string" && allowed.includes(value) ? value : undefined;

export function requireParam(event: H3Event, name: string): string {
  const raw = getRouterParam(event, name);

  if (!raw) {
    throw createError({ statusCode: 400, message: "Missing route parameter" });
  }

  return decodeURIComponent(raw);
}

export function requirePositiveIntParam(
  event: H3Event,
  name: string,
  message: string,
): number {
  const id = Number(getRouterParam(event, name));

  if (!Number.isInteger(id) || id <= 0) {
    throw createError({ statusCode: 400, message });
  }

  return id;
}
