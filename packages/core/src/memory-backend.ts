/**
 * Pluggable Memory Backend System
 *
 * This module provides a pluggable architecture for project memory storage.
 * Different backends can be plugged in based on project settings, with
 * each backend declaring its capabilities (readable, writable, etc.).
 *
 * The default backend is qmd-backed search over layered memory files, with
 * local file search as a fallback when qmd is not installed.
 */

import { readFile, writeFile, mkdir, access, constants, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";

export const MEMORY_WORKSPACE_PATH = ".fusion/memory";
export const MEMORY_LONG_TERM_FILENAME = "MEMORY.md";
export const MEMORY_DREAMS_FILENAME = "DREAMS.md";
export const QMD_INSTALL_COMMAND = "bun install -g @tobilu/qmd";
export const QMD_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

const DAILY_MEMORY_RE = /^\d{4}-\d{2}-\d{2}\.md$/;
const MAX_MEMORY_SNIPPET_CHARS = 700;
const DEFAULT_MEMORY_GET_LINES = 120;
const MAX_MEMORY_GET_LINES = 400;
const QMD_COLLECTION_PREFIX = "fusion-memory";

type ExecFileAsync = (
  file: string,
  args: readonly string[],
  options?: { cwd?: string; timeout?: number; maxBuffer?: number },
) => Promise<{ stdout: string; stderr: string }>;

const qmdRefreshState = new Map<string, { lastStartedAt: number; inFlight?: Promise<void> }>();
let qmdInstallPromise: Promise<boolean> | null = null;

export function shouldSkipBackgroundQmdRefresh(): boolean {
  return (process.env.VITEST === "true" || process.env.NODE_ENV === "test")
    && process.env.FUSION_ENABLE_QMD_REFRESH_IN_TESTS !== "1";
}

// ── Type Definitions ────────────────────────────────────────────────

/**
 * Capabilities that a memory backend may support.
 * Used by the engine and dashboard to determine what operations are available.
 */
export interface MemoryBackendCapabilities {
  /** Backend can read memory content */
  readable: boolean;
  /** Backend can write/update memory content */
  writable: boolean;
  /** Backend supports atomic writes (vs append-only or merge-based) */
  supportsAtomicWrite: boolean;
  /** Backend has built-in conflict resolution for concurrent access */
  hasConflictResolution: boolean;
  /** Backend persists data across sessions */
  persistent: boolean;
}

/**
 * Result of a memory read operation.
 */
export interface MemoryReadResult {
  /** The memory content, or empty string if not found */
  content: string;
  /** Whether the memory file existed */
  exists: boolean;
  /** Backend identifier that served this read */
  backend: string;
}

/**
 * Result of a memory write operation.
 */
export interface MemoryWriteResult {
  /** Whether the write succeeded */
  success: boolean;
  /** The backend that processed this write */
  backend: string;
}

export interface MemoryGetOptions {
  path: string;
  startLine?: number;
  lineCount?: number;
}

export interface MemoryGetResult {
  path: string;
  content: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  backend: string;
}

export interface MemorySearchOptions {
  query: string;
  limit?: number;
}

export interface MemorySearchResult {
  path: string;
  lineStart: number;
  lineEnd: number;
  snippet: string;
  score: number;
  backend: string;
}

export interface MemoryFileInfo {
  path: string;
  label: string;
  layer: "long-term" | "daily" | "dreams";
  size: number;
  updatedAt: string;
}

/**
 * Error codes for memory operations.
 */
export type MemoryBackendErrorCode =
  | "NOT_FOUND"
  | "READ_ONLY"
  | "READ_FAILED"
  | "WRITE_FAILED"
  | "UNSUPPORTED"
  | "CONFLICT"
  | "QUOTA_EXCEEDED"
  | "BACKEND_UNAVAILABLE";

/**
 * Error class for memory backend operations.
 */
export class MemoryBackendError extends Error {
  readonly code: MemoryBackendErrorCode;
  readonly backend: string;

  constructor(code: MemoryBackendErrorCode, message: string, backend: string) {
    super(message);
    this.name = "MemoryBackendError";
    this.code = code;
    this.backend = backend;
  }
}

/**
 * Interface for memory backends.
 * Implement this interface to create a new memory backend.
 */
export interface MemoryBackend {
  /** Unique identifier for this backend type */
  readonly type: string;
  /** Human-readable name for this backend */
  readonly name: string;
  /** Capabilities supported by this backend */
  readonly capabilities: MemoryBackendCapabilities;
  /**
   * Read memory content.
   * @param rootDir - The project root directory
   * @returns Promise resolving to the memory content and metadata
   * @throws MemoryBackendError if reading fails
   */
  read(rootDir: string): Promise<MemoryReadResult>;
  /**
   * Write memory content.
   * @param rootDir - The project root directory
   * @param content - The content to write
   * @returns Promise resolving to the write result
   * @throws MemoryBackendError if writing fails or backend is read-only
   */
  write(rootDir: string, content: string): Promise<MemoryWriteResult>;
  /**
   * Read a specific memory file or line window. Implementations must reject
   * paths outside the memory workspace.
   */
  get?(rootDir: string, options: MemoryGetOptions): Promise<MemoryGetResult>;
  /**
   * Search memory files. Backends may use keyword search, vector search, or
   * external sidecars, but should return bounded snippets rather than full files.
   */
  search?(rootDir: string, options: MemorySearchOptions): Promise<MemorySearchResult[]>;
  /**
   * Check if memory exists for a project.
   * @param rootDir - The project root directory
   * @returns Promise resolving to true if memory exists
   */
  exists?(rootDir: string): Promise<boolean>;
}

/**
 * Configuration for a memory backend.
 * Used to select and configure which backend to use.
 */
export interface MemoryBackendConfig {
  /** The type of backend to use */
  type: string;
  /** Backend-specific configuration options */
  options?: Record<string, unknown>;
}

// ── Backend Registry ────────────────────────────────────────────────

/** Registry of registered memory backends */
const backendRegistry = new Map<string, MemoryBackend>();

/**
 * File-based memory backend.
 *
 * Stores project memory in `.fusion/memory/MEMORY.md` at the project root.
 */
export class FileMemoryBackend implements MemoryBackend {
  readonly type = "file";
  readonly name = "File (.fusion/memory/MEMORY.md)";
  readonly capabilities: MemoryBackendCapabilities = {
    readable: true,
    writable: true,
    supportsAtomicWrite: true,
    hasConflictResolution: false,
    persistent: true,
  };

  private getLongTermPath(rootDir: string): string {
    return join(rootDir, MEMORY_WORKSPACE_PATH, MEMORY_LONG_TERM_FILENAME);
  }

  async read(rootDir: string): Promise<MemoryReadResult> {
    const filePath = this.getLongTermPath(rootDir);
    try {
      const content = await readFile(filePath, "utf-8");
      return {
        content,
        exists: true,
        backend: this.type,
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return {
          content: "",
          exists: false,
          backend: this.type,
        };
      }
      throw new MemoryBackendError(
        "READ_FAILED",
        `Failed to read memory file: ${(err as Error).message}`,
        this.type,
      );
    }
  }

  async write(rootDir: string, content: string): Promise<MemoryWriteResult> {
    const filePath = this.getLongTermPath(rootDir);
    const dir = join(rootDir, MEMORY_WORKSPACE_PATH);

    try {
      // Ensure directory exists
      if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true });
      }

      // Write atomically using temp file
      const tmpPath = filePath + ".tmp";
      await writeFile(tmpPath, content, "utf-8");

      // Import rename for atomic swap
      const { rename } = await import("node:fs/promises");
      await rename(tmpPath, filePath);

      return {
        success: true,
        backend: this.type,
      };
    } catch (err) {
      throw new MemoryBackendError(
        "WRITE_FAILED",
        `Failed to write memory file: ${(err as Error).message}`,
        this.type,
      );
    }
  }

  async exists(rootDir: string): Promise<boolean> {
    try {
      await access(this.getLongTermPath(rootDir), constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  async get(rootDir: string, options: MemoryGetOptions): Promise<MemoryGetResult> {
    return getMemoryFile(rootDir, options, this.type);
  }

  async search(rootDir: string, options: MemorySearchOptions): Promise<MemorySearchResult[]> {
    return searchMemoryFiles(rootDir, options, this.type);
  }
}

/**
 * Read-only memory backend.
 *
 * Returns empty content on read and throws on write.
 * Useful when memory is managed externally or read-only access is required.
 */
export class ReadOnlyMemoryBackend implements MemoryBackend {
  readonly type = "readonly";
  readonly name = "Read-Only";
  readonly capabilities: MemoryBackendCapabilities = {
    readable: true,
    writable: false,
    supportsAtomicWrite: false,
    hasConflictResolution: false,
    persistent: false,
  };

  async read(_rootDir: string): Promise<MemoryReadResult> {
    return {
      content: "",
      exists: false,
      backend: this.type,
    };
  }

  async write(_rootDir: string, _content: string): Promise<MemoryWriteResult> {
    throw new MemoryBackendError(
      "READ_ONLY",
      "This backend is read-only and cannot write memory",
      this.type,
    );
  }

  async get(_rootDir: string, options: MemoryGetOptions): Promise<MemoryGetResult> {
    throw new MemoryBackendError(
      "NOT_FOUND",
      `Memory path '${options.path}' not found`,
      this.type,
    );
  }

  async search(_rootDir: string, _options: MemorySearchOptions): Promise<MemorySearchResult[]> {
    return [];
  }
}

/**
 * QMD (qmd index/query integration) memory backend.
 *
 * Stores project memory in `.fusion/memory/MEMORY.md` so it can be indexed and queried
 * by the external `qmd` tool. Read/write operations use direct filesystem access
 * for reliability. The `qmd` tool can be configured separately to watch and index
 * layered memory files for advanced querying capabilities.
 *
 * **Capabilities:**
 * - readable: true
 * - writable: true
 * - supportsAtomicWrite: false (QMD indexing is async/external)
 * - hasConflictResolution: false
 * - persistent: true (memory files persist in `.fusion/memory/`)
 *
 * @example
 * ```typescript
 * // Configure in settings to enable qmd integration
 * const settings = { memoryBackendType: 'qmd' };
 * const backend = resolveMemoryBackend(settings);
 * ```
 */
export class QmdMemoryBackend implements MemoryBackend {
  readonly type = "qmd";
  readonly name = "QMD (qmd index/query integration)";
  readonly capabilities: MemoryBackendCapabilities = {
    readable: true,
    writable: true,
    supportsAtomicWrite: false,
    hasConflictResolution: false,
    persistent: true,
  };

  /** Delegate file backend for actual I/O operations */
  private readonly fileBackend = new FileMemoryBackend();

  /**
   * Read memory content from the filesystem.
   *
   * @param rootDir - The project root directory
   * @returns Promise resolving to memory read result
   */
  async read(rootDir: string): Promise<MemoryReadResult> {
    // Delegate to file backend, but return "qmd" as the backend identifier
    const result = await this.fileBackend.read(rootDir);
    return {
      ...result,
      backend: this.type,
    };
  }

  /**
   * Write memory content to the filesystem.
   *
   * @param rootDir - The project root directory
   * @param content - The content to write
   * @returns Promise resolving to write result
   */
  async write(rootDir: string, content: string): Promise<MemoryWriteResult> {
    // Delegate to file backend, but return "qmd" as the backend identifier
    const result = await this.fileBackend.write(rootDir, content);
    scheduleQmdProjectMemoryRefresh(rootDir);
    return {
      ...result,
      backend: this.type,
    };
  }

  /**
   * Check if memory file exists.
   *
   * @param rootDir - The project root directory
   * @returns Promise resolving to true if memory exists
   */
  async exists(rootDir: string): Promise<boolean> {
    return this.fileBackend.exists(rootDir);
  }

  async get(rootDir: string, options: MemoryGetOptions): Promise<MemoryGetResult> {
    return getMemoryFile(rootDir, options, this.type);
  }

  async search(rootDir: string, options: MemorySearchOptions): Promise<MemorySearchResult[]> {
    const qmdResults = await searchWithQmd(rootDir, options);
    if (qmdResults.length > 0) {
      return qmdResults.map((result) => ({ ...result, backend: this.type }));
    }
    return searchMemoryFiles(rootDir, options, this.type);
  }
}

export function memoryWorkspacePath(rootDir: string): string {
  return join(rootDir, MEMORY_WORKSPACE_PATH);
}

export function memoryLongTermPath(rootDir: string): string {
  return join(memoryWorkspacePath(rootDir), MEMORY_LONG_TERM_FILENAME);
}

export function memoryDreamsPath(rootDir: string): string {
  return join(memoryWorkspacePath(rootDir), MEMORY_DREAMS_FILENAME);
}

export function qmdMemoryCollectionName(rootDir: string): string {
  const absoluteRoot = resolve(rootDir);
  const slug = basename(absoluteRoot)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "project";
  const hash = createHash("sha1").update(absoluteRoot).digest("hex").slice(0, 12);
  return `${QMD_COLLECTION_PREFIX}-${slug}-${hash}`;
}

export function buildQmdSearchArgs(rootDir: string, options: MemorySearchOptions): string[] {
  const limit = Math.max(1, Math.min(options.limit ?? 5, 20));
  return [
    "search",
    options.query,
    "--json",
    "--collection",
    qmdMemoryCollectionName(rootDir),
    "-n",
    String(limit),
  ];
}

export function buildQmdCollectionAddArgs(rootDir: string): string[] {
  return [
    "collection",
    "add",
    memoryWorkspacePath(rootDir),
    "--name",
    qmdMemoryCollectionName(rootDir),
    "--mask",
    "**/*.md",
  ];
}

export function buildQmdRefreshCommands(rootDir: string): string[][] {
  return [
    buildQmdCollectionAddArgs(rootDir),
    ["update"],
    ["embed"],
  ];
}

export function dailyMemoryPath(rootDir: string, date = new Date()): string {
  return join(memoryWorkspacePath(rootDir), `${date.toISOString().slice(0, 10)}.md`);
}

export function getDefaultLongTermMemoryScaffold(): string {
  return `# Project Memory

<!-- Curated long-term memory. Store durable decisions, conventions, preferences, and pitfalls. -->

## Decisions

## Conventions

## Pitfalls

## Context
`;
}

export function getDefaultDailyMemoryScaffold(date = new Date()): string {
  return `# Daily Memory ${date.toISOString().slice(0, 10)}

<!-- Append running observations, open loops, and day-to-day notes here. Promote evergreen facts to MEMORY.md. -->
`;
}

export function getDefaultDreamsScaffold(): string {
  return `# Memory Dreams

<!-- Periodic synthesized patterns from daily notes. Promote durable lessons to MEMORY.md. -->
`;
}

export async function ensureOpenClawMemoryFiles(rootDir: string, date = new Date()): Promise<{ longTermCreated: boolean; dailyCreated: boolean }> {
  const workspacePath = memoryWorkspacePath(rootDir);
  await mkdir(workspacePath, { recursive: true });

  const longTermPath = memoryLongTermPath(rootDir);
  let longTermCreated = false;
  if (!existsSync(longTermPath)) {
    await writeFile(longTermPath, getDefaultLongTermMemoryScaffold(), "utf-8");
    longTermCreated = true;
  }

  const todayPath = dailyMemoryPath(rootDir, date);
  let dailyCreated = false;
  if (!existsSync(todayPath)) {
    await writeFile(todayPath, getDefaultDailyMemoryScaffold(date), "utf-8");
    dailyCreated = true;
  }

  const dreamsPath = memoryDreamsPath(rootDir);
  if (!existsSync(dreamsPath)) {
    await writeFile(dreamsPath, getDefaultDreamsScaffold(), "utf-8");
  }

  return { longTermCreated, dailyCreated };
}

function getMemoryFileLayer(displayPath: string): MemoryFileInfo["layer"] {
  if (displayPath === `${MEMORY_WORKSPACE_PATH}/${MEMORY_LONG_TERM_FILENAME}`) return "long-term";
  if (displayPath === `${MEMORY_WORKSPACE_PATH}/${MEMORY_DREAMS_FILENAME}`) return "dreams";
  return "daily";
}

function getMemoryFileLabel(displayPath: string): string {
  const layer = getMemoryFileLayer(displayPath);
  if (layer === "long-term") return "Long-term memory";
  if (layer === "dreams") return "Dreams";
  return `Daily notes ${basename(displayPath, ".md")}`;
}

export async function listProjectMemoryFiles(rootDir: string, date = new Date()): Promise<MemoryFileInfo[]> {
  await ensureOpenClawMemoryFiles(rootDir, date);
  const files = await listMemoryFiles(rootDir);
  const uniqueFiles = Array.from(new Map(files.map((file) => [file.displayPath, file])).values());
  const infos = await Promise.all(uniqueFiles.map(async (file) => {
    const fileStat = await stat(file.absPath);
    return {
      path: file.displayPath,
      label: getMemoryFileLabel(file.displayPath),
      layer: getMemoryFileLayer(file.displayPath),
      size: fileStat.size,
      updatedAt: fileStat.mtime.toISOString(),
    } satisfies MemoryFileInfo;
  }));

  const order: Record<MemoryFileInfo["layer"], number> = {
    "long-term": 0,
    daily: 1,
    dreams: 2,
  };
  return infos.sort((a, b) => order[a.layer] - order[b.layer] || b.path.localeCompare(a.path));
}

export async function readProjectMemoryFile(rootDir: string, options: MemoryGetOptions): Promise<MemoryGetResult> {
  return getMemoryFile(rootDir, options, "file");
}

export async function readProjectMemoryFileContent(rootDir: string, path: string): Promise<{ path: string; content: string }> {
  const { absPath, displayPath } = resolveMemoryFilePath(rootDir, path);
  try {
    const content = await readFile(absPath, "utf-8");
    return { path: displayPath, content };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new MemoryBackendError("NOT_FOUND", `Memory path '${path}' not found`, "file");
    }
    throw new MemoryBackendError("READ_FAILED", `Failed to read memory path '${path}': ${(err as Error).message}`, "file");
  }
}

export async function writeProjectMemoryFile(rootDir: string, path: string, content: string): Promise<MemoryWriteResult> {
  const { absPath } = resolveMemoryFilePath(rootDir, path);
  await mkdir(dirname(absPath), { recursive: true });
  const tmpPath = `${absPath}.tmp`;
  await writeFile(tmpPath, content, "utf-8");
  const { rename } = await import("node:fs/promises");
  await rename(tmpPath, absPath);

  return { success: true, backend: "file" };
}

function isPathTraversal(path: string): boolean {
  return path.split(/[\\/]+/).includes("..");
}

function normalizeMemoryRequestPath(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    throw new MemoryBackendError("NOT_FOUND", "Memory path is required", "memory");
  }
  if (isAbsolute(trimmed) || isPathTraversal(trimmed)) {
    throw new MemoryBackendError("UNSUPPORTED", "Memory paths must be workspace-relative", "memory");
  }
  const normalized = normalize(trimmed).replace(/\\/g, "/");
  if (
    normalized === MEMORY_LONG_TERM_FILENAME
    || normalized === MEMORY_DREAMS_FILENAME
    || normalized === `memory/${MEMORY_LONG_TERM_FILENAME}`
    || normalized === `memory/${MEMORY_DREAMS_FILENAME}`
  ) {
    return `${MEMORY_WORKSPACE_PATH}/${basename(normalized)}`;
  }
  if (DAILY_MEMORY_RE.test(basename(normalized)) && (normalized === basename(normalized) || normalized.startsWith("memory/"))) {
    return `${MEMORY_WORKSPACE_PATH}/${basename(normalized)}`;
  }
  if (normalized.startsWith(`${MEMORY_WORKSPACE_PATH}/`)) {
    const file = basename(normalized);
    if (file === MEMORY_LONG_TERM_FILENAME || file === MEMORY_DREAMS_FILENAME || DAILY_MEMORY_RE.test(file)) {
      return `${MEMORY_WORKSPACE_PATH}/${file}`;
    }
  }
  throw new MemoryBackendError(
    "UNSUPPORTED",
    `Memory path '${rawPath}' is outside allowed files: .fusion/memory/MEMORY.md, .fusion/memory/DREAMS.md, .fusion/memory/YYYY-MM-DD.md`,
    "memory",
  );
}

function resolveMemoryFilePath(rootDir: string, requestedPath: string): { absPath: string; displayPath: string } {
  const displayPath = normalizeMemoryRequestPath(requestedPath);
  const absPath = resolve(rootDir, displayPath);
  const rel = relative(rootDir, absPath);
  if (!rel || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
    throw new MemoryBackendError("UNSUPPORTED", "Memory path escapes project root", "memory");
  }
  return { absPath, displayPath };
}

async function getMemoryFile(rootDir: string, options: MemoryGetOptions, backend: string): Promise<MemoryGetResult> {
  const { absPath, displayPath } = resolveMemoryFilePath(rootDir, options.path);
  let content: string;
  try {
    content = await readFile(absPath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new MemoryBackendError("NOT_FOUND", `Memory path '${options.path}' not found`, backend);
    }
    throw new MemoryBackendError("READ_FAILED", `Failed to read memory path '${options.path}': ${(err as Error).message}`, backend);
  }

  const lines = content.split("\n");
  const startLine = Math.max(1, Math.floor(options.startLine ?? 1));
  const requestedCount = Math.max(1, Math.floor(options.lineCount ?? DEFAULT_MEMORY_GET_LINES));
  const lineCount = Math.min(requestedCount, MAX_MEMORY_GET_LINES);
  const startIndex = Math.min(startLine - 1, lines.length);
  const endIndex = Math.min(startIndex + lineCount, lines.length);

  return {
    path: displayPath,
    content: lines.slice(startIndex, endIndex).join("\n"),
    startLine,
    endLine: endIndex,
    totalLines: lines.length,
    backend,
  };
}

async function listMemoryFiles(rootDir: string): Promise<Array<{ absPath: string; displayPath: string }>> {
  const files: Array<{ absPath: string; displayPath: string }> = [];
  const workspacePath = memoryWorkspacePath(rootDir);
  const longTerm = memoryLongTermPath(rootDir);
  if (existsSync(longTerm)) {
    files.push({ absPath: longTerm, displayPath: `${MEMORY_WORKSPACE_PATH}/${MEMORY_LONG_TERM_FILENAME}` });
  }
  const dreams = memoryDreamsPath(rootDir);
  if (existsSync(dreams)) {
    files.push({ absPath: dreams, displayPath: `${MEMORY_WORKSPACE_PATH}/${MEMORY_DREAMS_FILENAME}` });
  }

  if (existsSync(workspacePath)) {
    for (const entry of await readdir(workspacePath)) {
      if (!DAILY_MEMORY_RE.test(entry)) continue;
      const absPath = join(workspacePath, entry);
      const fileStat = await stat(absPath);
      if (fileStat.isFile()) {
        files.push({ absPath, displayPath: `${MEMORY_WORKSPACE_PATH}/${entry}` });
      }
    }
  }

  return files;
}

function scoreSnippet(snippet: string, queryTerms: string[]): number {
  const normalized = snippet.toLowerCase();
  return queryTerms.reduce((score, term) => score + (normalized.includes(term) ? 1 : 0), 0);
}

async function searchMemoryFiles(rootDir: string, options: MemorySearchOptions, backend: string): Promise<MemorySearchResult[]> {
  const queryTerms = options.query
    .toLowerCase()
    .split(/[^a-z0-9_-]+/i)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2);
  if (queryTerms.length === 0) {
    return [];
  }

  const limit = Math.max(1, Math.min(options.limit ?? 5, 20));
  const results: MemorySearchResult[] = [];

  for (const file of await listMemoryFiles(rootDir)) {
    const lines = (await readFile(file.absPath, "utf-8")).split("\n");
    for (let index = 0; index < lines.length; index += 8) {
      const chunkLines = lines.slice(index, index + 12);
      const snippet = chunkLines.join("\n").trim();
      if (!snippet) continue;
      const score = scoreSnippet(snippet, queryTerms);
      if (score === 0) continue;
      results.push({
        path: file.displayPath,
        lineStart: index + 1,
        lineEnd: Math.min(index + chunkLines.length, lines.length),
        snippet: snippet.slice(0, MAX_MEMORY_SNIPPET_CHARS),
        score,
        backend,
      });
    }
  }

  return results
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, limit);
}

function normalizeQmdSearchResultPath(rootDir: string, rawPath: unknown): string {
  const original = String(rawPath ?? "").trim();
  if (!original) {
    return "";
  }

  let candidate = original.replace(/\\/g, "/");
  const uriMatch = candidate.match(/^qmd:\/\/[^/]+\/(.+)$/i);
  if (uriMatch?.[1]) {
    candidate = uriMatch[1];
  }

  candidate = candidate.split("?")[0]?.split("#")[0] ?? "";
  candidate = candidate.replace(/^\.\/+/, "");

  if (isAbsolute(candidate)) {
    const rel = relative(resolve(rootDir), resolve(candidate)).replace(/\\/g, "/");
    if (rel && rel !== "." && rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel)) {
      candidate = rel;
    }
  }

  const lowerCandidate = candidate.toLowerCase();
  const normalizedBaseName = basename(candidate).toLowerCase();
  const normalizedDirName = dirname(lowerCandidate).replace(/\\/g, "/");

  // Map stale indexed top-level memory paths to the canonical layered path so
  // qmd search results stay readable. This does not re-enable legacy read/write
  // requests in runtime APIs.
  if (normalizedBaseName === "memory.md" && (normalizedDirName === ".fusion" || normalizedDirName.endsWith("/.fusion"))) {
    return `${MEMORY_WORKSPACE_PATH}/${MEMORY_LONG_TERM_FILENAME}`;
  }
  if (normalizedBaseName === MEMORY_LONG_TERM_FILENAME.toLowerCase()) {
    return `${MEMORY_WORKSPACE_PATH}/${MEMORY_LONG_TERM_FILENAME}`;
  }
  if (normalizedBaseName === MEMORY_DREAMS_FILENAME.toLowerCase()) {
    return `${MEMORY_WORKSPACE_PATH}/${MEMORY_DREAMS_FILENAME}`;
  }
  if (DAILY_MEMORY_RE.test(normalizedBaseName)) {
    return `${MEMORY_WORKSPACE_PATH}/${normalizedBaseName}`;
  }

  try {
    return normalizeMemoryRequestPath(candidate);
  } catch {
    return original;
  }
}

async function searchWithQmd(rootDir: string, options: MemorySearchOptions): Promise<MemorySearchResult[]> {
  if (shouldSkipBackgroundQmdRefresh()) {
    return [];
  }
  const command = "qmd";
  const limit = Math.max(1, Math.min(options.limit ?? 5, 20));
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    await ensureQmdProjectMemoryCollection(rootDir, execFileAsync);
    scheduleQmdProjectMemoryRefresh(rootDir);
    const args = buildQmdSearchArgs(rootDir, options);
    const { stdout } = await execFileAsync(command, args, {
      cwd: rootDir,
      timeout: 4000,
      maxBuffer: 1024 * 1024,
    });
    const parsed = JSON.parse(stdout);
    const rawResults = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.results) ? parsed.results : [];
    return rawResults
      .slice(0, limit)
      .map((result: Record<string, unknown>, index: number) => {
        const rawPath = result.path ?? result.file ?? `qmd/result-${index + 1}`;
        return {
          path: normalizeQmdSearchResultPath(rootDir, rawPath) || String(rawPath),
          lineStart: Number(result.lineStart ?? result.startLine ?? 1),
          lineEnd: Number(result.lineEnd ?? result.endLine ?? result.startLine ?? 1),
          snippet: String(result.snippet ?? result.text ?? result.content ?? "").slice(
            0,
            MAX_MEMORY_SNIPPET_CHARS,
          ),
          score: Number(result.score ?? 1),
          backend: "qmd",
        };
      })
      .filter((result: MemorySearchResult) => result.snippet.trim().length > 0);
  } catch {
    return [];
  }
}

async function ensureQmdProjectMemoryCollection(
  rootDir: string,
  execFileAsync: ExecFileAsync,
): Promise<string> {
  const collectionName = qmdMemoryCollectionName(rootDir);
  const memoryDir = memoryWorkspacePath(rootDir);
  await mkdir(memoryDir, { recursive: true });

  try {
    await execFileAsync("qmd", buildQmdCollectionAddArgs(rootDir), {
      cwd: rootDir,
      timeout: 4000,
      maxBuffer: 512 * 1024,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const stderr = typeof err === "object" && err && "stderr" in err ? String((err as { stderr?: unknown }).stderr ?? "") : "";
    if (!/already exists|exists/i.test(`${message}\n${stderr}`)) {
      throw err;
    }
  }

  return collectionName;
}

async function getDefaultExecFileAsync(): Promise<ExecFileAsync> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  return promisify(execFile);
}

export async function refreshQmdProjectMemoryIndex(
  rootDir: string,
  options?: { force?: boolean; execFileAsync?: ExecFileAsync },
): Promise<void> {
  const key = resolve(rootDir);
  const now = Date.now();
  const current = qmdRefreshState.get(key);

  if (!options?.force) {
    if (current?.inFlight) {
      return current.inFlight;
    }
    if (current && now - current.lastStartedAt < QMD_REFRESH_INTERVAL_MS) {
      return;
    }
  }

  const promise = (async () => {
    const execFileAsync = options?.execFileAsync ?? await getDefaultExecFileAsync();
    await ensureQmdProjectMemoryCollection(rootDir, execFileAsync);
    await execFileAsync("qmd", ["update"], {
      cwd: rootDir,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    await execFileAsync("qmd", ["embed"], {
      cwd: rootDir,
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
    });
  })();

  qmdRefreshState.set(key, { lastStartedAt: now, inFlight: promise });

  try {
    await promise;
  } finally {
    const latest = qmdRefreshState.get(key);
    if (latest?.inFlight === promise) {
      qmdRefreshState.set(key, { lastStartedAt: latest.lastStartedAt });
    }
  }
}

export function scheduleQmdProjectMemoryRefresh(rootDir: string): void {
  if (shouldSkipBackgroundQmdRefresh()) {
    return;
  }

  void refreshQmdProjectMemoryIndex(rootDir).catch(() => {
    // qmd is optional. Search falls back to local file scanning when refresh fails.
  });
}

export async function isQmdAvailable(): Promise<boolean> {
  try {
    const execFileAsync = await getDefaultExecFileAsync();
    await execFileAsync("qmd", ["--help"], {
      timeout: 3000,
      maxBuffer: 128 * 1024,
    });
    return true;
  } catch {
    return false;
  }
}

export async function installQmd(
  options?: { execFileAsync?: ExecFileAsync },
): Promise<boolean> {
  const execFileAsync = options?.execFileAsync ?? await getDefaultExecFileAsync();
  const [command, ...args] = QMD_INSTALL_COMMAND.split(" ");
  if (!command || args.length === 0) {
    throw new MemoryBackendError("BACKEND_UNAVAILABLE", "qmd install command is not configured", "qmd");
  }
  await execFileAsync(command, args, {
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
  });
  return true;
}

export async function ensureQmdInstalled(
  options?: {
    execFileAsync?: ExecFileAsync;
    isAvailable?: () => Promise<boolean>;
  },
): Promise<boolean> {
  const checkAvailable = options?.isAvailable ?? isQmdAvailable;
  if (await checkAvailable()) {
    return true;
  }

  if (!qmdInstallPromise) {
    qmdInstallPromise = installQmd({ execFileAsync: options?.execFileAsync })
      .then(async () => checkAvailable())
      .finally(() => {
        qmdInstallPromise = null;
      });
  }

  return qmdInstallPromise;
}

export async function ensureQmdInstalledAndRefresh(rootDir: string): Promise<void> {
  const available = await ensureQmdInstalled();
  if (available) {
    await refreshQmdProjectMemoryIndex(rootDir, { force: true });
  }
}

export function scheduleQmdInstallAndRefresh(rootDir: string): void {
  if (shouldSkipBackgroundQmdRefresh()) {
    return;
  }

  void ensureQmdInstalledAndRefresh(rootDir).catch(() => {
    // qmd remains optional at runtime. Search falls back to local file scanning.
  });
}

// ── Backend Registration ─────────────────────────────────────────────

/**
 * File-based backend instance (shared across registry operations).
 */
const fileBackendInstance = new FileMemoryBackend();

// Register built-in backends
backendRegistry.set("file", fileBackendInstance);
backendRegistry.set("readonly", new ReadOnlyMemoryBackend());
backendRegistry.set("qmd", new QmdMemoryBackend());

/**
 * Register a new memory backend.
 * @param backend - The backend to register
 */
export function registerMemoryBackend(backend: MemoryBackend): void {
  backendRegistry.set(backend.type, backend);
}

/**
 * Get a registered memory backend by type.
 * @param type - The backend type
 * @returns The backend instance, or undefined if not found
 */
export function getMemoryBackend(type: string): MemoryBackend | undefined {
  return backendRegistry.get(type);
}

/**
 * List all registered backend types.
 * @returns Array of backend type identifiers
 */
export function listMemoryBackendTypes(): string[] {
  return Array.from(backendRegistry.keys());
}

// ── Settings Keys ────────────────────────────────────────────────────

/**
 * Settings keys related to memory backend selection.
 */
export const MEMORY_BACKEND_SETTINGS_KEYS = {
  /** Backend type to use (default: "file") */
  MEMORY_BACKEND_TYPE: "memoryBackendType",
} as const;

/**
 * Default memory backend type.
 */
export const DEFAULT_MEMORY_BACKEND = "qmd";

// ── Type for Settings ───────────────────────────────────────────────

/**
 * Type for settings that can be used with memory backend resolution.
 * Uses a generic constraint to accept any object with string indexing.
 */
type MemorySettings = {
  memoryEnabled?: boolean;
  memoryBackendType?: string;
  [key: string]: unknown;
};

// ── Resolution Functions ─────────────────────────────────────────────

/**
 * Resolve the appropriate memory backend based on settings.
 *
 * @param settings - Project settings object
 * @returns The memory backend to use, defaulting to file backend
 */
export function resolveMemoryBackend(settings?: MemorySettings): MemoryBackend {
  const backendType = (settings?.[MEMORY_BACKEND_SETTINGS_KEYS.MEMORY_BACKEND_TYPE] as string) || DEFAULT_MEMORY_BACKEND;
  const backend = backendRegistry.get(backendType);
  if (backend) {
    return backend;
  }
  // Fall back to file backend if unknown type
  return backendRegistry.get(DEFAULT_MEMORY_BACKEND)!;
}

/**
 * Get memory backend capabilities based on settings.
 *
 * @param settings - Project settings object
 * @returns The capabilities of the resolved backend
 */
export function getMemoryBackendCapabilities(settings?: MemorySettings): MemoryBackendCapabilities {
  return resolveMemoryBackend(settings).capabilities;
}

// ── Convenience Functions ────────────────────────────────────────────

/**
 * Read memory using the configured backend.
 * Returns empty content if backend is not readable or file doesn't exist.
 *
 * @param rootDir - Project root directory
 * @param settings - Project settings
 * @returns Promise resolving to memory content
 */
export async function readMemory(
  rootDir: string,
  settings?: MemorySettings,
): Promise<MemoryReadResult> {
  const backend = resolveMemoryBackend(settings);
  try {
    return await backend.read(rootDir);
  } catch (err) {
    if (err instanceof MemoryBackendError) {
      // For readable backends that fail, return empty content
      if (err.code === "READ_FAILED" || err.code === "BACKEND_UNAVAILABLE") {
        return {
          content: "",
          exists: false,
          backend: backend.type,
        };
      }
    }
    throw err;
  }
}

/**
 * Write memory using the configured backend.
 *
 * @param rootDir - Project root directory
 * @param content - Content to write
 * @param settings - Project settings
 * @returns Promise resolving to write result
 * @throws MemoryBackendError if backend is not writable
 */
export async function writeMemory(
  rootDir: string,
  content: string,
  settings?: MemorySettings,
): Promise<MemoryWriteResult> {
  const backend = resolveMemoryBackend(settings);

  if (!backend.capabilities.writable) {
    throw new MemoryBackendError(
      "READ_ONLY",
      `Backend '${backend.type}' does not support writing`,
      backend.type,
    );
  }

  return backend.write(rootDir, content);
}

/**
 * Check if memory exists using the configured backend.
 *
 * @param rootDir - Project root directory
 * @param settings - Project settings
 * @returns Promise resolving to true if memory exists
 */
export async function memoryExists(
  rootDir: string,
  settings?: MemorySettings,
): Promise<boolean> {
  const backend = resolveMemoryBackend(settings);

  if (backend.exists) {
    return backend.exists(rootDir);
  }

  // Fall back to read operation
  try {
    const result = await backend.read(rootDir);
    return result.exists;
  } catch {
    return false;
  }
}
