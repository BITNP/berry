import type { EnvConfig } from "../config/env.ts";
import type { SitePermissions } from "./authz.ts";
import { fromRoles } from "./authz.ts";

export interface DirectoryUser {
  subject: string;
  username: string;
  name: string;
  qq: string | null;
  enabled: boolean;
  permissions: SitePermissions;
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const POSITIVE_TTL_MS = 5 * 60 * 1000;
const NEGATIVE_TTL_MS = 30 * 1000;
const MAX_CACHE_SIZE = 2000;

interface KeycloakUserRaw {
  id?: string;
  username?: string;
  firstName?: string;
  lastName?: string;
  enabled?: boolean;
  attributes?: Record<string, unknown>;
}

export class IdentityDirectory {
  #adminUrl: string;
  #tokenUrl: string;
  #clientId: string;
  #clientSecret: string;
  #qqAttr: string;
  #token = "";
  #tokenExpiresAt = 0;
  #bySubject = new Map<string, CacheEntry<DirectoryUser | null>>();
  #byQQ = new Map<string, CacheEntry<DirectoryUser | null>>();

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

    const cached = this.#readCache(this.#bySubject, subject);

    if (cached !== undefined) {
      return cached;
    }

    const res = await this.#adminGet(`/users/${encodeURIComponent(subject)}`);

    if (res.status === 404) {
      this.#writeCache(this.#bySubject, subject, null, NEGATIVE_TTL_MS);

      return null;
    }

    if (!res.ok) {
      throw new Error(`Keycloak user lookup failed: HTTP ${res.status}`);
    }

    const raw = (await res.json()) as KeycloakUserRaw;
    const user = await this.#hydrateUser(raw);
    const resolved = user?.enabled ? user : null;

    this.#writeCache(
      this.#bySubject,
      subject,
      resolved,
      resolved ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS,
    );
    if (resolved?.qq) {
      this.#writeCache(this.#byQQ, resolved.qq, resolved, POSITIVE_TTL_MS);
    }

    return resolved;
  }

  public async byQQ(qq: string): Promise<DirectoryUser | null> {
    const clean = qq.trim();

    if (!this.enabled || !/^\d+$/.test(clean)) {
      return null;
    }

    const cached = this.#readCache(this.#byQQ, clean);

    if (cached !== undefined) {
      return cached;
    }

    const params = new URLSearchParams({
      q: `${this.#qqAttr}:${clean}`,
      exact: "true",
      max: "5",
    });
    const res = await this.#adminGet(`/users?${params.toString()}`);

    if (!res.ok) {
      throw new Error(`Keycloak QQ lookup failed: HTTP ${res.status}`);
    }

    const candidates = (await res.json()) as KeycloakUserRaw[];
    let matched: DirectoryUser | null = null;

    for (const raw of candidates) {
      if (raw.enabled === false) {
        continue;
      }

      if (this.#extractQQ(raw) !== clean) {
        continue;
      }

      const hydrated = await this.#hydrateUser(raw);

      if (hydrated?.enabled && hydrated.qq === clean) {
        matched = hydrated;

        break;
      }
    }

    this.#writeCache(
      this.#byQQ,
      clean,
      matched,
      matched ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS,
    );
    if (matched) {
      this.#writeCache(
        this.#bySubject,
        matched.subject,
        matched,
        POSITIVE_TTL_MS,
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

    const params = new URLSearchParams({
      search: trimmed,
      max: "15",
    });
    const res = await this.#adminGet(`/users?${params.toString()}`);

    if (!res.ok) {
      throw new Error(`Keycloak member search failed: HTTP ${res.status}`);
    }

    const rows = (await res.json()) as KeycloakUserRaw[];
    const users: DirectoryUser[] = [];

    for (const raw of rows) {
      if (raw.enabled === false) {
        continue;
      }

      const hydrated = await this.#hydrateUser(raw);

      if (hydrated) {
        users.push(hydrated);
      }
    }

    return users;
  }

  async #hydrateUser(raw: KeycloakUserRaw): Promise<DirectoryUser | null> {
    if (!raw.id) {
      return null;
    }

    const rolesRes = await this.#adminGet(
      `/users/${encodeURIComponent(raw.id)}/role-mappings/realm/composite`,
    );
    const roles: string[] = [];

    if (rolesRes.ok) {
      const roleObjects = (await rolesRes.json()) as { name?: string }[];

      for (const item of roleObjects) {
        if (item.name?.trim()) {
          roles.push(item.name);
        }
      }
    }

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
      permissions: fromRoles(roles),
    };
  }

  #extractQQ(raw: KeycloakUserRaw): string | null {
    const values = raw.attributes?.[this.#qqAttr];

    if (!Array.isArray(values) || values.length !== 1) {
      return null;
    }

    const text = String(values[0] ?? "").trim();

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
    const res = await fetch(this.#tokenUrl, {
      method: "POST",
      headers: {
        "Authorization": `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ grant_type: "client_credentials" }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      throw new Error(`Keycloak token request failed: HTTP ${res.status}`);
    }

    const body = (await res.json()) as {
      access_token: string;
      expires_in?: number;
    };

    if (!body.access_token) {
      throw new Error("Keycloak token response missing access_token");
    }

    const ttlSec = Math.max(30, body.expires_in ?? 60);

    this.#token = body.access_token;
    this.#tokenExpiresAt =
      now + (ttlSec - Math.min(30, Math.floor(ttlSec / 2))) * 1000;

    return this.#token;
  }

  async #adminGet(path: string): Promise<Response> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.#accessToken();
      const res = await fetch(`${this.#adminUrl}${path}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(10_000),
      });

      if (res.status !== 401 || attempt === 1) {
        return res;
      }

      this.#token = "";
      this.#tokenExpiresAt = 0;
    }

    throw new Error("Unreachable");
  }

  #readCache<T>(map: Map<string, CacheEntry<T>>, key: string): T | undefined {
    const entry = map.get(key);

    if (!entry) {
      return undefined;
    }

    if (Date.now() >= entry.expiresAt) {
      map.delete(key);

      return undefined;
    }

    return entry.value;
  }

  #writeCache<T>(
    map: Map<string, CacheEntry<T>>,
    key: string,
    value: T,
    ttlMs: number,
  ): void {
    if (map.size >= MAX_CACHE_SIZE) {
      map.clear();
    }

    map.set(key, { value, expiresAt: Date.now() + ttlMs });
  }
}
