import { spawn } from "node:child_process";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { basename, resolve, sep } from "node:path";

export interface CodebaseMetrics {
  tokenEstimate: number;
  sourceFileCount: number;
  sourceByteCount: number;
  diskBytes: number;
  diskFileCount: number;
  method: string;
  truncated: boolean;
}

export interface CodebaseMetricsOptions {
  maxSourceEntries?: number;
  maxSourceWalkMs?: number;
  maxScanBytes?: number;
  maxFileBytes?: number;
  maxDiskEntries?: number;
  maxWalkMs?: number;
  cacheTtlMs?: number;
  now?: () => number;
}

export const MAX_SOURCE_ENTRIES = 50_000;
export const MAX_SOURCE_WALK_MS = 4_000;
export const MAX_SCAN_BYTES = 64 * 1024 * 1024;
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_DISK_ENTRIES = 500_000;
export const MAX_WALK_MS = 4_000;
export const CACHE_TTL_MS = 120_000;
const RUN_SEGMENT_LENGTH = 4;
const CALIBRATION_MULTIPLIER = 51 / 66;

/*
FNXC:CodebaseMetrics 2026-07-16-10:30:
Codebase context is computed entirely locally: a cl100k_base-calibrated, length-sensitive pre-tokenization piece count (P * K, L=4) is materially more useful for source than chars/4 without shipping files or loading a BPE tokenizer. Source metrics describe only scanned text files; disk metrics independently describe apparent size.

Git source enumeration uses bounded `git ls-files -z`. Non-git fallback includes regular files except directories whose basename starts with `.` or is exactly `node_modules`, `dist`, or `build`. Both paths reject out-of-root candidates and lstat-gate regular files before reading, never following symlinks. Source defaults are 50,000 entries, 4 seconds, 64 MiB total, and 2 MiB/file; disk defaults are 500,000 entries and 4 seconds. Disk sums lstat.size for regular files and symlink entries only (apparent size, never directories/special files), does not descend symlinks, and cache TTL is two minutes. Injectable limits and clock make every cap deterministic in tests.
*/

const cache = new Map<string, { result: CodebaseMetrics; expiresAt: number }>();
export function resetCodebaseMetricsCache(): void { cache.clear(); }

export function countPreTokenPieces(text: string): number {
  let pieces = 0;
  for (const match of text.matchAll(/[\p{L}]+|[\p{N}]+|[^\s\p{L}\p{N}]/gu)) {
    const run = match[0];
    pieces += /[\p{L}\p{N}]/u.test(run[0]) ? Math.ceil(Array.from(run).length / RUN_SEGMENT_LENGTH) : 1;
  }
  return pieces;
}
export function estimateTextTokens(text: string): number { return Math.round(countPreTokenPieces(text) * CALIBRATION_MULTIPLIER); }

function isInside(root: string, candidate: string): boolean { return candidate === root || candidate.startsWith(`${root}${sep}`); }
function isFallbackExcluded(name: string): boolean { return name.startsWith(".") || ["node_modules", "dist", "build"].includes(name); }
function isBinary(buffer: Buffer): boolean { return buffer.subarray(0, 8_192).includes(0); }

async function gitFiles(root: string, maxEntries: number, now: () => number, deadline: number): Promise<{ files: string[]; truncated: boolean } | null> {
  return await new Promise((resolveResult) => {
    const child = spawn("git", ["ls-files", "-z"], { cwd: root, stdio: ["ignore", "pipe", "ignore"] });
    const files: string[] = []; let pending = ""; let truncated = false; let settled = false;
    const stop = () => { child.stdout.removeAllListeners(); child.kill(); };
    const finish = (result: { files: string[]; truncated: boolean } | null) => {
      if (!settled) {
        settled = true;
        if (timeout) clearTimeout(timeout);
        resolveResult(result);
      }
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (settled) return;
      pending += chunk;
      let nul: number;
      while ((nul = pending.indexOf("\0")) !== -1) {
        const file = pending.slice(0, nul); pending = pending.slice(nul + 1);
        if (files.length >= maxEntries || now() > deadline) { truncated = true; stop(); finish({ files, truncated }); return; }
        files.push(file);
      }
    });
    child.on("error", () => finish(null));
    child.on("close", (code) => {
      if (settled) return;
      if (code === 0) finish({ files, truncated }); else finish(null);
    });
    // FNXC:CodebaseMetrics 2026-07-16-14:00: The source-walk deadline must also stop a silent or stalled git process; checking it only while stdout arrives leaves the dashboard request unbounded.
    const timeout = setTimeout(() => {
      truncated = true;
      stop();
      finish({ files, truncated });
    }, Math.max(0, deadline - now()));
  });
}

async function fallbackFiles(root: string, maxEntries: number, now: () => number, deadline: number): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = []; let truncated = false;
  async function walk(dir: string): Promise<void> {
    if (truncated || now() > deadline) { truncated = true; return; }
    let entries: string[];
    try { entries = await readdir(dir); } catch { return; }
    for (const entry of entries) {
      if (truncated || now() > deadline || files.length >= maxEntries) { truncated = true; return; }
      const candidate = resolve(dir, entry); let info;
      try { info = await lstat(candidate); } catch { continue; }
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) { if (!isFallbackExcluded(basename(candidate))) await walk(candidate); }
      else if (info.isFile()) files.push(candidate.slice(root.length + 1));
    }
  }
  await walk(root); return { files, truncated };
}

export async function computeCodebaseMetrics(rootDir: string, options: CodebaseMetricsOptions = {}): Promise<CodebaseMetrics> {
  const now = options.now ?? Date.now;
  const limits = {
    maxSourceEntries: options.maxSourceEntries ?? MAX_SOURCE_ENTRIES, maxSourceWalkMs: options.maxSourceWalkMs ?? MAX_SOURCE_WALK_MS,
    maxScanBytes: options.maxScanBytes ?? MAX_SCAN_BYTES, maxFileBytes: options.maxFileBytes ?? MAX_FILE_BYTES,
    maxDiskEntries: options.maxDiskEntries ?? MAX_DISK_ENTRIES, maxWalkMs: options.maxWalkMs ?? MAX_WALK_MS, cacheTtlMs: options.cacheTtlMs ?? CACHE_TTL_MS,
  };
  const cacheKey = resolve(rootDir); const cached = options.now === undefined ? cache.get(cacheKey) : undefined;
  if (cached && cached.expiresAt > now()) return cached.result;
  const root = await realpath(rootDir);
  let truncated = false; const sourceStart = now();
  const git = await gitFiles(root, limits.maxSourceEntries, now, sourceStart + limits.maxSourceWalkMs);
  const enumeration = git ?? await fallbackFiles(root, limits.maxSourceEntries, now, sourceStart + limits.maxSourceWalkMs);
  truncated ||= enumeration.truncated;
  let tokenEstimate = 0; let sourceFileCount = 0; let sourceByteCount = 0;
  for (const relative of enumeration.files) {
    if (now() > sourceStart + limits.maxSourceWalkMs || sourceFileCount >= limits.maxSourceEntries) { truncated = true; break; }
    const candidate = resolve(root, relative);
    if (!isInside(root, candidate)) continue;
    let info; try { info = await lstat(candidate); } catch { continue; }
    if (!info.isFile()) continue;
    // FNXC:CodebaseMetrics 2026-07-16-14:00: A source candidate above the per-file read limit is omitted to protect the local machine, so surface the aggregate estimate as partial rather than implying complete project coverage.
    if (info.size > limits.maxFileBytes) { truncated = true; continue; }
    if (sourceByteCount + info.size > limits.maxScanBytes) { truncated = true; break; }
    const contents = await readFile(candidate);
    if (isBinary(contents)) continue;
    sourceByteCount += contents.length; sourceFileCount++; tokenEstimate += estimateTextTokens(contents.toString("utf8"));
  }
  let diskBytes = 0; let diskFileCount = 0; let diskEntries = 0; const diskStart = now();
  async function walkDisk(dir: string): Promise<void> {
    if (truncated && diskEntries >= limits.maxDiskEntries) return;
    if (now() > diskStart + limits.maxWalkMs) { truncated = true; return; }
    let entries: string[]; try { entries = await readdir(dir); } catch { return; }
    for (const entry of entries) {
      if (diskEntries >= limits.maxDiskEntries || now() > diskStart + limits.maxWalkMs) { truncated = true; return; }
      const candidate = resolve(dir, entry); if (!isInside(root, candidate)) continue;
      let info; try { info = await lstat(candidate); } catch { continue; }
      diskEntries++;
      if (info.isDirectory()) await walkDisk(candidate);
      else if (info.isFile() || info.isSymbolicLink()) { diskFileCount++; diskBytes += info.size; }
    }
  }
  await walkDisk(root);
  const result = { tokenEstimate, sourceFileCount, sourceByteCount, diskBytes, diskFileCount, method: "local-pretokenization-cl100k_base", truncated };
  if (options.now === undefined) cache.set(cacheKey, { result, expiresAt: now() + limits.cacheTtlMs });
  return result;
}
