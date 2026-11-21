import { EventSourceParserStream } from "eventsource-parser/stream";
import type { $Fetch } from "ofetch";
import { FetchError, ofetch } from "ofetch";

import type { EnvConfig } from "../config/env.ts";

export interface GuildNodeSummary {
  id: number;
  parentId: number | null;
  title: string;
  dueAt: string | null;
  completedAt: string | null;
  tags: string[];
  sortOrder: number;
  childCount: number;
  commentCount: number;
  myRelation: "leader" | "member" | null;
  updatedAt: string;
}

export interface GuildNodeTreeItem {
  id: number;
  title: string;
  completed: boolean;
  dueAt: string | null;
  tags: string[];
  childCount: number;
  commentCount: number;
  url: string;
  children: GuildNodeTreeItem[];
}

export interface GuildNodeDetail extends GuildNodeSummary {
  description: string;
  createdBySubject: string;
  breadcrumb: { id: number; title: string }[];
  directLeaders: { subject: string; userName: string }[];
  directMembers: { subject: string; userName: string }[];
  permissions: {
    canEdit: boolean;
    canDelete: boolean;
    canComment: boolean;
    canManageMembers: boolean;
    canAddChild: boolean;
  };
  children: GuildNodeSummary[];
}

export interface GuildCreateNodeInput {
  parentId: number | null;
  title: string;
  description?: string;
  dueAt?: string | null;
  tags?: string[];
  leaderSubjects?: string[];
  memberSubjects?: string[];
}

export interface GuildUpdateNodeInput {
  title: string;
  description: string;
  dueAt: string | null;
  tags: string[];
  completed: boolean;
}

export interface GuildReplaceMembersInput {
  leaders: string[];
  members: string[];
}

export interface GuildEvent {
  id: number;
  kind: string;
  nodeId: number | null;
  actorSubject: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface GuildEventListResponse {
  items: GuildEvent[];
  hasMore: boolean;
  nextAfter: number;
  latestId: number;
  serverTime: string;
}

export interface GuildDueNodeItem {
  id: number;
  parentId: number | null;
  title: string;
  dueAt: string;
  leaders: string[];
  members: string[];
  overdue: boolean;
}

export interface GuildDueNodesResponse {
  items: GuildDueNodeItem[];
  serverTime: string;
}

export interface GuildActivitySummaryNode {
  id: number;
  parentId: number | null;
  title: string;
  dueAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface GuildActivitySummaryComment {
  id: number;
  nodeId: number;
  nodeTitle: string;
  authorSubject: string;
  bodyPreview: string;
  createdAt: string;
}

export interface GuildActivitySummary {
  start: string;
  end: string;
  snapshotAt: string;
  createdCount: number;
  completedCount: number;
  commentCount: number;
  openCount: number;
  overdueCount: number;
  createdNodes: GuildActivitySummaryNode[];
  completedNodes: GuildActivitySummaryNode[];
  recentComments: GuildActivitySummaryComment[];
  overdueNodes: GuildActivitySummaryNode[];
}

export interface GuildDueNodesParams {
  since?: string;
  advanceHours?: number;
  dueAfter?: string;
  dueBefore?: string;
  includeOverdue?: boolean;
  limit?: number;
}

export interface GuildSseFrame {
  id?: string;
  event: string;
  data: string;
}

export class GuildInternalClient {
  #apiUrl: string;
  #token: string;
  #publicUrl: string;
  #api: $Fetch;

  constructor(
    env: Pick<
      EnvConfig,
      "guildApiUrl" | "guildInternalToken" | "guildPublicUrl"
    >,
  ) {
    this.#apiUrl = env.guildApiUrl.replace(/\/+$/, "");
    this.#token = env.guildInternalToken;
    this.#publicUrl = env.guildPublicUrl.replace(/\/+$/, "");
    this.#api = ofetch.create({
      baseURL: this.#apiUrl,
      timeout: 15_000,
      retry: 0,
      headers: { Authorization: `Bearer ${this.#token}` },
    });
  }

  public get enabled(): boolean {
    return Boolean(this.#apiUrl && this.#token);
  }

  public nodeUrl(nodeId: number): string {
    return this.#publicUrl
      ? `${this.#publicUrl}/nodes/${nodeId}`
      : `/nodes/${nodeId}`;
  }

  public listNodes(actorSubject: string): Promise<GuildNodeSummary[]> {
    return this.#request<GuildNodeSummary[]>(
      "GET",
      "/api/internal/nodes",
      actorSubject,
    );
  }

  public async listNodeTree(
    actorSubject: string,
    options: { rootId?: number; maxDepth?: number } = {},
  ): Promise<{
    totalNodes: number;
    rootCount: number;
    roots: GuildNodeTreeItem[];
  }> {
    const all = await this.listNodes(actorSubject);
    const byParent = new Map<number | null, GuildNodeSummary[]>();

    for (const node of all) {
      const siblings = byParent.get(node.parentId) ?? [];

      siblings.push(node);
      byParent.set(node.parentId, siblings);
    }

    for (const siblings of byParent.values()) {
      siblings.sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
    }

    const maxDepth = options.maxDepth ?? 6;
    const buildNode = (
      node: GuildNodeSummary,
      depth: number,
    ): GuildNodeTreeItem => {
      const kids =
        depth < maxDepth
          ? (byParent.get(node.id) ?? []).map((child) =>
              buildNode(child, depth + 1),
            )
          : [];

      return {
        id: node.id,
        title: node.title,
        completed: Boolean(node.completedAt),
        dueAt: node.dueAt,
        tags: node.tags,
        childCount: node.childCount,
        commentCount: node.commentCount,
        url: this.nodeUrl(node.id),
        children: kids,
      };
    };

    const topNodes =
      options.rootId === undefined
        ? (byParent.get(null) ?? [])
        : all.filter((n) => n.id === options.rootId);

    return {
      totalNodes: all.length,
      rootCount: (byParent.get(null) ?? []).length,
      roots: topNodes.map((root) => buildNode(root, 1)),
    };
  }

  public async searchNodes(
    actorSubject: string,
    query: string,
    limit = 100,
  ): Promise<(GuildNodeSummary & { pathTitles: string[]; url: string })[]> {
    const all = await this.listNodes(actorSubject);
    const byId = new Map(all.map((node) => [node.id, node]));
    const needle = query.trim().toLowerCase();

    const pathOf = (node: GuildNodeSummary): string[] => {
      const chain: string[] = [];
      let current: GuildNodeSummary | undefined = node;

      while (current) {
        chain.unshift(current.title);
        current =
          current.parentId === null ? undefined : byId.get(current.parentId);
      }

      return chain;
    };

    const matches = needle
      ? all.filter(
          (node) =>
            String(node.id) === needle ||
            node.title.toLowerCase().includes(needle) ||
            node.tags.some((tag) => tag.toLowerCase().includes(needle)),
        )
      : all;

    return matches.slice(0, limit).map((node) => ({
      ...node,
      pathTitles: pathOf(node),
      url: this.nodeUrl(node.id),
    }));
  }

  public async getNode(
    actorSubject: string,
    nodeId: number,
  ): Promise<GuildNodeDetail & { url: string }> {
    const detail = await this.#request<GuildNodeDetail>(
      "GET",
      `/api/internal/nodes/${nodeId}`,
      actorSubject,
    );

    return { ...detail, url: this.nodeUrl(detail.id) };
  }

  public listProgress(
    actorSubject: string,
    nodeId: number,
    limit = 20,
  ): Promise<unknown> {
    return this.#request<unknown>(
      "GET",
      `/api/internal/nodes/${nodeId}/progress?limit=${limit}`,
      actorSubject,
    );
  }

  public async createNode(
    actorSubject: string,
    input: GuildCreateNodeInput,
  ): Promise<GuildNodeDetail & { url: string }> {
    const detail = await this.#request<GuildNodeDetail>(
      "POST",
      "/api/internal/nodes",
      actorSubject,
      input,
    );

    return { ...detail, url: this.nodeUrl(detail.id) };
  }

  public async updateNode(
    actorSubject: string,
    nodeId: number,
    input: GuildUpdateNodeInput,
  ): Promise<GuildNodeDetail & { url: string }> {
    const detail = await this.#request<GuildNodeDetail>(
      "PUT",
      `/api/internal/nodes/${nodeId}`,
      actorSubject,
      input,
    );

    return { ...detail, url: this.nodeUrl(detail.id) };
  }

  public addComment(
    actorSubject: string,
    nodeId: number,
    body: string,
  ): Promise<{ id: number; body: string; createdAt: string }> {
    return this.#request<{ id: number; body: string; createdAt: string }>(
      "POST",
      `/api/internal/nodes/${nodeId}/comments`,
      actorSubject,
      { body, attachmentIds: [] },
    );
  }

  public async moveNode(
    actorSubject: string,
    nodeId: number,
    parentId: number | null,
  ): Promise<GuildNodeDetail & { url: string }> {
    const detail = await this.#request<GuildNodeDetail>(
      "PUT",
      `/api/internal/nodes/${nodeId}/move`,
      actorSubject,
      { parentId },
    );

    return { ...detail, url: this.nodeUrl(detail.id) };
  }

  public async replaceMembers(
    actorSubject: string,
    nodeId: number,
    input: GuildReplaceMembersInput,
  ): Promise<GuildNodeDetail & { url: string }> {
    const detail = await this.#request<GuildNodeDetail>(
      "PUT",
      `/api/internal/nodes/${nodeId}/members`,
      actorSubject,
      input,
    );

    return { ...detail, url: this.nodeUrl(detail.id) };
  }

  public listEvents(after = 0, limit = 50): Promise<GuildEventListResponse> {
    return this.#serviceGet<GuildEventListResponse>("/api/internal/events", {
      after,
      limit,
    });
  }

  public listDueNodes(
    query: GuildDueNodesParams = {},
  ): Promise<GuildDueNodesResponse> {
    return this.#serviceGet<GuildDueNodesResponse>(
      "/api/internal/due-nodes",
      Object.fromEntries(
        Object.entries(query).filter(([, value]) => value !== undefined),
      ),
    );
  }

  public getActivitySummary(
    start?: string,
    end?: string,
  ): Promise<GuildActivitySummary> {
    return this.#serviceGet<GuildActivitySummary>(
      "/api/internal/activity-summary",
      {
        ...(start ? { start } : {}),
        ...(end ? { end } : {}),
      },
    );
  }

  public async *streamEvents(
    after: number,
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncGenerator<GuildSseFrame> {
    this.assertEnabled();

    const res = await this.#api.raw("/api/internal/events/stream", {
      method: "GET",
      query: { after },
      headers: {
        "Accept": "text/event-stream",
        "Last-Event-ID": String(after),
      },
      responseType: "stream",
      timeout: undefined,
      signal,
      ignoreResponseError: true,
    });

    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as {
        message?: string;
        error?: string;
      };

      throw new Error(
        data.message || data.error || `Guild SSE HTTP ${res.status}`,
      );
    }

    if (!res.body) {
      throw new Error("Guild SSE response body is empty");
    }

    onOpen?.();

    const stream = res.body
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(new EventSourceParserStream());

    for await (const frame of stream) {
      yield {
        ...(frame.id === undefined ? {} : { id: frame.id }),
        event: frame.event || "message",
        data: frame.data,
      };
    }
  }

  #serviceGet<T>(
    path: string,
    query?: Record<string, string | number | boolean>,
  ): Promise<T> {
    return this.#fetchJson<T>("GET", path, { query });
  }

  #request<T>(
    method: string,
    path: string,
    actorSubject: string,
    body?: unknown,
  ): Promise<T> {
    return this.#fetchJson<T>(method, path, {
      headers: { "X-Act-As-Subject": actorSubject },
      body,
    });
  }

  public assertEnabled(): void {
    if (!this.enabled) {
      throw new Error(
        "Guild 内部服务接口未配置（BERRY_GUILD_API_URL / BERRY_GUILD_INTERNAL_TOKEN）",
      );
    }
  }

  async #fetchJson<T>(
    method: string,
    path: string,
    options: {
      query?: Record<string, string | number | boolean>;
      headers?: Record<string, string>;
      body?: unknown;
    } = {},
  ): Promise<T> {
    this.assertEnabled();

    try {
      return await this.#api<T>(path, {
        method,
        query: options.query,
        headers: options.headers,
        body: options.body === undefined ? undefined : (options.body as object),
      });
    } catch (error) {
      if (error instanceof FetchError && error.statusCode) {
        const data = error.data as { message?: string; error?: string } | null;

        throw new Error(
          data?.message || data?.error || `Guild API HTTP ${error.statusCode}`,
        );
      }

      throw error;
    }
  }
}
