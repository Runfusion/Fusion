import { existsSync } from "node:fs";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { RunMutationContext, Settings, Task, TaskStore, SecretsStore } from "@fusion/core";
import { generateWorktreeName, resolveTaskWorkingBranch, slugify } from "./worktree-names.js";
import { resolveTaskWorktreePathForBackend } from "./worktree-paths.js";
import { hydrateWorktreeDb } from "./worktree-db-hydrate.js";
import { formatError } from "./logger.js";
import { classifyBootstrapMisbinding, isBranchConflictError, reanchorBranchToBase } from "./branch-conflicts.js";
import {
  type WorktreePool,
  classifyTaskWorktree,
  isInsideWorktreesDir,
  isRepoRootPath,
  removeWorktree,
  RemovalReason,
  PoolDoubleLeaseError,
} from "./worktree-pool.js";
import {
  NativeWorktreeBackend,
  WorktrunkOperationError,
  resolveWorktreeBackend,
  type WorktreeBackend,
} from "./worktree-backend.js";
import {
  WorktrunkBinaryUnavailableError,
  WorktrunkInstallDeniedError,
  WorktrunkInstallFailedError,
} from "./worktrunk-installer.js";
import {
  handleWorktrunkOperationFailure,
  type WorktreeOperationResult,
  type WorktrunkOpName,
} from "./worktrunk-failure-handler.js";
import type { RunAuditor } from "./run-audit.js";
import { writeSecretsEnvFile } from "./secrets-env-writer.js";
import { removeDesktopBuildArtifacts } from "./worktree-desktop-artifacts.js";

const execAsync = promisify(exec);

/**
 * Worktree acquisition contract:
 * - `runInitCommand=true` runs the init command only for newly-created worktrees (fresh, not pool/existing).
 * - Heartbeat task runs should pass `runInitCommand=false`.
 * - Executor may pass `runInitCommand=true`; if heartbeat created the worktree earlier, executor reuses it and init is skipped.
 */
export interface AcquireTaskWorktreeOptions {
  task: Task;
  rootDir: string;
  store: TaskStore;
  settings: Partial<Settings>;
  pool?: WorktreePool;
  logger?: { log: (m: string) => void; warn: (m: string) => void; error?: (m: string) => void };
  audit?: Pick<RunAuditor, "git" | "filesystem">;
  runContext?: RunMutationContext;
  runInitCommand?: boolean;
  secretsStore?: Pick<SecretsStore, "listEnvExportable">;
  createWorktree?: (
    branch: string,
    path: string,
    taskId: string,
    startPoint?: string,
    allowSiblingBranchRename?: boolean,
  ) => Promise<{ path: string; branch: string }>;
  runConfiguredCommand?: (command: string, cwd: string, timeoutMs: number, env?: NodeJS.ProcessEnv) => Promise<{
    spawnError?: string | Error;
    timedOut?: boolean;
    exitCode?: number | null;
    signal?: NodeJS.Signals | null;
    stdout?: string;
    stderr?: string;
    bufferExceeded?: boolean;
  }>;
  taskEnv?: NodeJS.ProcessEnv;
  backend?: WorktreeBackend;
}

export interface AcquireTaskWorktreeResult {
  worktreePath: string;
  branch: string;
  source: "existing" | "pool" | "fresh";
  hydrated: boolean;
  isResume: boolean;
  reclaimed?: {
    existingTipSha?: string;
    strandedCommitCount?: number;
  };
}

type InitCommandResult = Awaited<ReturnType<NonNullable<AcquireTaskWorktreeOptions["runConfiguredCommand"]>>>;

export class RepoRootWorktreeError extends Error {
  constructor(public readonly taskId: string, public readonly rootDir: string, public readonly worktreePath: string, public readonly source: string) {
    super(`Refusing to return repo root as task worktree for ${taskId}: ${worktreePath} (${source}) canonicalizes to ${rootDir}`);
    this.name = "RepoRootWorktreeError";
  }
}

const INIT_OUTCOME_MAX_CHARS = 2_000;

function configuredCommandErrorMessage(result: { spawnError?: string | Error; timedOut?: boolean; exitCode?: number | null }): string {
  if (result.spawnError) return `Failed to start command: ${result.spawnError}`;
  if (result.timedOut) return "Command timed out";
  return `Command exited with code ${result.exitCode ?? "unknown"}`;
}

function truncateInitCommandOutput(output: string): string {
  if (output.length <= INIT_OUTCOME_MAX_CHARS) return output;
  return `... output truncated to last ${INIT_OUTCOME_MAX_CHARS} chars ...\n${output.slice(-INIT_OUTCOME_MAX_CHARS)}`;
}

function formatInitFailureOutcome(initResult: InitCommandResult | undefined, err: unknown): string {
  const stderr = initResult?.stderr?.trim();
  if (stderr) return truncateInitCommandOutput(stderr);

  const stdout = initResult?.stdout?.trim();
  if (stdout) return truncateInitCommandOutput(stdout);

  if (initResult?.spawnError) {
    return typeof initResult.spawnError === "string" ? initResult.spawnError : initResult.spawnError.message;
  }

  const parts: string[] = [];
  if (initResult?.timedOut) parts.push("Command timed out");
  if (initResult?.exitCode !== undefined && initResult.exitCode !== null) parts.push(`exit code: ${initResult.exitCode}`);
  if (initResult?.signal) parts.push(`signal: ${initResult.signal}`);
  if (parts.length > 0) return parts.join("; ");

  if (err instanceof Error && err.message.trim().length > 0) return err.message;

  const fallback = String(err).trim();
  return fallback.length > 0 ? fallback : "Command failed";
}

async function maybeWarnForeignTaskStartPoint(
  input: {
    baseBranch: string | null;
    rootDir: string;
    worktreePath: string;
    taskId: string;
    logger?: { warn: (m: string) => void };
    store: TaskStore;
    runContext?: RunMutationContext;
  },
): Promise<void> {
  const { baseBranch, rootDir, worktreePath, taskId, logger, store, runContext } = input;
  if (!baseBranch || !/^fusion\/fn-\d+$/i.test(baseBranch)) return;

  try {
    const tipSha = (await execAsync(`git rev-parse --verify ${JSON.stringify(`${baseBranch}^{commit}`)}`, { cwd: rootDir, encoding: "utf-8" })).stdout.trim();
    const details = (await execAsync(`git log -1 --format=%s%x1f%b ${JSON.stringify(tipSha)}`, { cwd: worktreePath, encoding: "utf-8" })).stdout.trim();
    const [subject = "", body = ""] = details.split("\u001f");
    const subjectMatch = subject.match(/^(?:feat|fix|test|chore|docs|refactor|perf|build)\((FN-\d+)\):/i);
    const trailerMatch = body.match(/(?:^|\n)Fusion-Task-Id:\s*(FN-\d+)\s*(?:\n|$)/i);
    const attributedTaskId = (trailerMatch?.[1] ?? subjectMatch?.[1] ?? "").toUpperCase();
    if (!attributedTaskId || attributedTaskId === taskId.toUpperCase()) return;

    const warning = `worktree acquired with foreign-task start point: ${baseBranch} (resolved tip ${tipSha.slice(0, 12)}) — bootstrap-misbinding recovery may engage on contamination check`;
    logger?.warn(`${taskId}: ${warning}`);
    await store.logEntry(taskId, warning, undefined, runContext);
  } catch {
    // best-effort observability only
  }
}

export async function acquireTaskWorktree(opts: AcquireTaskWorktreeOptions): Promise<AcquireTaskWorktreeResult> {
  const { task, rootDir, store, settings, pool, logger, audit, runContext, createWorktree, runConfiguredCommand, runInitCommand, taskEnv, secretsStore } = opts;
  const notifyFallback = async (op: WorktrunkOpName, stderr?: string) => {
    await store.logEntry(task.id, `Worktrunk ${op} failed; continuing with native worktree backend (${stderr ?? "no stderr"})`, undefined, runContext);
  };

  const handleWorktrunkFailure = async (
    op: WorktrunkOpName,
    error: Error,
    nativeFallback?: () => Promise<unknown>,
  ) => {
    const stderr = error instanceof WorktrunkOperationError ? error.stderr : undefined;
    const exitCode = error instanceof WorktrunkOperationError ? error.exitCode : null;
    const disposition = await handleWorktrunkOperationFailure({
      failure: {
        op,
        cause: error,
        stderr,
        exitCode,
        worktreePath,
      },
      task,
      settings: settings.worktrunk ?? {},
      store,
      runContext,
      runAudit: audit,
      notify: ({ op: failedOp, stderr: failedStderr }) => notifyFallback(failedOp, failedStderr),
      nativeFallback: nativeFallback as (() => Promise<WorktreeOperationResult>) | undefined,
    });
    if (disposition.kind === "fallback-native") {
      return disposition.result;
    }
    throw error;
  };

  let backend: WorktreeBackend;
  try {
    backend = opts.backend ?? resolveWorktreeBackend(settings, { logger, audit });
  } catch (error) {
    if (
      settings.worktrunk?.enabled
      && (error instanceof WorktrunkBinaryUnavailableError || error instanceof WorktrunkInstallFailedError || error instanceof WorktrunkInstallDeniedError)
    ) {
      await handleWorktrunkFailure("resolve-binary", error);
    }
    throw error;
  }
  const branchName = resolveTaskWorkingBranch(task);
  const naming = settings.worktreeNaming || "random";
  const allowSiblingBranchRename = settings.executorAllowSiblingBranchRename === true;
  const baseBranch = task.executionStartBranch || null;

  let worktreePath = task.worktree;
  if (!worktreePath) {
    const worktreeName = naming === "task-id"
      ? task.id.toLowerCase()
      : naming === "task-title"
        ? slugify(task.title || task.description.slice(0, 60))
        : generateWorktreeName(rootDir, settings);
    worktreePath = await resolveTaskWorktreePathForBackend(rootDir, worktreeName, settings, backend, branchName);
  }

  let isResume = Boolean(task.worktree && existsSync(worktreePath));
  if (task.worktree && isResume) {
    const resumeClassification = await classifyTaskWorktree(rootDir, worktreePath);
    /*
     * FNXC:WorktreeLiveness 2026-06-21-11:10:
     * A resumed task can carry a stale or recovered `task.worktree` that points at the repository root. Treat every non-usable classification, including repo-root, as self-healable metadata so acquisition clears the assignment and creates a fresh task worktree instead of feeding the executor's defensive gate forever.
     */
    if (!resumeClassification.ok) {
      await audit?.git({
        type: "worktree:incomplete-detected",
        target: worktreePath,
        metadata: { classification: resumeClassification.classification, reason: resumeClassification.reason, source: "resume", taskId: task.id },
      });
      logger?.log(`${task.id}: assigned worktree is not usable; creating a fresh worktree instead: ${worktreePath}`);
      await store.logEntry(task.id, "Assigned worktree is not a registered, usable git worktree; creating a fresh worktree instead", worktreePath, runContext);
      await store.updateTask(task.id, { worktree: null, branch: null, sessionFile: null });
      const fallbackName = generateWorktreeName(rootDir, settings);
      worktreePath = await resolveTaskWorktreePathForBackend(rootDir, fallbackName, settings, backend, branchName);
      isResume = false;
    }
  }

  let acquiredFromPool = false;
  let branch = branchName;

  const hydrate = async (path: string): Promise<boolean> => {
    if (rootDir === path) return false;
    try {
      const hydration = await hydrateWorktreeDb({ rootDir, worktreePath: path, taskId: task.id, store, logger: logger ?? { warn: () => {} } });
      if (hydration.degraded) {
        await store.logEntry(task.id, `Worktree DB hydration degraded: ${hydration.reason ?? "unknown"}`, undefined, runContext);
      } else {
        await store.logEntry(task.id, `Hydrated worktree DB: ${hydration.tasksCopied} tasks, ${hydration.documentsCopied} task_documents, ${hydration.artifactsCopied} artifacts`, undefined, runContext);
      }
      return true;
    } catch (error) {
      logger?.warn(`${task.id}: worktree DB hydration failed: ${formatError(error)}`);
      return false;
    }
  };

  const createWorktreeImpl = createWorktree
    ? createWorktree
    : async (createBranch: string, createPath: string, createTaskId: string, startPoint?: string, allowRename?: boolean) => {
      try {
        const created = await backend.create({
          rootDir,
          branch: createBranch,
          worktreePath: createPath,
          startPoint,
          taskId: createTaskId,
          allowSiblingBranchRename: allowRename,
        });
        if (backend.kind === "worktrunk") {
          await audit?.git({
            type: "worktree:worktrunk-create",
            target: created.path,
            metadata: { branch: created.branch },
          });
        }
        return created;
      } catch (error) {
        if (backend.kind === "worktrunk" && error instanceof WorktrunkOperationError) {
          const nativeBackend = new NativeWorktreeBackend({ logger: logger ?? undefined });
          const fallback = () => nativeBackend.create({
            rootDir,
            branch: createBranch,
            worktreePath: createPath,
            startPoint,
            taskId: createTaskId,
            allowSiblingBranchRename: allowRename,
          });
          return await handleWorktrunkFailure("create", error, fallback) as { path: string; branch: string };
        }
        throw error;
      }
    };

  const emitRepoRootReturnGuardAudit = async (guardedPath: string, source: string) => {
    await audit?.git({
      type: "worktree:incomplete-detected",
      target: guardedPath,
      metadata: {
        classification: "repo-root",
        reason: "acquireTaskWorktree return path canonicalizes to the project root",
        source: "acquire-return-guard",
        returnSource: source,
        taskId: task.id,
      },
    });
  };

  const finalizeCreatedWorktree = async (
    created: { path: string; branch: string },
    source: "fresh" | "pool",
    logOrigin: "normal" | "return-guard",
  ): Promise<AcquireTaskWorktreeResult> => {
    /*
     * FNXC:WorktreeLiveness 2026-06-22-18:30:
     * FN-6861 fixed the resume classifier path, but FN-6888 showed the repo root can still reach the executor through another acquisition return branch. FN-6922 makes acquisition itself enforce a return-value invariant: no resume, pool, or fresh branch may return the repo root, so the executor's realpath_matches_repo_root gate remains defense-in-depth instead of a requeue loop source.
     */
    if (isRepoRootPath(rootDir, created.path)) {
      await emitRepoRootReturnGuardAudit(created.path, source);
      await store.updateTask(task.id, { worktree: null, branch: null, sessionFile: null });
      throw new RepoRootWorktreeError(task.id, rootDir, created.path, `fresh-create:${logOrigin}`);
    }

    worktreePath = created.path;
    branch = created.branch;
    await store.updateTask(task.id, { worktree: created.path, branch: created.branch });
    await audit?.git({ type: "worktree:create", target: created.path, metadata: { branch: created.branch, source: logOrigin === "return-guard" ? "acquire-return-guard" : undefined } });
    await audit?.git({ type: "branch:create", target: created.branch });
    if (created.branch !== branchName) {
      logger?.log(`Branch conflict resolved: using ${created.branch} instead of ${branchName}`);
      await store.logEntry(task.id, `Worktree created at ${worktreePath} (branch conflict: using ${created.branch})`, undefined, runContext);
    } else if (baseBranch) {
      await store.logEntry(task.id, `Worktree created at ${worktreePath} (based on ${baseBranch})`, undefined, runContext);
    } else {
      await store.logEntry(task.id, `Worktree created at ${worktreePath}`, undefined, runContext);
    }

    const cleanup = await removeDesktopBuildArtifacts(worktreePath, logger);
    if (cleanup.removed.length > 0) {
      await store.logEntry(task.id, `Removed desktop build artifacts from worktree: ${cleanup.removed.join(", ")}`, undefined, runContext);
    }

    if (runInitCommand && settings.worktreeInitCommand && runConfiguredCommand) {
      const initStartedAt = Date.now();
      let initResult: InitCommandResult | undefined;
      try {
        initResult = await runConfiguredCommand(settings.worktreeInitCommand, worktreePath, 300_000, taskEnv);
        if (initResult.spawnError || initResult.timedOut || initResult.exitCode !== 0) {
          throw new Error(configuredCommandErrorMessage(initResult));
        }
        await store.logEntry(task.id, `[timing] Worktree init command completed in ${Date.now() - initStartedAt}ms`, settings.worktreeInitCommand, runContext);
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          throw err;
        }
        await store.logEntry(task.id, `[timing] Worktree init command failed after ${Date.now() - initStartedAt}ms`, undefined, runContext);
        const message = err instanceof Error ? err.message : String(err);
        const outcome = formatInitFailureOutcome(initResult, err);
        logger?.error?.(`${task.id}: worktree init command failed — first test run will likely fail: ${message} (stderr captured in task log outcome)`);
        await store.logEntry(task.id, `Worktree init command failed (first test run will likely fail): ${message}`, outcome, runContext);
      }
    }

    await maybeWarnForeignTaskStartPoint({
      baseBranch,
      rootDir,
      worktreePath,
      taskId: task.id,
      logger,
      store,
      runContext,
    });
    const hydrated = await hydrate(worktreePath);
    try {
      await writeSecretsEnvFile({
        rootDir,
        worktreePath,
        taskId: task.id,
        settings,
        worktreeSource: "fresh",
        secretsStore,
        audit,
        logger,
      });
    } catch (err) {
      logger?.warn?.(`${task.id}: secrets-env write failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
    return { worktreePath, branch, source, hydrated, isResume: false };
  };

  const createFreshWorktreeFromReturnGuard = async (guardedPath: string, source: string): Promise<AcquireTaskWorktreeResult> => {
    await emitRepoRootReturnGuardAudit(guardedPath, source);
    logger?.warn(`${task.id}: acquisition ${source} returned repo root; clearing assignment and creating a fresh worktree`);
    await store.logEntry(task.id, "Acquisition attempted to return the project root as a task worktree; creating a fresh worktree instead", guardedPath, runContext);
    await store.updateTask(task.id, { worktree: null, branch: null, sessionFile: null });
    const fallbackName = generateWorktreeName(rootDir, settings);
    const fallbackPath = await resolveTaskWorktreePathForBackend(rootDir, fallbackName, settings, backend, branchName);
    const created = await createWorktreeImpl(branchName, fallbackPath, task.id, baseBranch ?? undefined, allowSiblingBranchRename);
    return finalizeCreatedWorktree(created, "fresh", "return-guard");
  };

  const guardAcquisitionReturn = async (result: AcquireTaskWorktreeResult): Promise<AcquireTaskWorktreeResult> => {
    if (!isRepoRootPath(rootDir, result.worktreePath)) return result;
    return createFreshWorktreeFromReturnGuard(result.worktreePath, result.source);
  };

  if (task.worktree && isResume) {
    logger?.log(`Reusing existing worktree: ${worktreePath}`);
    const cleanup = await removeDesktopBuildArtifacts(worktreePath, logger);
    if (cleanup.removed.length > 0) {
      await store.logEntry(task.id, `Removed desktop build artifacts from worktree: ${cleanup.removed.join(", ")}`, undefined, runContext);
    }
    const hydrated = await hydrate(worktreePath);
    const resumedBranch = task.branch ?? branchName;
    await verifyResumeBranchNotMisbound({
      worktreePath,
      branchName: resumedBranch,
      taskId: task.id,
      rootDir,
      store,
      audit,
      logger,
      runContext,
    });
    // FN-4912: resume path reuses the prior on-disk .env (and its fingerprint sidecar). Rewrite is owned by the next fresh acquisition.
    return guardAcquisitionReturn({ worktreePath, branch: resumedBranch, source: "existing", hydrated, isResume: true });
  }

  if (!isResume && pool && settings.recycleWorktrees) {
    let pooled: string | null = null;
    try {
      pooled = pool.acquire(task.id);
    } catch (poolErr) {
      if (poolErr instanceof PoolDoubleLeaseError) {
        const poolErrMessage = poolErr instanceof Error ? poolErr.message : String(poolErr);
        logger?.warn(`${task.id}: ${poolErrMessage}; skipping pool and creating fresh worktree`);
        await store.logEntry(task.id, `Pool double-lease guard triggered (${poolErrMessage}), creating fresh worktree`, undefined, runContext);
      } else {
        throw poolErr;
      }
    }
    if (pooled) {
      try {
        const preparedRaw = await pool.prepareForTask(pooled, branchName, baseBranch ?? undefined, {
          allowSiblingBranchRename,
          repoDir: rootDir,
          requestingTaskId: task.id,
        });
        const prepared = typeof preparedRaw === "string"
          ? { branch: preparedRaw, worktreePath: pooled, reclaimed: false as const }
          : preparedRaw;
        if (prepared.reclaimed && prepared.worktreePath !== pooled) {
          pool.release(pooled, task.id);
        }
        worktreePath = prepared.worktreePath;
        branch = prepared.branch;
        const pooledClassification = await classifyTaskWorktree(rootDir, worktreePath);
        if (!pooledClassification.ok) {
          await audit?.git({
            type: "worktree:incomplete-detected",
            target: worktreePath,
            metadata: {
              classification: pooledClassification.classification,
              reason: pooledClassification.reason,
              source: "pool-acquire",
              taskId: task.id,
            },
          });
          await store.logEntry(task.id, `Pool returned ${pooledClassification.classification} worktree (${pooledClassification.reason}); creating fresh worktree`, undefined, runContext);
          if (isInsideWorktreesDir(rootDir, worktreePath, settings)) {
            try {
              await removeWorktree({
                rootDir,
                worktreePath,
                settings,
                reason: RemovalReason.PoolPrune,
                taskId: task.id,
                audit: undefined,
              });
            } catch (removeErr) {
              logger?.warn(`${task.id}: failed to remove unusable pooled worktree ${worktreePath}: ${formatError(removeErr)}`);
            }
          }
          const fallbackName = generateWorktreeName(rootDir, settings);
          worktreePath = await resolveTaskWorktreePathForBackend(rootDir, fallbackName, settings, backend, branchName);
          branch = branchName;
        } else {
          acquiredFromPool = true;
          logger?.log(`Acquired worktree from pool: ${worktreePath}`);
          await store.updateTask(task.id, { worktree: worktreePath, branch });
          await audit?.git({ type: "worktree:reuse", target: worktreePath, metadata: { branch, reclaimed: prepared.reclaimed } });
          if (prepared.reclaimed) {
            await store.logEntry(task.id, `Acquired reclaimed worktree from pool: ${worktreePath} (${prepared.strandedCommitCount ?? 0} commits preserved)`, undefined, runContext);
          } else if (branch !== branchName) {
            logger?.log(`Branch conflict resolved: using ${branch} instead of ${branchName}`);
            await store.logEntry(task.id, `Acquired worktree from pool: ${worktreePath} (branch conflict: using ${branch})`, undefined, runContext);
          } else {
            await store.logEntry(task.id, `Acquired worktree from pool: ${worktreePath}`, undefined, runContext);
          }
          const cleanup = await removeDesktopBuildArtifacts(worktreePath, logger);
          if (cleanup.removed.length > 0) {
            await store.logEntry(task.id, `Removed desktop build artifacts from worktree: ${cleanup.removed.join(", ")}`, undefined, runContext);
          }
          await maybeWarnForeignTaskStartPoint({
            baseBranch,
            rootDir,
            worktreePath,
            taskId: task.id,
            logger,
            store,
            runContext,
          });
          const hydrated = await hydrate(worktreePath);
          try {
            await writeSecretsEnvFile({
              rootDir,
              worktreePath,
              taskId: task.id,
              settings,
              worktreeSource: "pool",
              secretsStore,
              audit,
              logger,
            });
          } catch (err) {
            logger?.warn?.(`${task.id}: secrets-env write failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
          }
          return guardAcquisitionReturn({
            worktreePath,
            branch,
            source: "pool",
            hydrated,
            isResume: false,
            reclaimed: prepared.reclaimed
              ? {
                  existingTipSha: prepared.existingTipSha,
                  strandedCommitCount: prepared.strandedCommitCount,
                }
              : undefined,
          });
        }
      } catch (poolErr) {
        pool.release(pooled, task.id);
        if (poolErr instanceof PoolDoubleLeaseError) {
          const poolErrMessage = poolErr instanceof Error ? poolErr.message : String(poolErr);
          logger?.warn(`${task.id}: ${poolErrMessage}; skipping pool and creating fresh worktree`);
          await store.logEntry(task.id, `Pool double-lease guard triggered (${poolErrMessage}), creating fresh worktree`, undefined, runContext);
        } else if (isBranchConflictError(poolErr)) throw poolErr;
        const poolErrMessage = poolErr instanceof Error ? poolErr.message : String(poolErr);
        logger?.log(`Pool prepareForTask failed, falling through to fresh worktree: ${poolErrMessage}`);
        await store.logEntry(task.id, `Pool worktree preparation failed (${poolErrMessage}), creating fresh worktree`, undefined, runContext);
      }
    }
  }

  // Worktree removal in merger.ts, worktree-pool.ts, and self-healing.ts is now
  // backend-mediated via WorktreeBackend.remove(). executor.ts and
  // step-session-executor.ts remain native-only paths (tracked separately).
  const created = await createWorktreeImpl(branchName, worktreePath, task.id, baseBranch ?? undefined, allowSiblingBranchRename);
  return finalizeCreatedWorktree(created, acquiredFromPool ? "pool" : "fresh", "normal");
}

/**
 * Resume-path safety check: before handing a reused worktree back to the
 * executor, verify that its branch contains only this task's own commits
 * since `main`. If the branch was created from a poisoned local-main tip
 * (a sibling task's commit, observed in the FN-5475 cascade) the only
 * commits between merge-base and HEAD are foreign-attributed and zero
 * are this task's — the bootstrap-misbinding shape. Re-anchor inline so
 * downstream checks see a clean branch.
 *
 * Mixed contamination (own + foreign, or non-attributed commits) is
 * intentionally not handled here — those cases need richer adjudication
 * and continue to flow through the executor's primary contamination
 * path at `tryBootstrapMisbindingRecovery` / `classifyForeignCommits`.
 */
async function verifyResumeBranchNotMisbound(input: {
  worktreePath: string;
  branchName: string;
  taskId: string;
  rootDir: string;
  store: TaskStore;
  audit?: Pick<RunAuditor, "git" | "filesystem">;
  logger?: { log?: (msg: string) => void; warn?: (msg: string) => void };
  runContext: RunMutationContext | undefined;
}): Promise<void> {
  const { worktreePath, branchName, taskId, rootDir, store, audit, logger, runContext } = input;

  let baseSha = "";
  try {
    const { stdout } = await execAsync(
      "git merge-base HEAD main 2>/dev/null || git merge-base HEAD origin/main",
      { cwd: worktreePath, encoding: "utf-8" },
    );
    baseSha = stdout.trim();
  } catch {
    // Can't resolve a base — let executor's primary contamination path handle it.
    return;
  }
  if (!baseSha) return;

  let classification;
  try {
    classification = await classifyBootstrapMisbinding({
      repoDir: rootDir,
      branchName,
      baseSha,
      taskId,
    });
  } catch (err) {
    logger?.warn?.(`${taskId}: resume misbinding check failed: ${formatError(err)}`);
    return;
  }

  if (!classification.isBootstrapMisbinding) return;

  await store.logEntry(
    taskId,
    `[recovery] resume-path bootstrap misbinding detected on ${branchName}: 0 own commits, ${classification.foreignCommitCount} foreign — re-anchoring to ${baseSha.slice(0, 12)}`,
    undefined,
    runContext,
  );

  try {
    const reanchor = await reanchorBranchToBase({
      repoDir: rootDir,
      worktreePath,
      branchName,
      baseSha,
      taskId,
    });
    await audit?.git({
      type: "branch:reanchor",
      target: branchName,
      metadata: {
        taskId,
        baseSha,
        previousTipSha: reanchor.previousTipSha,
        newTipSha: reanchor.newTipSha,
        trigger: "resume-misbinding",
      },
    });
  } catch (err) {
    logger?.warn?.(`${taskId}: resume re-anchor failed (continuing — executor preflight will handle): ${formatError(err)}`);
  }
}

export interface AcquireWorkspaceRepoWorktreeOptions {
  repoRelPath: string;
  workspaceRootDir: string;
  task: Task;
  store: TaskStore;
  settings: Partial<Settings>;
  logger?: { log: (m: string) => void; warn: (m: string) => void; error?: (m: string) => void };
  secretsStore?: Pick<SecretsStore, "listEnvExportable">;
  runContext?: RunMutationContext;
  audit?: Pick<RunAuditor, "git" | "filesystem">;
  runConfiguredCommand?: AcquireTaskWorktreeOptions["runConfiguredCommand"];
  taskEnv?: NodeJS.ProcessEnv;
}

/*
FNXC:WorkspaceWorktree 2026-06-22-00:00:
`repoRelPath` is an exported, caller-trusted parameter that is joined onto `workspaceRootDir`.
An absolute path or a `..` escape (`../outside`) would resolve a worktree outside the workspace
root. Validate it is a normalized, relative, in-root path before resolving the absolute path.
*/
function assertInRootRepoRelPath(repoRelPath: string, sep: string, isAbsolute: (p: string) => boolean, normalize: (p: string) => string): void {
  if (typeof repoRelPath !== "string" || repoRelPath.length === 0 || isAbsolute(repoRelPath)) {
    throw new Error(`Invalid workspace repo path (must be relative and in-root): ${String(repoRelPath)}`);
  }
  const normalized = normalize(repoRelPath);
  if (normalized === ".." || normalized.startsWith(`..${sep}`) || normalized.startsWith("../")) {
    throw new Error(`Invalid workspace repo path (escapes workspace root): ${repoRelPath}`);
  }
}

export async function acquireWorkspaceRepoWorktree(
  opts: AcquireWorkspaceRepoWorktreeOptions,
): Promise<{ worktreePath: string; branch: string; alreadyAcquired: boolean }> {
  const { repoRelPath, workspaceRootDir, task, store, settings, logger, secretsStore, runContext, audit, runConfiguredCommand, taskEnv } = opts;
  const { join, isAbsolute, normalize, sep } = await import("node:path");

  // FNXC:WorkspaceWorktree 2026-06-22-00:00: reject absolute / `..`-escaping repo paths before resolving.
  assertInRootRepoRelPath(repoRelPath, sep, isAbsolute, normalize);
  const repoAbsPath = join(workspaceRootDir, repoRelPath);

  /*
  FNXC:WorkspaceWorktree 2026-06-22-00:00:
  A remembered per-repo worktree is only reusable if it still exists and is a registered git
  worktree. A pruned/deleted worktree path would otherwise be reported as "ready" without the
  resume/classification checks that `acquireTaskWorktree` runs on the singular path. Verify the
  remembered path passes the same liveness check (existence + git work-tree classification);
  if it is dead, drop it and fall through to re-acquire a fresh worktree.
  */
  const existing = task.workspaceWorktrees?.[repoRelPath];
  if (existing) {
    let live = existsSync(existing.worktreePath);
    if (live) {
      try {
        const classification = await classifyTaskWorktree(repoAbsPath, existing.worktreePath);
        live = classification.ok;
      } catch {
        live = false;
      }
    }
    if (live) {
      return { ...existing, alreadyAcquired: true };
    }
    logger?.warn(`${task.id}: remembered workspace worktree for ${repoRelPath} is missing/unusable (${existing.worktreePath}); re-acquiring`);
    await store.logEntry(task.id, `Remembered workspace worktree for ${repoRelPath} is no longer usable; re-acquiring`, existing.worktreePath, runContext);
  }

  /*
  FNXC:WorkspaceWorktree 2026-06-21-19:05:
  Workspace mode acquires one worktree per sub-repo for a single task. `acquireTaskWorktree`
  is single-repo: it reads `task.worktree`/`task.branch` to decide resume-vs-fresh and rewrites
  those singular fields on the task row after each acquisition. Passing the live task straight
  through means the second repo's acquisition sees the first repo's `task.worktree` (which exists
  on disk), classifies it as a resume, and reuses repo A's worktree inside repo B — cross-repo
  contamination. Clear the singular worktree/branch fields on the copy handed to the single-repo
  helper so each sub-repo always gets a fresh worktree; per-repo state is tracked in
  `task.workspaceWorktrees`, not the singular column.

  FNXC:WorkspaceWorktree 2026-06-22-00:00:
  `acquireTaskWorktree` only runs the configured worktree-init command when `runConfiguredCommand`
  is threaded through. Forward it (plus runContext/audit/taskEnv) so workspace sub-repos run the
  same configured setup as the non-workspace acquire path instead of silently skipping it.
  */
  const result = await acquireTaskWorktree({
    task: { ...task, worktree: undefined, branch: undefined },
    rootDir: repoAbsPath,
    store,
    settings,
    logger,
    secretsStore,
    runContext,
    audit,
    runConfiguredCommand,
    taskEnv,
    runInitCommand: true,
  });

  /*
  FNXC:WorkspaceWorktree 2026-06-22-00:00:
  Re-read the task immediately before merging so a concurrent sibling-repo acquisition that
  landed between our initial read and now is not clobbered — `updateTask` replaces the
  `workspaceWorktrees` map wholesale, so we must merge onto the freshest map, not the stale
  snapshot captured before `acquireTaskWorktree`. This narrows the read-modify-write window to
  the store's own lock; a fully atomic per-repo store-level merge is a follow-up.
  */
  const freshTask = (await store.getTask(task.id)) ?? task;
  const updated: Record<string, { worktreePath: string; branch: string }> = {
    ...(freshTask.workspaceWorktrees ?? {}),
    [repoRelPath]: { worktreePath: result.worktreePath, branch: result.branch },
  };
  /*
  FNXC:WorkspaceWorktree 2026-06-22-00:00:
  `acquireTaskWorktree` persists the singular `task.worktree`/`task.branch` on the task row.
  For a workspace task that pointer would end up referencing whichever sub-repo was acquired last,
  violating the contract that per-repo state lives only in `workspaceWorktrees`. Clear the singular
  fields in the same update so a workspace task never carries a misleading singular worktree pointer.
  */
  await store.updateTask(task.id, { workspaceWorktrees: updated, worktree: null, branch: null });

  return { worktreePath: result.worktreePath, branch: result.branch, alreadyAcquired: false };
}
