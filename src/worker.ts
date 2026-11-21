import type { JobRegistry } from "./jobs/registry.ts";
import type { Store } from "./store/index.ts";
import type { JobKind, JobRecord } from "./types.ts";
import { Logger } from "./utils/logger.ts";
import { errorMessage } from "./utils/time.ts";

const GATE_LANE_CONCURRENCY = 4;
const DIALOG_LANE_CONCURRENCY = 4;
const BACKGROUND_LANE_CONCURRENCY = 3;

export class JobWorker {
  #store: Store;
  #registry: JobRegistry;
  #logger = new Logger("worker");
  #started = false;
  #stopped = false;
  #running = new Map<string, number>();
  #inFlight = new Set<Promise<void>>();
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(store: Store, registry: JobRegistry) {
    this.#store = store;
    this.#registry = registry;
  }

  public get running(): boolean {
    return this.#started && !this.#stopped;
  }

  public start(): void {
    this.#started = true;
    this.#stopped = false;
    this.wake();
    if (!this.#timer) {
      this.#timer = setInterval(() => this.wake(), 500);
      this.#timer.unref();
    }
  }

  public wake(): void {
    if (!this.#started || this.#stopped) {
      return;
    }

    // Serialize per chatKey while allowing distinct chats to execute concurrently
    // against the shared global timeline.
    this.#spawnLane(
      "gate",
      this.#registry.kindsForLane("gate"),
      GATE_LANE_CONCURRENCY,
      true,
    );
    this.#spawnLane(
      "dialog",
      this.#registry.kindsForLane("dialog"),
      DIALOG_LANE_CONCURRENCY,
      true,
    );
    this.#spawnLane(
      "background",
      this.#registry.kindsForLane("background"),
      BACKGROUND_LANE_CONCURRENCY,
      false,
    );
  }

  public async drainOnce(): Promise<void> {
    while (true) {
      const job = await this.#store.jobs.claim(
        this.#registry.allKinds(),
        Date.now(),
      );

      if (!job) {
        return;
      }

      await this.#runOne(job, false);
    }
  }

  public async stop(): Promise<void> {
    this.#started = false;
    this.#stopped = true;
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }

    await Promise.all(this.#inFlight);
  }

  #spawnLane(
    lane: string,
    kinds: JobKind[],
    concurrency: number,
    serializeByChatKey: boolean,
  ): void {
    if (kinds.length === 0) {
      return;
    }

    while ((this.#running.get(lane) ?? 0) < concurrency && !this.#stopped) {
      this.#running.set(lane, (this.#running.get(lane) ?? 0) + 1);
      const task = this.#drainLane(kinds, serializeByChatKey)
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

  async #drainLane(
    kinds: JobKind[],
    serializeByChatKey: boolean,
  ): Promise<void> {
    while (!this.#stopped) {
      const job = await this.#store.jobs.claim(kinds, Date.now(), {
        serializeByChatKey,
      });

      if (!job) {
        return;
      }

      await this.#runOne(job, true);
    }
  }

  async #runOne(job: JobRecord, triggerWake: boolean): Promise<void> {
    const def = this.#registry.get(job.kind);

    if (!def) {
      throw new Error(`Unknown job kind: ${job.kind}`);
    }

    try {
      await def.execute(job);
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
      if (triggerWake && !this.#stopped) {
        this.wake();
      }
    }
  }
}
