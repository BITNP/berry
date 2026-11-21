import { LRUCache } from "lru-cache";

const DEFAULT_SHORTLINK_ORIGIN = "https://p.bitnp.net";

function extractShortUrlFromHtml(html: string): string {
  const inputMatch = html.match(/<input\b[^>]+\bid=["']short-url["'][^>]*>/i);

  if (!inputMatch) {
    return "";
  }

  return inputMatch[0].match(/\bvalue=["']([^"']+)["']/i)?.[1]?.trim() ?? "";
}

function normalizeOrigin(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");

  if (!trimmed) {
    return "";
  }

  const parsed = new URL(trimmed);

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Invalid shortlink origin: ${raw}`);
  }

  return parsed.origin;
}

export class ShortLinkClient {
  #origin: string;
  #cache = new LRUCache<string, string>({
    max: 500,
    ttl: 24 * 60 * 60 * 1000,
  });

  constructor(origin = DEFAULT_SHORTLINK_ORIGIN) {
    this.#origin = normalizeOrigin(origin);
  }

  public get enabled(): boolean {
    return Boolean(this.#origin);
  }

  public async shorten(rawUrl: string): Promise<string> {
    if (!this.#origin) {
      throw new Error("短链服务未启用（BERRY_SHORTLINK_ORIGIN）");
    }

    const parsedTarget = new URL(rawUrl.trim());

    if (
      parsedTarget.protocol !== "http:" &&
      parsedTarget.protocol !== "https:"
    ) {
      throw new Error("短链服务仅支持 http/https 链接");
    }

    if (parsedTarget.origin === this.#origin) {
      return parsedTarget.href;
    }

    const normalized = parsedTarget.href;
    const cached = this.#cache.get(normalized);

    if (cached) {
      return cached;
    }

    const res = await fetch(`${this.#origin}/create`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Origin": this.#origin,
      },
      body: new URLSearchParams({ url: normalized }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      throw new Error(`短链服务返回 HTTP ${res.status}`);
    }

    const shortUrl = extractShortUrlFromHtml(await res.text());

    if (!shortUrl.startsWith(`${this.#origin}/`)) {
      throw new Error("短链服务未返回有效的短链接");
    }

    this.#cache.set(normalized, shortUrl);

    return shortUrl;
  }

  public async shortenOrFallback(rawUrl: string): Promise<string> {
    const trimmed = rawUrl.trim();

    if (!this.enabled || !trimmed) {
      return trimmed;
    }

    try {
      return await this.shorten(trimmed);
    } catch {
      return trimmed;
    }
  }
}
