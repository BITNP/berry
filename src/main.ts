import { BerryApp } from "./app.ts";
import { loadEnvConfig } from "./config/env.ts";
import { Logger, printStartupBanner } from "./utils/logger.ts";

const logger = new Logger("main");

async function main(): Promise<void> {
  const env = loadEnvConfig();
  const app = await BerryApp.create(env);
  const { url } = await app.listen();

  printStartupBanner({
    url,
    devAuthBypass: env.devAuthBypass,
    gatewayConfigured: app.gateway.configured,
    guildApiConfigured: app.guild.enabled,
    bunkoConfigured: app.bunko.enabled,
  });

  logger.info("berry ready", {
    url,
    devAuthBypass: env.devAuthBypass,
    gatewayConfigured: app.gateway.configured,
    guildApiConfigured: app.guild.enabled,
    bunkoConfigured: app.bunko.enabled,
  });

  async function shutdown(signal: string) {
    logger.info("shutting down", { signal });
    await app.close();
    process.exit(0);
  }

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

main().catch((error) => {
  logger.error("fatal startup error", {
    error:
      error instanceof Error ? (error.stack ?? error.message) : String(error),
  });
  process.exit(1);
});
