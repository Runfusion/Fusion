import { exec, execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { promisify } from "node:util";
import type { Settings } from "@fusion/core";
import { inspectBranchConflict } from "./branch-conflicts.js";
import { formatError } from "./logger.js";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
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

function parseWorktreePathsFromPorcelain(porcelain: string): string[] {
  return porcelain
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length).trim())
    .filter(Boolean);
}

export class NativeWorktreeBackend implements WorktreeBackend {
  readonly kind: WorktreeBackendKind = "native";

  constructor(private readonly deps: { logger?: { log: (m: string) => void; warn: (m: string) => void } } = {}) {}

  async create(input: WorktreeCreateInput): Promise<WorktreeCreateResult> {
    const startArg = input.startPoint ? ` ${quoteShellArg(input.startPoint)}` : "";
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

    try {
      return await createWithBranch(input.branch);
    } catch (error) {
      if (!input.allowSiblingBranchRename) {
        throw error;
      }

      for (let suffix = 2; suffix <= 50; suffix += 1) {
        const candidateBranch = `${input.branch}-${suffix}`;
        try {
          return await createWithBranch(candidateBranch);
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
    // FN-4678: migrate remove call sites to backend.remove().
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

    await execAsync(`git rebase ${quoteShellArg(`origin/${input.branch}`)}`, {
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
}

type WorktrunkOperation = keyof typeof WORKTRUNK_TIMEOUTS_MS;

export class WorktrunkWorktreeBackend implements WorktreeBackend {
  readonly kind: WorktreeBackendKind = "worktrunk";

  constructor(
    private readonly deps: {
      binaryPath: string | null;
      logger?: { log: (m: string) => void; warn: (m: string) => void };
    },
  ) {}

  private async getBinaryPath(operation: WorktrunkOperation): Promise<string> {
    const binaryPath = this.deps.binaryPath?.trim() ?? "";
    if (!binaryPath) {
      throw new WorktrunkOperationError({
        operation: operation === "layout" ? "create" : operation,
        code: "worktrunk_binary_missing",
        stderr: "worktrunk binary not configured",
        exitCode: null,
      });
    }
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
      return await execFileAsync(binaryPath, args, {
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

    const { stdout } = await execAsync("git worktree list --porcelain", {
      cwd: input.rootDir,
      encoding: "utf-8",
      timeout: WORKTRUNK_TIMEOUTS_MS.layout,
      maxBuffer: MAX_BUFFER,
    });
    const paths = parseWorktreePathsFromPorcelain(stdout);
    const resolved = paths.find((path) => path.endsWith(input.branch) || path === input.worktreePath) ?? input.worktreePath;
    return { path: resolved, branch: input.branch };
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
      await execAsync(`git fetch origin ${quoteShellArg(input.branch)}`, {
        cwd: input.worktreePath,
        encoding: "utf-8",
        timeout: WORKTRUNK_TIMEOUTS_MS.sync,
        maxBuffer: MAX_BUFFER,
      });
      await execAsync(`git rebase ${quoteShellArg(input.branch)}`, {
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
    await execAsync("git worktree prune", {
      cwd: input.rootDir,
      encoding: "utf-8",
      timeout: WORKTRUNK_TIMEOUTS_MS.prune,
      maxBuffer: MAX_BUFFER,
    });
  }
}

export function resolveWorktreeBackend(
  settings: Partial<Settings>,
  deps: { logger?: { log: (m: string) => void; warn: (m: string) => void } } = {},
): WorktreeBackend {
  if (settings.worktrunk?.enabled === true) {
    return new WorktrunkWorktreeBackend({
      binaryPath: settings.worktrunk.binaryPath ?? null,
      logger: deps.logger,
    });
  }

  return new NativeWorktreeBackend({ logger: deps.logger });
}
