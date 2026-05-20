import { exec } from "node:child_process";
import { existsSync } from "node:fs";
import { access } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { promisify } from "node:util";
import type { Settings } from "@fusion/core";
import { activeSessionRegistry } from "./active-session-registry.js";
import type { RunAuditor } from "./run-audit.js";
import { resolveTaskWorktreePath } from "./worktree-paths.js";
import { inspectBranchConflict } from "./branch-conflicts.js";
import { formatError } from "./logger.js";
import { installTaskWorktreeIdentityGuard } from "./worktree-hooks.js";
import { pruneWorktreeAdminEntries } from "./worktree-prune.js";
import {
  StaleWorktreeIndexLockError,
  classifyStaleLock,
  parseIndexLockPath,
  tryRemoveStaleLock,
} from "./worktree-stale-lock.js";
import { parseStaleRegistrationPath, recoverStaleRegistration } from "./worktree-stale-registration.js";

const execAsync = promisify(exec);
const NATIVE_TIMEOUT_MS = 120_000;
const REMOVE_TIMEOUT_MS = 60_000;
const MAX_BUFFER = 10 * 1024 * 1024;

/**
 * worktrunk CLI mapping (verified 2026-05-15 from README + worktrunk.dev docs):
 * - create -> `wt switch --create <branch> [--base <startPoint>]`
 * - remove -> `wt remove <branch> --foreground`
 * - sync -> no dedicated `wt sync/rebase` primitive; fallback to git fetch+rebase
 * - prune -> no dedicated `wt prune` primitive; backend-owned prune implementation
 * - layout -> no dedicated path-query command; derive from worktrunk template/config
 */
const WORKTRUNK_TIMEOUTS_MS = {
  create: 120_000,
  sync: 180_000,
  prune: 60_000,
  remove: 60_000,
  layout: 5_000,
} as const;

export type WorktreeBackendKind = "native" | "worktrunk";
export type WorktreeOperation = "create" | "remove" | "sync" | "prune";

export interface WorktreeCreateInput {
  rootDir: string;
  branch: string;
  worktreePath: string;
  startPoint?: string;
  taskId: string;
  allowSiblingBranchRename?: boolean;
}

export interface WorktreeCreateResult {
  path: string;
  branch: string;
}

export interface WorktreeRemoveInput {
  rootDir: string;
  worktreePath: string;
  branch?: string;
  taskId?: string;
}

export interface WorktreeSyncInput {
  rootDir: string;
  worktreePath: string;
  branch: string;
  trunk?: string;
  taskId?: string;
}

export interface WorktreePruneInput {
  rootDir: string;
}

export interface WorktreeBackend {
  readonly kind: WorktreeBackendKind;
  create(input: WorktreeCreateInput): Promise<WorktreeCreateResult>;
  remove(input: WorktreeRemoveInput): Promise<void>;
  sync(input: WorktreeSyncInput): Promise<{ skipped: boolean }>;
  prune(input: WorktreePruneInput): Promise<void>;
  resolveWorktreePath(input: { rootDir: string; worktreeName: string; branch: string }): Promise<string>;
}

export type WorktrunkOperationCode =
  | "worktrunk_operation_failed"
  | "worktrunk_binary_missing"
  | "worktrunk_timeout"
  | "worktrunk_sync_conflict"
  | "worktrunk_unsupported_operation";

export class WorktrunkOperationError extends Error {
  readonly code: WorktrunkOperationCode;
  readonly operation: WorktreeOperation;
  readonly stderr?: string;
  readonly exitCode?: number | null;

  constructor(input: {
    operation: WorktreeOperation;
    code: WorktrunkOperationCode;
    stderr?: string;
    exitCode?: number | null;
  }) {
    super(`worktrunk ${input.operation} failed`);
    this.name = "WorktrunkOperationError";
    this.operation = input.operation;
    this.code = input.code;
    this.stderr = input.stderr;
    this.exitCode = input.exitCode;
  }
}

function quoteShellArg(value: string): string {
  return JSON.stringify(value);
}

function getErrorStderr(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("stderr" in error)) return undefined;
  const stderr = (error as { stderr?: unknown }).stderr;
  return stderr == null ? undefined : String(stderr);
}

function getErrorExitCode(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const value = error as Record<string, unknown>;
  if (typeof value.status === "number") return value.status;
  if (typeof value.code === "number") return value.code;
  return null;
}

function findStringByKey(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findStringByKey(item, key);
      if (found) return found;
    }
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record[key] === "string") return record[key] as string;
  for (const nested of Object.values(record)) {
    const found = findStringByKey(nested, key);
    if (found) return found;
  }
  return null;
}

function parseWorktreesFromPorcelain(porcelain: string): Array<{ path: string; branch?: string }> {
  const lines = porcelain.split("\n");
  const rows: Array<{ path: string; branch?: string }> = [];
  let current: { path?: string; branch?: string } = {};
  for (const line of lines) {
    if (!line.trim()) {
      if (current.path) rows.push({ path: current.path, branch: current.branch });
      current = {};
      continue;
    }
    if (line.startsWith("worktree ")) current.path = line.slice("worktree ".length).trim();
    if (line.startsWith("branch refs/heads/")) current.branch = line.slice("branch refs/heads/".length).trim();
  }
  if (current.path) rows.push({ path: current.path, branch: current.branch });
  return rows;
}

export class NativeWorktreeBackend implements WorktreeBackend {
  readonly kind: WorktreeBackendKind = "native";

  constructor(
    private readonly deps: {
      logger?: { log: (m: string) => void; warn: (m: string) => void };
      settings?: Partial<Pick<Settings, "worktreesDir" | "commitMsgHookEnabled" | "taskPrefix" | "taskAttributionTrailerNames">>;
      audit?: Pick<RunAuditor, "git">;
    } = {},
  ) {}

  async create(input: WorktreeCreateInput): Promise<WorktreeCreateResult> {
    const startArg = input.startPoint ? ` ${quoteShellArg(input.startPoint)}` : "";
    const installGuardOrCleanup = async (worktreePath: string) => {
      try {
        await installTaskWorktreeIdentityGuard({
          worktreePath,
          taskId: input.taskId,
          commitMsgHookEnabled: this.deps.settings?.commitMsgHookEnabled,
          taskPrefix: this.deps.settings?.taskPrefix,
          taskAttributionTrailerName: this.deps.settings?.taskAttributionTrailerNames?.[0],
        });
      } catch (error) {
        await execAsync(`rm -rf ${quoteShellArg(worktreePath)}`, {
          cwd: input.rootDir,
          encoding: "utf-8",
          timeout: REMOVE_TIMEOUT_MS,
          maxBuffer: MAX_BUFFER,
        }).catch(() => undefined);
        await pruneWorktreeAdminEntries({
          rootDir: input.rootDir,
          auditor: this.deps.audit,
          reason: "backend-guard-failed",
          target: worktreePath,
          logger: this.deps.logger,
        }).catch(() => undefined);
        throw error;
      }
    };
    const createWithBranch = async (branchName: string): Promise<WorktreeCreateResult> => {
      await execAsync(
        `git worktree add -b ${quoteShellArg(branchName)} ${quoteShellArg(input.worktreePath)}${startArg}`,
        {
          cwd: input.rootDir,
          encoding: "utf-8",
          timeout: NATIVE_TIMEOUT_MS,
          maxBuffer: MAX_BUFFER,
        },
      );
      return { path: input.worktreePath, branch: branchName };
    };

    const createWithBranchForce = async (branchName: string): Promise<WorktreeCreateResult> => {
      await execAsync(`git worktree add -f ${quoteShellArg(input.worktreePath)} ${quoteShellArg(branchName)}`, {
        cwd: input.rootDir,
        encoding: "utf-8",
        timeout: NATIVE_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
      });
      return { path: input.worktreePath, branch: branchName };
    };

    let staleLockRecoveryAttempted = false;
    let staleRegistrationRecoveryAttempted = false;
    try {
      const created = await createWithBranch(input.branch);
      await installGuardOrCleanup(created.path);
      return created;
    } catch (error) {
      const lockPath = parseIndexLockPath(`${(error as { message?: string })?.message ?? ""}\n${getErrorStderr(error) ?? ""}`);
      if (lockPath && !staleLockRecoveryAttempted) {
        staleLockRecoveryAttempted = true;
        const classification = await classifyStaleLock({
          rootDir: input.rootDir,
          lockPath,
          activeSessionRegistry,
        });
        await this.deps.audit?.git({
          type: "worktree:stale-lock-detected",
          target: input.worktreePath,
          metadata: {
            lockPath,
            classification: classification.kind,
            reason: classification.reason,
            ageMs: classification.ageMs ?? null,
            owningWorktreePath: classification.owningWorktreePath ?? null,
          },
        });
        if (classification.kind === "stale") {
          try {
            const removed = await tryRemoveStaleLock({ lockPath: resolve(input.rootDir, lockPath) });
            if (removed.removed) {
              await this.deps.audit?.git({
                type: "worktree:stale-lock-recovered",
                target: input.worktreePath,
                metadata: { lockPath },
              });
              const created = await createWithBranch(input.branch);
              await installGuardOrCleanup(created.path);
              return created;
            }
            await this.deps.audit?.git({
              type: "worktree:stale-lock-recovery-failed",
              target: input.worktreePath,
              metadata: { lockPath, reason: removed.reason ?? "not-removed" },
            });
          } catch (removeError) {
            await this.deps.audit?.git({
              type: "worktree:stale-lock-recovery-failed",
              target: input.worktreePath,
              metadata: { lockPath, reason: formatError(removeError).detail },
            });
          }
        } else {
          await this.deps.audit?.git({
            type: "worktree:stale-lock-refused",
            target: input.worktreePath,
            metadata: {
              lockPath,
              classification: classification.kind,
              reason: classification.reason,
              ageMs: classification.ageMs ?? null,
              owningWorktreePath: classification.owningWorktreePath ?? null,
            },
          });
          throw new StaleWorktreeIndexLockError({
            message: `Worktree creation blocked: index.lock at ${resolve(input.rootDir, lockPath)} is held by another git process (reason: ${classification.reason}). Resolve manually before retrying.`,
            lockPath: resolve(input.rootDir, lockPath),
            classification: classification.kind,
            reason: classification.reason,
          });
        }
      }

      const combinedErrorOutput = `${(error as { message?: string })?.message ?? ""}\n${getErrorStderr(error) ?? ""}`;
      const staleRegistrationPath = parseStaleRegistrationPath(combinedErrorOutput);
      if (staleRegistrationPath && !staleRegistrationRecoveryAttempted) {
        staleRegistrationRecoveryAttempted = true;
        await this.deps.audit?.git({
          type: "worktree:stale-registration-detected",
          target: input.worktreePath,
          metadata: { staleRegistrationPath, worktreePath: input.worktreePath },
        });
        const recovery = await recoverStaleRegistration({
          rootDir: input.rootDir,
          worktreePath: input.worktreePath,
          logger: this.deps.logger,
        });
        if (recovery.recovered) {
          try {
            const created = await createWithBranch(input.branch);
            await this.deps.audit?.git({
              type: "worktree:stale-registration-recovered",
              target: input.worktreePath,
              metadata: { actions: recovery.actions },
            });
            await installGuardOrCleanup(created.path);
            return created;
          } catch (retryError) {
            const actionsWithForce = [...recovery.actions, "add-force-retry"];
            try {
              const created = await createWithBranchForce(input.branch);
              await this.deps.audit?.git({
                type: "worktree:stale-registration-recovered",
                target: input.worktreePath,
                metadata: { actions: actionsWithForce },
              });
              await installGuardOrCleanup(created.path);
              return created;
            } catch (forceError) {
              await this.deps.audit?.git({
                type: "worktree:stale-registration-recovery-failed",
                target: input.worktreePath,
                metadata: {
                  actions: actionsWithForce,
                  reason: `${formatError(retryError).detail}; force-retry: ${formatError(forceError).detail}`,
                },
              });
              throw error;
            }
          }
        }
        await this.deps.audit?.git({
          type: "worktree:stale-registration-recovery-failed",
          target: input.worktreePath,
          metadata: { actions: recovery.actions, reason: recovery.reason ?? "unknown" },
        });
      }

      if (!input.allowSiblingBranchRename) {
        throw error;
      }

      for (let suffix = 2; suffix <= 50; suffix += 1) {
        const candidateBranch = `${input.branch}-${suffix}`;
        try {
          const created = await createWithBranch(candidateBranch);
          await installGuardOrCleanup(created.path);
          return created;
        } catch {
          // continue probing suffixes
        }
      }

      let inspection: Awaited<ReturnType<typeof inspectBranchConflict>> | null = null;
      try {
        inspection = await inspectBranchConflict({
          repoDir: input.rootDir,
          branchName: input.branch,
          conflictingWorktreePath: input.worktreePath,
          requestingTaskId: input.taskId,
          startPoint: input.startPoint,
        });
      } catch (inspectError) {
        this.deps.logger?.warn?.(
          `[worktree-backend] ${input.taskId}: failed to inspect branch conflict: ${formatError(inspectError).detail}`,
        );
      }

      if (inspection?.kind === "live-foreign") {
        throw inspection.error;
      }

      throw error;
    }
  }

  async remove(input: WorktreeRemoveInput): Promise<void> {
    await execAsync(`git worktree remove --force ${quoteShellArg(input.worktreePath)}`, {
      cwd: input.rootDir,
      encoding: "utf-8",
      timeout: REMOVE_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    });
  }

  async sync(input: WorktreeSyncInput): Promise<{ skipped: boolean }> {
    await execAsync("git fetch --all --prune", {
      cwd: input.worktreePath,
      encoding: "utf-8",
      timeout: NATIVE_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    });

    await execAsync(`git rebase ${quoteShellArg(input.trunk ? input.trunk : `origin/${input.branch}`)}`, {
      cwd: input.worktreePath,
      encoding: "utf-8",
      timeout: NATIVE_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    });

    return { skipped: false };
  }

  async prune(input: WorktreePruneInput): Promise<void> {
    await execAsync("git worktree prune", {
      cwd: input.rootDir,
      encoding: "utf-8",
      timeout: NATIVE_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    });
  }

  async resolveWorktreePath(input: { rootDir: string; worktreeName: string; branch: string }): Promise<string> {
    return resolveTaskWorktreePath(input.rootDir, this.deps.settings, input.worktreeName);
  }
}

type WorktrunkOperation = keyof typeof WORKTRUNK_TIMEOUTS_MS;

export class WorktrunkWorktreeBackend implements WorktreeBackend {
  readonly kind: WorktreeBackendKind = "worktrunk";
  private resolvedBinaryPath: string | null = null;

  constructor(
    private readonly deps: {
      binaryPath: string | (() => Promise<string | null>) | null;
      logger?: { log: (m: string) => void; warn: (m: string) => void };
      audit?: Pick<RunAuditor, "git">;
    },
  ) {}

  private async resolveBinaryPathFromDeps(operation: WorktrunkOperation): Promise<string> {
    if (typeof this.deps.binaryPath === "string") {
      const literalPath = this.deps.binaryPath.trim();
      if (literalPath) return literalPath;
    }

    if (typeof this.deps.binaryPath === "function") {
      if (this.resolvedBinaryPath) return this.resolvedBinaryPath;
      const resolvedPath = (await this.deps.binaryPath())?.trim() ?? "";
      if (!resolvedPath) {
        throw new WorktrunkOperationError({
          operation: operation === "layout" ? "create" : operation,
          code: "worktrunk_binary_missing",
          stderr: "worktrunk binary not configured",
          exitCode: null,
        });
      }
      this.resolvedBinaryPath = resolvedPath;
      return resolvedPath;
    }

    throw new WorktrunkOperationError({
      operation: operation === "layout" ? "create" : operation,
      code: "worktrunk_binary_missing",
      stderr: "worktrunk binary not configured",
      exitCode: null,
    });
  }

  private async getBinaryPath(operation: WorktrunkOperation): Promise<string> {
    const binaryPath = await this.resolveBinaryPathFromDeps(operation);
    try {
      await access(binaryPath);
    } catch {
      if (binaryPath.includes("/") || binaryPath.includes("\\")) {
        throw new WorktrunkOperationError({
          operation: operation === "layout" ? "create" : operation,
          code: "worktrunk_binary_missing",
          stderr: `worktrunk binary not found at path: ${binaryPath}`,
          exitCode: null,
        });
      }
    }
    return binaryPath;
  }

  private async runWorktrunk(
    args: string[],
    opts: { cwd: string; operation: WorktrunkOperation; signal?: AbortSignal },
  ): Promise<{ stdout: string; stderr: string }> {
    const binaryPath = await this.getBinaryPath(opts.operation);
    this.deps.logger?.log?.(`[worktree-backend] running worktrunk command: ${binaryPath} ${args.join(" ")}`);

    try {
      const command = `${quoteShellArg(binaryPath)} ${args.map((arg) => quoteShellArg(arg)).join(" ")}`;
      return await execAsync(command, {
        cwd: opts.cwd,
        encoding: "utf-8",
        timeout: WORKTRUNK_TIMEOUTS_MS[opts.operation],
        maxBuffer: MAX_BUFFER,
        signal: opts.signal,
      });
    } catch (error) {
      const stderr = getErrorStderr(error) ?? String(error);
      const signal =
        error && typeof error === "object" && "signal" in error
          ? ((error as { signal?: unknown }).signal as string | null | undefined)
          : undefined;
      const syscallCode =
        error && typeof error === "object" && "code" in error
          ? ((error as { code?: unknown }).code as string | number | undefined)
          : undefined;
      const exitCode = getErrorExitCode(error);
      const op = opts.operation === "layout" ? "create" : opts.operation;
      let code: WorktrunkOperationCode = "worktrunk_operation_failed";
      if (syscallCode === "ENOENT") {
        code = "worktrunk_binary_missing";
      } else if (signal === "SIGTERM") {
        code = "worktrunk_timeout";
      }
      this.deps.logger?.warn?.(`[worktree-backend] worktrunk ${opts.operation} failed: ${stderr}`);
      throw new WorktrunkOperationError({ operation: op, code, stderr, exitCode });
    }
  }

  async create(input: WorktreeCreateInput): Promise<WorktreeCreateResult> {
    const args = ["switch", "--create", input.branch, "--no-hooks", "--no-cd"];
    if (input.startPoint) args.push("--base", input.startPoint);
    await this.runWorktrunk(args, { cwd: input.rootDir, operation: "create" });

    const resolvedPath = await this.resolveCreatedWorktreePath({
      rootDir: input.rootDir,
      branch: input.branch,
    });
    if (resolvedPath !== input.worktreePath) {
      this.deps.logger?.warn?.(
        `[worktree-backend] worktrunk created branch ${input.branch} at ${resolvedPath} (fusion assumed ${input.worktreePath}); using worktrunk-assigned path`,
      );
    }

    try {
      await installTaskWorktreeIdentityGuard({
        worktreePath: resolvedPath,
        taskId: input.taskId,
      });
    } catch (error) {
      await execAsync(`rm -rf ${quoteShellArg(resolvedPath)}`, {
        cwd: input.rootDir,
        encoding: "utf-8",
        timeout: REMOVE_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
      }).catch(() => undefined);
      await pruneWorktreeAdminEntries({
        rootDir: input.rootDir,
        auditor: this.deps.audit,
        reason: "backend-guard-failed",
        target: resolvedPath,
        logger: this.deps.logger,
      }).catch(() => undefined);
      throw error;
    }
    return { path: resolvedPath, branch: input.branch };
  }

  private async resolveCreatedWorktreePath(input: { rootDir: string; branch: string }): Promise<string> {
    let rows: Array<{ path: string; branch?: string }>;
    try {
      const { stdout } = await execAsync("git worktree list --porcelain", {
        cwd: input.rootDir,
        encoding: "utf-8",
        timeout: 30_000,
        maxBuffer: MAX_BUFFER,
      });
      rows = parseWorktreesFromPorcelain(stdout);
    } catch (error) {
      throw new WorktrunkOperationError({
        operation: "create",
        code: "worktrunk_operation_failed",
        stderr: getErrorStderr(error) ?? String(error),
        exitCode: getErrorExitCode(error),
      });
    }

    const matches = rows.filter((row) => row.branch === input.branch);
    if (matches.length === 0) {
      throw new WorktrunkOperationError({
        operation: "create",
        code: "worktrunk_operation_failed",
        stderr: `worktrunk created branch ${input.branch} but no registered worktree was found`,
        exitCode: null,
      });
    }
    if (matches.length > 1) {
      throw new WorktrunkOperationError({
        operation: "create",
        code: "worktrunk_operation_failed",
        stderr: `worktrunk created branch ${input.branch} but multiple registered worktrees claim it: ${matches.map((match) => match.path).join(", ")}`,
        exitCode: null,
      });
    }

    const resolvedPath = matches[0]?.path;
    if (!resolvedPath || !existsSync(resolvedPath)) {
      throw new WorktrunkOperationError({
        operation: "create",
        code: "worktrunk_operation_failed",
        stderr: `worktrunk reported worktree at ${resolvedPath ?? "<unknown>"} but the path does not exist`,
        exitCode: null,
      });
    }

    return resolvedPath;
  }

  async remove(input: WorktreeRemoveInput): Promise<void> {
    const target = input.branch ?? input.worktreePath;
    try {
      await this.runWorktrunk(["remove", "--foreground", target], {
        cwd: input.rootDir,
        operation: "remove",
      });
    } catch (error) {
      if (
        error instanceof WorktrunkOperationError &&
        error.code === "worktrunk_operation_failed" &&
        /(not managed|not found|already removed)/i.test(error.stderr ?? "")
      ) {
        return;
      }
      throw error;
    }
  }

  async sync(input: WorktreeSyncInput): Promise<{ skipped: boolean }> {
    try {
      const trunk = input.trunk ?? "main";
      await execAsync(`git fetch origin ${quoteShellArg(trunk)}`, {
        cwd: input.worktreePath,
        encoding: "utf-8",
        timeout: WORKTRUNK_TIMEOUTS_MS.sync,
        maxBuffer: MAX_BUFFER,
      });
      await execAsync(`git rebase ${quoteShellArg(trunk)}`, {
        cwd: input.worktreePath,
        encoding: "utf-8",
        timeout: WORKTRUNK_TIMEOUTS_MS.sync,
        maxBuffer: MAX_BUFFER,
      });
      return { skipped: false };
    } catch (error) {
      const stderr = getErrorStderr(error) ?? String(error);
      if (/conflict|could not apply|resolve all conflicts/i.test(stderr)) {
        throw new WorktrunkOperationError({
          operation: "sync",
          code: "worktrunk_sync_conflict",
          stderr,
          exitCode: getErrorExitCode(error),
        });
      }
      throw new WorktrunkOperationError({
        operation: "sync",
        code: "worktrunk_operation_failed",
        stderr,
        exitCode: getErrorExitCode(error),
      });
    }
  }

  async prune(input: WorktreePruneInput): Promise<void> {
    const { stdout } = await execAsync("git worktree list --porcelain", {
      cwd: input.rootDir,
      encoding: "utf-8",
      timeout: WORKTRUNK_TIMEOUTS_MS.prune,
      maxBuffer: MAX_BUFFER,
    });
    const rows = parseWorktreesFromPorcelain(stdout).filter(
      (row) => row.path !== input.rootDir && row.path.includes(".worktrees") && row.branch,
    );
    for (const row of rows) {
      await this.remove({ rootDir: input.rootDir, worktreePath: row.path, branch: row.branch });
    }
  }

  async resolveWorktreePath(input: { rootDir: string; worktreeName: string; branch: string }): Promise<string> {
    const template = await this.resolveWorktrunkTemplate(input.rootDir);
    const sanitizedBranch = input.branch.replace(/[\\/]/g, "-");
    const expanded = template
      .replace(/^~(?=$|[\\/])/, process.env.HOME ?? "~")
      .replace(/\{\{\s*repo_path\s*\}\}/g, input.rootDir)
      .replace(/\{\{\s*repo\s*\}\}/g, basename(input.rootDir))
      .replace(/\{\{\s*branch\s*\|\s*sanitize\s*\}\}/g, sanitizedBranch)
      .replace(/\{\{\s*branch\s*\}\}/g, input.branch);
    return resolve(input.rootDir, expanded);
  }

  private async resolveWorktrunkTemplate(rootDir: string): Promise<string> {
    try {
      const { stdout } = await this.runWorktrunk(["config", "show", "--format", "json"], {
        cwd: rootDir,
        operation: "layout",
      });
      const parsed = JSON.parse(stdout) as Record<string, unknown>;
      const fromJson = findStringByKey(parsed, "worktree-path");
      if (fromJson) return fromJson;
    } catch {
      // fall back to documented default template when config cannot be read.
    }
    return "{{ repo_path }}/.worktrees/{{ branch | sanitize }}";
  }
}

export const RemovalReason = {
  HardCancel: "hard-cancel",
  ExecutorTransientRetry: "executor-transient-retry",
  ExecutorStuckKilled: "executor-stuck-killed",
  ExecutorDispose: "executor-dispose",
  StepSessionCleanup: "step-session-cleanup",
  MergerPostMerge: "merger-post-merge",
  MergerCleanup: "merger-cleanup",
  SelfHealingReclaim: "self-healing-reclaim",
  SelfHealingStaleActiveBranch: "self-healing-stale-active-branch",
  SelfHealingBranchConflict: "self-healing-branch-conflict",
  SelfHealingOrphanRescue: "self-healing-orphan-rescue",
  SelfHealingIdleSweep: "self-healing-idle-sweep",
  PoolPrune: "pool-prune",
} as const;

export type RemovalReason = typeof RemovalReason[keyof typeof RemovalReason];

const ALLOWED_FORCE_REASONS = new Set<RemovalReason>([
  RemovalReason.HardCancel,
  RemovalReason.ExecutorDispose,
  RemovalReason.ExecutorTransientRetry,
  RemovalReason.ExecutorStuckKilled,
]);

export class InvalidForceUsageError extends Error {
  constructor(reason: RemovalReason) {
    super(`force=true is not allowed for removal reason '${reason}'`);
    this.name = "InvalidForceUsageError";
  }
}

export class ActiveSessionWorktreeRemovalError extends Error {
  constructor(public readonly details: {
    worktreePath: string;
    taskId: string;
    kind: string;
    ownerKey: string;
    reason: RemovalReason;
  }) {
    super(`cannot remove active-session worktree ${details.worktreePath} (${details.taskId}/${details.kind})`);
    this.name = "ActiveSessionWorktreeRemovalError";
  }
}

/**
 * Remove a worktree via configured backend.
 * Only executor-owned hard-cancel/dispose paths may use force=true.
 */
export async function removeWorktree(input: {
  worktreePath: string;
  rootDir: string;
  settings: Partial<Settings>;
  reason: RemovalReason;
  taskId?: string;
  audit?: RunAuditor;
  force?: boolean;
  timeout?: number;
}): Promise<void> {
  const logger = {
    log: (_message: string): void => {},
    warn: (_message: string): void => {},
  };

  if (input.force === true && !ALLOWED_FORCE_REASONS.has(input.reason)) {
    throw new InvalidForceUsageError(input.reason);
  }

  const active = activeSessionRegistry.lookupByPath(input.worktreePath);
  if (active && input.force !== true) {
    await input.audit?.git({
      type: "worktree:removal-refused-active-session",
      target: input.worktreePath,
      metadata: { taskId: active.taskId, reason: input.reason, kind: active.kind },
    });
    throw new ActiveSessionWorktreeRemovalError({
      worktreePath: input.worktreePath,
      taskId: active.taskId,
      kind: active.kind,
      ownerKey: active.ownerKey,
      reason: input.reason,
    });
  }

  if (active && input.force === true) {
    await input.audit?.git({
      type: "worktree:removal-forced-over-active-session",
      target: input.worktreePath,
      metadata: { taskId: active.taskId, reason: input.reason, kind: active.kind },
    });
  }

  const backend = resolveWorktreeBackend(input.settings, { logger, audit: input.audit });
  const removeInput: WorktreeRemoveInput = {
    rootDir: input.rootDir,
    worktreePath: input.worktreePath,
    taskId: input.taskId,
  };

  if (input.force === false || typeof input.timeout === "number") {
    // Backwards-compatible helper signature for callers that carried raw git flags/timeouts.
    // Current backend remove implementations are forceful and use backend-owned timeouts.
  }

  try {
    await backend.remove(removeInput);
    if (input.audit) {
      await input.audit.git({
        type: backend.kind === "worktrunk" ? "worktree:worktrunk-remove" : "worktree:remove",
        target: input.worktreePath,
      });
    }
    return;
  } catch (error) {
    if (!(error instanceof WorktrunkOperationError) || input.settings.worktrunk?.onFailure !== "fallback-native") {
      throw error;
    }

    logger.warn(`[worktree-backend] falling back to native remove for ${input.worktreePath}`);

    await input.audit?.git({
      type: "worktree:worktrunk-fallback",
      target: input.worktreePath,
      metadata: {
        op: "fallback-native",
        stderrPreview: error.stderr?.slice(0, 4096),
        exitCode: error.exitCode ?? null,
      },
    });

    const native = new NativeWorktreeBackend({ logger, settings: input.settings });
    await native.remove(removeInput);
    await input.audit?.git({ type: "worktree:remove", target: input.worktreePath });
  }
}

export function resolveWorktreeBackend(
  settings: Partial<Settings>,
  deps: {
    logger?: { log: (m: string) => void; warn: (m: string) => void };
    binaryPathResolver?: () => Promise<string | null>;
    audit?: Pick<RunAuditor, "git">;
  } = {},
): WorktreeBackend {
  if (settings.worktrunk?.enabled === true) {
    // FN-4681 wires binaryPathResolver from worktree-acquisition; precedence is literal setting > resolver > null.
    const configuredBinaryPath = settings.worktrunk.binaryPath?.trim() ?? "";
    const binaryPath = configuredBinaryPath ? configuredBinaryPath : deps.binaryPathResolver ?? null;
    return new WorktrunkWorktreeBackend({
      binaryPath,
      logger: deps.logger,
    });
  }

  return new NativeWorktreeBackend({ logger: deps.logger, settings, audit: deps.audit });
}
