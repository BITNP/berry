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

export class GuildInternalClient {
  #apiUrl: string;
  #token: string;
  #publicUrl: string;

  constructor(
    env: Pick<
      EnvConfig,
      "guildApiUrl" | "guildInternalToken" | "guildPublicUrl"
    >,
  ) {
    this.#apiUrl = env.guildApiUrl.replace(/\/+$/, "");
    this.#token = env.guildInternalToken;
    this.#publicUrl = env.guildPublicUrl.replace(/\/+$/, "");
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

  public async searchNodes(
    actorSubject: string,
    query: string,
  ): Promise<(GuildNodeSummary & { pathTitles: string[]; url: string })[]> {
    const all = await this.listNodes(actorSubject);
    const byId = new Map(all.map((node) => [node.id, node]));
    const needle = query.trim().toLowerCase();

    const pathOf = (node: GuildNodeSummary): string[] => {
      const chain: string[] = [];
      let current: GuildNodeSummary | undefined = node;
      let guard = 0;

      while (current && guard++ < 30) {
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
      : all.slice(0, 30);

    return matches.slice(0, 30).map((node) => ({
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

  public listUsers(
    actorSubject: string,
  ): Promise<{ subject: string; userName: string }[]> {
    return this.#request<{ subject: string; userName: string }[]>(
      "GET",
      "/api/internal/users",
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

  public async replaceMembers(
    actorSubject: string,
    nodeId: number,
    leaders: string[],
    members: string[],
  ): Promise<GuildNodeDetail & { url: string }> {
    const detail = await this.#request<GuildNodeDetail>(
      "PUT",
      `/api/internal/nodes/${nodeId}/members`,
      actorSubject,
      { leaders, members },
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

  async #request<T>(
    method: string,
    path: string,
    actorSubject: string,
    body?: unknown,
  ): Promise<T> {
    if (!this.enabled) {
      throw new Error(
        "Guild 内部服务接口未配置（BERRY_GUILD_API_URL / BERRY_GUILD_INTERNAL_TOKEN）",
      );
    }

    const res = await fetch(`${this.#apiUrl}${path}`, {
      method,
      headers: {
        "Authorization": `Bearer ${this.#token}`,
        "X-Act-As-Subject": actorSubject,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });

    const data = (await res.json().catch(() => ({}))) as {
      message?: string;
      error?: string;
    };

    if (!res.ok) {
      throw new Error(
        data.message || data.error || `Guild API HTTP ${res.status}`,
      );
    }

    return data as T;
  }
}
