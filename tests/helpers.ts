import { mkdtemp, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BerryApp } from "../src/app.ts";
import type { EnvConfig } from "../src/config/env.ts";
import { loadEnvConfig } from "../src/config/env.ts";
import type { RuntimeSettingsPatch } from "./types-helper.ts";

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

  await new Promise<void>((_resolve) => {
    server.listen(0, "127.0.0.1", () => _resolve());
  });

  const addr = server.address();
  const port = addr && typeof addr === "object" ? addr.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export async function createTestBerryApp(
  overrides: Partial<EnvConfig> = {},
  settingsPatch: RuntimeSettingsPatch = {},
): Promise<{
  app: BerryApp;
  cleanup: () => Promise<void>;
}> {
  const dataDir = await mkdtemp(join(tmpdir(), "berry-test-"));
  const env = loadEnvConfig({
    BERRY_HOST: "127.0.0.1",
    BERRY_PORT: "0",
    BERRY_DATA_DIR: dataDir,
    BERRY_BOT_QQ: "999999",
    BERRY_MAIN_API_KEY: "test-main-key",
    BERRY_MAIN_MODEL: "gpt-test-main",
    BERRY_GATE_API_KEY: "test-gate-key",
    BERRY_GATE_MODEL: "gpt-test-gate",
  });

  Object.assign(env, overrides);
  const app = await BerryApp.create(env, { startBackground: false });

  if (Object.keys(settingsPatch).length > 0) {
    await app.updateSettings({
      ...app.settings,
      ...settingsPatch,
      bot: { ...app.settings.bot, ...settingsPatch.bot },
      mainModel: { ...app.settings.mainModel, ...settingsPatch.mainModel },
      gateModel: { ...app.settings.gateModel, ...settingsPatch.gateModel },
      policy: { ...app.settings.policy, ...settingsPatch.policy },
      media: { ...app.settings.media, ...settingsPatch.media },
    });
  }

  return {
    app,
    cleanup: async () => {
      await app.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}
