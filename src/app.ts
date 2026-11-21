import type { Server } from "node:http";
import { createServer } from "node:http";
import { resolve } from "node:path";

import { toNodeListener } from "h3";

import { BerryAgent } from "./agent/runner.ts";
import type { SubagentRegistry } from "./agent/subagents/index.ts";
import { createDefaultSubagentRegistry } from "./agent/subagents/index.ts";
import { BunkoClient } from "./bunko/client.ts";
import type { EnvConfig } from "./config/env.ts";
import type { RuntimeSettings } from "./config/settings.ts";
import { SmallModelClassifier } from "./gate/classifier.ts";
import { MessageGate } from "./gate/gate.ts";
import { MessageGatewayClient } from "./gateway/client.ts";
import { GatewayEventSubscriber } from "./gateway/events.ts";
import { GuildAutomationRunner } from "./guild/automation.ts";
import { GuildInternalClient } from "./guild/client.ts";
import { IdentityDirectory } from "./identity/keycloak.ts";
import type { JobRegistry } from "./jobs/index.ts";
import { createDefaultJobRegistry } from "./jobs/index.ts";
import { McpHub } from "./mcp/hub.ts";
import { MediaProcessor } from "./media/processor.ts";
import { ScheduleRunner } from "./scheduler/runner.ts";
import { AdminAuthService } from "./server/auth.ts";
import { AvatarCache } from "./server/avatars.ts";
import { createHttpApp } from "./server/routes.ts";
import { Store } from "./store/index.ts";
import type { AgentServices, ToolRegistry } from "./tools/index.ts";
import { createDefaultMainToolRegistry } from "./tools/index.ts";
import { EventBus, LogHub, Logger } from "./utils/logger.ts";
import { ShortLinkClient } from "./utils/shortlink.ts";
import { JobWorker } from "./worker.ts";

export class BerryApp {
  public readonly env: EnvConfig;
  public readonly events: EventBus;
  public readonly logs: LogHub;
  public readonly store: Store;
  public readonly gateway: MessageGatewayClient;
  public readonly media: MediaProcessor;
  public readonly avatars: AvatarCache;
  public readonly directory: IdentityDirectory;
  public readonly guild: GuildInternalClient;
  public readonly bunko: BunkoClient;
  public readonly shortlink: ShortLinkClient;
  public readonly mcp: McpHub;
  public readonly classifier: SmallModelClassifier;
  public readonly gate: MessageGate;
  public readonly gatewayEvents: GatewayEventSubscriber;
  public readonly subagents: SubagentRegistry;
  public readonly mainTools: ToolRegistry;
  public readonly agent: BerryAgent;
  public readonly scheduler: ScheduleRunner;
  public readonly guildAutomation: GuildAutomationRunner;
  public readonly jobs: JobRegistry;
  public readonly worker: JobWorker;
  public readonly auth: AdminAuthService;
  public settings: RuntimeSettings;

  #server: Server | null = null;
  #logger = new Logger("berry");

  private constructor(options: {
    env: EnvConfig;
    events: EventBus;
    logs: LogHub;
    store: Store;
    settings: RuntimeSettings;
    gateway: MessageGatewayClient;
    media: MediaProcessor;
    avatars: AvatarCache;
    directory: IdentityDirectory;
    guild: GuildInternalClient;
    bunko: BunkoClient;
    shortlink: ShortLinkClient;
    mcp: McpHub;
    classifier: SmallModelClassifier;
    gate: MessageGate;
    gatewayEvents: GatewayEventSubscriber;
    subagents: SubagentRegistry;
    mainTools: ToolRegistry;
    agent: BerryAgent;
    scheduler: ScheduleRunner;
    guildAutomation: GuildAutomationRunner;
    jobs: JobRegistry;
    worker: JobWorker;
    auth: AdminAuthService;
  }) {
    this.env = options.env;
    this.events = options.events;
    this.logs = options.logs;
    this.store = options.store;
    this.settings = options.settings;
    this.gateway = options.gateway;
    this.media = options.media;
    this.avatars = options.avatars;
    this.directory = options.directory;
    this.guild = options.guild;
    this.bunko = options.bunko;
    this.shortlink = options.shortlink;
    this.mcp = options.mcp;
    this.classifier = options.classifier;
    this.gate = options.gate;
    this.gatewayEvents = options.gatewayEvents;
    this.subagents = options.subagents;
    this.mainTools = options.mainTools;
    this.agent = options.agent;
    this.scheduler = options.scheduler;
    this.guildAutomation = options.guildAutomation;
    this.jobs = options.jobs;
    this.worker = options.worker;
    this.auth = options.auth;
  }

  public static async create(
    env: EnvConfig,
    options: { startBackground?: boolean } = {},
  ): Promise<BerryApp> {
    const events = new EventBus();
    const logs = new LogHub(events);
    const store = await Store.open(env.dataDir, events);
    const settings = await store.settings.loadOrSeed(env);

    await store.jobs.recoverOnStartup();

    let instanceRef: BerryApp | null = null;
    const getSettings = () => (instanceRef ? instanceRef.settings : settings);

    const gateway = new MessageGatewayClient(env, store, { getSettings });
    const avatars = new AvatarCache(store);
    const directory = new IdentityDirectory(env);
    const guild = new GuildInternalClient(env);
    const bunko = new BunkoClient(env);
    const shortlink = new ShortLinkClient(env.shortlinkOrigin);
    const mcp = new McpHub();
    const classifier = new SmallModelClassifier(store);

    logs.setSecretProvider(() => {
      const current = getSettings();

      return [
        env.gatewayToken,
        env.guildInternalToken,
        env.bunkoApiKey,
        env.oidcClientSecret,
        env.keycloakClientSecret,
        current.mainModel.apiKey,
        current.gateModel.apiKey,
        current.media.visionApiKey,
        current.media.audioApiKey,
      ];
    });

    const media = new MediaProcessor(store, gateway, getSettings);
    const services: AgentServices = {
      store,
      gateway,
      media,
      bunko,
      shortlink,
      directory,
      guild,
      mcp,
      getSettings,
    };

    const subagents = createDefaultSubagentRegistry();
    const mainTools = createDefaultMainToolRegistry(subagents);
    const agent = new BerryAgent(services, { subagents, mainTools });

    let workerRef: JobWorker;

    const gate = new MessageGate(
      store,
      classifier,
      gateway,
      media,
      directory,
      getSettings,
      () => workerRef.wake(),
    );
    const gatewayEvents = new GatewayEventSubscriber(
      env,
      store,
      gate,
      media,
      getSettings,
      () => gateway.clearLoginInfoCache(),
    );
    const scheduler = new ScheduleRunner(services, subagents, () =>
      workerRef.wake(),
    );
    const guildAutomation = new GuildAutomationRunner(
      env,
      guild,
      store,
      directory,
      gateway,
      bunko,
      shortlink,
      getSettings,
    );

    const jobs = createDefaultJobRegistry({
      gate,
      agent,
      scheduler,
      guildAutomation,
    });

    workerRef = new JobWorker(store, jobs);
    const auth = new AdminAuthService(env, store);

    const instance = new BerryApp({
      env,
      events,
      logs,
      store,
      settings,
      gateway,
      media,
      avatars,
      directory,
      guild,
      bunko,
      shortlink,
      mcp,
      classifier,
      gate,
      gatewayEvents,
      subagents,
      mainTools,
      agent,
      scheduler,
      guildAutomation,
      jobs,
      worker: workerRef,
      auth,
    });

    instanceRef = instance;

    if (options.startBackground !== false) {
      await mcp.sync(settings.mcpServers);
      gatewayEvents.start();
      workerRef.start();
      scheduler.start();
      guildAutomation.start();
    }

    return instance;
  }

  public async updateSettings(next: RuntimeSettings): Promise<RuntimeSettings> {
    const saved = await this.store.settings.save(next);

    this.settings = saved;
    await this.mcp.sync(saved.mcpServers);
    this.guildAutomation.syncState();

    return saved;
  }

  public async listen(
    webDistDir = resolve(import.meta.dirname, "../dist/web"),
  ): Promise<{ port: number; url: string }> {
    const httpApp = createHttpApp(this, webDistDir);
    const server = createServer(toNodeListener(httpApp));

    await new Promise<void>((_resolve, _reject) => {
      server.once("error", _reject);
      server.listen(this.env.port, this.env.host, () => {
        server.off("error", _reject);
        _resolve();
      });
    });

    this.#server = server;
    const addr = server.address();
    const port = addr && typeof addr === "object" ? addr.port : this.env.port;
    const url = `http://${this.env.host}:${port}`;

    this.#logger.info("berry listening", { url, dataDir: this.env.dataDir });

    return { port, url };
  }

  public async close(): Promise<void> {
    await this.gatewayEvents.stop();
    this.scheduler.stop();
    await this.guildAutomation.stop();
    await this.worker.stop();
    await this.media.close();
    await this.gateway.close();
    await this.mcp.close();
    this.logs.close();

    if (this.#server) {
      const srv = this.#server;

      this.#server = null;
      await new Promise<void>((_resolve) => {
        srv.close(() => _resolve());
        srv.closeAllConnections();
      });
    }

    await this.store.close();
  }
}
