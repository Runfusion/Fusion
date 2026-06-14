import { exec } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Settings } from "@fusion/core";

const execAsync = promisify(exec);

export const INSTALL_MARKER_RELPATH = join("node_modules", ".fusion-install-marker");
const LOCKFILE_CANDIDATES = ["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lockb", "bun.lock"];
const INSTALL_TIMEOUT_MS = 300_000;

export interface WorktreeDependencySyncLogger {
  log?: (message: string) => void;
}

export interface WorktreeDependencySyncResult {
  installCommand: string | null;
  configured: boolean;
  skipped: boolean;
  skipReason?: "no-command" | "lockfile-marker-match";
  durationMs: number;
}

export interface InstallWorktreeDependenciesOptions {
  cwd: string;
  settings?: Settings | null;
  taskId: string;
  signal?: AbortSignal;
  log?: (message: string) => Promise<void> | void;
  logger?: WorktreeDependencySyncLogger;
  context?: string;
}

export function hasInstallState(rootDir: string): boolean {
  return existsSync(join(rootDir, "node_modules")) || existsSync(join(rootDir, ".pnp.cjs"));
}

export function getConfiguredWorktreeInitCommand(settings?: Pick<Settings, "worktreeInitCommand"> | null): string | null {
  const trimmed = settings?.worktreeInitCommand?.trim();
  return trimmed ? trimmed : null;
}

export function getDependencySyncCommand(rootDir: string, settings?: Settings | null): string | null {
  const configuredCommand = getConfiguredWorktreeInitCommand(settings);
  if (configuredCommand) return configuredCommand;
  if (existsSync(join(rootDir, "pnpm-lock.yaml"))) return "pnpm install --frozen-lockfile";
  if (existsSync(join(rootDir, "package-lock.json"))) return "npm install";
  if (existsSync(join(rootDir, "yarn.lock"))) return "yarn install --frozen-lockfile";
  if (existsSync(join(rootDir, "bun.lock")) || existsSync(join(rootDir, "bun.lockb"))) {
    return "bun install --frozen-lockfile";
  }
  return null;
}

export function computeLockfileHash(rootDir: string): string | null {
  for (const name of LOCKFILE_CANDIDATES) {
    const p = join(rootDir, name);
    if (existsSync(p)) {
      try {
        return createHash("sha256").update(readFileSync(p)).digest("hex");
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function readInstallMarker(rootDir: string): string | null {
  try {
    const value = readFileSync(join(rootDir, INSTALL_MARKER_RELPATH), "utf-8").trim();
    return value || null;
  } catch {
    return null;
  }
}

export function writeInstallMarker(rootDir: string, hash: string): void {
  try {
    writeFileSync(join(rootDir, INSTALL_MARKER_RELPATH), hash);
  } catch {
    // Best-effort: a missing marker just means the next merge re-runs install.
  }
}

function throwIfDependencySyncAborted(signal: AbortSignal | undefined, taskId: string): void {
  if (!signal?.aborted) return;
  const err = new Error(`Dependency sync aborted for ${taskId}`);
  err.name = "AbortError";
  throw err;
}

/**
 * FNXC:AIMerge 2026-06-13-20:18:
 * Temporary AI-merge clean-room worktrees must install workspace dependencies before merge/review verification runs inside them. A configured worktreeInitCommand is the authoritative bootstrap and always runs; inferred lockfile installs may skip only when the node_modules install marker matches the current lockfile hash.
 */
export async function installWorktreeDependencies(options: InstallWorktreeDependenciesOptions): Promise<WorktreeDependencySyncResult> {
  const { cwd, settings, taskId, signal, log, logger, context = "merge worktree dependency sync" } = options;
  const startedAt = Date.now();
  const configuredCommand = getConfiguredWorktreeInitCommand(settings);
  const installCommand = getDependencySyncCommand(cwd, settings);
  const configured = configuredCommand !== null;

  if (!installCommand) {
    return { installCommand: null, configured: false, skipped: true, skipReason: "no-command", durationMs: Date.now() - startedAt };
  }

  const shouldUseInstallMarker = !configured;
  const lockHash = shouldUseInstallMarker ? computeLockfileHash(cwd) : null;
  if (lockHash && hasInstallState(cwd) && readInstallMarker(cwd) === lockHash) {
    logger?.log?.(`${taskId}: skipping dependency sync (lockfile unchanged since last install)`);
    await log?.(`Skipping dependency sync: lockfile hash matches last successful ${installCommand}`);
    return {
      installCommand,
      configured,
      skipped: true,
      skipReason: "lockfile-marker-match",
      durationMs: Date.now() - startedAt,
    };
  }

  throwIfDependencySyncAborted(signal, taskId);
  logger?.log?.(`${taskId}: syncing dependencies ${context}`);
  await log?.(`Syncing dependencies ${context}: ${installCommand}`);

  try {
    await execAsync(installCommand, {
      cwd,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: INSTALL_TIMEOUT_MS,
    });
    throwIfDependencySyncAborted(signal, taskId);
    if (lockHash) writeInstallMarker(cwd, lockHash);
    return { installCommand, configured, skipped: false, durationMs: Date.now() - startedAt };
  } catch (error: unknown) {
    throwIfDependencySyncAborted(signal, taskId);
    const maybeCommandError = error as { stderr?: unknown; stdout?: unknown; message?: unknown };
    const details = maybeCommandError.stderr || maybeCommandError.stdout || maybeCommandError.message || String(error);
    throw new Error(`Dependency sync failed for ${taskId}: ${String(details)}`.trim());
  }
}
