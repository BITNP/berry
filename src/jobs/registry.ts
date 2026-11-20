import type {
  JobActionLink,
  JobKind,
  JobLane,
  JobPayload,
  JobRecord,
  JobTagType,
  JobTypeDescriptor,
  MessageRecord,
} from "../types.ts";

export interface JobSummaryContext {
  messagesById: ReadonlyMap<number, MessageRecord>;
}

export interface JobDefinition<K extends JobKind = JobKind> {
  readonly kind: K;
  readonly label: string;
  readonly lane: JobLane;
  readonly tagType: JobTagType;
  readonly execute: (job: JobRecord<K>) => Promise<void>;
  readonly referencedMessageIds?: (payload: JobPayload<K>) => number[];
  readonly summarize?: (job: JobRecord<K>, ctx: JobSummaryContext) => string;
  readonly links?: (job: JobRecord<K>) => JobActionLink[];
}

export interface DescribedJobMeta {
  label: string;
  lane: JobLane;
  tagType: JobTagType;
  summary: string;
  links: JobActionLink[];
}

export class JobRegistry {
  #definitions = new Map<string, JobDefinition<any>>();

  public register<K extends JobKind>(definition: JobDefinition<K>): this {
    const kind = definition.kind.trim();

    if (!kind) {
      throw new Error("Job kind must be non-empty");
    }

    if (this.#definitions.has(kind)) {
      throw new Error(`Duplicate job registration: ${kind}`);
    }

    this.#definitions.set(kind, definition);

    return this;
  }

  public get(kind: string): JobDefinition | undefined {
    return this.#definitions.get(kind);
  }

  public list(): JobDefinition[] {
    return [...this.#definitions.values()];
  }

  public descriptors(): JobTypeDescriptor[] {
    return this.list().map((def) => ({
      kind: def.kind,
      label: def.label,
      lane: def.lane,
      tagType: def.tagType,
    }));
  }

  public kindsForLane(lane: JobLane): JobKind[] {
    return this.list()
      .filter((def) => def.lane === lane)
      .map((def) => def.kind);
  }

  public allKinds(): JobKind[] {
    return [...this.#definitions.keys()];
  }

  public collectMessageIds(jobs: readonly JobRecord[]): number[] {
    const ids = new Set<number>();

    for (const job of jobs) {
      const def = this.#definitions.get(job.kind);

      if (!def?.referencedMessageIds) {
        continue;
      }

      for (const id of def.referencedMessageIds(job.payload)) {
        if (Number.isInteger(id) && id > 0) {
          ids.add(id);
        }
      }
    }

    return [...ids];
  }

  public describeJob(job: JobRecord, ctx: JobSummaryContext): DescribedJobMeta {
    const def = this.#definitions.get(job.kind);

    if (!def) {
      return {
        label: job.kind,
        lane: "background",
        tagType: "default",
        summary: job.chatKey,
        links: defaultChatLinks(job.chatKey),
      };
    }

    return {
      label: def.label,
      lane: def.lane,
      tagType: def.tagType,
      summary: def.summarize ? def.summarize(job, ctx) : def.label,
      links: def.links ? def.links(job) : defaultChatLinks(job.chatKey),
    };
  }
}

export function defaultChatLinks(chatKey: string): JobActionLink[] {
  if (!chatKey.startsWith("group:") && !chatKey.startsWith("private:")) {
    return [];
  }

  const encoded = encodeURIComponent(chatKey);

  return [
    { label: "查看该会话 AI 调用", to: `/ai?chatKey=${encoded}` },
    { label: "查看会话消息", to: `/chats?chat=${encoded}` },
  ];
}
