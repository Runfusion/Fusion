import { existsSync } from "node:fs";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { RunMutationContext, Settings, Task, TaskStore, SecretsStore } from "@fusion/core";
import { canonicalFusionBranchName, generateWorktreeName, slugify } from "./worktree-names.js";
import { resolveTaskWorktreePathForBackend } from "./worktree-paths.js";
import { hydrateWorktreeDb } from "./worktree-db-hydrate.js";
import { formatError } from "./logger.js";
import { classifyBootstrapMisbinding, isBranchConflictError, reanchorBranchToBase } from "./branch-conflicts.js";
import {
  type WorktreePool,
  classifyTaskWorktree,
  isInsideWorktreesDir,
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
  const branchName = task.branch || canonicalFusionBranchName(task.id);
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

  const hydrate = async (path: string): Promise<boolean> => {
    if (rootDir === path) return false;
    try {
      const hydration = await hydrateWorktreeDb({ rootDir, worktreePath: path, taskId: task.id, store, logger: logger ?? { warn: () => {} } });
      if (hydration.degraded) {
        await store.logEntry(task.id, `Worktree DB hydration degraded: ${hydration.reason ?? "unknown"}`, undefined, runContext);
      } else {
        await store.logEntry(task.id, `Hydrated worktree DB: ${hydration.tasksCopied} tasks, ${hydration.documentsCopied} task_documents`, undefined, runContext);
      }
      return true;
    } catch (error) {
      logger?.warn(`${task.id}: worktree DB hydration failed: ${formatError(error)}`);
      return false;
    }
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
    return { worktreePath, branch: resumedBranch, source: "existing", hydrated, isResume: true };
  }

  let acquiredFromPool = false;
  let branch = branchName;

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
          return {
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
          };
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

  const createWorktreeImpl = createWorktree
    ? createWorktree
    : async (branch: string, path: string, taskId: string, startPoint?: string, allowRename?: boolean) => {
      try {
        const created = await backend.create({
          rootDir,
          branch,
          worktreePath: path,
          startPoint,
          taskId,
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
            branch,
            worktreePath: path,
            startPoint,
            taskId,
            allowSiblingBranchRename: allowRename,
          });
          return await handleWorktrunkFailure("create", error, fallback) as { path: string; branch: string };
        }
        throw error;
      }
    };

  // Worktree removal in merger.ts, worktree-pool.ts, and self-healing.ts is now
  // backend-mediated via WorktreeBackend.remove(). executor.ts and
  // step-session-executor.ts remain native-only paths (tracked separately).
  const created = await createWorktreeImpl(branchName, worktreePath, task.id, baseBranch ?? undefined, allowSiblingBranchRename);
  worktreePath = created.path;
  branch = created.branch;
  await store.updateTask(task.id, { worktree: created.path, branch: created.branch });
  await audit?.git({ type: "worktree:create", target: created.path, metadata: { branch: created.branch } });
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
  return { worktreePath, branch, source: acquiredFromPool ? "pool" : "fresh", hydrated, isResume: false };
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
