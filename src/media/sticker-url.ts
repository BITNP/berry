import { createHmac, timingSafeEqual } from "node:crypto";

const DEFAULT_STICKER_URL_TTL_MS = 15 * 60 * 1000;

const LOOPBACK_HOSTS = new Set([
  "0.0.0.0",
  "127.0.0.1",
  "::1",
  "[::1]",
  "localhost",
]);

export function isPublicMediaOrigin(rawUrl: string | undefined): boolean {
  const trimmed = rawUrl?.trim();

  if (!trimmed || !URL.canParse(trimmed)) {
    return false;
  }

  const parsed = new URL(trimmed);

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false;
  }

  const host = parsed.hostname.toLowerCase();

  return !LOOPBACK_HOSTS.has(host) && !host.startsWith("127.");
}

const signStickerPayload = (
  secret: string,
  stickerId: number,
  expiresAtMs: number,
): string =>
  createHmac("sha256", secret)
    .update(`berry-sticker:${stickerId}:${expiresAtMs}`)
    .digest("base64url");

export function buildSignedStickerUrl(options: {
  publicUrl?: string;
  secret?: string;
  stickerId: number;
  ttlMs?: number;
  now?: number;
}): string | null {
  const secret = options.secret?.trim();

  if (
    !secret ||
    !Number.isInteger(options.stickerId) ||
    options.stickerId <= 0 ||
    !isPublicMediaOrigin(options.publicUrl)
  ) {
    return null;
  }

  const origin = options.publicUrl!.trim().replace(/\/+$/, "");
  const exp =
    (options.now ?? Date.now()) + (options.ttlMs ?? DEFAULT_STICKER_URL_TTL_MS);
  const sig = signStickerPayload(secret, options.stickerId, exp);

  return `${origin}/api/media/stickers/${options.stickerId}?exp=${exp}&sig=${sig}`;
}

export function verifySignedStickerParams(options: {
  secret?: string;
  stickerId: number;
  exp: number;
  sig: string;
  now?: number;
}): boolean {
  const secret = options.secret?.trim();

  if (
    !secret ||
    !Number.isInteger(options.stickerId) ||
    options.stickerId <= 0 ||
    !Number.isFinite(options.exp) ||
    options.exp <= (options.now ?? Date.now()) ||
    !options.sig
  ) {
    return false;
  }

  const expected = Buffer.from(
    signStickerPayload(secret, options.stickerId, options.exp),
    "utf8",
  );
  const provided = Buffer.from(options.sig, "utf8");

  return (
    expected.length === provided.length && timingSafeEqual(expected, provided)
  );
}
