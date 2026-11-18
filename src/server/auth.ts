import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { H3Event } from "h3";
import {
  createError,
  deleteCookie,
  getCookie,
  getHeader,
  getQuery,
  sendRedirect,
  setCookie,
} from "h3";
import { createRemoteJWKSet, jwtVerify } from "jose";

import type { EnvConfig } from "../config/env.ts";
import { fromClaims } from "../identity/authz.ts";
import type { Store } from "../store/index.ts";
import type { AdminSession } from "../store/sessions.ts";
import { queryString } from "./http.ts";

const SESSION_COOKIE = "berry_session";
const PENDING_TTL_MS = 10 * 60 * 1000;

interface PendingLogin {
  nonce: string;
  verifier: string;
  returnTo: string;
  expiresAt: number;
}

interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

function safeReturnTo(raw: string | undefined): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) {
    return "/gate";
  }

  return raw;
}

function claimString(claims: Record<string, unknown>, key: string): string {
  const value = claims[key];

  return typeof value === "string" ? value : "";
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);

  if (bufA.length !== bufB.length) {
    return false;
  }

  return timingSafeEqual(bufA, bufB);
}

export class AdminAuthService {
  #env: EnvConfig;
  #store: Store;
  #pending = new Map<string, PendingLogin>();
  #discovery: OidcDiscovery | null = null;
  #jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
  #devCsrf = randomBytes(24).toString("base64url");

  constructor(env: EnvConfig, store: Store) {
    this.#env = env;
    this.#store = store;
  }

  public get oidcConfigured(): boolean {
    return Boolean(
      this.#env.oidcIssuer &&
      this.#env.oidcClientId &&
      this.#env.oidcClientSecret,
    );
  }

  public get devBypass(): boolean {
    return this.#env.devAuthBypass;
  }

  public async getSession(event: H3Event): Promise<AdminSession | null> {
    if (this.#env.devAuthBypass) {
      return {
        id: "dev-bypass",
        subject: this.#env.devAuthSubject || "dev-admin",
        name: this.#env.devAuthName || "Dev Admin",
        email: "",
        avatar: "",
        permissions: {
          admitted: true,
          systemAdmin: true,
          manager: true,
          accessDepartments: ["techdept"],
          managedDepartments: ["techdept"],
          positions: [],
        },
        csrfToken: this.#devCsrf,
        expiresAt: Date.now() + 86_400_000,
      };
    }

    const token = getCookie(event, SESSION_COOKIE);

    if (!token) {
      return null;
    }

    return this.#store.sessions.get(token);
  }

  public async requireAdmin(event: H3Event): Promise<AdminSession> {
    const session = await this.getSession(event);

    if (!session) {
      throw createError({
        statusCode: 401,
        statusMessage: "UNAUTHORIZED",
        message: "需要登录管理后台",
      });
    }

    if (!session.permissions.systemAdmin) {
      throw createError({
        statusCode: 403,
        statusMessage: "FORBIDDEN",
        message: "仅限系统管理员访问",
      });
    }

    const method = event.method.toUpperCase();

    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      const csrf = getHeader(event, "x-csrf-token") ?? "";

      if (!csrf || !constantTimeEquals(csrf, session.csrfToken)) {
        throw createError({
          statusCode: 403,
          statusMessage: "CSRF_INVALID",
          message: "CSRF 令牌无效",
        });
      }
    }

    return session;
  }

  public async startLogin(event: H3Event): Promise<unknown> {
    const query = getQuery(event);
    const returnTo = safeReturnTo(queryString(query, "returnTo"));

    if (this.#env.devAuthBypass) {
      return sendRedirect(event, returnTo, 302);
    }

    if (!this.oidcConfigured) {
      return sendRedirect(event, "/login?error=provider_unavailable", 302);
    }

    try {
      const discovery = await this.#ensureDiscovery();
      const state = randomBytes(24).toString("base64url");
      const nonce = randomBytes(24).toString("base64url");
      const verifier = randomBytes(32).toString("base64url");
      const challenge = createHash("sha256")
        .update(verifier)
        .digest("base64url");

      this.#prunePending();
      this.#pending.set(state, {
        nonce,
        verifier,
        returnTo,
        expiresAt: Date.now() + PENDING_TTL_MS,
      });

      const url = new URL(discovery.authorization_endpoint);

      url.searchParams.set("client_id", this.#env.oidcClientId);
      url.searchParams.set("redirect_uri", this.#redirectUri());
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", "openid profile email roles");
      url.searchParams.set("state", state);
      url.searchParams.set("nonce", nonce);
      url.searchParams.set("code_challenge", challenge);
      url.searchParams.set("code_challenge_method", "S256");

      return sendRedirect(event, url.href, 302);
    } catch {
      return sendRedirect(event, "/login?error=provider_unavailable", 302);
    }
  }

  public async callback(event: H3Event): Promise<unknown> {
    const query = getQuery(event);
    const code = queryString(query, "code") ?? "";
    const state = queryString(query, "state") ?? "";

    const pending = state ? this.#pending.get(state) : undefined;

    if (state) {
      this.#pending.delete(state);
    }

    if (!code || !pending || pending.expiresAt < Date.now()) {
      return sendRedirect(event, "/login?error=oidc_failed", 302);
    }

    try {
      const discovery = await this.#ensureDiscovery();
      const tokenRes = await fetch(discovery.token_endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: this.#redirectUri(),
          client_id: this.#env.oidcClientId,
          client_secret: this.#env.oidcClientSecret,
          code_verifier: pending.verifier,
        }),
        signal: AbortSignal.timeout(15_000),
      });

      if (!tokenRes.ok) {
        return sendRedirect(event, "/login?error=oidc_failed", 302);
      }

      const tokenJson = (await tokenRes.json()) as { id_token?: string };

      if (!tokenJson.id_token || !this.#jwks) {
        return sendRedirect(event, "/login?error=oidc_failed", 302);
      }

      const verified = await jwtVerify(tokenJson.id_token, this.#jwks, {
        issuer: discovery.issuer,
        audience: this.#env.oidcClientId,
      });
      const claims = verified.payload as Record<string, unknown>;

      const sub = claimString(claims, "sub");

      if (claims.nonce !== pending.nonce || !sub) {
        return sendRedirect(event, "/login?error=oidc_failed", 302);
      }

      const permissions = fromClaims(claims);

      if (!permissions.systemAdmin) {
        return sendRedirect(event, "/login?error=not_admin", 302);
      }

      const session = await this.#store.sessions.create({
        subject: sub,
        name:
          claimString(claims, "name") ||
          claimString(claims, "preferred_username") ||
          sub,
        email: claimString(claims, "email"),
        avatar: claimString(claims, "picture"),
        permissions,
      });

      setCookie(event, SESSION_COOKIE, session.id, {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: this.#env.publicUrl.startsWith("https://"),
        maxAge: 86_400,
      });

      return sendRedirect(event, pending.returnTo, 302);
    } catch {
      return sendRedirect(event, "/login?error=oidc_failed", 302);
    }
  }

  public async logout(event: H3Event): Promise<void> {
    if (!this.#env.devAuthBypass) {
      const token = getCookie(event, SESSION_COOKIE);

      if (token) {
        await this.#store.sessions.delete(token);
      }
    }

    deleteCookie(event, SESSION_COOKIE, { path: "/" });
  }

  #redirectUri(): string {
    return `${this.#env.publicUrl}/api/auth/callback`;
  }

  async #ensureDiscovery(): Promise<OidcDiscovery> {
    if (this.#discovery && this.#jwks) {
      return this.#discovery;
    }

    const res = await fetch(
      `${this.#env.oidcIssuer}/.well-known/openid-configuration`,
      { signal: AbortSignal.timeout(10_000) },
    );

    if (!res.ok) {
      throw new Error(`OIDC discovery HTTP ${res.status}`);
    }

    const doc = (await res.json()) as OidcDiscovery;

    this.#discovery = doc;
    this.#jwks = createRemoteJWKSet(new URL(doc.jwks_uri));

    return doc;
  }

  #prunePending(): void {
    const now = Date.now();

    for (const [key, item] of this.#pending) {
      if (item.expiresAt < now) {
        this.#pending.delete(key);
      }
    }
  }
}
