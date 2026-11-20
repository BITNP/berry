import type { JobRegistry } from "./jobs/registry.ts";
import type { Store } from "./store/index.ts";
import type { JobKind, JobRecord } from "./types.ts";
import { Logger } from "./utils/logger.ts";
import { errorMessage } from "./utils/time.ts";

export class JobWorker {
  #store: Store;
  #registry: JobRegistry;
  #logger = new Logger("worker");
  #stopped = false;
  #running = new Map<string, number>();
  #dialogActive = false;
  #inFlight = new Set<Promise<void>>();
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(store: Store, registry: JobRegistry) {
    this.#store = store;
    this.#registry = registry;
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

    // Single-consumer dialog lane enforces strict serialization of the global conversation.
    this.#spawnLane("gate", this.#registry.kindsForLane("gate"), 2);
    this.#spawnLane("dialog", this.#registry.kindsForLane("dialog"), 1);
    this.#spawnLane("background", this.#registry.kindsForLane("background"), 1);
  }

  public async drainOnce(): Promise<void> {
    while (true) {
      const dialogKinds = new Set(this.#registry.kindsForLane("dialog"));
      const kinds = this.#dialogActive
        ? this.#registry.allKinds().filter((kind) => !dialogKinds.has(kind))
        : this.#registry.allKinds();
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
    if (kinds.length === 0) {
      return;
    }

    while ((this.#running.get(lane) ?? 0) < concurrency && !this.#stopped) {
      this.#running.set(lane, (this.#running.get(lane) ?? 0) + 1);
      const task = this.#drainLane(lane, kinds)
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

  async #drainLane(lane: string, kinds: JobKind[]): Promise<void> {
    while (!this.#stopped) {
      if (lane === "dialog" && this.#dialogActive) {
        return;
      }

      const job = await this.#store.jobs.claim(kinds, Date.now());

      if (!job) {
        return;
      }

      await this.#runOne(job);
    }
  }

  async #runOne(job: JobRecord): Promise<void> {
    const def = this.#registry.get(job.kind);
    const isDialog = def?.lane === "dialog";

    if (isDialog) {
      this.#dialogActive = true;
    }

    try {
      if (!def) {
        throw new Error(`Unknown job kind: ${job.kind}`);
      }

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
      if (isDialog) {
        this.#dialogActive = false;
      }
    }
  }
}
