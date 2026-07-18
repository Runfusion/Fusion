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
  /**
   * FNXC:AIMerge 2026-07-02-14:05 (lockfile auto-heal):
   * True when the inferred frozen-lockfile install failed with an outdated-lockfile error and Fusion
   * recovered by re-running the non-frozen variant (regenerating the lockfile inside the clean-room
   * worktree). `healedCommand` records what actually reran. Callers surface this in run-audit.
   */
  healed: boolean;
  healedCommand?: string;
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

function extractCommandErrorDetails(error: unknown): string {
  const maybeCommandError = error as { stderr?: unknown; stdout?: unknown; message?: unknown };
  return String(maybeCommandError.stderr || maybeCommandError.stdout || maybeCommandError.message || error);
}

/**
 * FNXC:AIMerge 2026-07-02-14:05 (lockfile auto-heal):
 * A task that adds/removes a dependency but does not regenerate the lockfile makes the inferred frozen
 * install fail (pnpm `ERR_PNPM_OUTDATED_LOCKFILE`; yarn/bun equivalents). That is the normal outcome of a
 * legitimate dependency change, not corruption, so detect it and retry non-frozen instead of dead-ending
 * the merge. Match the frozen-refusal signatures across pnpm/yarn/bun.
 */
export function isOutdatedLockfileError(details: string): boolean {
  return /ERR_PNPM_OUTDATED_LOCKFILE|OUTDATED_LOCKFILE|frozen-lockfile|lockfile is frozen|lockfile had changes, but lockfile is frozen|lockfile needs to be updated|Your lockfile needs to be updated/i.test(
    details,
  );
}

/**
 * FNXC:AIMerge 2026-07-02-14:05 (lockfile auto-heal):
 * Build the non-frozen retry for an inferred frozen install. pnpm gets the explicit `--no-frozen-lockfile`
 * negation so a CI-default `frozen-lockfile=true` is overridden deterministically; yarn/bun simply drop the
 * flag. Returns null when the command carries no frozen flag (nothing to heal).
 */
export function buildNonFrozenRetryCommand(installCommand: string): string | null {
  if (!installCommand.includes("--frozen-lockfile")) return null;
  if (/^\s*pnpm\b/.test(installCommand)) {
    return installCommand.replace(/--frozen-lockfile/g, "--no-frozen-lockfile");
  }
  return installCommand.replace(/\s*--frozen-lockfile/g, "").trim();
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
    return { installCommand: null, configured: false, skipped: true, skipReason: "no-command", healed: false, durationMs: Date.now() - startedAt };
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
      healed: false,
      durationMs: Date.now() - startedAt,
    };
  }

  throwIfDependencySyncAborted(signal, taskId);
  logger?.log?.(`${taskId}: syncing dependencies ${context}`);
  await log?.(`Syncing dependencies ${context}: ${installCommand}`);

  /*
  FNXC:MergeDeps 2026-07-17-12:00:
  Pass corepack/pnpm env vars (PNPM_HOME, COREPACK_HOME, npm_config_registry) to the exec
  child process — mirrors mission-verification.ts VERIFICATION_ENV_ALLOWLIST so pnpm is
  resolvable even when the engine process starts without full shell initialization. Without
  these vars, corepack cannot locate its pnpm shim and "pnpm: command not found" occurs.
  */
  const resolvedEnv: NodeJS.ProcessEnv = { ...process.env };
  const PNPM_ENV_VARS = ["COREPACK_HOME", "PNPM_HOME", "npm_config_registry"] as const;
  for (const key of PNPM_ENV_VARS) {
    const value = process.env[key];
    if (value !== undefined) {
      resolvedEnv[key] = value;
    }
  }
  const runInstall = (command: string): Promise<unknown> =>
    execAsync(command, {
      cwd,
      env: resolvedEnv,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: INSTALL_TIMEOUT_MS,
    });

  try {
    await runInstall(installCommand);
    throwIfDependencySyncAborted(signal, taskId);
    if (lockHash) writeInstallMarker(cwd, lockHash);
    return { installCommand, configured, skipped: false, healed: false, durationMs: Date.now() - startedAt };
  } catch (error: unknown) {
    throwIfDependencySyncAborted(signal, taskId);
    const details = extractCommandErrorDetails(error);

    /*
    FNXC:AIMerge 2026-07-02-14:05 (lockfile auto-heal):
    Only auto-heal an INFERRED frozen install (`!configured`) — a user-supplied worktreeInitCommand is
    authoritative and its frozen intent is respected. On an outdated-lockfile refusal, retry once with the
    non-frozen variant so a task's legitimate dependency add/remove regenerates the lockfile in the clean
    room rather than aborting the merge. The regenerated lockfile changes the hash, so recompute the marker
    from disk (writing the pre-heal hash would wrongly skip the next real change).
    */
    const retryCommand = configured ? null : buildNonFrozenRetryCommand(installCommand);
    if (retryCommand && isOutdatedLockfileError(details)) {
      logger?.log?.(`${taskId}: lockfile out of date; retrying dependency sync without frozen lockfile`);
      await log?.(`Dependency sync hit an outdated lockfile; retrying without frozen lockfile: ${retryCommand}`);
      try {
        await runInstall(retryCommand);
      } catch (retryError: unknown) {
        throwIfDependencySyncAborted(signal, taskId);
        throw new Error(
          `Dependency sync failed for ${taskId} (after non-frozen retry): ${extractCommandErrorDetails(retryError)}`.trim(),
        );
      }
      throwIfDependencySyncAborted(signal, taskId);
      const healedHash = computeLockfileHash(cwd);
      if (healedHash) writeInstallMarker(cwd, healedHash);
      return { installCommand, configured, skipped: false, healed: true, healedCommand: retryCommand, durationMs: Date.now() - startedAt };
    }

    throw new Error(`Dependency sync failed for ${taskId}: ${details}`.trim());
  }
}
