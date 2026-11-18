import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export type DocScope = "knowledge" | "notebook";

export interface DocFileInfo {
  scope: DocScope;
  path: string;
  sizeBytes: number;
  updatedAt: number;
}

export class KnowledgeBase {
  #knowledgeDir: string;
  #notebookDir: string;

  constructor(knowledgeDir: string, notebookDir: string) {
    this.#knowledgeDir = resolve(knowledgeDir);
    this.#notebookDir = resolve(notebookDir);
  }

  public async listFiles(
    scope: DocScope | "all" = "all",
    prefix = "",
  ): Promise<DocFileInfo[]> {
    const scopes: DocScope[] =
      scope === "all" ? ["knowledge", "notebook"] : [scope];
    const items: DocFileInfo[] = [];

    for (const current of scopes) {
      const root = this.#rootFor(current);

      await this.#walk(root, root, current, items);
    }

    const normalizedPrefix = prefix.replace(/^\/+/, "");
    const filtered = normalizedPrefix
      ? items.filter((item) => item.path.startsWith(normalizedPrefix))
      : items;

    return filtered.sort((a, b) => a.path.localeCompare(b.path));
  }

  public async readLines(
    scope: DocScope,
    relPath: string,
    startLine = 1,
    endLine = 120,
  ): Promise<{
    scope: DocScope;
    path: string;
    startLine: number;
    endLine: number;
    totalLines: number;
    content: string;
  }> {
    const absPath = this.#resolveSafe(scope, relPath);
    const info = await stat(absPath);

    if (info.size > 2_000_000) {
      throw new Error("File exceeds 2MB read limit");
    }

    const text = await readFile(absPath, "utf8");
    const lines = text.split("\n");
    const start = Math.max(1, startLine);
    const end = Math.min(lines.length, Math.max(start, endLine, start + 399));
    const clampedEnd = Math.min(end, start + 399, lines.length);
    const slice = lines
      .slice(start - 1, clampedEnd)
      .map((line, idx) => `${start + idx}: ${line}`)
      .join("\n");

    return {
      scope,
      path: relPath,
      startLine: start,
      endLine: clampedEnd,
      totalLines: lines.length,
      content: slice,
    };
  }

  public async readRaw(scope: DocScope, relPath: string): Promise<string> {
    const absPath = this.#resolveSafe(scope, relPath);

    return readFile(absPath, "utf8");
  }

  public async search(
    query: string,
    scope: DocScope | "all" = "all",
    maxResults = 30,
  ): Promise<{ scope: DocScope; path: string; line: number; text: string }[]> {
    const needle = query.trim().toLowerCase();

    if (!needle) {
      return [];
    }

    const files = await this.listFiles(scope);
    const matches: {
      scope: DocScope;
      path: string;
      line: number;
      text: string;
    }[] = [];

    for (const file of files) {
      if (file.sizeBytes > 2_000_000) {
        continue;
      }

      const content = await readFile(
        this.#resolveSafe(file.scope, file.path),
        "utf8",
      );
      const lines = content.split("\n");

      for (const [i, line] of lines.entries()) {
        if (line.toLowerCase().includes(needle)) {
          matches.push({
            scope: file.scope,
            path: file.path,
            line: i + 1,
            text: line.slice(0, 300),
          });
          if (matches.length >= maxResults) {
            return matches;
          }
        }
      }
    }

    return matches;
  }

  public async writeNotebook(
    relPath: string,
    content: string,
    mode: "replace" | "append" = "replace",
  ): Promise<{ path: string; bytes: number }> {
    const absPath = this.#resolveSafe("notebook", relPath);

    await mkdir(dirname(absPath), { recursive: true });
    let nextContent = content;

    if (mode === "append") {
      try {
        const existing = await readFile(absPath, "utf8");

        nextContent = existing
          ? `${existing.replace(/\n*$/, "\n")}${content}`
          : content;
      } catch {
        // File does not exist yet.
      }
    }

    await writeFile(absPath, nextContent, "utf8");

    return { path: relPath, bytes: Buffer.byteLength(nextContent, "utf8") };
  }

  public async deleteNotebook(relPath: string): Promise<{ deleted: boolean }> {
    const absPath = this.#resolveSafe("notebook", relPath);

    await rm(absPath, { force: true });

    return { deleted: true };
  }

  #rootFor(scope: DocScope): string {
    return scope === "knowledge" ? this.#knowledgeDir : this.#notebookDir;
  }

  #resolveSafe(scope: DocScope, relPath: string): string {
    const clean = relPath.trim();

    if (!clean || isAbsolute(clean)) {
      throw new Error(`Invalid relative path: ${relPath}`);
    }

    const root = this.#rootFor(scope);
    const resolved = resolve(root, clean);
    const rel = relative(root, resolved);

    if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`Path escapes ${scope} sandbox: ${relPath}`);
    }

    return resolved;
  }

  async #walk(
    root: string,
    dir: string,
    scope: DocScope,
    out: DocFileInfo[],
  ): Promise<void> {
    let entries;

    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }

      const full = resolve(dir, entry.name);

      if (entry.isDirectory()) {
        await this.#walk(root, full, scope, out);
      } else if (entry.isFile()) {
        const info = await stat(full);

        out.push({
          scope,
          path: relative(root, full).replaceAll("\\", "/"),
          sizeBytes: info.size,
          updatedAt: info.mtimeMs,
        });
      }
    }
  }
}
