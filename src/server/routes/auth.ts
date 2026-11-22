import type { Router } from "h3";
import { defineEventHandler, setHeader, setResponseStatus } from "h3";

import type { BerryApp } from "../../app.ts";
import { hasConsoleAccess } from "../auth.ts";

export function registerAuthRoutes(router: Router, berry: BerryApp): void {
  router.get(
    "/api/healthz",
    defineEventHandler(async () => ({
      status: "ok",
      gatewayConfigured: berry.gateway.configured,
      gatewayStreamConnected: berry.gatewayEvents.connected,
      bunkoConfigured: berry.bunko.enabled,
      workerRunning: berry.worker.running,
      devAuthBypass: berry.auth.devBypass,
      oidcConfigured: berry.auth.oidcConfigured,
    })),
  );

  router.get(
    "/api/auth/login",
    defineEventHandler((event) => berry.auth.startLogin(event)),
  );

  router.get(
    "/api/auth/callback",
    defineEventHandler((event) => berry.auth.callback(event)),
  );

  router.get(
    "/api/auth/status",
    defineEventHandler(async (event) => {
      setHeader(event, "Cache-Control", "no-store");
      const session = await berry.auth.getSession(event);

      if (!session || !hasConsoleAccess(session.permissions)) {
        return {
          state: "anonymous",
          user: null,
          oidcConfigured: berry.auth.oidcConfigured,
          devAuthBypass: berry.auth.devBypass,
        };
      }

      return {
        state: "active",
        user: {
          subject: session.subject,
          name: session.name,
          email: session.email,
          avatar: session.avatar || null,
          permissions: session.permissions,
        },
        csrfToken: session.csrfToken,
        oidcConfigured: berry.auth.oidcConfigured,
        devAuthBypass: berry.auth.devBypass,
      };
    }),
  );

  router.get(
    "/api/auth/csrf",
    defineEventHandler(async (event) => {
      setHeader(event, "Cache-Control", "no-store");
      const session = await berry.auth.requireAdmin(event);

      return { token: session.csrfToken, headerName: "X-CSRF-Token" };
    }),
  );

  router.post(
    "/api/auth/logout",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);
      await berry.auth.logout(event);
      setResponseStatus(event, 204);

      return null;
    }),
  );
}
