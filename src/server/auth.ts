import { randomBytes } from "node:crypto";

import { fromClaims } from "bitnp-authz";
import type { H3Event } from "h3";
import {
  createError,
  deleteCookie,
  getCookie,
  getHeader,
  getRequestURL,
  sendRedirect,
  setCookie,
} from "h3";
import { LRUCache } from "lru-cache";
import * as oidc from "openid-client";
import { Type } from "typebox";

import type { EnvConfig } from "../config/env.ts";
import type { Store } from "../store/index.ts";
import type { AdminSession } from "../store/sessions.ts";
import { constantTimeEquals } from "../utils/crypto.ts";
import { parseQuery } from "./http.ts";

const loginQuerySchema = Type.Object({
  returnTo: Type.Optional(Type.String()),
});

const callbackQuerySchema = Type.Object({
  code: Type.String({ default: "" }),
  state: Type.String({ default: "" }),
});

const SESSION_COOKIE = "berry_session";
const PENDING_TTL_MS = 10 * 60 * 1000;

interface PendingLogin {
  nonce: string;
  verifier: string;
  returnTo: string;
}

function safeReturnTo(raw: string | undefined): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) {
    return "/overview";
  }

  return raw;
}

function claimString(claims: Record<string, unknown>, key: string): string {
  const value = claims[key];

  return typeof value === "string" ? value : "";
}

export class AdminAuthService {
  #env: EnvConfig;
  #store: Store;
  #pending = new LRUCache<string, PendingLogin>({
    max: 500,
    ttl: PENDING_TTL_MS,
  });

  #oidcConfig: oidc.Configuration | null = null;
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
    const query = await parseQuery(event, loginQuerySchema);
    const returnTo = safeReturnTo(query.returnTo);

    if (this.#env.devAuthBypass) {
      return sendRedirect(event, returnTo, 302);
    }

    if (!this.oidcConfigured) {
      return sendRedirect(event, "/login?error=provider_unavailable", 302);
    }

    try {
      const config = await this.#ensureConfig();
      const state = oidc.randomState();
      const nonce = oidc.randomNonce();
      const verifier = oidc.randomPKCECodeVerifier();
      const challenge = await oidc.calculatePKCECodeChallenge(verifier);

      this.#pending.set(state, {
        nonce,
        verifier,
        returnTo,
      });

      const url = oidc.buildAuthorizationUrl(config, {
        redirect_uri: this.#redirectUri(),
        scope: "openid profile email roles",
        state,
        nonce,
        code_challenge: challenge,
        code_challenge_method: "S256",
      });

      return sendRedirect(event, url.href, 302);
    } catch {
      return sendRedirect(event, "/login?error=provider_unavailable", 302);
    }
  }

  public async callback(event: H3Event): Promise<unknown> {
    const { code, state } = await parseQuery(event, callbackQuerySchema);

    const pending = state ? this.#pending.get(state) : undefined;

    if (state) {
      this.#pending.delete(state);
    }

    if (!code || !pending) {
      return sendRedirect(event, "/login?error=oidc_failed", 302);
    }

    try {
      const config = await this.#ensureConfig();
      const callbackUrl = new URL(this.#redirectUri());

      callbackUrl.search = getRequestURL(event).search;

      const tokens = await oidc.authorizationCodeGrant(config, callbackUrl, {
        pkceCodeVerifier: pending.verifier,
        expectedState: state,
        expectedNonce: pending.nonce,
        idTokenExpected: true,
      });
      const rawClaims = tokens.claims();

      if (!rawClaims) {
        return sendRedirect(event, "/login?error=oidc_failed", 302);
      }

      const claims = rawClaims as Record<string, unknown>;
      const sub = claimString(claims, "sub");

      if (!sub) {
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

  async #ensureConfig(): Promise<oidc.Configuration> {
    if (this.#oidcConfig) {
      return this.#oidcConfig;
    }

    const issuerUrl = new URL(this.#env.oidcIssuer);
    const config = await oidc.discovery(
      issuerUrl,
      this.#env.oidcClientId,
      this.#env.oidcClientSecret,
      undefined,
      issuerUrl.protocol === "http:"
        ? { execute: [oidc.allowInsecureRequests] }
        : undefined,
    );

    this.#oidcConfig = config;

    return config;
  }
}
