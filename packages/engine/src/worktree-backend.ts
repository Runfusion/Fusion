import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { Settings } from "@fusion/core";
import { inspectBranchConflict } from "./branch-conflicts.js";
import { formatError, worktreePoolLog } from "./logger.js";

const execAsync = promisify(exec);
const GIT_TIMEOUT_MS = 120_000;
const GIT_REMOVE_TIMEOUT_MS = 60_000;
const GIT_MAX_BUFFER = 10 * 1024 * 1024;

export type WorktreeBackendKind = "native" | "worktrunk";
export type WorktrunkOperation = "create" | "remove" | "sync" | "prune";
export type WorktrunkOperationErrorCode =
  | "worktrunk_operation_failed"
  | "worktrunk_binary_missing"
  | "worktrunk_unsupported_operation";

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
  readonly kind: WorktreeBackendKind;
  create(input: WorktreeCreateInput): Promise<{ path: string; branch: string }>;
  remove(input: WorktreeRemoveInput): Promise<void>;
  sync(input: WorktreeSyncInput): Promise<{ skipped: boolean }>;
  prune(input: WorktreePruneInput): Promise<void>;
}

export class WorktrunkOperationError extends Error {
  readonly name = "WorktrunkOperationError";
  readonly operation: WorktrunkOperation;
  readonly stderr?: string;
  readonly exitCode?: number | null;
  readonly code: WorktrunkOperationErrorCode;

  constructor(input: {
    operation: WorktrunkOperation;
    stderr?: string;
    exitCode?: number | null;
    code: WorktrunkOperationErrorCode;
  }) {
    super(`worktrunk ${input.operation} failed: ${input.stderr || input.code}`);
    this.operation = input.operation;
    this.stderr = input.stderr;
    this.exitCode = input.exitCode;
    this.code = input.code;
  }
}

function quoteShellArg(value: string): string {
  return JSON.stringify(value);
}

async function runCommand(
  command: string,
  cwd: string,
  timeout: number = GIT_TIMEOUT_MS,
): Promise<{ stdout: string; stderr: string }> {
  const result = await execAsync(command, {
    cwd,
    encoding: "utf-8",
    timeout,
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
          // continue suffix probing
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
    // FN-4678: removal call sites migrate to this backend in follow-up.
    await runCommand(`git worktree remove --force ${quoteShellArg(input.worktreePath)}`, input.rootDir, GIT_REMOVE_TIMEOUT_MS);
  }

  async sync(): Promise<{ skipped: boolean }> {
    // Native backend has no dedicated sync semantic today.
    return { skipped: true };
  }

  async prune(input: WorktreePruneInput): Promise<void> {
    await runCommand("git worktree prune", input.rootDir);
  }
}

export class WorktrunkWorktreeBackend implements WorktreeBackend {
  readonly kind: WorktreeBackendKind = "worktrunk";

  constructor(private readonly deps: { binaryPath: string | null; logger?: LoggerLike }) {}

  private throwUnsupported(operation: WorktrunkOperation): never {
    if (!this.deps.binaryPath || !this.deps.binaryPath.trim()) {
      throw new WorktrunkOperationError({
        operation,
        code: "worktrunk_binary_missing",
        stderr: "worktrunk binary not configured",
        exitCode: null,
      });
    }

    this.deps.logger?.warn?.(`[worktree-backend] worktrunk ${operation} is not implemented in FN-4685`);
    // TODO(FN-4623): map backend operations to real worktrunk CLI subcommands.
    throw new WorktrunkOperationError({
      operation,
      code: "worktrunk_unsupported_operation",
      stderr: "worktrunk backend is not implemented yet",
      exitCode: null,
    });
  }

  async create(_input: WorktreeCreateInput): Promise<{ path: string; branch: string }> {
    return this.throwUnsupported("create");
  }

  async remove(_input: WorktreeRemoveInput): Promise<void> {
    return this.throwUnsupported("remove");
  }

  async sync(_input: WorktreeSyncInput): Promise<{ skipped: boolean }> {
    return this.throwUnsupported("sync");
  }

  async prune(_input: WorktreePruneInput): Promise<void> {
    return this.throwUnsupported("prune");
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
