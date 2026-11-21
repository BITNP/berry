import type { EventBus } from "../utils/logger.ts";
import { AssetsStore } from "./assets.ts";
import { GuildAuditStore } from "./audit.ts";
import { ChatsStore } from "./chats.ts";
import { ConversationsStore } from "./conversations.ts";
import { CursorsStore } from "./cursors.ts";
import { BerryDatabase } from "./database.ts";
import { DeliveriesStore } from "./deliveries.ts";
import { GateDecisionsStore } from "./gate.ts";
import { JobsStore } from "./jobs.ts";
import { MaintenanceStore } from "./maintenance.ts";
import { MemoriesStore } from "./memories.ts";
import { MessagesStore } from "./messages.ts";
import { ReactionsStore } from "./reactions.ts";
import { SchedulesStore } from "./schedules.ts";
import { AdminSessionsStore } from "./sessions.ts";
import { SettingsStore } from "./settings.ts";
import { UsageStore } from "./usage.ts";

export class Store {
  public readonly database: BerryDatabase;
  public readonly settings: SettingsStore;
  public readonly chats: ChatsStore;
  public readonly messages: MessagesStore;
  public readonly assets: AssetsStore;
  public readonly reactions: ReactionsStore;
  public readonly gate: GateDecisionsStore;
  public readonly conversations: ConversationsStore;
  public readonly memories: MemoriesStore;
  public readonly jobs: JobsStore;
  public readonly deliveries: DeliveriesStore;
  public readonly schedules: SchedulesStore;
  public readonly cursors: CursorsStore;
  public readonly guildAudit: GuildAuditStore;
  public readonly usage: UsageStore;
  public readonly maintenance: MaintenanceStore;
  public readonly sessions: AdminSessionsStore;

  private constructor(database: BerryDatabase, events: EventBus) {
    this.database = database;
    this.settings = new SettingsStore(database);
    this.chats = new ChatsStore(database);
    this.messages = new MessagesStore(database, events);
    this.assets = new AssetsStore(database);
    this.reactions = new ReactionsStore(database);
    this.gate = new GateDecisionsStore(database, events);
    this.conversations = new ConversationsStore(database, events);
    this.memories = new MemoriesStore(database, events);
    this.jobs = new JobsStore(database, events);
    this.deliveries = new DeliveriesStore(database, events);
    this.schedules = new SchedulesStore(database, events);
    this.cursors = new CursorsStore(database);
    this.guildAudit = new GuildAuditStore(database, events);
    this.usage = new UsageStore(database, events);
    this.maintenance = new MaintenanceStore(database);
    this.sessions = new AdminSessionsStore(database);
  }

  public static async open(dataDir: string, events: EventBus): Promise<Store> {
    const database = await BerryDatabase.open(dataDir);

    return new Store(database, events);
  }

  public get knowledgeDir(): string {
    return this.database.knowledgeDir;
  }

  public get assetsDir(): string {
    return this.database.assetsDir;
  }

  public get avatarsDir(): string {
    return this.database.avatarsDir;
  }

  public close(): Promise<void> {
    return this.database.close();
  }
}
