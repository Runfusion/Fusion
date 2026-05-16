import { exec } from "node:child_process";
import { promisify } from "node:util";
import { inspectBranchConflict } from "./branch-conflicts.js";
import { formatError, worktreePoolLog } from "./logger.js";

const execAsync = promisify(exec);
const GIT_TIMEOUT_MS = 120_000;
const GIT_MAX_BUFFER = 10 * 1024 * 1024;

export type WorktreeBackendKind = "native" | "worktrunk";

export interface WorktreeBackend {
  kind: WorktreeBackendKind;
  create(input: WorktreeCreateInput): Promise<WorktreeCreateResult>;
}

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

export class WorktrunkOperationError extends Error {
  constructor(
    public readonly operation: string,
    public readonly code: "worktrunk_operation_failed" | "worktrunk_binary_missing",
    public readonly stderr: string,
    public readonly exitCode: number | null,
  ) {
    super(`worktrunk ${operation} failed: ${stderr}`);
    this.name = "WorktrunkOperationError";
  }
}

function quoteShellArg(value: string): string {
  return JSON.stringify(value);
}

export class NativeWorktreeBackend implements WorktreeBackend {
  kind: WorktreeBackendKind = "native";

  async create(input: WorktreeCreateInput): Promise<WorktreeCreateResult> {
    const startArg = input.startPoint ? ` ${quoteShellArg(input.startPoint)}` : "";
    const createWithBranch = async (branchName: string): Promise<WorktreeCreateResult> => {
      await execAsync(
        `git worktree add -b ${quoteShellArg(branchName)} ${quoteShellArg(input.worktreePath)}${startArg}`,
        {
          cwd: input.rootDir,
          encoding: "utf-8",
          timeout: GIT_TIMEOUT_MS,
          maxBuffer: GIT_MAX_BUFFER,
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
          // keep probing suffixes
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
        worktreePoolLog.warn(
          `[worktree-backend] ${input.taskId}: failed to inspect branch conflict: ${formatError(inspectError).detail}`,
        );
      }

      if (inspection?.kind === "live-foreign") {
        throw inspection.error;
      }

      throw error;
    }
  }
}

export class WorktrunkWorktreeBackend implements WorktreeBackend {
  kind: WorktreeBackendKind = "worktrunk";

  constructor(private readonly deps: { binaryPath: string | null; logger?: { warn: (m: string) => void } }) {}

  async create(input: WorktreeCreateInput): Promise<WorktreeCreateResult> {
    if (!this.deps.binaryPath || !this.deps.binaryPath.trim()) {
      throw new WorktrunkOperationError(
        "create",
        "worktrunk_binary_missing",
        "worktrunk binary not configured",
        null,
      );
    }

    // Placeholder command wiring for FN-4622; FN-4623 will map this to the finalized worktrunk README contract.
    const command = `${quoteShellArg(this.deps.binaryPath)} switch --create ${quoteShellArg(input.branch)}`;

    try {
      await execAsync(command, {
        cwd: input.rootDir,
        encoding: "utf-8",
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
      });
      return { path: input.worktreePath, branch: input.branch };
    } catch (error) {
      const stderr =
        error && typeof error === "object" && "stderr" in error
          ? String((error as { stderr?: unknown }).stderr ?? "")
          : "";
      const execError = error && typeof error === "object" ? (error as Record<string, unknown>) : null;
      const exitCode = execError
        ? typeof execError.status === "number"
          ? execError.status
          : typeof execError.code === "number"
            ? execError.code
            : null
        : null;
      this.deps.logger?.warn?.(
        `[worktree-backend] worktrunk create failed: ${stderr || String(error)}`,
      );
      throw new WorktrunkOperationError(
        "create",
        "worktrunk_operation_failed",
        stderr,
        exitCode,
      );
    }
  }
}

export interface ResolveWorktreeBackendDeps {
  logger?: { warn: (m: string) => void };
}

export function resolveWorktreeBackend(
  // Intentionally structural so this file can land before FN-4621 adds the typed worktrunk settings schema.
  settings: Partial<{ worktrunk?: { enabled?: boolean; binaryPath?: string } }>,
  deps: ResolveWorktreeBackendDeps = {},
): WorktreeBackend {
  if (settings.worktrunk?.enabled === true) {
    return new WorktrunkWorktreeBackend({
      binaryPath: settings.worktrunk.binaryPath ?? null,
      logger: deps.logger,
    });
  }

  return new NativeWorktreeBackend();
}
