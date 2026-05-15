import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { Settings } from "@fusion/core";
import { inspectBranchConflict } from "./branch-conflicts.js";
import { formatError, worktreePoolLog } from "./logger.js";

const execAsync = promisify(exec);
const GIT_TIMEOUT_MS = 120_000;
const GIT_MAX_BUFFER = 10 * 1024 * 1024;

export type WorktreeBackendKind = "native" | "worktrunk";

type LoggerLike = { log?: (message: string) => void; warn?: (message: string) => void };

export interface WorktreeCreateInput {
  rootDir: string;
  worktreePath: string;
  branch: string;
  startPoint?: string;
  taskId: string;
  allowSiblingBranchRename?: boolean;
}

export interface WorktreeRemoveInput {
  rootDir: string;
  worktreePath: string;
  taskId: string;
}

export interface WorktreeSyncInput {
  rootDir: string;
  worktreePath: string;
  branch: string;
  startPoint?: string;
  taskId: string;
}

export interface WorktreePruneInput {
  rootDir: string;
  taskId: string;
}

export interface WorktreeBackend {
  kind: WorktreeBackendKind;
  create(input: WorktreeCreateInput): Promise<{ path: string; branch: string }>;
  remove(input: WorktreeRemoveInput): Promise<void>;
  sync(input: WorktreeSyncInput): Promise<void>;
  prune(input: WorktreePruneInput): Promise<void>;
}

export type WorktrunkOperation = "create" | "remove" | "sync" | "prune";
export type WorktrunkOperationErrorCode = "worktrunk_operation_failed" | "worktrunk_binary_missing";

export class WorktrunkOperationError extends Error {
  readonly name = "WorktrunkOperationError";
  readonly operation: WorktrunkOperation;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly code: WorktrunkOperationErrorCode;

  constructor(input: {
    operation: WorktrunkOperation;
    stderr: string;
    exitCode: number | null;
    code: WorktrunkOperationErrorCode;
  }) {
    super(`worktrunk ${input.operation} failed: ${input.stderr || "unknown error"}`);
    this.operation = input.operation;
    this.stderr = input.stderr;
    this.exitCode = input.exitCode;
    this.code = input.code;
  }
}

function quoteShellArg(value: string): string {
  return JSON.stringify(value);
}

async function runCommand(command: string, cwd: string): Promise<{ stdout: string; stderr: string }> {
  const result = await execAsync(command, {
    cwd,
    encoding: "utf-8",
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

export class NativeWorktreeBackend implements WorktreeBackend {
  readonly kind: WorktreeBackendKind = "native";

  constructor(private readonly deps: { logger?: LoggerLike } = {}) {}

  async create(input: WorktreeCreateInput): Promise<{ path: string; branch: string }> {
    const startArg = input.startPoint ? ` ${quoteShellArg(input.startPoint)}` : "";
    const create = async (branchName: string): Promise<void> => {
      await runCommand(
        `git worktree add -b ${quoteShellArg(branchName)} ${quoteShellArg(input.worktreePath)}${startArg}`,
        input.rootDir,
      );
    };

    try {
      await create(input.branch);
      return { path: input.worktreePath, branch: input.branch };
    } catch (error) {
      if (!input.allowSiblingBranchRename) {
        throw error;
      }

      for (let suffix = 2; suffix <= 50; suffix += 1) {
        const candidateBranch = `${input.branch}-${suffix}`;
        try {
          await create(candidateBranch);
          return { path: input.worktreePath, branch: candidateBranch };
        } catch {
          // try next suffix
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
    await runCommand(`git worktree remove --force ${quoteShellArg(input.worktreePath)}`, input.rootDir);
  }

  async sync(input: WorktreeSyncInput): Promise<void> {
    await runCommand("git fetch --all --prune", input.worktreePath);
    const target = input.startPoint ?? "main";
    await runCommand(`git rebase ${quoteShellArg(target)}`, input.worktreePath);
  }

  async prune(input: WorktreePruneInput): Promise<void> {
    await runCommand("git worktree prune", input.rootDir);
  }
}

export class WorktrunkWorktreeBackend implements WorktreeBackend {
  readonly kind: WorktreeBackendKind = "worktrunk";

  constructor(private readonly deps: { binaryPath: string | null; logger?: LoggerLike }) {}

  private async runOperation(operation: WorktrunkOperation, cwd: string): Promise<void> {
    if (!this.deps.binaryPath || !this.deps.binaryPath.trim()) {
      throw new WorktrunkOperationError({
        operation,
        code: "worktrunk_binary_missing",
        stderr: "worktrunk binary not configured",
        exitCode: null,
      });
    }

    try {
      // FN-4623: replace placeholder with real worktrunk subcommand.
      await execAsync(`${quoteShellArg(this.deps.binaryPath)} --help`, {
        cwd,
        encoding: "utf-8",
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
      });
    } catch (error) {
      const err = error as { stderr?: string; code?: number };
      const stderr = typeof err?.stderr === "string" ? err.stderr : String(err ?? "");
      this.deps.logger?.warn?.(
        `[worktree-backend] worktrunk ${operation} failed: ${stderr || formatError(error).detail}`,
      );
      throw new WorktrunkOperationError({
        operation,
        code: "worktrunk_operation_failed",
        stderr,
        exitCode: typeof err?.code === "number" ? err.code : null,
      });
    }
  }

  async create(input: WorktreeCreateInput): Promise<{ path: string; branch: string }> {
    await this.runOperation("create", input.rootDir);
    return { path: input.worktreePath, branch: input.branch };
  }

  async remove(input: WorktreeRemoveInput): Promise<void> {
    await this.runOperation("remove", input.rootDir);
  }

  async sync(input: WorktreeSyncInput): Promise<void> {
    await this.runOperation("sync", input.worktreePath);
  }

  async prune(input: WorktreePruneInput): Promise<void> {
    await this.runOperation("prune", input.rootDir);
  }
}

export function resolveWorktreeBackend(
  settings: Partial<Settings>,
  deps: { logger?: LoggerLike } = {},
): WorktreeBackend {
  if (settings.worktrunk?.enabled === true) {
    return new WorktrunkWorktreeBackend({
      binaryPath: settings.worktrunk.binaryPath ?? null,
      logger: deps.logger,
    });
  }
  return new NativeWorktreeBackend({ logger: deps.logger ?? worktreePoolLog });
}
