import { mkdtemp, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { BerryApp } from "../src/app.ts";
import type { EnvConfig } from "../src/config/env.ts";
import { loadEnvConfig } from "../src/config/env.ts";
import type { RuntimeSettings } from "../src/config/settings.ts";

export interface RuntimeSettingsPatch {
  bot?: Partial<RuntimeSettings["bot"]>;
  mainModel?: Partial<RuntimeSettings["mainModel"]>;
  gateModel?: Partial<RuntimeSettings["gateModel"]>;
  policy?: Partial<RuntimeSettings["policy"]>;
  guildAutomation?: Partial<RuntimeSettings["guildAutomation"]>;
  groupDigest?: Partial<RuntimeSettings["groupDigest"]>;
  media?: Partial<RuntimeSettings["media"]>;
}

export interface StubServer {
  url: string;
  close: () => Promise<void>;
}

export async function startStubServer(
  handler: (
    req: IncomingMessage,
    res: ServerResponse,
    bodyText: string,
  ) => void | Promise<void>,
  t?: TestContext,
): Promise<StubServer> {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];

    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    const bodyText = Buffer.concat(chunks).toString("utf8");

    try {
      await handler(req, res, bodyText);
    } catch (error) {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const addr = server.address();
  const port = addr && typeof addr === "object" ? addr.port : 0;
  const close = () =>
    new Promise<void>((resolve) => server.close(() => resolve()));

  t?.after(close);

  return {
    url: `http://127.0.0.1:${port}`,
    close,
  };
}

export async function createTestBerryApp(
  overrides: Partial<EnvConfig> = {},
  settingsPatch: RuntimeSettingsPatch = {},
  t?: TestContext,
): Promise<{
  app: BerryApp;
  cleanup: () => Promise<void>;
}> {
  const dataDir = await mkdtemp(join(tmpdir(), "berry-test-"));
  let app: BerryApp | null = null;

  async function cleanup() {
    if (app) {
      await app.close();
      app = null;
    }

    await rm(dataDir, { recursive: true, force: true });
  }

  t?.after(cleanup);

  const env = loadEnvConfig({
    BERRY_HOST: "127.0.0.1",
    BERRY_PORT: "0",
    BERRY_DATA_DIR: dataDir,
    BERRY_BOT_QQ: "999999",
    BERRY_MAIN_API_KEY: "test-main-key",
    BERRY_MAIN_MODEL: "gpt-test-main",
    BERRY_GATE_API_KEY: "test-gate-key",
    BERRY_GATE_MODEL: "gpt-test-gate",
    BERRY_SHORTLINK_ORIGIN: "",
  });

  Object.assign(env, overrides);
  app = await BerryApp.create(env, { startBackground: false });

  if (Object.keys(settingsPatch).length > 0) {
    await app.updateSettings({
      ...app.settings,
      bot: { ...app.settings.bot, ...settingsPatch.bot },
      mainModel: { ...app.settings.mainModel, ...settingsPatch.mainModel },
      gateModel: { ...app.settings.gateModel, ...settingsPatch.gateModel },
      policy: { ...app.settings.policy, ...settingsPatch.policy },
      guildAutomation: {
        ...app.settings.guildAutomation,
        ...settingsPatch.guildAutomation,
      },
      groupDigest: {
        ...app.settings.groupDigest,
        ...settingsPatch.groupDigest,
      },
      media: { ...app.settings.media, ...settingsPatch.media },
    });
  }

  return { app, cleanup };
}

export const chatReply = (
  content: unknown,
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    prompt_tokens_details?: { cached_tokens?: number };
  } = { prompt_tokens: 100, completion_tokens: 20 },
) => ({
  id: "chat-reply",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content:
          typeof content === "string" ? content : JSON.stringify(content),
      },
      finish_reason: "stop",
    },
  ],
  usage,
});

export const chatToolCalls = (
  calls: { id: string; name: string; args: Record<string, unknown> }[],
) => ({
  id: "chat-tools",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: null,
        tool_calls: calls.map((c) => ({
          id: c.id,
          type: "function",
          function: {
            name: c.name,
            arguments: JSON.stringify(c.args),
          },
        })),
      },
      finish_reason: "tool_calls",
    },
  ],
});

export const captureText = (
  app: BerryApp,
  input: {
    kind: "group" | "private";
    chatId: string;
    id: string;
    userId: string;
    senderName: string;
    text: string;
    mentionedBot?: boolean;
    sentAt?: number;
  },
) =>
  app.store.messages.capture({
    kind: input.kind,
    chatId: input.chatId,
    onebotMessageId: input.id,
    userId: input.userId,
    senderName: input.senderName,
    text: input.text,
    segments: [{ type: "text", data: { text: input.text } }],
    replyToMessageId: null,
    isBot: false,
    mentionedBot: input.mentionedBot ?? false,
    sentAt: input.sentAt ?? Date.now(),
  });

export async function waitUntil(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }

    await delay(25);
  }

  throw new Error("waitUntil timed out");
}
