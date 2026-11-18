import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Store } from "../store/index.ts";

export interface CachedAvatar {
  contentType: string;
  data: Buffer;
}

const FALLBACK_COLORS = [
  "#be123c",
  "#0369a1",
  "#15803d",
  "#b45309",
  "#6d28d9",
  "#0f766e",
  "#4338ca",
  "#b91c1c",
];

function buildFallbackSvg(label: string): CachedAvatar {
  const clean = label.replace(/[^0-9A-Z\u4E00-\u9FA5]/gi, "");
  const badge = (clean.slice(-2) || "QQ").toUpperCase();
  let hash = 0;

  for (let i = 0; i < label.length; i++) {
    hash = (hash * 31 + label.charCodeAt(i)) >>> 0;
  }

  const bg = FALLBACK_COLORS[hash % FALLBACK_COLORS.length]!;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80" viewBox="0 0 80 80"><rect width="80" height="80" rx="16" fill="${bg}"/><text x="50%" y="54%" dominant-baseline="middle" text-anchor="middle" fill="#ffffff" font-family="system-ui,sans-serif" font-size="28" font-weight="600">${badge}</text></svg>`;

  return {
    contentType: "image/svg+xml; charset=utf-8",
    data: Buffer.from(svg, "utf8"),
  };
}

const TTL_MS = 24 * 60 * 60 * 1000;

export class AvatarCache {
  #avatarsDir: string;
  #pending = new Map<string, Promise<CachedAvatar>>();

  constructor(store: Store) {
    this.#avatarsDir = store.avatarsDir;
  }

  public async get(kind: "user" | "group", id: string): Promise<CachedAvatar> {
    const cleanId = id.replace(/[^\w-]/g, "");

    if (!cleanId) {
      return buildFallbackSvg("?");
    }

    const key = `${kind}:${cleanId}`;
    const pending = this.#pending.get(key);

    if (pending) {
      return pending;
    }

    const req = this.#load(kind, cleanId).finally(() => {
      this.#pending.delete(key);
    });

    this.#pending.set(key, req);

    return req;
  }

  async #load(kind: "user" | "group", id: string): Promise<CachedAvatar> {
    await mkdir(this.#avatarsDir, { recursive: true });
    const imgPath = join(this.#avatarsDir, `${kind}-${id}.bin`);
    const metaPath = join(this.#avatarsDir, `${kind}-${id}.json`);

    try {
      const [info, metaRaw, data] = await Promise.all([
        stat(imgPath),
        readFile(metaPath, "utf8"),
        readFile(imgPath),
      ]);
      const meta = JSON.parse(metaRaw) as { contentType?: string };

      if (Date.now() - info.mtimeMs < TTL_MS && meta.contentType) {
        return { contentType: meta.contentType, data };
      }
    } catch {
      // Cache miss; fetch below.
    }

    const remoteUrl =
      kind === "user"
        ? `https://q.qlogo.cn/headimg_dl?dst_uin=${encodeURIComponent(id)}&spec=100`
        : `https://p.qlogo.cn/gh/${encodeURIComponent(id)}/${encodeURIComponent(id)}/100/`;

    try {
      const res = await fetch(remoteUrl, {
        signal: AbortSignal.timeout(4000),
      });
      const contentType = res.headers.get("content-type")?.split(";")[0] ?? "";

      if (res.ok && /^image\/(jpeg|png|gif|webp|avif)$/i.test(contentType)) {
        const data = Buffer.from(await res.arrayBuffer());

        if (data.byteLength > 64) {
          await Promise.all([
            writeFile(imgPath, data),
            writeFile(metaPath, JSON.stringify({ contentType }), "utf8"),
          ]);

          return { contentType, data };
        }
      }
    } catch {
      // Offline / unreachable environment: return deterministic SVG badge.
    }

    return buildFallbackSvg(id);
  }
}
