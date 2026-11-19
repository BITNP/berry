import { Writable } from "node:stream";

import pino from "pino";
import pinoPretty from "pino-pretty";

import type { AdminEvent, LogEntry, LogLevel } from "../types.ts";

export type EventSubscriber = (event: AdminEvent) => void;

export class EventBus {
  #subscribers = new Set<EventSubscriber>();

  public subscribe(listener: EventSubscriber): () => void {
    this.#subscribers.add(listener);

    return () => {
      this.#subscribers.delete(listener);
    };
  }

  public emit(event: AdminEvent): void {
    for (const listener of this.#subscribers) {
      try {
        listener(event);
      } catch {
        // Ignore individual subscriber failure.
      }
    }
  }
}

const activeHubs = new Set<LogHub>();

function redactString(input: string, secrets: string[]): string {
  let out = input;

  for (const secret of secrets) {
    if (secret && secret.length >= 4) {
      out = out.replaceAll(secret, "[已脱敏]");
    }
  }

  return out;
}

function redactSecretValues(
  value: unknown,
  secrets: string[],
  depth = 0,
): unknown {
  if (depth > 5) {
    return "[...]";
  }

  if (typeof value === "string") {
    return redactString(value, secrets);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactSecretValues(item, secrets, depth + 1));
  }

  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};

    for (const [key, item] of Object.entries(value)) {
      out[key] = redactSecretValues(item, secrets, depth + 1);
    }

    return out;
  }

  return value;
}

function collectSecrets(): string[] {
  const secrets: string[] = [];

  for (const hub of activeHubs) {
    for (const secret of hub.secrets()) {
      if (secret) {
        secrets.push(secret);
      }
    }
  }

  return secrets;
}

const LEVEL_NAMES: Record<number, LogLevel> = {
  10: "debug",
  20: "debug",
  30: "info",
  40: "warn",
  50: "error",
  60: "error",
};

const MAX_LOG_BUFFER = 2000;

export class LogHub {
  #events: EventBus;
  #entries: LogEntry[] = [];
  #nextId = 1;
  #secretProvider: (() => string[]) | null = null;

  constructor(events: EventBus) {
    this.#events = events;
    activeHubs.add(this);
  }

  public setSecretProvider(provider: () => string[]): void {
    this.#secretProvider = provider;
  }

  public secrets(): string[] {
    return this.#secretProvider ? this.#secretProvider() : [];
  }

  public pushRaw(
    level: LogLevel,
    scope: string,
    message: string,
    context: Record<string, unknown>,
    time = Date.now(),
  ): LogEntry {
    const secrets = this.secrets();
    const entry: LogEntry = {
      id: this.#nextId++,
      time,
      level,
      scope,
      message: redactString(message, secrets),
      context: redactSecretValues(context, secrets) as Record<string, unknown>,
    };

    this.#entries.push(entry);
    if (this.#entries.length > MAX_LOG_BUFFER) {
      this.#entries.splice(0, this.#entries.length - MAX_LOG_BUFFER);
    }

    this.#events.emit({ type: "log", data: entry });

    return entry;
  }

  public list(
    filters: {
      level?: LogLevel;
      scope?: string;
      search?: string;
      afterId?: number;
      limit?: number;
    } = {},
  ): { items: LogEntry[]; latestId: number; scopes: string[] } {
    const scopesSet = new Set<string>();

    for (const entry of this.#entries) {
      scopesSet.add(entry.scope);
    }

    const search = (filters.search ?? "").trim().toLowerCase();
    const limit = Math.min(500, Math.max(1, filters.limit ?? 200));

    let matched = this.#entries.filter((entry) => {
      if (filters.afterId !== undefined && entry.id <= filters.afterId) {
        return false;
      }

      if (filters.level && entry.level !== filters.level) {
        return false;
      }

      if (filters.scope && entry.scope !== filters.scope) {
        return false;
      }

      if (search) {
        const hay =
          `${entry.scope} ${entry.message} ${JSON.stringify(entry.context)}`.toLowerCase();

        if (!hay.includes(search)) {
          return false;
        }
      }

      return true;
    });

    if (matched.length > limit) {
      matched = matched.slice(-limit);
    }

    return {
      items: matched,
      latestId: this.#entries.at(-1)?.id ?? 0,
      scopes: [...scopesSet].sort((a, b) => a.localeCompare(b)),
    };
  }

  public clear(): void {
    this.#entries = [];
  }

  public close(): void {
    activeHubs.delete(this);
  }
}

const memorySink = new Writable({
  write(chunk, _encoding, callback) {
    try {
      const line = String(chunk).trim();

      if (line) {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        const {
          level: rawLevel,
          time: rawTime,
          scope: rawScope,
          msg: rawMsg,
          pid: _pid,
          hostname: _hostname,
          ...rest
        } = parsed;

        const level =
          typeof rawLevel === "number"
            ? (LEVEL_NAMES[rawLevel] ?? "info")
            : "info";
        const time = typeof rawTime === "number" ? rawTime : Date.now();
        const scope = typeof rawScope === "string" ? rawScope : "berry";
        const message = typeof rawMsg === "string" ? rawMsg : "";

        for (const hub of activeHubs) {
          hub.pushRaw(level, scope, message, rest, time);
        }
      }
    } catch {
      // Ignore malformed log chunks.
    }

    callback();
  },
});

const prettyStream =
  process.env.BERRY_LOG_JSON === "true"
    ? process.stdout
    : pinoPretty({
        colorize: Boolean(process.stdout.isTTY),
        singleLine: true,
        sync: true,
        translateTime: "SYS:yyyy-mm-dd HH:MM:ss.l",
        ignore: "pid,hostname,scope",
        messageFormat: (log, messageKey) => {
          const scope = typeof log.scope === "string" ? log.scope : "berry";
          const text = String(log[messageKey] ?? "");

          return `[${scope}] ${text}`;
        },
      });

const SENSITIVE_REDACT_PATHS = [
  "apiKey",
  "password",
  "secret",
  "token",
  "authorization",
  "Authorization",
].flatMap((key) => [key, `*.${key}`, `*.*.${key}`]);

const rootPino = pino(
  {
    level: process.env.BERRY_LOG_LEVEL === "debug" ? "debug" : "info",
    base: undefined,
    redact: {
      paths: SENSITIVE_REDACT_PATHS,
      censor: "[已脱敏]",
    },
  },
  pino.multistream([
    { level: "debug", stream: prettyStream },
    { level: "debug", stream: memorySink },
  ]),
);

export class Logger {
  #child: pino.Logger;

  constructor(scope: string) {
    this.#child = rootPino.child({ scope });
  }

  public info(message: string, meta?: Record<string, unknown>): void {
    this.#emit("info", message, meta);
  }

  public warn(message: string, meta?: Record<string, unknown>): void {
    this.#emit("warn", message, meta);
  }

  public error(message: string, meta?: Record<string, unknown>): void {
    this.#emit("error", message, meta);
  }

  public debug(message: string, meta?: Record<string, unknown>): void {
    if (process.env.BERRY_LOG_LEVEL === "debug") {
      this.#emit("debug", message, meta);
    }
  }

  #emit(
    level: LogLevel,
    message: string,
    meta?: Record<string, unknown>,
  ): void {
    const secrets = collectSecrets();
    const safeMessage = redactString(message, secrets);
    const safeMeta = meta
      ? (redactSecretValues(meta, secrets) as Record<string, unknown>)
      : undefined;

    if (safeMeta && Object.keys(safeMeta).length > 0) {
      this.#child[level](safeMeta, safeMessage);
    } else {
      this.#child[level](safeMessage);
    }
  }
}
