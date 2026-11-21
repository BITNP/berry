import { createHash } from "node:crypto";

import { Type } from "typebox";

import type { BunkoDocumentView } from "../bunko/client.ts";
import type { Tool, ToolContext } from "./types.ts";
import { defineTool, isPrivilegedActor, requirePrivileged } from "./types.ts";

async function isDocVisibleToActor(
  ctx: ToolContext,
  doc: BunkoDocumentView,
): Promise<boolean> {
  if (isPrivilegedActor(ctx.actor)) {
    return true;
  }

  if (doc.isPublic) {
    return true;
  }

  if (!ctx.actor.actorAdmitted || doc.isPrivate) {
    return false;
  }

  return ctx.services.bunko.canStandardUserRead(doc.id, true);
}

export const bunkoListTreeTool = defineTool({
  name: "bunko_list_tree",
  description:
    "浏览 Bunko 云文档目录树或按标题关键词查找文档（不传 folderId 表示工作区根目录；传 query 或 recursive=true 可递归检索）。普通权限仅可见公开文档或允许全员可读的非私密文档。",
  parameters: Type.Object(
    {
      folderId: Type.Optional(Type.String()),
      query: Type.Optional(Type.String()),
      recursive: Type.Optional(Type.Boolean()),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    },
    { additionalProperties: false },
  ),
  execute: async (args, ctx) => {
    const { bunko } = ctx.services;
    const privileged = isPrivilegedActor(ctx.actor);
    const kw = args.query?.trim().toLowerCase() ?? "";
    const recursive = Boolean(args.recursive) || Boolean(kw);
    const limit = args.limit ?? 50;
    const rootFolderId = args.folderId?.trim() || null;

    if (!recursive) {
      const listing = await bunko.listTree(rootFolderId);

      if (!privileged && listing.folder?.isPrivate) {
        throw new Error("该目录为私密目录，普通权限无权访问");
      }

      if (!privileged && rootFolderId) {
        for (const crumb of listing.breadcrumb) {
          if (!crumb.id || crumb.id === rootFolderId) {
            continue;
          }

          const parentListing = await bunko.listTree(crumb.id);

          if (parentListing.folder?.isPrivate) {
            throw new Error("该目录位于私密目录树下，普通权限无权访问");
          }
        }
      }

      const folders = listing.folders
        .filter((f) => privileged || !f.isPrivate)
        .map((f) => ({
          id: f.id,
          name: f.name,
          isPrivate: f.isPrivate,
        }));
      const visibleDocs = [];

      for (const doc of listing.documents) {
        if (await isDocVisibleToActor(ctx, doc)) {
          visibleDocs.push({
            id: doc.id,
            title: doc.title,
            folderId: doc.folderId,
            isPublic: doc.isPublic,
            isPrivate: doc.isPrivate,
            version: doc.version,
            updatedAt: doc.updatedAt,
            url: bunko.docUrl(doc.id),
          });
        }
      }

      return {
        folder: listing.folder
          ? {
              id: listing.folder.id,
              name: listing.folder.name,
              isPrivate: listing.folder.isPrivate,
            }
          : null,
        breadcrumb: listing.breadcrumb.map((c) => c.name),
        folders,
        documents: visibleDocs.slice(0, limit),
      };
    }

    const queue: { id: string | null; path: string }[] = [
      { id: rootFolderId, path: "" },
    ];
    const visited = new Set<string>();
    const folders: {
      id: string;
      name: string;
      path: string;
      isPrivate: boolean;
    }[] = [];
    const documents: {
      id: string;
      title: string;
      folderPath: string;
      folderId: string | null;
      isPublic: boolean;
      version: number;
      updatedAt: string;
      url: string;
    }[] = [];
    let scannedFolders = 0;

    while (
      queue.length > 0 &&
      scannedFolders < 80 &&
      documents.length < limit
    ) {
      const current = queue.shift()!;

      scannedFolders++;
      const listing = await bunko.listTree(current.id);

      if (!privileged && listing.folder?.isPrivate) {
        if (current.id === rootFolderId && rootFolderId !== null) {
          throw new Error("该目录为私密目录，普通权限无权访问");
        }

        continue;
      }

      const currentPath =
        current.path ||
        listing.breadcrumb
          .filter((c) => c.id !== null)
          .map((c) => c.name)
          .join("/");

      for (const folder of listing.folders) {
        if (!privileged && folder.isPrivate) {
          continue;
        }

        if (visited.has(folder.id)) {
          continue;
        }

        visited.add(folder.id);
        const nextPath = currentPath
          ? `${currentPath}/${folder.name}`
          : folder.name;

        if (!kw || folder.name.toLowerCase().includes(kw)) {
          folders.push({
            id: folder.id,
            name: folder.name,
            path: nextPath,
            isPrivate: folder.isPrivate,
          });
        }

        queue.push({ id: folder.id, path: nextPath });
      }

      for (const doc of listing.documents) {
        if (documents.length >= limit) {
          break;
        }

        if (kw && !doc.title.toLowerCase().includes(kw)) {
          continue;
        }

        if (!(await isDocVisibleToActor(ctx, doc))) {
          continue;
        }

        documents.push({
          id: doc.id,
          title: doc.title,
          folderPath: currentPath || "/",
          folderId: doc.folderId,
          isPublic: doc.isPublic,
          version: doc.version,
          updatedAt: doc.updatedAt,
          url: bunko.docUrl(doc.id),
        });
      }
    }

    return {
      query: kw || null,
      folders: folders.slice(0, limit),
      documents,
    };
  },
});

export const bunkoReadDocumentTool = defineTool({
  name: "bunko_read_document",
  description:
    "读取指定 Bunko 云文档的元信息、路径和 Markdown 正文（可按行号分段读取）。普通权限仅可读取公开文档或允许全员可读的非私密文档。",
  parameters: Type.Object(
    {
      documentId: Type.String({ minLength: 1 }),
      startLine: Type.Optional(Type.Integer({ minimum: 1 })),
      endLine: Type.Optional(Type.Integer({ minimum: 1 })),
    },
    { additionalProperties: false },
  ),
  execute: async (args, ctx) => {
    const { bunko } = ctx.services;
    const docId = args.documentId.trim();

    if (!isPrivilegedActor(ctx.actor)) {
      const allowed = await bunko.canStandardUserRead(
        docId,
        ctx.actor.actorAdmitted,
      );

      if (!allowed) {
        throw new Error(
          "该 Bunko 文档为私密或受限文档，普通权限仅可查阅公开或允许全员可读的非私密文档",
        );
      }
    }

    const [doc, breadcrumb, content] = await Promise.all([
      bunko.getDocument(docId),
      bunko.getBreadcrumb(docId),
      bunko.getContent(docId),
    ]);
    const lines = content.markdown ? content.markdown.split("\n") : [];
    const start = Math.max(1, args.startLine ?? 1);
    const end = Math.min(
      lines.length,
      Math.max(start, args.endLine ?? start + 199),
      start + 399,
    );
    const excerpt =
      lines.length > 0
        ? lines
            .slice(start - 1, end)
            .map((line, idx) => `${start + idx}: ${line}`)
            .join("\n")
        : "";

    return {
      id: doc.id,
      title: doc.title,
      url: bunko.docUrl(doc.id),
      breadcrumb: breadcrumb.map((c) => c.name),
      isPublic: doc.isPublic,
      isPrivate: doc.isPrivate,
      version: content.version,
      headVersion: content.headVersion,
      materialized: content.materialized,
      stale: content.stale,
      totalLines: lines.length,
      startLine: lines.length > 0 ? start : 0,
      endLine: lines.length > 0 ? end : 0,
      content: excerpt,
    };
  },
});

export const bunkoCreateDocumentTool = defineTool({
  name: "bunko_create_document",
  description:
    "在 Bunko 云文档中新建一篇文档并可选写入初始 Markdown 正文（仅管理员或网协管理层可用）。正文须为标准 GFM Markdown 且 <= 128 KiB，禁止原始 HTML 标签、图片节点或公式节点。",
  mutating: true,
  guard: requirePrivileged("在 Bunko 云文档创建文档"),
  parameters: Type.Object(
    {
      title: Type.String({ minLength: 1, maxLength: 200 }),
      folderId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      markdown: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
  ),
  execute: async (args, ctx) => {
    const doc = await ctx.services.bunko.createDocument({
      title: args.title,
      folderId: args.folderId,
      markdown: args.markdown,
    });

    return {
      mutated: true,
      document: {
        id: doc.id,
        title: doc.title,
        folderId: doc.folderId,
        version: doc.version,
        url: ctx.services.bunko.docUrl(doc.id),
      },
    };
  },
});

export const bunkoAppendDocumentTool = defineTool({
  name: "bunko_append_document",
  description:
    "向已有的 Bunko 云文档末尾幂等追加 Markdown 片段，实时同步给在线协同编辑者（仅管理员或网协管理层可用）。正文须为标准 GFM Markdown，禁止原始 HTML 标签、图片或公式节点。",
  mutating: true,
  guard: requirePrivileged("在 Bunko 云文档追加文档内容"),
  parameters: Type.Object(
    {
      documentId: Type.String({ minLength: 1 }),
      markdown: Type.String({ minLength: 1 }),
      idempotencyKey: Type.Optional(
        Type.String({ minLength: 1, maxLength: 128 }),
      ),
    },
    { additionalProperties: false },
  ),
  execute: async (args, ctx) => {
    const docId = args.documentId.trim();
    const derivedKey =
      args.idempotencyKey?.trim() ||
      `berry:${ctx.actor.triggerMessageId ?? "cmd"}:${createHash("sha256")
        .update(`${docId}\0${args.markdown}`)
        .digest("hex")
        .slice(0, 32)}`;

    const res = await ctx.services.bunko.appendContent(
      docId,
      args.markdown,
      derivedKey,
    );

    return {
      mutated: true,
      documentId: docId,
      version: res.version,
      url: ctx.services.bunko.docUrl(docId),
    };
  },
});

export const bunkoDeleteDocumentTool = defineTool({
  name: "bunko_delete_document",
  description:
    "将指定的 Bunko 云文档移入回收站（软删除，仅管理员或网协管理层可用）。",
  mutating: true,
  guard: requirePrivileged("在 Bunko 云文档删除文档"),
  parameters: Type.Object(
    {
      documentId: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
  execute: async (args, ctx) => {
    const docId = args.documentId.trim();
    const res = await ctx.services.bunko.deleteDocument(docId);

    return {
      mutated: true,
      documentId: docId,
      ...res,
    };
  },
});

export const bunkoTools: readonly Tool[] = [
  bunkoListTreeTool,
  bunkoReadDocumentTool,
  bunkoCreateDocumentTool,
  bunkoAppendDocumentTool,
  bunkoDeleteDocumentTool,
];
