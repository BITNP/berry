import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve, sep } from "node:path";

import { fileTypeFromBuffer } from "file-type";
import type { H3Event, Router } from "h3";
import { createError, defineEventHandler, setHeader } from "h3";
import { lookup } from "mrmime";
import { Type } from "typebox";

import type { BerryApp } from "../../app.ts";
import { verifySignedStickerParams } from "../../media/sticker-url.ts";
import type { ChatKey, StickerRecord } from "../../types.ts";
import { idParamSchema, parseBody, parseParams, parseQuery } from "../http.ts";

const memoryScopeSchema = Type.Union([
  Type.Literal("global"),
  Type.Literal("chat"),
  Type.Literal("user"),
]);

const reviewStatusSchema = Type.Union([
  Type.Literal("approved"),
  Type.Literal("pending"),
]);

const listMemoriesQuerySchema = Type.Object({
  scope: Type.Optional(memoryScopeSchema),
  ownerId: Type.Optional(Type.String()),
});

const deleteMemoryQuerySchema = Type.Object({
  scope: memoryScopeSchema,
  ownerId: Type.String({ default: "" }),
  key: Type.String({ default: "" }),
});

const upsertMemoryBodySchema = Type.Object({
  scope: memoryScopeSchema,
  ownerId: Type.String({ default: "" }),
  key: Type.String({ minLength: 1 }),
  summary: Type.String({ default: "" }),
  content: Type.String({ default: "" }),
  expiresAt: Type.Optional(
    Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  ),
});

const userIdParamSchema = Type.Object({
  userId: Type.String({ minLength: 1 }),
});

export function registerKnowledgeRoutes(router: Router, berry: BerryApp): void {
  // Memories
  router.get(
    "/api/admin/memories",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);
      const query = await parseQuery(event, listMemoriesQuerySchema);

      return { items: await berry.store.memories.list(query) };
    }),
  );

  router.put(
    "/api/admin/memories",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);
      const body = await parseBody(event, upsertMemoryBodySchema);

      return berry.store.memories.upsert(body);
    }),
  );

  router.delete(
    "/api/admin/memories",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);
      const { scope, ownerId, key } = await parseQuery(
        event,
        deleteMemoryQuerySchema,
      );

      return {
        deleted: await berry.store.memories.remove(scope, ownerId, key),
      };
    }),
  );

  // Jargon dictionary (global across all chats)
  router.get(
    "/api/admin/jargon",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);
      const query = await parseQuery(
        event,
        Type.Object({
          status: Type.Optional(reviewStatusSchema),
          search: Type.Optional(Type.String()),
        }),
      );

      return { items: await berry.store.jargon.list(query) };
    }),
  );

  router.post(
    "/api/admin/jargon",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);
      const body = await parseBody(
        event,
        Type.Object({
          term: Type.String({ minLength: 1, maxLength: 48 }),
          aliases: Type.Optional(Type.Array(Type.String())),
          meaning: Type.String({ minLength: 1, maxLength: 240 }),
          status: Type.Optional(reviewStatusSchema),
        }),
      );

      return berry.store.jargon.upsert({ ...body, source: "manual" });
    }),
  );

  router.patch(
    "/api/admin/jargon/:id",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);
      const { id } = await parseParams(
        event,
        idParamSchema,
        "无效的黑话词条 ID",
      );
      const body = await parseBody(
        event,
        Type.Object({
          term: Type.Optional(Type.String({ minLength: 1, maxLength: 48 })),
          aliases: Type.Optional(Type.Array(Type.String())),
          meaning: Type.Optional(Type.String({ minLength: 1, maxLength: 240 })),
          status: Type.Optional(reviewStatusSchema),
        }),
      );
      const updated = await berry.store.jargon.update(id, body);

      if (!updated) {
        throw createError({ statusCode: 404, statusMessage: "词条不存在" });
      }

      return updated;
    }),
  );

  router.delete(
    "/api/admin/jargon/:id",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);
      const { id } = await parseParams(
        event,
        idParamSchema,
        "无效的黑话词条 ID",
      );

      return { deleted: await berry.store.jargon.remove(id) };
    }),
  );

  router.post(
    "/api/admin/jargon/distill",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);
      const body = await parseBody(
        event,
        Type.Object({ chatKey: Type.String({ minLength: 1 }) }),
      );

      return {
        ok: true,
        ...(await berry.social.distillChatJargon(body.chatKey as ChatKey)),
      };
    }),
  );

  // Member impressions
  async function mapWithConcurrency<T, R>(
    items: readonly T[],
    limit: number,
    fn: (item: T) => Promise<R>,
  ): Promise<R[]> {
    const results = Array.from<R>({ length: items.length });
    let nextIndex = 0;

    async function worker() {
      while (nextIndex < items.length) {
        const idx = nextIndex++;

        results[idx] = await fn(items[idx]!);
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(limit, items.length) }, () => worker()),
    );

    return results;
  }

  router.get(
    "/api/admin/impressions",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);
      const query = await parseQuery(
        event,
        Type.Object({ search: Type.Optional(Type.String()) }),
      );

      const rows = await berry.store.impressions.list();
      const resolved = await mapWithConcurrency(rows, 8, async (item) => {
        const name = await berry.social.resolveMemberName(item.userId);

        return name ? { ...item, displayName: name } : item;
      });
      const kw = query.search?.trim().toLowerCase() ?? "";

      return {
        items: kw
          ? resolved.filter(
              (item) =>
                item.userId.includes(kw) ||
                item.displayName.toLowerCase().includes(kw) ||
                item.impression.toLowerCase().includes(kw),
            )
          : resolved,
      };
    }),
  );

  router.put(
    "/api/admin/impressions/:userId",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);
      const { userId } = await parseParams(
        event,
        userIdParamSchema,
        "无效成员 QQ 号",
      );
      const body = await parseBody(
        event,
        Type.Object({
          displayName: Type.Optional(Type.String({ maxLength: 64 })),
          impression: Type.String({ minLength: 1, maxLength: 120 }),
          locked: Type.Optional(Type.Boolean()),
        }),
      );
      const displayName =
        body.displayName?.trim() ||
        (await berry.social.resolveMemberName(userId)) ||
        undefined;

      return berry.store.impressions.upsert({
        userId,
        displayName,
        impression: body.impression,
        source: "manual",
        locked: body.locked ?? true,
      });
    }),
  );

  router.delete(
    "/api/admin/impressions/:userId",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);
      const { userId } = await parseParams(
        event,
        userIdParamSchema,
        "无效成员 QQ 号",
      );

      return { deleted: await berry.store.impressions.remove(userId) };
    }),
  );

  router.post(
    "/api/admin/impressions/:userId/refresh",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);
      const { userId } = await parseParams(
        event,
        userIdParamSchema,
        "无效成员 QQ 号",
      );
      const item = await berry.social.refreshMemberImpression(userId, {
        force: true,
      });

      return { ok: true, item };
    }),
  );

  // Stickers library
  router.get(
    "/api/admin/stickers",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);
      const query = await parseQuery(
        event,
        Type.Object({
          status: Type.Optional(reviewStatusSchema),
          enabled: Type.Optional(Type.Boolean()),
          search: Type.Optional(Type.String()),
        }),
      );

      return { items: await berry.store.stickers.list(query) };
    }),
  );

  async function serveStickerFile(
    event: H3Event,
    sticker: StickerRecord,
    cacheControl: string,
  ) {
    const root = resolve(berry.store.assetsDir);
    const resolvedFile = resolve(sticker.filePath);

    if (!resolvedFile.startsWith(`${root}${sep}`)) {
      throw createError({ statusCode: 403, statusMessage: "非法文件路径" });
    }

    try {
      await stat(resolvedFile);
    } catch {
      throw createError({ statusCode: 404, statusMessage: "文件已不存在" });
    }

    setHeader(
      event,
      "Content-Type",
      sticker.mimeType || lookup(resolvedFile) || "application/octet-stream",
    );
    setHeader(event, "Cache-Control", cacheControl);

    return createReadStream(resolvedFile);
  }

  // Signed short-lived sticker media route for OneBot/NapCat image fetch (avoids gateway HTTP 413 on large base64 payloads).
  router.get(
    "/api/media/stickers/:id",
    defineEventHandler(async (event) => {
      const { id } = await parseParams(event, idParamSchema, "无效的表情包 ID");
      const query = await parseQuery(
        event,
        Type.Object({
          exp: Type.Integer({ minimum: 1 }),
          sig: Type.String({ minLength: 1 }),
        }),
      );

      if (
        !verifySignedStickerParams({
          secret: berry.env.gatewayToken,
          stickerId: id,
          exp: query.exp,
          sig: query.sig,
        })
      ) {
        throw createError({
          statusCode: 403,
          message: "表情包签名无效或已过期",
        });
      }

      const sticker = await berry.store.stickers.get(id);

      if (
        sticker?.status !== "approved" ||
        !sticker.enabled ||
        !sticker.filePath
      ) {
        throw createError({ statusCode: 404, message: "表情包不存在" });
      }

      return serveStickerFile(event, sticker, "private, max-age=300");
    }),
  );

  router.get(
    "/api/admin/stickers/:id/file",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);
      const { id } = await parseParams(event, idParamSchema, "无效的表情包 ID");
      const sticker = await berry.store.stickers.get(id);

      if (!sticker?.filePath) {
        throw createError({ statusCode: 404, statusMessage: "表情包不存在" });
      }

      return serveStickerFile(event, sticker, "private, max-age=3600");
    }),
  );

  router.patch(
    "/api/admin/stickers/:id",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);
      const { id } = await parseParams(event, idParamSchema, "无效的表情包 ID");
      const body = await parseBody(
        event,
        Type.Object({
          meaning: Type.Optional(Type.String({ maxLength: 200 })),
          tags: Type.Optional(Type.Array(Type.String())),
          status: Type.Optional(reviewStatusSchema),
          enabled: Type.Optional(Type.Boolean()),
        }),
      );
      const updated = await berry.store.stickers.update(id, body);

      if (!updated) {
        throw createError({ statusCode: 404, statusMessage: "表情包不存在" });
      }

      return updated;
    }),
  );

  router.delete(
    "/api/admin/stickers/:id",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);
      const { id } = await parseParams(event, idParamSchema, "无效的表情包 ID");

      return { deleted: await berry.store.stickers.remove(id) };
    }),
  );

  router.post(
    "/api/admin/stickers/from-asset/:assetId",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);
      const { assetId } = await parseParams(
        event,
        Type.Object({ assetId: Type.Integer({ minimum: 1 }) }),
        "无效的附件 ID",
      );
      const asset = await berry.store.assets.get(assetId);

      if (asset?.kind !== "image" || !asset.filePath || !asset.sha256) {
        throw createError({
          statusCode: 404,
          statusMessage: "未找到已缓存的图片附件",
        });
      }

      const { record, created } = await berry.store.stickers.collectIfAbsent({
        sha256: asset.sha256,
        filePath: asset.filePath,
        mimeType: asset.mimeType || "image/png",
        meaning: (asset.transcript || "表情包").slice(0, 180),
        tags: ["表情包"],
        sourceChatKey: asset.chatKey,
        status: "approved",
        enabled: true,
      });

      return { ok: true, created, item: record };
    }),
  );

  const ALLOWED_STICKER_MIMES = new Set([
    "image/gif",
    "image/jpeg",
    "image/png",
    "image/webp",
  ]);
  const MAX_STICKER_UPLOAD_BYTES = 8 * 1024 * 1024;

  router.post(
    "/api/admin/stickers/upload",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);
      const body = await parseBody(
        event,
        Type.Object({
          dataUrl: Type.String({ minLength: 16 }),
          filename: Type.Optional(Type.String({ maxLength: 160 })),
          meaning: Type.Optional(Type.String({ maxLength: 200 })),
          tags: Type.Optional(Type.Array(Type.String())),
          status: Type.Optional(reviewStatusSchema),
          enabled: Type.Optional(Type.Boolean()),
        }),
        "请上传有效的图片文件",
      );

      const base64 = body.dataUrl.includes(",")
        ? body.dataUrl.slice(body.dataUrl.indexOf(",") + 1)
        : body.dataUrl;
      const bytes = Buffer.from(base64, "base64");

      if (bytes.length === 0 || bytes.length > MAX_STICKER_UPLOAD_BYTES) {
        throw createError({
          statusCode: 400,
          message: "图片文件不能为空且不能超过 8 MB",
        });
      }

      const detected = await fileTypeFromBuffer(bytes);

      if (!detected || !ALLOWED_STICKER_MIMES.has(detected.mime)) {
        throw createError({
          statusCode: 400,
          message: "仅支持 PNG、JPG、GIF 或 WebP 格式的图片",
        });
      }

      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const stickerDir = join(berry.store.assetsDir, "stickers");

      await mkdir(stickerDir, { recursive: true });
      const filePath = join(stickerDir, `${sha256}.${detected.ext}`);

      await writeFile(filePath, bytes);

      const fallbackName = body.filename
        ? basename(body.filename, extname(body.filename)).trim()
        : "";
      const meaning = (body.meaning?.trim() || fallbackName || "表情包").slice(
        0,
        180,
      );
      const tags = (body.tags ?? [])
        .map((t) => t.trim())
        .filter(Boolean)
        .slice(0, 8);
      const status = body.status ?? "approved";
      const enabled = body.enabled ?? true;

      const { record, created } = await berry.store.stickers.collectIfAbsent({
        sha256,
        filePath,
        mimeType: detected.mime,
        meaning,
        tags: tags.length > 0 ? tags : ["表情包"],
        sourceChatKey: "manual",
        status,
        enabled,
      });

      const item = created
        ? record
        : ((await berry.store.stickers.update(record.id, {
            meaning,
            tags: tags.length > 0 ? tags : record.tags,
            status,
            enabled,
          })) ?? record);

      return { ok: true, created, item };
    }),
  );
}
