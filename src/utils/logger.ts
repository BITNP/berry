import { Writable } from "node:stream";
import { stripVTControlCharacters } from "node:util";

import pino from "pino";

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

const ANSI = {
  reset: "\x1B[0m",
  bold: "\x1B[1m",
  dim: "\x1B[2m",
  gray: "\x1B[90m",
  white: "\x1B[97m",
  red: "\x1B[31m",
  brightRed: "\x1B[91m",
  green: "\x1B[32m",
  yellow: "\x1B[33m",
  blue: "\x1B[34m",
  brightBlue: "\x1B[94m",
  magenta: "\x1B[35m",
  brightMagenta: "\x1B[95m",
  cyan: "\x1B[36m",
  brightCyan: "\x1B[96m",
  errBadge: "\x1B[1;41;97m",
  warnBadge: "\x1B[1;33m",
  infoBadge: "\x1B[1;36m",
  debugBadge: "\x1B[90m",
} as const;

const SCOPE_PALETTE = [
  ANSI.cyan,
  ANSI.magenta,
  ANSI.brightBlue,
  ANSI.green,
  ANSI.yellow,
  ANSI.brightMagenta,
  ANSI.brightCyan,
] as const;

function shouldColorize(): boolean {
  if (process.env.NO_COLOR !== undefined) {
    return false;
  }

  if (
    process.env.FORCE_COLOR !== undefined &&
    process.env.FORCE_COLOR !== "0"
  ) {
    return true;
  }

  return Boolean(process.stdout.isTTY);
}

const paint = (text: string, code: string, color: boolean): string =>
  color ? `${code}${text}${ANSI.reset}` : text;

function scopeColor(scope: string): string {
  if (scope === "berry" || scope === "main") {
    return ANSI.brightMagenta;
  }

  if (scope === "agent" || scope.startsWith("llm")) {
    return ANSI.brightCyan;
  }

  if (scope.startsWith("gate")) {
    return ANSI.green;
  }

  if (scope.startsWith("gateway")) {
    return ANSI.brightBlue;
  }

  if (scope.startsWith("guild")) {
    return ANSI.yellow;
  }

  let hash = 0;

  for (let i = 0; i < scope.length; i++) {
    hash = (hash * 31 + scope.charCodeAt(i)) | 0;
  }

  return SCOPE_PALETTE[Math.abs(hash) % SCOPE_PALETTE.length]!;
}

function formatClockMs(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const frac = String(d.getMilliseconds()).padStart(3, "0");

  return `${hh}:${mm}:${ss}.${frac}`;
}

function formatMetaValue(value: unknown, color: boolean): string {
  if (typeof value === "boolean") {
    return paint(String(value), value ? ANSI.green : ANSI.red, color);
  }

  if (typeof value === "number") {
    return paint(String(value), ANSI.yellow, color);
  }

  if (typeof value === "string") {
    const clean = value.replaceAll(/\s+/g, " ").trim();
    const display =
      clean.length === 0 || /[\s=]/.test(clean) ? JSON.stringify(clean) : clean;

    return paint(
      display,
      clean === "[已脱敏]" ? ANSI.magenta : ANSI.white,
      color,
    );
  }

  return paint(JSON.stringify(value), ANSI.gray, color);
}

export function formatPrettyLogLine(
  input: {
    time: number;
    level: LogLevel;
    scope: string;
    message: string;
    context: Record<string, unknown>;
  },
  color = shouldColorize(),
): string {
  const clock = paint(formatClockMs(input.time), ANSI.gray, color);
  const rail = paint("│", ANSI.gray, color);
  const badge =
    input.level === "error"
      ? paint("ERROR", ANSI.errBadge, color)
      : input.level === "warn"
        ? paint("WARN ", ANSI.warnBadge, color)
        : input.level === "debug"
          ? paint("DEBUG", ANSI.debugBadge, color)
          : paint("INFO ", ANSI.infoBadge, color);

  const rawScope =
    input.scope.length > 16 ? `${input.scope.slice(0, 15)}…` : input.scope;
  const bracketedScope = `${paint("[", ANSI.gray, color)}${paint(rawScope, scopeColor(input.scope), color)}${paint("]", ANSI.gray, color)}`;
  const scopePad = " ".repeat(Math.max(0, 16 - rawScope.length));
  const scopePart = `${bracketedScope}${scopePad}`;
  const pointer = paint("›", ANSI.gray, color);

  const msgColor =
    input.level === "error"
      ? `${ANSI.bold}${ANSI.brightRed}`
      : input.level === "warn"
        ? ANSI.yellow
        : input.level === "debug"
          ? ANSI.gray
          : ANSI.white;
  const msgPart = paint(input.message, msgColor, color);

  const inlinePairs: string[] = [];
  let errorDetail: string | null = null;

  for (const [key, value] of Object.entries(input.context)) {
    if (value === undefined) {
      continue;
    }

    if ((key === "error" || key === "err") && typeof value === "string") {
      errorDetail = value;

      continue;
    }

    inlinePairs.push(
      `${paint(`${key}=`, ANSI.gray, color)}${formatMetaValue(value, color)}`,
    );
  }

  const head = `${clock} ${rail} ${badge} ${rail} ${scopePart} ${pointer} ${msgPart}${inlinePairs.length > 0 ? `  ${inlinePairs.join("  ")}` : ""}`;

  if (!errorDetail) {
    return `${head}\n`;
  }

  const prefix = `${" ".repeat(12)} ${rail} ${" ".repeat(5)} ${rail} `;
  const lines = errorDetail.split("\n");
  const formattedErr = lines
    .map((line, idx) =>
      idx === 0
        ? `${prefix}${paint("└─", ANSI.gray, color)} ${paint(line, ANSI.brightRed, color)}`
        : `${prefix}   ${paint(line, ANSI.red, color)}`,
    )
    .join("\n");

  return `${head}\n${formattedErr}\n`;
}

const isWideCodePoint = (cp: number): boolean =>
  (cp >= 0x11_00 && cp <= 0x11_5f) ||
  (cp >= 0x2e_80 && cp <= 0xa4_cf && cp !== 0x30_3f) ||
  (cp >= 0xac_00 && cp <= 0xd7_a3) ||
  (cp >= 0xf9_00 && cp <= 0xfa_ff) ||
  (cp >= 0xfe_10 && cp <= 0xfe_19) ||
  (cp >= 0xfe_30 && cp <= 0xfe_6f) ||
  (cp >= 0xff_00 && cp <= 0xff_60) ||
  (cp >= 0xff_e0 && cp <= 0xff_e6) ||
  (cp >= 0x2_00_00 && cp <= 0x3_ff_fd);

function visibleWidth(text: string): number {
  const plain = stripVTControlCharacters(text);
  let width = 0;

  for (const ch of plain) {
    const cp = ch.codePointAt(0) ?? 0;

    width += isWideCodePoint(cp) ? 2 : 1;
  }

  return width;
}

export function printStartupBanner(info: {
  url: string;
  devAuthBypass: boolean;
  gatewayConfigured: boolean;
  guildApiConfigured: boolean;
  bunkoConfigured?: boolean;
}): void {
  if (process.env.BERRY_LOG_JSON === "true") {
    return;
  }

  const color = shouldColorize();
  const edge = paint("│", ANSI.gray, color);
  const logoColor = `${ANSI.bold}${ANSI.brightMagenta}`;
  const dot = (ok: boolean, label: string) =>
    `${paint(ok ? "●" : "○", ok ? ANSI.green : ANSI.gray, color)} ${paint(label, ok ? ANSI.white : ANSI.gray, color)}`;

  const topRows = [
    `  ${paint("█▀▄ █▀▀ █▀▄ █▀▄ █ █", logoColor, color)}   ${paint("Berry", `${ANSI.bold}${ANSI.white}`, color)}  ${paint("树莓娘控制台", ANSI.gray, color)}`,
    `  ${paint("█▀▄ █▀▀ █▀▄ █▀▄ ▀█▀", logoColor, color)}   ${paint("BITNP QQ Agent Console", ANSI.dim, color)}`,
    `  ${paint("▀▀  ▀▀▀ ▀ ▀ ▀ ▀  ▀ ", logoColor, color)}`,
  ];
  const infoRows = [
    `  ${paint("➜", ANSI.brightCyan, color)}  ${paint("[控制台]", ANSI.gray, color)}  ${paint(info.url, `${ANSI.bold}${ANSI.cyan}`, color)}`,
    `  ${paint("➜", ANSI.brightCyan, color)}  ${paint("[模块]  ", ANSI.gray, color)}  ${dot(info.gatewayConfigured, "QQ 网关")}   ${dot(info.guildApiConfigured, "公会看板")}   ${dot(Boolean(info.bunkoConfigured), "Bunko 云文档")}   ${dot(info.devAuthBypass, info.devAuthBypass ? "开发免登" : "OIDC 鉴权")}`,
  ];

  const innerWidth = Math.max(
    54,
    ...[...topRows, ...infoRows].map((row) => visibleWidth(row) + 2),
  );
  const rule = "─".repeat(innerWidth);

  function frameRow(row: string) {
    const pad = " ".repeat(Math.max(0, innerWidth - visibleWidth(row)));

    return `${edge}${row}${pad}${edge}`;
  }

  const lines = [
    "",
    paint(`╭${rule}╮`, ANSI.gray, color),
    ...topRows.map(frameRow),
    paint(`├${rule}┤`, ANSI.gray, color),
    ...infoRows.map(frameRow),
    paint(`╰${rule}╯`, ANSI.gray, color),
    "",
  ];

  process.stdout.write(`${lines.join("\n")}\n`);
}

const prettyStream =
  process.env.BERRY_LOG_JSON === "true"
    ? process.stdout
    : new Writable({
        write(chunk, _encoding, callback) {
          try {
            const raw = String(chunk).trim();

            if (raw) {
              const parsed = JSON.parse(raw) as Record<string, unknown>;
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

              process.stdout.write(
                formatPrettyLogLine({
                  time,
                  level,
                  scope,
                  message,
                  context: rest,
                }),
              );
            }
          } catch {
            process.stdout.write(chunk);
          }

          callback();
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
