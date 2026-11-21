import { readFile, readdir, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

export interface DocFileInfo {
  path: string;
  sizeBytes: number;
  updatedAt: number;
}

export class KnowledgeBase {
  #knowledgeDir: string;

  constructor(knowledgeDir: string) {
    this.#knowledgeDir = resolve(knowledgeDir);
  }

  public async listFiles(prefix = ""): Promise<DocFileInfo[]> {
    const items: DocFileInfo[] = [];
    const entries = await readdir(this.#knowledgeDir, {
      recursive: true,
      withFileTypes: true,
    }).catch(() => []);

    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }

      const full = resolve(entry.parentPath, entry.name);
      const relPath = relative(this.#knowledgeDir, full).replaceAll("\\", "/");

      if (relPath.split("/").some((part) => part.startsWith("."))) {
        continue;
      }

      const info = await stat(full);

      items.push({
        path: relPath,
        sizeBytes: info.size,
        updatedAt: info.mtimeMs,
      });
    }

    const normalizedPrefix = prefix.replace(/^\/+/, "");
    const filtered = normalizedPrefix
      ? items.filter((item) => item.path.startsWith(normalizedPrefix))
      : items;

    return filtered.sort((a, b) => a.path.localeCompare(b.path));
  }

  public async readLines(
    relPath: string,
    startLine = 1,
    endLine = 120,
  ): Promise<{
    path: string;
    startLine: number;
    endLine: number;
    totalLines: number;
    content: string;
  }> {
    const absPath = this.#resolveSafe(relPath);
    const info = await stat(absPath);

    if (info.size > 2_000_000) {
      throw new Error("File exceeds 2MB read limit");
    }

    const text = await readFile(absPath, "utf8");
    const lines = text.split("\n");
    const start = Math.max(1, startLine);
    const end = Math.min(lines.length, Math.max(start, endLine), start + 399);
    const slice = lines
      .slice(start - 1, end)
      .map((line, idx) => `${start + idx}: ${line}`)
      .join("\n");

    return {
      path: relPath,
      startLine: start,
      endLine: end,
      totalLines: lines.length,
      content: slice,
    };
  }

  public async readRaw(relPath: string): Promise<string> {
    const absPath = this.#resolveSafe(relPath);

    return readFile(absPath, "utf8");
  }

  public async search(
    query: string,
    maxResults = 30,
  ): Promise<{ path: string; line: number; text: string }[]> {
    const needle = query.trim().toLowerCase();

    if (!needle) {
      return [];
    }

    const files = await this.listFiles();
    const matches: { path: string; line: number; text: string }[] = [];

    for (const file of files) {
      if (file.sizeBytes > 2_000_000) {
        continue;
      }

      const content = await readFile(this.#resolveSafe(file.path), "utf8");
      const lines = content.split("\n");

      for (const [i, line] of lines.entries()) {
        if (line.toLowerCase().includes(needle)) {
          matches.push({
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

  #resolveSafe(relPath: string): string {
    const clean = relPath.trim();

    if (!clean || isAbsolute(clean)) {
      throw new Error(`Invalid relative path: ${relPath}`);
    }

    const resolved = resolve(this.#knowledgeDir, clean);
    const rel = relative(this.#knowledgeDir, resolved);

    if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`Path escapes knowledge sandbox: ${relPath}`);
    }

    return resolved;
  }
}
