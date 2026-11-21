import { LRUCache } from "lru-cache";
import type { $Fetch, FetchResponse } from "ofetch";
import { FetchError, ofetch } from "ofetch";

import type { EnvConfig } from "../config/env.ts";
import { Logger } from "../utils/logger.ts";
import type { BerryPermissions } from "./permissions.ts";
import { permissionsFromRoles } from "./permissions.ts";

export interface DirectoryUser {
  subject: string;
  username: string;
  name: string;
  qq: string | null;
  enabled: boolean;
  permissions: BerryPermissions;
}

const POSITIVE_TTL_MS = 5 * 60 * 1000;
const NEGATIVE_TTL_MS = 30 * 1000;
const MAX_CACHE_SIZE = 2000;

interface CachedDirectoryUser {
  user: DirectoryUser | null;
}

interface KeycloakUserRaw {
  id: string;
  username?: string;
  firstName?: string;
  lastName?: string;
  enabled?: boolean;
  attributes?: Record<string, string[]>;
}

export class IdentityDirectory {
  #adminUrl: string;
  #adminApi: $Fetch;
  #tokenUrl: string;
  #clientId: string;
  #clientSecret: string;
  #qqAttr: string;
  #logger = new Logger("identity:keycloak");
  #token = "";
  #tokenExpiresAt = 0;
  #bySubject = new LRUCache<string, CachedDirectoryUser>({
    max: MAX_CACHE_SIZE,
    ttl: POSITIVE_TTL_MS,
  });

  #byQQ = new LRUCache<string, CachedDirectoryUser>({
    max: MAX_CACHE_SIZE,
    ttl: POSITIVE_TTL_MS,
  });

  constructor(
    env: Pick<
      EnvConfig,
      | "keycloakAdminUrl"
      | "keycloakClientId"
      | "keycloakClientSecret"
      | "keycloakQqAttr"
      | "oidcIssuer"
    >,
  ) {
    this.#adminUrl = env.keycloakAdminUrl.replace(/\/+$/, "");
    this.#adminApi = ofetch.create({
      baseURL: this.#adminUrl,
      timeout: 10_000,
      retry: 0,
      headers: { Accept: "application/json" },
    });
    const issuerBase =
      env.oidcIssuer || this.#adminUrl.replace(/\/admin\/realms\//, "/realms/");

    this.#tokenUrl = issuerBase
      ? `${issuerBase.replace(/\/+$/, "")}/protocol/openid-connect/token`
      : "";
    this.#clientId = env.keycloakClientId;
    this.#clientSecret = env.keycloakClientSecret;
    this.#qqAttr = env.keycloakQqAttr || "qq_number";
  }

  public get enabled(): boolean {
    return Boolean(
      this.#adminUrl && this.#tokenUrl && this.#clientId && this.#clientSecret,
    );
  }

  public async bySubject(subject: string): Promise<DirectoryUser | null> {
    if (!this.enabled || !subject) {
      return null;
    }

    const cached = this.#bySubject.get(subject);

    if (cached !== undefined) {
      return cached.user;
    }

    const res = await this.#adminGet<KeycloakUserRaw>(
      `/users/${encodeURIComponent(subject)}`,
    );

    if (res.status === 404) {
      this.#bySubject.set(subject, { user: null }, { ttl: NEGATIVE_TTL_MS });

      return null;
    }

    if (!res.ok || !res._data) {
      throw new Error(`Keycloak user lookup failed: HTTP ${res.status}`);
    }

    const resolved =
      res._data.enabled === false ? null : await this.#hydrateUser(res._data);

    this.#bySubject.set(
      subject,
      { user: resolved },
      { ttl: resolved ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS },
    );

    return resolved;
  }

  public async byQQ(qq: string): Promise<DirectoryUser | null> {
    const clean = qq.trim();

    if (!this.enabled || !/^\d+$/.test(clean)) {
      return null;
    }

    const cached = this.#byQQ.get(clean);

    if (cached !== undefined) {
      return cached.user;
    }

    const res = await this.#adminGet<KeycloakUserRaw[]>("/users", {
      q: `${this.#qqAttr}:${clean}`,
      exact: "true",
      max: 5,
    });

    if (!res.ok) {
      throw new Error(`Keycloak QQ lookup failed: HTTP ${res.status}`);
    }

    const candidates = res._data ?? [];
    const matchedRaws = candidates.filter(
      (raw) => raw.enabled !== false && this.#extractQQ(raw) === clean,
    );

    if (matchedRaws.length > 1) {
      this.#logger.warn(
        "Ambiguous Keycloak QQ binding; refusing identity resolution",
        { matchCount: matchedRaws.length },
      );
      this.#byQQ.set(clean, { user: null }, { ttl: NEGATIVE_TTL_MS });

      return null;
    }

    const matched =
      matchedRaws.length === 1
        ? await this.#hydrateUser(matchedRaws[0]!)
        : null;

    this.#byQQ.set(
      clean,
      { user: matched },
      { ttl: matched ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS },
    );
    if (matched) {
      this.#bySubject.set(
        matched.subject,
        { user: matched },
        { ttl: POSITIVE_TTL_MS },
      );
    }

    return matched;
  }

  public async searchMembers(query: string): Promise<DirectoryUser[]> {
    const trimmed = query.trim();

    if (!this.enabled || !trimmed) {
      return [];
    }

    if (/^\d{5,15}$/.test(trimmed)) {
      const exact = await this.byQQ(trimmed);

      if (exact) {
        return [exact];
      }
    }

    const res = await this.#adminGet<KeycloakUserRaw[]>("/users", {
      search: trimmed,
      max: 15,
    });

    if (!res.ok) {
      throw new Error(`Keycloak member search failed: HTTP ${res.status}`);
    }

    const rows = res._data ?? [];
    const users: DirectoryUser[] = [];

    for (const raw of rows) {
      if (raw.enabled === false) {
        continue;
      }

      users.push(await this.#hydrateUser(raw));
    }

    return users;
  }

  async #hydrateUser(raw: KeycloakUserRaw): Promise<DirectoryUser> {
    const rolesRes = await this.#adminGet<{ name: string }[]>(
      `/users/${encodeURIComponent(raw.id)}/role-mappings/realm/composite`,
    );
    const roles =
      rolesRes.ok && rolesRes._data ? rolesRes._data.map((r) => r.name) : [];

    const fullName = [raw.firstName, raw.lastName]
      .filter((part): part is string => Boolean(part?.trim()))
      .map((part) => part.trim())
      .join(" ");

    return {
      subject: raw.id,
      username: raw.username?.trim() ?? raw.id,
      name: fullName || raw.username?.trim() || raw.id,
      qq: this.#extractQQ(raw),
      enabled: raw.enabled !== false,
      permissions: permissionsFromRoles(roles),
    };
  }

  #extractQQ(raw: KeycloakUserRaw): string | null {
    const values = raw.attributes?.[this.#qqAttr];

    if (values?.length !== 1) {
      return null;
    }

    const text = values[0]!.trim();

    return /^\d+$/.test(text) ? text : null;
  }

  async #accessToken(): Promise<string> {
    const now = Date.now();

    if (this.#token && now < this.#tokenExpiresAt) {
      return this.#token;
    }

    const credentials = Buffer.from(
      `${this.#clientId}:${this.#clientSecret}`,
    ).toString("base64");
    let body: { access_token: string; expires_in?: number };

    try {
      body = await ofetch<{ access_token: string; expires_in?: number }>(
        this.#tokenUrl,
        {
          method: "POST",
          timeout: 10_000,
          retry: 0,
          headers: {
            "Authorization": `Basic ${credentials}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ grant_type: "client_credentials" }),
        },
      );
    } catch (error) {
      if (error instanceof FetchError && error.statusCode) {
        throw new Error(
          `Keycloak token request failed: HTTP ${error.statusCode}`,
        );
      }

      throw error;
    }

    const ttlSec = Math.max(30, body.expires_in ?? 60);

    this.#token = body.access_token;
    this.#tokenExpiresAt =
      now + (ttlSec - Math.min(30, Math.floor(ttlSec / 2))) * 1000;

    return this.#token;
  }

  async #adminGet<T>(
    path: string,
    query?: Record<string, string | number>,
  ): Promise<FetchResponse<T>> {
    const fetchOnce = async () =>
      this.#adminApi.raw<T>(path, {
        query,
        headers: { Authorization: `Bearer ${await this.#accessToken()}` },
        ignoreResponseError: true,
      });

    const res = await fetchOnce();

    if (res.status !== 401) {
      return res;
    }

    this.#token = "";
    this.#tokenExpiresAt = 0;

    return fetchOnce();
  }
}
