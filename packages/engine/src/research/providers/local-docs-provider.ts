import { promises as fs } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import type { ResearchProviderConfig, ResearchSource } from "@fusion/core";
import type { ResearchProvider } from "../../research-step-runner.js";
import { createLogger } from "../../logger.js";
import { ResearchProviderError, type ResearchFetchResult } from "../types.js";

const log = createLogger("research:local-docs");
const DEFAULT_MAX_RESULTS = 10;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_FILE_SIZE_BYTES = 1024 * 1024;
const BINARY_SNIFF_BYTES = 8 * 1024;

export interface LocalDocsProviderOptions {
  projectRoot: string;
  timeoutMs?: number;
  maxResults?: number;
  scanPaths?: string[];
}

export class LocalDocsProvider implements ResearchProvider {
  readonly type = "local-docs";
  private readonly projectRoot: string;
  private readonly scanPaths: string[];

  constructor(private readonly options: LocalDocsProviderOptions) {
    this.projectRoot = resolve(options.projectRoot);
    this.scanPaths = options.scanPaths ?? ["docs", "README.md", "AGENTS.md", ".fusion/memory"];
  }

  isConfigured(): boolean {
    return true;
  }

  async search(query: string, config: ResearchProviderConfig = {}, signal?: AbortSignal): Promise<ResearchSource[]> {
    const timeoutMs = Number(config.timeoutMs ?? this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const maxResults = Number(config.maxResults ?? this.options.maxResults ?? DEFAULT_MAX_RESULTS);
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);

    const files = await this.withTimeout(this.collectCandidateFiles(signal), timeoutMs, signal);
    const results: Array<{ source: ResearchSource; score: number }> = [];

    for (const file of files) {
      this.throwIfAborted(signal);
      const content = await this.safeReadText(file, signal);
      if (!content) continue;
      const lower = content.toLowerCase();
      let score = 0;
      for (const term of terms) {
        const matches = lower.match(new RegExp(escapeRegex(term), "g"));
        score += matches?.length ?? 0;
      }
      if (score <= 0) continue;

      const relPath = relative(this.projectRoot, file);
      results.push({
        score,
        source: {
          id: `local-docs-${relPath}`,
          type: "local",
          reference: relPath,
          title: relPath,
          excerpt: buildExcerpt(content, terms),
          status: "completed",
          metadata: { score, path: relPath },
        },
      });
    }

    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults)
      .map((item) => item.source);
  }

  async fetchContent(filePath: string, config: ResearchProviderConfig = {}, signal?: AbortSignal): Promise<ResearchFetchResult> {
    const timeoutMs = Number(config.timeoutMs ?? this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const resolvedPath = resolve(this.projectRoot, filePath);
    if (!resolvedPath.startsWith(this.projectRoot)) {
      throw new ResearchProviderError({
        providerType: "local-docs",
        code: "provider-unavailable",
        message: "Path traversal is not allowed",
      });
    }

    const stat = await this.withTimeout(fs.stat(resolvedPath), timeoutMs, signal);
    if (!stat.isFile()) {
      throw new ResearchProviderError({ providerType: "local-docs", code: "provider-unavailable", message: "Path is not a file" });
    }

    const content = await this.withTimeout(fs.readFile(resolvedPath), timeoutMs, signal);
    const sniff = content.subarray(0, BINARY_SNIFF_BYTES);
    if (sniff.includes(0)) {
      throw new ResearchProviderError({ providerType: "local-docs", code: "provider-unavailable", message: "Binary file is not supported" });
    }

    const text = content.toString("utf-8");
    return {
      content: text.length > MAX_FILE_SIZE_BYTES ? text.slice(0, MAX_FILE_SIZE_BYTES) : text,
      metadata: {
        path: relative(this.projectRoot, resolvedPath),
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        extension: extname(resolvedPath),
      },
      mimeType: "text/plain",
    };
  }

  private async collectCandidateFiles(signal?: AbortSignal): Promise<string[]> {
    const ignorePatterns = await this.readGitignore();
    const files: string[] = [];

    for (const pathEntry of this.scanPaths) {
      const target = resolve(this.projectRoot, pathEntry);
      if (!target.startsWith(this.projectRoot)) continue;
      try {
        const stat = await fs.stat(target);
        if (stat.isDirectory()) {
          await this.walk(target, files, ignorePatterns, signal);
        } else if (stat.isFile()) {
          files.push(target);
        }
      } catch {
        // ignore missing entries
      }
    }

    const rootEntries = await fs.readdir(this.projectRoot, { withFileTypes: true });
    for (const entry of rootEntries) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        files.push(join(this.projectRoot, entry.name));
      }
    }

    return [...new Set(files)];
  }

  private async walk(dir: string, out: string[], ignorePatterns: string[], signal?: AbortSignal): Promise<void> {
    this.throwIfAborted(signal);
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      this.throwIfAborted(signal);
      const fullPath = join(dir, entry.name);
      const relPath = relative(this.projectRoot, fullPath).replace(/\\/g, "/");
      if (matchesGitignore(relPath, ignorePatterns)) continue;

      if (entry.isDirectory()) {
        await this.walk(fullPath, out, ignorePatterns, signal);
      } else if (entry.isFile()) {
        out.push(fullPath);
      }
    }
  }

  private async safeReadText(filePath: string, signal?: AbortSignal): Promise<string | undefined> {
    try {
      const stat = await fs.stat(filePath);
      if (stat.size > MAX_FILE_SIZE_BYTES) return undefined;
      const content = await fs.readFile(filePath);
      if (content.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return undefined;
      this.throwIfAborted(signal);
      return content.toString("utf-8");
    } catch (error) {
      log.warn("failed to read local docs file", { filePath, error });
      return undefined;
    }
  }

  private async readGitignore(): Promise<string[]> {
    try {
      const content = await fs.readFile(join(this.projectRoot, ".gitignore"), "utf-8");
      return content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"));
    } catch {
      return [];
    }
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw new ResearchProviderError({ providerType: "local-docs", code: "abort", message: "Local docs scan aborted" });
    }
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        combined.addEventListener(
          "abort",
          () => {
            reject(
              new ResearchProviderError({
                providerType: "local-docs",
                code: signal?.aborted ? "abort" : "timeout",
                message: signal?.aborted ? "Local docs operation aborted" : `Local docs operation timed out after ${timeoutMs}ms`,
                retryable: !signal?.aborted,
              }),
            );
          },
          { once: true },
        );
      }),
    ]);
  }
}

function buildExcerpt(content: string, terms: string[]): string {
  const lower = content.toLowerCase();
  const first = terms.find((term) => lower.includes(term));
  if (!first) return content.slice(0, 220).replace(/\s+/g, " ").trim();

  const idx = lower.indexOf(first);
  const start = Math.max(0, idx - 80);
  const end = Math.min(content.length, idx + 140);
  return content.slice(start, end).replace(/\s+/g, " ").trim();
}

function matchesGitignore(relPath: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    if (pattern.endsWith("/")) return relPath.startsWith(pattern.slice(0, -1));
    if (pattern.includes("*")) {
      const regex = new RegExp(`^${pattern.split("*").map(escapeRegex).join(".*")}$`);
      return regex.test(relPath);
    }
    return relPath === pattern || relPath.startsWith(`${pattern}/`);
  });
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
