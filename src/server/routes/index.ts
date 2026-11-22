import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import {
  createApp,
  createError,
  createRouter,
  defineEventHandler,
  serveStatic,
  setHeader,
} from "h3";
import { lookup } from "mrmime";

import type { BerryApp } from "../../app.ts";
import { registerAiRoutes } from "./ai.ts";
import { registerAuthRoutes } from "./auth.ts";
import { registerChatRoutes } from "./chats.ts";
import { registerKnowledgeRoutes } from "./knowledge.ts";
import { registerScheduleRoutes } from "./schedules.ts";
import { registerSystemRoutes } from "./system.ts";

export function createHttpApp(berry: BerryApp, webDistDir: string) {
  const app = createApp({
    onBeforeResponse: (event) => {
      setHeader(event, "X-Content-Type-Options", "nosniff");
      setHeader(event, "X-Frame-Options", "DENY");
      setHeader(event, "Referrer-Policy", "same-origin");
      setHeader(
        event,
        "Content-Security-Policy",
        "default-src 'self'; img-src 'self' https: data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self' data:; frame-ancestors 'none'",
      );
    },
  });

  const router = createRouter();

  registerAuthRoutes(router, berry);
  registerSystemRoutes(router, berry);
  registerAiRoutes(router, berry);
  registerChatRoutes(router, berry);
  registerKnowledgeRoutes(router, berry);
  registerScheduleRoutes(router, berry);

  app.use(router);

  // Unknown API routes return JSON 404 before static SPA fallback.
  app.use(
    "/api",
    defineEventHandler(() => {
      throw createError({ statusCode: 404, message: "接口不存在" });
    }),
  );

  // Static SPA serving from dist/web.
  const resolvedDist = resolve(webDistDir);

  app.use(
    defineEventHandler(async (event) => {
      const served = await serveStatic(event, {
        fallthrough: true,
        indexNames: ["/index.html"],
        getMeta: async (id) => {
          const rel = id.replace(/^\/+/, "");
          const candidate = resolve(resolvedDist, rel);

          if (
            candidate !== resolvedDist &&
            !candidate.startsWith(`${resolvedDist}${sep}`)
          ) {
            return;
          }

          const info = await stat(candidate).catch(() => null);

          if (!info?.isFile()) {
            return;
          }

          if (rel.startsWith("assets/")) {
            setHeader(
              event,
              "Cache-Control",
              "public, max-age=31536000, immutable",
            );
          } else if (rel === "index.html") {
            setHeader(event, "Cache-Control", "no-store");
          }

          return {
            type: lookup(candidate) || "application/octet-stream",
            size: info.size,
            mtime: info.mtimeMs,
          };
        },
        getContents: (id) =>
          createReadStream(resolve(resolvedDist, id.replace(/^\/+/, ""))),
      });

      if (served !== false) {
        return;
      }

      if (event.method !== "GET" && event.method !== "HEAD") {
        throw createError({ statusCode: 404, message: "Not Found" });
      }

      try {
        const html = await readFile(join(resolvedDist, "index.html"), "utf8");

        setHeader(event, "Content-Type", "text/html; charset=utf-8");
        setHeader(event, "Cache-Control", "no-store");

        return html;
      } catch {
        setHeader(event, "Content-Type", "text/plain; charset=utf-8");

        return "berry console build not found. Run `pnpm build` or use Vite dev server.";
      }
    }),
  );

  return app;
}
