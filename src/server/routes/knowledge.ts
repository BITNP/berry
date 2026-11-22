import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve, sep } from "node:path";

import type { Router } from "h3";
import { createError, defineEventHandler, setHeader } from "h3";
import { lookup } from "mrmime";
import { Type } from "typebox";

import type { BerryApp } from "../../app.ts";
import type { ChatKey } from "../../types.ts";
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

  // Jargon dictionary
  router.get(
    "/api/admin/jargon",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);
      const query = await parseQuery(
        event,
        Type.Object({
          chatKey: Type.Optional(Type.String()),
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
          chatKey: Type.Optional(Type.String()),
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
          chatKey: Type.Optional(Type.String()),
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
  router.get(
    "/api/admin/impressions",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);
      const query = await parseQuery(
        event,
        Type.Object({ search: Type.Optional(Type.String()) }),
      );

      return { items: await berry.store.impressions.list(query) };
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

      return berry.store.impressions.upsert({
        userId,
        displayName: body.displayName,
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

  router.get(
    "/api/admin/stickers/:id/file",
    defineEventHandler(async (event) => {
      await berry.auth.requireAdmin(event);
      const { id } = await parseParams(event, idParamSchema, "无效的表情包 ID");
      const sticker = await berry.store.stickers.get(id);

      if (!sticker?.filePath) {
        throw createError({ statusCode: 404, statusMessage: "表情包不存在" });
      }

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
      setHeader(event, "Cache-Control", "private, max-age=3600");

      return createReadStream(resolvedFile);
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
}
