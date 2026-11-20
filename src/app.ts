import type { Server } from "node:http";
import { createServer } from "node:http";
import { resolve } from "node:path";

import { toNodeListener } from "h3";

import type { AgentServices } from "./agent/loop.ts";
import { BerryAgent } from "./agent/runner.ts";
import type { EnvConfig } from "./config/env.ts";
import type { RuntimeSettings } from "./config/settings.ts";
import { SmallModelClassifier } from "./gate/classifier.ts";
import { MessageGate } from "./gate/gate.ts";
import { MessageGatewayClient } from "./gateway/client.ts";
import { GatewayEventSubscriber } from "./gateway/events.ts";
import { GuildAutomationRunner } from "./guild/automation.ts";
import { GuildInternalClient } from "./guild/client.ts";
import { IdentityDirectory } from "./identity/keycloak.ts";
import { KnowledgeBase } from "./knowledge/files.ts";
import { McpHub } from "./mcp/hub.ts";
import { MediaProcessor } from "./media/processor.ts";
import { ScheduleRunner } from "./scheduler/runner.ts";
import { AdminAuthService } from "./server/auth.ts";
import { AvatarCache } from "./server/avatars.ts";
import { createHttpApp } from "./server/routes.ts";
import { Store } from "./store/index.ts";
import { EventBus, LogHub, Logger } from "./utils/logger.ts";
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
  public readonly knowledge: KnowledgeBase;
  public readonly mcp: McpHub;
  public readonly classifier: SmallModelClassifier;
  public readonly gate: MessageGate;
  public readonly gatewayEvents: GatewayEventSubscriber;
  public readonly agent: BerryAgent;
  public readonly scheduler: ScheduleRunner;
  public readonly guildAutomation: GuildAutomationRunner;
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
    knowledge: KnowledgeBase;
    mcp: McpHub;
    classifier: SmallModelClassifier;
    gate: MessageGate;
    gatewayEvents: GatewayEventSubscriber;
    agent: BerryAgent;
    scheduler: ScheduleRunner;
    guildAutomation: GuildAutomationRunner;
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
    this.knowledge = options.knowledge;
    this.mcp = options.mcp;
    this.classifier = options.classifier;
    this.gate = options.gate;
    this.gatewayEvents = options.gatewayEvents;
    this.agent = options.agent;
    this.scheduler = options.scheduler;
    this.guildAutomation = options.guildAutomation;
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

    const gateway = new MessageGatewayClient(env, store);
    const avatars = new AvatarCache(store);
    const directory = new IdentityDirectory(env);
    const guild = new GuildInternalClient(env);
    const knowledge = new KnowledgeBase(store.knowledgeDir, store.notebookDir);
    const mcp = new McpHub();
    const classifier = new SmallModelClassifier(store);

    let activeSettings = settings;
    const getSettings = () => activeSettings;

    logs.setSecretProvider(() => [
      env.gatewayToken,
      env.guildInternalToken,
      env.oidcClientSecret,
      env.keycloakClientSecret,
      activeSettings.mainModel.apiKey,
      activeSettings.gateModel.apiKey,
      activeSettings.media.visionApiKey,
      activeSettings.media.audioApiKey,
    ]);

    const media = new MediaProcessor(store, gateway, getSettings);
    const services: AgentServices = {
      store,
      gateway,
      media,
      knowledge,
      directory,
      guild,
      mcp,
      getSettings,
    };

    const agent = new BerryAgent(services);

    let workerRef: JobWorker;

    const gate = new MessageGate(
      store,
      classifier,
      gateway,
      media,
      getSettings,
      () => workerRef.wake(),
    );
    const gatewayEvents = new GatewayEventSubscriber(
      env,
      store,
      gate,
      media,
      getSettings,
    );
    const scheduler = new ScheduleRunner(services, () => workerRef.wake());
    const guildAutomation = new GuildAutomationRunner(
      env,
      guild,
      store,
      directory,
      gateway,
      knowledge,
      mcp,
      getSettings,
    );

    workerRef = new JobWorker(store, gate, agent, scheduler);
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
      knowledge,
      mcp,
      classifier,
      gate,
      gatewayEvents,
      agent,
      scheduler,
      guildAutomation,
      worker: workerRef,
      auth,
    });

    instance.updateSettings = async (next: RuntimeSettings) => {
      const saved = await store.settings.save(next);

      activeSettings = saved;
      instance.settings = saved;
      await mcp.sync(saved.mcpServers);
      guildAutomation.syncState();

      return saved;
    };

    if (options.startBackground !== false) {
      await mcp.sync(settings.mcpServers);
      gatewayEvents.start();
      workerRef.start();
      scheduler.start();
      guildAutomation.start();
    }

    return instance;
  }

  public updateSettings: (next: RuntimeSettings) => Promise<RuntimeSettings> =
    async (next) => next;

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
      await new Promise<void>((_resolve) => srv.close(() => _resolve()));
    }

    await this.store.close();
  }
}
