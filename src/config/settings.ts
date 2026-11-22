import type { Static } from "typebox";
import { Type } from "typebox";
import * as Value from "typebox/value";

import type { EnvConfig } from "./env.ts";

export const DEFAULT_PERSONA = `你是北京理工大学网络开拓者协会（BITNP，简称“网协”）的吉祥物兼值班小助手“树莓娘”。
性格可靠、直率、带点小傲娇和主见，用自然口语和群友交流，不装腔、不无脑讨好，避免官方套话与无意义感叹号。
回答技术问题、协查任务或操作公会看板前，先核对事实与权限，不确定时不编造。`;

export const scheduleSpecSchema = Type.Union([
  Type.Object({
    kind: Type.Literal("once"),
    at: Type.String({ minLength: 1 }),
  }),
  Type.Object({
    kind: Type.Literal("interval"),
    everySeconds: Type.Optional(Type.Integer({ minimum: 1 })),
    everyMinutes: Type.Optional(Type.Integer({ minimum: 1 })),
    everyHours: Type.Optional(Type.Integer({ minimum: 1 })),
    everyDays: Type.Optional(Type.Integer({ minimum: 1 })),
  }),
  Type.Object({
    kind: Type.Literal("daily"),
    time: Type.String({ minLength: 1 }),
  }),
  Type.Object({
    kind: Type.Literal("weekly"),
    weekdays: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    time: Type.String({ minLength: 1 }),
  }),
  Type.Object({
    kind: Type.Literal("monthly"),
    daysOfMonth: Type.Array(Type.Integer({ minimum: 1, maximum: 31 }), {
      minItems: 1,
    }),
    time: Type.String({ minLength: 1 }),
  }),
  Type.Object({
    kind: Type.Literal("yearly"),
    month: Type.Integer({ minimum: 1, maximum: 12 }),
    day: Type.Integer({ minimum: 1, maximum: 31 }),
    time: Type.String({ minLength: 1 }),
  }),
]);

export const thinkingEffortSchema = Type.Union([
  Type.Literal("none"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
]);

export type ThinkingEffort = Static<typeof thinkingEffortSchema>;

export const mcpServerSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, pattern: "^[a-zA-Z0-9_-]+$" }),
    enabled: Type.Boolean({ default: true }),
    transport: Type.Union([Type.Literal("stdio"), Type.Literal("http")]),
    command: Type.Optional(Type.String()),
    args: Type.Optional(Type.Array(Type.String())),
    url: Type.Optional(Type.String()),
    headers: Type.Optional(Type.Record(Type.String(), Type.String())),
    allowedTools: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: false },
);

export const runtimeSettingsSchema = Type.Object(
  {
    bot: Type.Object(
      {
        botQQ: Type.String({ pattern: "^\\d*$", default: "" }),
        names: Type.Array(Type.String(), {
          default: ["树莓娘", "树莓", "berry"],
        }),
        personaPrompt: Type.String({ default: DEFAULT_PERSONA }),
        timezone: Type.String({ default: "Asia/Shanghai" }),
        paused: Type.Boolean({ default: false }),
      },
      { default: {}, additionalProperties: false },
    ),
    mainModel: Type.Object(
      {
        baseURL: Type.String({ default: "https://api.openai.com/v1" }),
        apiKey: Type.String({ default: "" }),
        model: Type.String({ default: "gpt-4.1-mini" }),
        contextTokens: Type.Integer({ minimum: 8192, default: 128_000 }),
        maxOutputTokens: Type.Integer({ minimum: 256, default: 4096 }),
        temperature: Type.Number({ minimum: 0, maximum: 2, default: 0.3 }),
        timeoutMs: Type.Integer({ minimum: 1000, default: 120_000 }),
        thinkingEffort: Type.Union(
          [
            Type.Literal("none"),
            Type.Literal("low"),
            Type.Literal("medium"),
            Type.Literal("high"),
          ],
          { default: "none" },
        ),
        taskThinkingEffort: Type.Record(Type.String(), thinkingEffortSchema, {
          default: {},
        }),
      },
      { default: {}, additionalProperties: false },
    ),
    gateModel: Type.Object(
      {
        baseURL: Type.String({ default: "https://api.openai.com/v1" }),
        apiKey: Type.String({ default: "" }),
        model: Type.String({ default: "gpt-4.1-nano" }),
        minConfidence: Type.Number({ minimum: 0, maximum: 1, default: 0.65 }),
        failClosed: Type.Boolean({ default: true }),
        batchWindowMs: Type.Integer({
          minimum: 100,
          maximum: 10_000,
          default: 1000,
        }),
        contextMessages: Type.Integer({ minimum: 0, maximum: 40, default: 15 }),
        timeoutMs: Type.Integer({ minimum: 1000, default: 25_000 }),
        cooldownWindowMinutes: Type.Integer({
          minimum: 1,
          maximum: 60,
          default: 10,
        }),
        proactiveSoftLimit: Type.Integer({
          minimum: 0,
          maximum: 50,
          default: 3,
        }),
        cooldownMinConfidence: Type.Number({
          minimum: 0,
          maximum: 1,
          default: 0.88,
        }),
      },
      { default: {}, additionalProperties: false },
    ),
    policy: Type.Object(
      {
        privateDefaultEnabled: Type.Boolean({ default: true }),
        privateAccessMode: Type.Union(
          [
            Type.Literal("all"),
            Type.Literal("members_and_admins"),
            Type.Literal("admins_only"),
          ],
          { default: "all" },
        ),
        groupDefaultMode: Type.Union(
          [
            Type.Literal("off"),
            Type.Literal("mention_only"),
            Type.Literal("smart_observe"),
          ],
          { default: "mention_only" },
        ),
        adminBypassGate: Type.Boolean({ default: true }),
        adminQQs: Type.Array(Type.String({ pattern: "^\\d+$" }), {
          default: [],
        }),
        allowedGroups: Type.Array(Type.String({ pattern: "^\\d+$" }), {
          default: [],
        }),
      },
      { default: {}, additionalProperties: false },
    ),
    guildAutomation: Type.Object(
      {
        enabled: Type.Boolean({ default: false }),
        pollSeconds: Type.Integer({ minimum: 10, default: 60 }),
        dueReminderEnabled: Type.Boolean({ default: true }),
        dueAdvanceHours: Type.Number({ minimum: 0.5, default: 24 }),
        assignmentsEnabled: Type.Boolean({ default: true }),
        weeklyReportEnabled: Type.Boolean({ default: true }),
        weeklySchedule: Type.Union([scheduleSpecSchema, Type.Null()], {
          default: null,
        }),
        weeklyFolderId: Type.String({ default: "" }),
      },
      { default: {}, additionalProperties: false },
    ),
    bunko: Type.Object(
      {
        autoRecordFolderId: Type.String({ default: "" }),
      },
      { default: {}, additionalProperties: false },
    ),
    groupDigest: Type.Object(
      {
        enabled: Type.Boolean({ default: false }),
        groups: Type.Array(Type.String({ pattern: "^\\d+$" }), { default: [] }),
        intervalMinutes: Type.Integer({ minimum: 5, default: 60 }),
        minMessages: Type.Integer({ minimum: 1, default: 3 }),
        prompt: Type.String({
          default: "整理这段时间内有价值的群聊讨论、技术结论、争议和后续事项。",
        }),
        folderId: Type.String({ default: "" }),
      },
      { default: {}, additionalProperties: false },
    ),
    mcpServers: Type.Array(mcpServerSchema, { default: [] }),
    media: Type.Object(
      {
        autoAnalyzeImages: Type.Boolean({ default: true }),
        visionBaseURL: Type.String({ default: "" }),
        visionApiKey: Type.String({ default: "" }),
        visionModel: Type.String({ default: "" }),
        autoTranscribeAudio: Type.Boolean({ default: false }),
        audioBaseURL: Type.String({ default: "" }),
        audioApiKey: Type.String({ default: "" }),
        audioModel: Type.String({ default: "whisper-1" }),
        expandForwards: Type.Boolean({ default: true }),
      },
      { default: {}, additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export type RuntimeSettings = Static<typeof runtimeSettingsSchema>;
export type McpServerConfig = Static<typeof mcpServerSchema>;

export const seedSettingsFromEnv = (env: EnvConfig): RuntimeSettings =>
  parseSettings({
    bot: {
      botQQ: env.botQQ,
    },
    policy: {
      allowedGroups: env.allowedGroups,
    },
    mainModel: {
      baseURL: env.mainBaseUrl,
      apiKey: env.mainApiKey,
      model: env.mainModel,
    },
    gateModel: {
      baseURL: env.gateBaseUrl,
      apiKey: env.gateApiKey,
      model: env.gateModel,
    },
  });

export function parseSettings(input: unknown): RuntimeSettings {
  const defaulted = Value.Clean(
    runtimeSettingsSchema,
    Value.Default(runtimeSettingsSchema, structuredClone(input ?? {})),
  ) as RuntimeSettings;

  if (!Value.Check(runtimeSettingsSchema, defaulted)) {
    const details = [...Value.Errors(runtimeSettingsSchema, defaulted)]
      .map((err) => `${err.instancePath || "/"} ${err.message}`)
      .join("; ");

    throw new Error(`Invalid runtime settings: ${details}`);
  }

  for (const [label, url] of [
    ["mainModel.baseURL", defaulted.mainModel.baseURL],
    ["gateModel.baseURL", defaulted.gateModel.baseURL],
    ["media.visionBaseURL", defaulted.media.visionBaseURL],
    ["media.audioBaseURL", defaulted.media.audioBaseURL],
  ] as const) {
    if (
      url &&
      (!URL.canParse(url) ||
        !["http:", "https:"].includes(new URL(url).protocol))
    ) {
      throw new Error(`${label} must be an http(s) URL`);
    }
  }

  if (
    defaulted.mainModel.contextTokens <=
    defaulted.mainModel.maxOutputTokens + 4096
  ) {
    throw new Error(
      "mainModel.contextTokens must exceed maxOutputTokens + 4096",
    );
  }

  defaulted.policy.allowedGroups = [...new Set(defaulted.policy.allowedGroups)];

  return defaulted;
}

export function resolveThinkingEffort(
  settings: RuntimeSettings,
  purpose: string,
  fallback?: ThinkingEffort,
): ThinkingEffort {
  const overrides = settings.mainModel.taskThinkingEffort;
  const exact = overrides[purpose];

  if (exact) {
    return exact;
  }

  if (purpose.startsWith("subagent:") && overrides.subagent) {
    return overrides.subagent;
  }

  if (fallback) {
    return fallback;
  }

  const base = settings.mainModel.thinkingEffort;

  if (purpose === "memory_update" || purpose === "compaction") {
    return "none";
  }

  if (purpose === "subagent" || purpose.startsWith("subagent:")) {
    return base === "none" ? "none" : "low";
  }

  return base;
}

export function isGroupAllowed(
  settings: Pick<RuntimeSettings, "policy">,
  groupId: string,
): boolean {
  const allowlist = settings.policy.allowedGroups;

  return allowlist.length === 0 || allowlist.includes(groupId);
}
