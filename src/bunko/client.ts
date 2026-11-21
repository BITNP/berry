import type { $Fetch } from "ofetch";
import { ofetch } from "ofetch";

import type { EnvConfig } from "../config/env.ts";

export interface BunkoFolderView {
  id: string;
  name: string;
  isPrivate: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface BunkoDocumentView {
  id: string;
  title: string;
  isPublic: boolean;
  isPrivate: boolean;
  folderId: string | null;
  updatedAt: string;
  version: number;
}

export interface BunkoAliasView {
  id: string;
  name: string;
  folderId: string;
  target: {
    documentId: string;
    title: string;
    targetDeleted: boolean;
    accessible: boolean;
    folderId: string | null;
  };
  updatedAt: string;
}

export interface BunkoCrumb {
  id: string | null;
  name: string;
}

export interface BunkoListing {
  folder: BunkoFolderView | null;
  breadcrumb: BunkoCrumb[];
  folders: BunkoFolderView[];
  documents: BunkoDocumentView[];
  aliases: BunkoAliasView[];
}

export interface BunkoDocumentContent {
  markdown: string;
  materialized: boolean;
  version: number;
  headVersion: number;
  stale: boolean;
}

export interface BunkoAccessRule {
  principalType: string;
  principalId: string;
  permission: string;
  label?: string;
}

export interface BunkoDocumentAccess {
  custom: boolean;
  rules: BunkoAccessRule[];
  isPublic: boolean;
  isPrivate: boolean;
  folderId: string | null;
}

export interface BunkoAclEntry {
  id: string;
  resourceType: string;
  resourceId: string;
  principalType: string;
  principalId: string;
  permission: string;
}

export interface BunkoFolderSummary {
  id: string;
  name: string;
  path: string;
  isPrivate: boolean;
}

export class BunkoApiError extends Error {
  public readonly status: number;
  public readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "BunkoApiError";
    this.status = status;
    this.code = code;
  }
}

export class BunkoClient {
  #apiUrl: string;
  #apiKey: string;
  #publicUrl: string;
  #workspaceSlug: string;
  #api: $Fetch;

  constructor(
    env: Pick<
      EnvConfig,
      "bunkoApiUrl" | "bunkoApiKey" | "bunkoPublicUrl" | "bunkoWorkspaceSlug"
    >,
  ) {
    this.#apiUrl = env.bunkoApiUrl.replace(/\/+$/, "");
    this.#apiKey = env.bunkoApiKey.trim();
    this.#publicUrl = (env.bunkoPublicUrl || env.bunkoApiUrl).replace(
      /\/+$/,
      "",
    );
    this.#workspaceSlug = env.bunkoWorkspaceSlug.trim() || "bitnp";
    this.#api = ofetch.create({
      baseURL: this.#apiUrl ? `${this.#apiUrl}/api/v1` : "",
      timeout: 20_000,
      retry: 0,
      headers: {
        Accept: "application/json",
      },
    });
  }

  public get enabled(): boolean {
    return Boolean(this.#apiUrl && this.#apiKey);
  }

  public get publicUrl(): string {
    return this.#publicUrl;
  }

  public get workspaceSlug(): string {
    return this.#workspaceSlug;
  }

  public docUrl(docId: string): string {
    if (!this.#publicUrl || !docId) {
      return "";
    }

    return `${this.#publicUrl}/${this.#workspaceSlug}/doc/${encodeURIComponent(docId)}`;
  }

  public workspaceUrl(): string {
    if (!this.#publicUrl) {
      return "";
    }

    return `${this.#publicUrl}/${this.#workspaceSlug}`;
  }

  public async listTree(folderId?: string | null): Promise<BunkoListing> {
    const query = folderId?.trim() ? { folderId: folderId.trim() } : undefined;
    const raw = await this.#request<Partial<BunkoListing>>("/tree", { query });

    return {
      folder: raw.folder ?? null,
      breadcrumb: raw.breadcrumb ?? [],
      folders: raw.folders ?? [],
      documents: raw.documents ?? [],
      aliases: raw.aliases ?? [],
    };
  }

  public async listAllFolders(maxFolders = 200): Promise<BunkoFolderSummary[]> {
    const result: BunkoFolderSummary[] = [];
    const queue: { id: string | null; prefix: string }[] = [
      { id: null, prefix: "" },
    ];
    const visited = new Set<string>();

    while (queue.length > 0 && result.length < maxFolders) {
      const current = queue.shift()!;
      const listing = await this.listTree(current.id);

      for (const folder of listing.folders) {
        if (visited.has(folder.id)) {
          continue;
        }

        visited.add(folder.id);
        const path = current.prefix
          ? `${current.prefix}/${folder.name}`
          : folder.name;

        result.push({
          id: folder.id,
          name: folder.name,
          path,
          isPrivate: Boolean(folder.isPrivate),
        });
        queue.push({ id: folder.id, prefix: path });

        if (result.length >= maxFolders) {
          break;
        }
      }
    }

    return result;
  }

  public async getBreadcrumb(documentId: string): Promise<BunkoCrumb[]> {
    const res = await this.#request<{ breadcrumb?: BunkoCrumb[] }>(
      "/tree/path",
      {
        query: { documentId },
      },
    );

    return res.breadcrumb ?? [];
  }

  public async getDocument(documentId: string): Promise<BunkoDocumentView> {
    const res = await this.#request<{ document: BunkoDocumentView }>(
      `/documents/${encodeURIComponent(documentId)}`,
    );

    return res.document;
  }

  public getContent(documentId: string): Promise<BunkoDocumentContent> {
    return this.#request<BunkoDocumentContent>(
      `/documents/${encodeURIComponent(documentId)}/content`,
    );
  }

  public getDocumentAccess(documentId: string): Promise<BunkoDocumentAccess> {
    return this.#request<BunkoDocumentAccess>(
      `/documents/${encodeURIComponent(documentId)}/access`,
    );
  }

  public async listAcl(
    resourceType: "folder" | "document",
    resourceId: string,
  ): Promise<BunkoAclEntry[]> {
    const res = await this.#request<{ items?: BunkoAclEntry[] }>("/acl", {
      query: { resourceType, resourceId },
    });

    return res.items ?? [];
  }

  public async createDocument(input: {
    title: string;
    folderId?: string | null;
    markdown?: string;
  }): Promise<BunkoDocumentView> {
    const body: Record<string, unknown> = {
      title: input.title.trim(),
    };

    if (input.folderId?.trim()) {
      body.folderId = input.folderId.trim();
    }

    if (input.markdown?.trim()) {
      body.markdown = input.markdown;
    }

    const res = await this.#request<{ document: BunkoDocumentView }>(
      "/documents",
      {
        method: "POST",
        body,
      },
    );

    return res.document;
  }

  public appendContent(
    documentId: string,
    markdown: string,
    idempotencyKey: string,
  ): Promise<{ version: number }> {
    const key = idempotencyKey.trim();

    if (!key || Buffer.byteLength(key, "utf8") > 128) {
      throw new Error("Idempotency-Key 必须为 1 至 128 字节的 UTF-8 字符串");
    }

    return this.#request<{ version: number }>(
      `/documents/${encodeURIComponent(documentId)}/content/append`,
      {
        method: "POST",
        headers: {
          "Idempotency-Key": key,
        },
        body: { markdown },
      },
    );
  }

  public deleteDocument(
    documentId: string,
  ): Promise<{ deleted: boolean; hard: boolean }> {
    return this.#request<{ deleted: boolean; hard: boolean }>(
      `/documents/${encodeURIComponent(documentId)}`,
      {
        method: "DELETE",
      },
    );
  }

  public async canStandardUserRead(
    documentId: string,
    admitted: boolean,
  ): Promise<boolean> {
    const access = await this.getDocumentAccess(documentId);

    if (access.isPublic) {
      return true;
    }

    if (!admitted || access.isPrivate) {
      return false;
    }

    if (access.custom) {
      const memberAllRules = access.rules.filter(
        (rule) => rule.principalType === "member" && rule.principalId === "all",
      );

      if (memberAllRules.some((rule) => rule.permission === "deny")) {
        return false;
      }

      return memberAllRules.length > 0;
    }

    const crumbs = await this.getBreadcrumb(documentId);

    for (const crumb of crumbs) {
      if (!crumb.id) {
        continue;
      }

      const folderListing = await this.listTree(crumb.id);

      if (folderListing.folder?.isPrivate) {
        return false;
      }
    }

    return true;
  }

  public async publishOrAppend(input: {
    title: string;
    folderId?: string | null;
    markdown: string;
    idempotencyKey: string;
  }): Promise<{
    documentId: string;
    title: string;
    url: string;
    created: boolean;
    version: number;
  }> {
    const folderId = input.folderId?.trim() || null;

    try {
      const created = await this.createDocument({
        title: input.title,
        folderId,
        markdown: input.markdown,
      });

      return {
        documentId: created.id,
        title: created.title,
        url: this.docUrl(created.id),
        created: true,
        version: created.version,
      };
    } catch (error) {
      if (!(error instanceof BunkoApiError) || error.status !== 409) {
        throw error;
      }

      const listing = await this.listTree(folderId);
      const needle = input.title.trim().toLowerCase();
      const existing = listing.documents.find(
        (doc) => doc.title.trim().toLowerCase() === needle,
      );

      if (!existing) {
        throw error;
      }

      const appended = await this.appendContent(
        existing.id,
        input.markdown,
        input.idempotencyKey,
      );

      return {
        documentId: existing.id,
        title: existing.title,
        url: this.docUrl(existing.id),
        created: false,
        version: appended.version,
      };
    }
  }

  async #request<T>(
    path: string,
    options: {
      method?: string;
      query?: Record<string, string>;
      headers?: Record<string, string>;
      body?: Record<string, unknown>;
    } = {},
  ): Promise<T> {
    if (!this.enabled) {
      throw new Error(
        "Bunko 云文档未配置（BERRY_BUNKO_API_URL / BERRY_BUNKO_API_KEY）",
      );
    }

    const res = await this.#api.raw<T>(path, {
      method: options.method ?? "GET",
      query: options.query,
      headers: {
        Authorization: `Bearer ${this.#apiKey}`,
        ...options.headers,
      },
      body: options.body,
      ignoreResponseError: true,
    });

    if (!res.ok) {
      const errBody = res._data as
        { code?: string; message?: string; error?: string } | undefined;
      const code = errBody?.code ?? `http_${res.status}`;
      const message =
        errBody?.message ?? errBody?.error ?? `Bunko API HTTP ${res.status}`;

      throw new BunkoApiError(res.status, code, message);
    }

    return res._data as T;
  }
}
