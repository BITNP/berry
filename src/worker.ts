import type { BerryAgent } from "./agent/runner.ts";
import type { MessageGate } from "./gate/gate.ts";
import type { GuildAutomationRunner } from "./guild/automation.ts";
import type { ScheduleRunner } from "./scheduler/runner.ts";
import type { Store } from "./store/index.ts";
import type { JobKind, JobRecord } from "./types.ts";
import { Logger } from "./utils/logger.ts";
import { errorMessage } from "./utils/time.ts";

export class JobWorker {
  #store: Store;
  #gate: MessageGate;
  #agent: BerryAgent;
  #scheduler: ScheduleRunner;
  #guildAutomation: GuildAutomationRunner;
  #logger = new Logger("worker");
  #stopped = false;
  #running = new Map<string, number>();
  #invokeActive = false;
  #inFlight = new Set<Promise<void>>();
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    store: Store,
    gate: MessageGate,
    agent: BerryAgent,
    scheduler: ScheduleRunner,
    guildAutomation: GuildAutomationRunner,
  ) {
    this.#store = store;
    this.#gate = gate;
    this.#agent = agent;
    this.#scheduler = scheduler;
    this.#guildAutomation = guildAutomation;
  }

  public get running(): boolean {
    return !this.#stopped;
  }

  public start(): void {
    this.#stopped = false;
    this.wake();
    if (!this.#timer) {
      this.#timer = setInterval(() => this.wake(), 500);
      this.#timer.unref();
    }
  }

  public wake(): void {
    if (this.#stopped) {
      return;
    }

    // Single-consumer invoke lane enforces strict serialization of the global conversation.
    this.#spawnLane("gate_batch", ["gate_batch"], 2);
    this.#spawnLane("invoke", ["invoke"], 1);
    this.#spawnLane(
      "background",
      ["memory_update", "group_digest", "guild_task"],
      1,
    );
  }

  public async drainOnce(): Promise<void> {
    while (true) {
      const kinds: JobKind[] = this.#invokeActive
        ? ["gate_batch", "memory_update", "group_digest", "guild_task"]
        : [
            "gate_batch",
            "invoke",
            "memory_update",
            "group_digest",
            "guild_task",
          ];
      const job = await this.#store.jobs.claim(kinds, Date.now());

      if (!job) {
        return;
      }

      await this.#runOne(job);
    }
  }

  public async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }

    await Promise.all(this.#inFlight);
  }

  #spawnLane(lane: string, kinds: JobKind[], concurrency: number): void {
    while ((this.#running.get(lane) ?? 0) < concurrency && !this.#stopped) {
      this.#running.set(lane, (this.#running.get(lane) ?? 0) + 1);
      const task = this.#drainLane(kinds)
        .catch((error) => {
          this.#logger.warn("Worker lane error", {
            lane,
            error: errorMessage(error),
          });
        })
        .finally(() => {
          this.#running.set(lane, (this.#running.get(lane) ?? 1) - 1);
          this.#inFlight.delete(task);
        });

      this.#inFlight.add(task);
    }
  }

  async #drainLane(kinds: JobKind[]): Promise<void> {
    while (!this.#stopped) {
      const claimKinds =
        this.#invokeActive && kinds.includes("invoke")
          ? kinds.filter((k) => k !== "invoke")
          : kinds;

      if (claimKinds.length === 0) {
        return;
      }

      const job = await this.#store.jobs.claim(claimKinds, Date.now());

      if (!job) {
        return;
      }

      await this.#runOne(job);
    }
  }

  async #runOne(job: JobRecord): Promise<void> {
    if (job.kind === "invoke") {
      this.#invokeActive = true;
    }

    try {
      switch (job.kind) {
        case "gate_batch": {
          await this.#gate.processBatch(job as JobRecord<"gate_batch">);

          break;
        }

        case "invoke": {
          await this.#agent.invoke((job as JobRecord<"invoke">).payload);

          break;
        }

        case "memory_update": {
          const payload = (job as JobRecord<"memory_update">).payload;

          await this.#agent.updateMemoryFromMessage(
            payload.chatKey,
            payload.messageId,
          );

          break;
        }

        case "group_digest": {
          await this.#scheduler.runGroupDigest(
            job as JobRecord<"group_digest">,
          );

          break;
        }

        case "guild_task": {
          const { task } = (job as JobRecord<"guild_task">).payload;

          if (task === "due") {
            await this.#guildAutomation.runDueReminders();
          } else if (task === "assignments") {
            await this.#guildAutomation.runAssignments();
          } else {
            await this.#guildAutomation.runWeeklyReport();
          }

          break;
        }
      }

      await this.#store.jobs.done(job.id);
    } catch (error) {
      if (this.#stopped) {
        await this.#store.jobs.interrupt(job.id);

        return;
      }

      const msg = errorMessage(error);
      const nextState = await this.#store.jobs.retryOrFail(job, msg, true);

      this.#logger.warn("Job execution failed", {
        jobId: job.id,
        kind: job.kind,
        chatKey: job.chatKey,
        state: nextState,
        error: msg,
      });
    } finally {
      if (job.kind === "invoke") {
        this.#invokeActive = false;
      }
    }
  }
}
