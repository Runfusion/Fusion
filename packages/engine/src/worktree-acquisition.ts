import { existsSync } from "node:fs";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import {acquireWorktreePathReservation, canonicalizeWorktreePath, type RunMutationContext, type Settings, type Task, type TaskStore, type SecretsStore} from "@fusion/core";
import { generateWorktreeName, resolveTaskWorkingBranch, slugify } from "./worktree-names.js";
import { resolveTaskWorktreePathForBackend, resolveWorktreesDir } from "./worktree-paths.js";
import { hydrateWorktreeDb } from "./worktree-db-hydrate.js";
import { formatError } from "./logger.js";
import { classifyBootstrapMisbinding, isBranchConflictError, reanchorBranchToBase } from "./branch-conflicts.js";
import {
  type WorktreePool,
  canonicalizePath,
  classifyTaskWorktree,
  getRegisteredWorktreeBranches,
  isInsideWorktreesDir,
  isRepoRootPath,
  removeWorktree,
  RemovalReason,
  PoolDoubleLeaseError,
} from "./worktree-pool.js";
import { isTaskPinnedWorktreeNaming, pinnedWorktreePathForTask } from "./worktree-pinning.js";
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
import { installTaskWorktreeIdentityGuard } from "./worktree-hooks.js";
import { copyConfiguredWorktreeFiles, type WorktreeCopyFileResult } from "./worktree-copy-files.js";
import { resolveCapturedBaseCommitSha } from "./base-commit-capture.js";
import { resolveIntegrationBranch } from "./integration-branch.js";
import { activeSessionRegistry, type ActiveSessionRegistry } from "./active-session-registry.js";

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

/*
FNXC:TaskPinnedWorktrees 2026-07-16-00:00:
Warm-reuse of a task-pinned worktree requires the on-disk directory to be checked out on the task's own
branch. A same-name directory carrying a foreign branch (or detached HEAD) is stale/foreign and must be
reclaimed in place rather than reused, so pinned mode never hands a task another task's checkout.
*/
async function pinnedWorktreeBranchMatches(rootDir: string, worktreePath: string, expectedBranch: string): Promise<boolean> {
  const canonical = canonicalizePath(worktreePath);
  const entries = await getRegisteredWorktreeBranches(rootDir);
  /*
   * FNXC:TaskPinnedWorktrees 2026-07-16-12:30:
   * `false` (branch mismatch) drives DESTRUCTIVE reclaim, so it must mean a PROVEN mismatch — never a probe
   * failure. This function is only called after `classifyTaskWorktree` already proved the pinned path is a
   * registered, usable worktree, so a totally empty branch enumeration is an inconsistency: the underlying
   * `git worktree list` is failing transiently (it swallows errors and returns []). Treating that as
   * "foreign branch" would blow away a valid warm worktree. Throw so acquisition fails safe and retries with
   * a fresh probe, rather than reclaiming on a flaky signal. A non-empty list that simply omits this path
   * (detached HEAD / no branch line) is a genuine reclaim case and correctly returns false below.
   */
  if (entries.length === 0) {
    throw new Error(
      `pinned branch probe returned no registered worktrees for ${rootDir}; cannot confirm branch of ${worktreePath} (transient git failure) — refusing to prove mismatch`,
    );
  }
  const match = entries.find((entry) => entry.worktreePath === canonical);
  return match?.branch === expectedBranch;
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
  /*
   * FNXC:TaskPinnedWorktrees 2026-07-16-00:00:
   * Pinning and `recycleWorktrees` are MUTUALLY EXCLUSIVE — the settings-write boundary rejects enabling both
   * (see `assertWorktreeNamingRecycleExclusive`). Pinned mode is therefore active only under
   * `worktreeNaming: "task-id"` AND recycling OFF AND the native backend. The `!recycleWorktrees` guard here is
   * the runtime backstop: a legacy/hand-edited on-disk config that still carries both settings degrades safely
   * to recycling (pinning off), matching the rule "task-pinned worktrees only apply when recycling is off".
   * Worktrunk owns its own layout, so pinning is bypassed whenever worktrunk is enabled or in play.
   */
  const pinned = isTaskPinnedWorktreeNaming(settings)
    && !settings.recycleWorktrees
    && backend.kind !== "worktrunk"
    && settings.worktrunk?.enabled !== true;
  const allowSiblingBranchRename = settings.executorAllowSiblingBranchRename === true;
  const baseBranch = task.executionStartBranch || null;
  /*
   * FNXC:WorktreeIsolation 2026-07-01-08:35:
   * Fresh task worktrees must never inherit the project root checkout's ambient HEAD. The root checkout can temporarily point at a sibling task branch/commit during merge or recovery work, so an omitted `git worktree add -b ... <startPoint>` contaminates new task branches with unrelated task commits. Use the task's explicit executionStartBranch when present; otherwise pin creation to the resolved integration branch.
   */
  const freshStartPoint = baseBranch ?? await resolveIntegrationBranch(rootDir, settings, { logger: logger ?? console });

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
  // FNXC:TaskPinnedWorktrees 2026-07-16-00:00: the non-pinned resume-classification self-heal is skipped in
  // pinned mode; acquirePinnedWorktree runs its own derive→validate→reuse-or-recreate decision below.
  if (!pinned && task.worktree && isResume) {
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
      } else if (hydration.reason === "postgres_shared_store") {
        // FNXC:PostgresWorktreeStorage 2026-07-14-18:35:
        // Worktrees use the authoritative project-scoped PostgreSQL store; record readiness without implying that a local SQLite database was copied.
        await store.logEntry(task.id, "Worktree uses shared PostgreSQL task storage", undefined, runContext);
      } else {
        await store.logEntry(task.id, `Hydrated worktree DB: ${hydration.tasksCopied} tasks, ${hydration.documentsCopied} task_documents, ${hydration.artifactsCopied} artifacts`, undefined, runContext);
      }
      return true;
    } catch (error) {
      logger?.warn(`${task.id}: worktree DB hydration failed: ${formatError(error)}`);
      return false;
    }
  };

  /*
  FNXC:Worktrees 2026-07-19-15:47:
  Acquisition delegates branch creation to the isolated-worktree primitive. The project root remains
  on its current branch; task branch selection must never use a root-checkout `git checkout` or `git switch`.
  */
  const createWorktreeImpl = createWorktree
    ? createWorktree
    : async (createBranch: string, createPath: string, createTaskId: string, startPoint?: string, allowRename?: boolean) => {
      const reservation = await acquireWorktreePathReservation({
        canonicalPath: await canonicalizeWorktreePath(createPath),
        worktreesDir: resolveWorktreesDir(rootDir, settings),
        rootDir,
        /*
        FNXC:WorkflowLifecycle 2026-07-16-10:00:
        A failed archive removal leaves a durable quarantine record. The next
        owner must reconcile that old pinned path while it exclusively holds
        the reservation, rather than colliding with it during creation.
        */
        reconcileQuarantined: async () => {
          await removeWorktree({
            worktreePath: createPath,
            rootDir,
            settings,
            taskId: createTaskId,
            reason: RemovalReason.ExecutorDispose,
            force: true,
          });
        },
      });
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
          // FNXC:WorktreeAcquisition 2026-07-16-00:00: FN-8132 requires native fallback collision dispositions to be audited just like direct native acquisition.
          const nativeBackend = new NativeWorktreeBackend({ logger: logger ?? undefined, audit });
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
      } finally {
        if (reservation.state === "held") await reservation.release();
      }
    };

  const logConfiguredCopyFileResults = async (results: WorktreeCopyFileResult[], source: "fresh" | "pool") => {
    if (results.length === 0) return;
    const copied = results.filter((result) => result.outcome === "copied");
    const skipped = results.filter((result) => result.outcome === "skipped" && result.reason !== "blank" && result.reason !== "duplicate");
    if (copied.length > 0) {
      await store.logEntry(task.id, `Copied configured worktree files into ${source} worktree: ${copied.map((result) => result.path).join(", ")}`, undefined, runContext);
    }
    for (const result of skipped) {
      await store.logEntry(task.id, `Skipped configured worktree copy file ${result.path}: ${result.reason ?? "unknown"}`, undefined, runContext);
    }
  };

  const copyConfiguredFilesForPreparedWorktree = async (source: "fresh" | "pool") => {
    const preparedWorktreePath = worktreePath;
    if (!preparedWorktreePath) return;
    const results = await copyConfiguredWorktreeFiles({
      rootDir,
      worktreePath: preparedWorktreePath,
      paths: settings.worktreeCopyFiles,
      taskId: task.id,
      logger,
      audit,
    });
    await logConfiguredCopyFileResults(results, source);
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
    } else if (freshStartPoint) {
      await store.logEntry(task.id, `Worktree created at ${worktreePath} (based on ${freshStartPoint})`, undefined, runContext);
    } else {
      await store.logEntry(task.id, `Worktree created at ${worktreePath}`, undefined, runContext);
    }

    const cleanup = await removeDesktopBuildArtifacts(worktreePath, logger);
    if (cleanup.removed.length > 0) {
      await store.logEntry(task.id, `Removed desktop build artifacts from worktree: ${cleanup.removed.join(", ")}`, undefined, runContext);
    }

    await copyConfiguredFilesForPreparedWorktree(source);

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
    const created = await createWorktreeImpl(branchName, fallbackPath, task.id, freshStartPoint, allowSiblingBranchRename);
    return finalizeCreatedWorktree(created, "fresh", "return-guard");
  };

  const guardAcquisitionReturn = async (result: AcquireTaskWorktreeResult): Promise<AcquireTaskWorktreeResult> => {
    if (!isRepoRootPath(rootDir, result.worktreePath)) return result;
    return createFreshWorktreeFromReturnGuard(result.worktreePath, result.source);
  };

  /** Warm-reuse an existing, usable, branch-matched worktree (mirrors the resume path). */
  const reuseWarmWorktree = async (path: string, resumedBranch: string, source: "existing"): Promise<AcquireTaskWorktreeResult> => {
    logger?.log(`Reusing existing worktree: ${path}`);
    const cleanup = await removeDesktopBuildArtifacts(path, logger);
    if (cleanup.removed.length > 0) {
      await store.logEntry(task.id, `Removed desktop build artifacts from worktree: ${cleanup.removed.join(", ")}`, undefined, runContext);
    }
    const hydrated = await hydrate(path);
    await verifyResumeBranchNotMisbound({
      worktreePath: path,
      branchName: resumedBranch,
      taskId: task.id,
      rootDir,
      store,
      audit,
      logger,
      runContext,
    });
    return guardAcquisitionReturn({ worktreePath: path, branch: resumedBranch, source, hydrated, isResume: true });
  };

  /*
   * FNXC:TaskPinnedWorktrees 2026-07-16-00:00:
   * Pinned-mode acquisition: derive → validate → reuse-or-recreate at the SAME derived path.
   * `task.worktree` is a cache here — if it disagrees with the derived pinned path (the FN-7996 stale/foreign
   * pointer shape), re-derive, correct the metadata, and emit `worktree:pin-rederived` before validating.
   * The pool is never consulted (a pooled dir has the wrong name), so a task dispatched N times only ever
   * touches `<worktreesDir>/<task-id>` and never suffixes a sibling directory name. Recreate-in-place does NOT
   * consume any worktree-session retry budget (acquisition returns a valid fresh worktree directly).
   */
  const acquirePinnedWorktree = async (): Promise<AcquireTaskWorktreeResult> => {
    const pinnedPath = pinnedWorktreePathForTask(task.id, settings, rootDir);
    const resumedBranch = task.branch ?? branchName;

    if (task.worktree && canonicalizePath(task.worktree) !== canonicalizePath(pinnedPath)) {
      await audit?.git({
        type: "worktree:pin-rederived",
        target: pinnedPath,
        metadata: { taskId: task.id, previous: task.worktree, derived: pinnedPath, source: "acquire" },
      });
      await store.logEntry(task.id, "Re-derived task-pinned worktree path from task id", `${task.worktree} -> ${pinnedPath}`, runContext);
      await store.updateTask(task.id, { worktree: pinnedPath });
    }

    worktreePath = pinnedPath;
    branch = branchName;

    if (existsSync(pinnedPath)) {
      const classification = await classifyTaskWorktree(rootDir, pinnedPath);
      const branchMatches = classification.ok
        ? await pinnedWorktreeBranchMatches(rootDir, pinnedPath, resumedBranch)
        : false;
      if (classification.ok && branchMatches) {
        /*
         * FNXC:TaskPinnedWorktrees 2026-07-16-12:30:
         * Warm reuse can ADOPT an orphaned pinned directory (dir exists on its own branch while `task.worktree`
         * is null — first dispatch onto a leftover dir, or a recovery path that cleared the pointer). Persist
         * the derived worktree/branch before returning so the acquisition leaves the task assigned; otherwise
         * later lifecycle steps see a successful acquisition on an unassigned task. Idempotent when the cache
         * was already correct.
         */
        if (task.worktree !== pinnedPath || task.branch !== resumedBranch) {
          await store.updateTask(task.id, { worktree: pinnedPath, branch: resumedBranch });
        }
        return reuseWarmWorktree(pinnedPath, resumedBranch, "existing");
      }
      // Invalid / foreign-branch / stale (crash leftover, archive→restore) → reclaim in place: remove the
      // registered worktree (owner probe via removeWorktree) then recreate fresh at the SAME path — never suffix.
      await audit?.git({
        type: "worktree:incomplete-detected",
        target: pinnedPath,
        metadata: {
          classification: classification.ok ? "foreign-branch" : classification.classification,
          reason: classification.ok ? `branch mismatch (expected ${resumedBranch})` : classification.reason,
          source: "pinned-acquire",
          taskId: task.id,
        },
      });
      await store.logEntry(
        task.id,
        classification.ok
          ? `Task-pinned worktree ${pinnedPath} is checked out on a foreign branch; reclaiming in place`
          : `Task-pinned worktree ${pinnedPath} is ${classification.classification} (${classification.reason}); reclaiming in place`,
        undefined,
        runContext,
      );
      if (isInsideWorktreesDir(rootDir, pinnedPath, settings)) {
        try {
          await removeWorktree({
            rootDir,
            worktreePath: pinnedPath,
            settings,
            reason: RemovalReason.PoolPrune,
            taskId: task.id,
            audit: undefined,
          });
        } catch (removeErr) {
          /*
           * FNXC:TaskPinnedWorktrees 2026-07-16-12:30:
           * Reclaim-in-place must FAIL LOUD when removal fails, not swallow-and-recreate. If removeWorktree
           * rejected (e.g. ActiveSessionWorktreeRemovalError — a live session still owns the path) or otherwise
           * left the stale checkout registered, the path is still occupied: proceeding would clobber a live
           * session, and `git worktree add` would then reject the occupied path AFTER we cleared sessionFile —
           * stranding the task with no worktree and no resume metadata. Rethrow before the sessionFile clear so
           * sessionFile is preserved and the executor's retry/self-healing owns recovery.
           */
          logger?.warn(`${task.id}: failed to remove stale pinned worktree ${pinnedPath}: ${formatError(removeErr)}`);
          await store.logEntry(task.id, `Failed to reclaim task-pinned worktree ${pinnedPath}; leaving resume metadata intact for retry`, formatError(removeErr).detail ?? undefined, runContext);
          throw removeErr;
        }
      }
      // The removed worktree's session cannot resume into a fresh checkout — clear it so the executor starts clean.
      await store.updateTask(task.id, { sessionFile: null });
    }

    const created = await createWorktreeImpl(branchName, pinnedPath, task.id, freshStartPoint, allowSiblingBranchRename);
    return finalizeCreatedWorktree(created, "fresh", "normal");
  };

  if (pinned) {
    return acquirePinnedWorktree();
  }

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
        const preparedRaw = await pool.prepareForTask(pooled, branchName, freshStartPoint, {
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
          /*
          FNXC:WorktreeIdentity 2026-07-19-16:05:
          Pool preparation changes the checked-out branch but linked-worktree
          identity metadata survives the prior occupant. Refresh the marker and
          shared hooks before exposing the checkout to the new task.
          */
          await installTaskWorktreeIdentityGuard({
            worktreePath,
            taskId: task.id,
            commitMsgHookEnabled: settings.commitMsgHookEnabled,
            taskPrefix: settings.taskPrefix,
            taskAttributionTrailerName: settings.taskAttributionTrailerNames?.[0],
            commitAuthorEnabled: settings.commitAuthorEnabled,
            commitAuthorName: settings.commitAuthorName,
            commitAuthorEmail: settings.commitAuthorEmail,
          });
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
          await copyConfiguredFilesForPreparedWorktree("pool");
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
  const created = await createWorktreeImpl(branchName, worktreePath, task.id, freshStartPoint, allowSiblingBranchRename);
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
  audit?: Pick<RunAuditor, "git" | "filesystem">;
  runContext?: RunMutationContext;
  /** Test seam: inject the path-keyed exclusivity registry (defaults to the process singleton). */
  registry?: ActiveSessionRegistry;
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

/*
FNXC:Workspace 2026-06-21-20:10:
Acquisition-time exclusivity owner key for the same-sub-repo lock (U2/KTD4). The
registry record is keyed by the sub-repo ABSOLUTE path and carries this distinct
ownerKey so it never collides with the executor's later "executor"/"step-session"
registration on the produced WORKTREE path.
*/
const WORKSPACE_REPO_ACQUIRE_OWNER_KEY = "workspace-repo-acquire";

export async function acquireWorkspaceRepoWorktree(
  opts: AcquireWorkspaceRepoWorktreeOptions,
): Promise<{ worktreePath: string; branch: string; baseCommitSha?: string; alreadyAcquired: boolean }> {
  const { repoRelPath, workspaceRootDir, task, store, settings, logger, secretsStore, audit, runContext, runConfiguredCommand, taskEnv } = opts;
  const registry = opts.registry ?? activeSessionRegistry;
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
    /*
    FNXC:Workspace 2026-06-21-20:10:
    Idempotency across (taskId, repo): a re-acquire of an already-acquired sub-repo
    returns the persisted entry verbatim — no second identity-guard install, no
    re-capture of the base SHA, no second exclusivity registration.
    */
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
  FNXC:Workspace 2026-06-22-09:00:
  Run best-effort observability (task log + audit) for the NON-FATAL post-acquire
  steps without letting their own awaited writes escape. logEntry/audit can throw
  (DB hiccup, audit sink failure); an unsuppressed throw inside a non-fatal catch
  would re-escalate guard/base-capture failures into fatal acquisition errors that
  strand the already-created worktree. Mirrors the busy-path swallow above.
  */
  const safeObserve = async (fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (obsErr) {
      logger?.warn(
        `${task.id}: workspace acquisition observability failed (suppressed): ${obsErr instanceof Error ? obsErr.message : String(obsErr)}`,
      );
    }
  };

  /*
  FNXC:Workspace 2026-06-21-20:10:
  Same-sub-repo exclusivity (KTD4): register the sub-repo absolute path in the
  path-keyed activeSessionRegistry BEFORE acquiring so two concurrent workspace
  tasks contending for the SAME sub-repo are serialized. WorktreePool is a recycle
  cache, not a cross-task lock, and disjoint-scope contention on one sub-repo is
  otherwise unprotected (file-scope leases don't catch it). The entry is keyed by
  the sub-repo path with a distinct ownerKey so it does not collide with the
  executor's later session registration on the produced worktree path. We release
  it once acquisition completes (success or failure) — it guards the acquisition
  critical section, not the whole task lifetime.
  */
  const exclusivityHolder = registry.lookupByPath(repoAbsPath);
  if (exclusivityHolder && exclusivityHolder.ownerKey === WORKSPACE_REPO_ACQUIRE_OWNER_KEY && exclusivityHolder.taskId !== task.id) {
    const err = new WorkspaceRepoAcquireBusyError(repoRelPath, exclusivityHolder.taskId, task.id);
    /*
    FNXC:Workspace 2026-06-21-22:30:
    F6 — the busy short-circuit's logEntry/audit are best-effort observability; if
    either throws (e.g. a DB write hiccup) it must NOT replace the
    WorkspaceRepoAcquireBusyError the caller relies on to classify "serialized,
    retry later". Swallow logging failures so the busy error is what propagates.
    */
    try {
      const message = `sub-repo ${repoRelPath} is being acquired by ${exclusivityHolder.taskId}; serializing concurrent workspace acquisition`;
      logger?.warn(`${task.id}: ${message}`);
      await store.logEntry(task.id, message, undefined, runContext);
      await audit?.git({
        type: "worktree:workspace-repo-acquire-busy",
        target: repoAbsPath,
        metadata: { repoRelPath, holderTaskId: exclusivityHolder.taskId, requestingTaskId: task.id },
      });
    } catch {
      // best-effort observability only — never mask the busy error
    }
    throw err;
  }
  /*
  FNXC:Workspace 2026-06-21-22:30:
  F9 — no `await` may be inserted between lookupByPath and registerPath: the
  atomicity of the exclusivity claim depends on staying in one synchronous slice.
  An interleaved await would let a second task pass the lookup gate before this
  task registers, defeating the same-sub-repo serialization (KTD4).
  */
  registry.registerPath(repoAbsPath, {
    taskId: task.id,
    kind: "workspace-repo-acquire",
    ownerKey: WORKSPACE_REPO_ACQUIRE_OWNER_KEY,
  });

  try {
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
    */
    const result = await acquireTaskWorktree({
      task: { ...task, worktree: undefined, branch: undefined },
      rootDir: repoAbsPath,
      store,
      // FNXC:Workspace 2026-07-07-08:40 (FN-7360 regression — strip shared branch overrides for per-repo start-point):
      // FN-7360 pinned fresh task worktree creation to `resolveIntegrationBranch(rootDir, settings)`
      // when no executionStartBranch is present, so new branches never inherit an ambient root HEAD.
      // For a workspace sub-repo, `settings` carries the SHARED project integrationBranch/baseBranch;
      // honoring it resolves a branch absent from this sub-repo and fails `git worktree add` with
      // "invalid reference". Strip both overrides here so freshStartPoint falls through to this
      // sub-repo's own origin/HEAD — matching the per-repo base-SHA capture below, which already
      // resolves against stripped settings (F4/KTD3).
      settings: { ...settings, integrationBranch: undefined, baseBranch: undefined },
      logger,
      secretsStore,
      audit,
      runContext,
      runConfiguredCommand,
      taskEnv,
      runInitCommand: true,
    });

    /*
    FNXC:Workspace 2026-06-21-22:30:
    F3 — post-acquire steps are NON-FATAL. Once acquireTaskWorktree has created the
    on-disk worktree, a failure of the identity-guard install or the base-SHA capture
    must NOT strand that worktree (the previous catch re-threw, leaving the worktree
    orphaned while the exclusivity entry released). The worktree is usable without the
    identity guard, and an undefined baseCommitSha is already an accepted state. Only a
    failure of acquireTaskWorktree ITSELF fails the acquisition. Each step is wrapped to
    log a warning (and emit the existing failure audit event) but CONTINUE.
    */

    /*
    FNXC:Workspace 2026-06-21-20:10:
    Identity guard (single-repo parity): acquireTaskWorktree above runs WITHOUT a
    createWorktree override, so the default native backend installs NO identity
    hooks for a sub-repo worktree. Install the same guard the executor installs for
    single-repo tasks (executor.ts identity-guard call), passing the SAME settings
    args (commitMsgHookEnabled / taskPrefix / first taskAttributionTrailerName) so a
    commit on a non-fusion/<id> branch is refused inside every sub-repo worktree too.
    */
    try {
      await installTaskWorktreeIdentityGuard({
        worktreePath: result.worktreePath,
        taskId: task.id,
        commitMsgHookEnabled: settings.commitMsgHookEnabled,
        taskPrefix: settings.taskPrefix,
        taskAttributionTrailerName: settings.taskAttributionTrailerNames?.[0],
        commitAuthorEnabled: settings.commitAuthorEnabled,
        commitAuthorName: settings.commitAuthorName,
        commitAuthorEmail: settings.commitAuthorEmail,
      });
    } catch (guardErr) {
      // FNXC:Workspace 2026-06-21-22:30: F3 — identity-guard install is non-fatal; worktree is usable without it.
      // FNXC:Workspace 2026-06-22-00:00: the non-fatal logEntry/audit are themselves best-effort — if either throws
      // (e.g. a DB write hiccup) it must NOT promote this non-fatal guard failure into a fatal acquisition failure.
      // Swallow logging errors so acquisition continues (matching the F6 busy-path defensive wrap above).
      const message = guardErr instanceof Error ? guardErr.message : String(guardErr);
      logger?.warn(`${task.id}: identity-guard install failed for sub-repo ${repoRelPath} (non-fatal): ${message}`);
      // FNXC:Workspace 2026-06-22-09:00: the observability writes (store.logEntry / audit.git)
      // are themselves awaited and can throw; an unwrapped throw here would escape the catch
      // and re-escalate this deliberately NON-FATAL step into a fatal acquisition error,
      // stranding the already-created worktree. Suppress observability failures via safeObserve.
      await safeObserve(async () => {
        await store.logEntry(task.id, `Workspace sub-repo identity-guard install failed for ${repoRelPath} (non-fatal): ${message}`, undefined, runContext);
        await audit?.git({
          type: "worktree:workspace-repo-acquire-failed",
          target: repoAbsPath,
          metadata: { repoRelPath, taskId: task.id, error: message, stage: "identity-guard" },
        });
      });
    }

    /*
    FNXC:Workspace 2026-06-21-20:10:
    Per-repo base SHA (KTD3): resolve THIS sub-repo's integration branch with the
    shared settings.integrationBranch AND settings.baseBranch overrides STRIPPED.
    resolveFromSettings (integration-branch.ts) falls back integrationBranch →
    baseBranch → origin/HEAD, so leaving either set means every sub-repo resolves to
    the shared workspace branch — defeating per-repo resolution (F4). With both
    undefined, each sub-repo falls through to its own origin/HEAD. Capture the base
    local-first against that branch so local-ahead-of-origin integration tips don't
    inflate the per-repo diff (FN-5937 invariant, per sub-repo).
    */
    let baseCommitSha: string | undefined;
    try {
      const integrationBranch = await resolveIntegrationBranch(
        repoAbsPath,
        { ...settings, integrationBranch: undefined, baseBranch: undefined },
        { logger },
      );
      baseCommitSha = await resolveCapturedBaseCommitSha(result.worktreePath, logger, integrationBranch);
    } catch (baseErr) {
      // FNXC:Workspace 2026-06-21-22:30: F3 — base-SHA capture is non-fatal; an undefined baseCommitSha is an accepted state.
      // FNXC:Workspace 2026-06-22-00:00: guard the best-effort logEntry/audit so a logging throw cannot promote this
      // non-fatal capture failure into a fatal acquisition failure (parity with the F6 busy-path defensive wrap).
      const message = baseErr instanceof Error ? baseErr.message : String(baseErr);
      logger?.warn(`${task.id}: base-SHA capture failed for sub-repo ${repoRelPath} (non-fatal): ${message}`);
      // FNXC:Workspace 2026-06-22-09:00: same non-fatal contract as the identity-guard catch —
      // the awaited observability writes must not re-escalate a non-fatal base-capture failure.
      await safeObserve(async () => {
        await store.logEntry(task.id, `Workspace sub-repo base-SHA capture failed for ${repoRelPath} (non-fatal): ${message}`, undefined, runContext);
        await audit?.git({
          type: "worktree:workspace-repo-acquire-failed",
          target: repoAbsPath,
          metadata: { repoRelPath, taskId: task.id, error: message, stage: "base-sha-capture" },
        });
      });
    }

    /*
    FNXC:Workspace 2026-06-21-22:30:
    F5 — re-read the task fresh immediately before building the merged
    workspaceWorktrees map. store.updateTask wholesale-replaces the map, and the
    `task` snapshot was read earlier; two sequential acquires for DIFFERENT sub-repos
    in one task would otherwise clobber a sibling's entry. Merging into the LATEST map
    closes the common sequential-tool-call case. NOTE: a fully-atomic store-level
    per-repo merge is the complete fix (it also covers truly-concurrent writes); it is
    deferred to Phase B, which exercises multi-repo acquisition.
    */
    const latest = await store.getTask(task.id);
    const updated: Record<string, { worktreePath: string; branch: string; baseCommitSha?: string }> = {
      ...(latest.workspaceWorktrees ?? {}),
      [repoRelPath]: { worktreePath: result.worktreePath, branch: result.branch, baseCommitSha },
    };
    /*
    FNXC:Workspace 2026-06-22-09:00:
    F10 — reset the singular worktree/branch columns to null in the SAME write that
    persists workspaceWorktrees. The single-repo `acquireTaskWorktree` above wrote
    `task.worktree`/`task.branch` (the sub-repo path/branch) to the real task row;
    clearing the in-memory copy passed in only stops the NEXT sub-repo from resuming
    into this one's worktree — the DB row stays polluted. A non-null `task.worktree`
    makes `isWorkspaceTask(task)` return false (its first guard), so the dashboard
    stops rendering WorkspaceWorktreesSummary and instead shows the sub-repo branch in
    the standard chip — the blank/wrong-card state U10 prevents. Nulling them here
    keeps `task.worktree` null for the workspace task's whole lifetime.
    */
    await store.updateTask(task.id, { workspaceWorktrees: updated, worktree: null, branch: null });

    return { worktreePath: result.worktreePath, branch: result.branch, baseCommitSha, alreadyAcquired: false };
  } catch (err) {
    /*
    FNXC:Workspace 2026-06-21-20:10:
    Acquisition failure must surface an error and leave an audit trail (no swallowed
    stall): persist the failure as an audit event + task log, then re-throw so the
    caller observes the failure rather than silently proceeding with an unacquired
    sub-repo.
    */
    if (!(err instanceof WorkspaceRepoAcquireBusyError)) {
      // FNXC:Workspace 2026-06-22-00:00: wrap the failure logEntry/audit so a throw here cannot replace the ORIGINAL
      // acquisition `err` the caller must observe — losing it would mask the real cause and the re-throw below would
      // surface a logging error instead. Best-effort observability; `err` is always re-thrown.
      const message = err instanceof Error ? err.message : String(err);
      logger?.error?.(`${task.id}: workspace sub-repo acquisition failed for ${repoRelPath}: ${message}`);
      // FNXC:Workspace 2026-06-22-09:30: the fatal-path observability writes must use safeObserve
      // for the same reason as the non-fatal catches — an unsuppressed throw from logEntry/audit
      // would replace `err` as the propagated rejection, so a store/audit hiccup could surface a
      // non-WorkspaceRepoAcquireBusyError to callers whose `instanceof` type checks then misfire.
      // The original acquisition `err` (line below) is the contract; observability is best-effort.
      await safeObserve(async () => {
        await store.logEntry(task.id, `Workspace sub-repo acquisition failed for ${repoRelPath}: ${message}`, undefined, runContext);
        await audit?.git({
          type: "worktree:workspace-repo-acquire-failed",
          target: repoAbsPath,
          metadata: { repoRelPath, taskId: task.id, error: message },
        });
      });
    }
    throw err;
  } finally {
    /*
    FNXC:Workspace 2026-06-21-20:10:
    Release the acquisition-time exclusivity entry only when WE hold it. The busy-path
    throw above does NOT enter this try (it short-circuits before registerPath), so a
    serialized loser never unregisters the winner's entry.
    */
    const held = registry.lookupByPath(repoAbsPath);
    if (held && held.taskId === task.id && held.ownerKey === WORKSPACE_REPO_ACQUIRE_OWNER_KEY) {
      registry.unregisterPath(repoAbsPath);
    }
  }
}

/*
FNXC:Workspace 2026-06-21-20:10:
Thrown when a second workspace task tries to acquire a sub-repo already inside
another task's acquisition critical section (KTD4). Distinct from generic
acquisition failures so the caller (and tests) can tell "serialized, retry later"
apart from "this sub-repo is broken".
*/
export class WorkspaceRepoAcquireBusyError extends Error {
  constructor(
    public readonly repoRelPath: string,
    public readonly holderTaskId: string,
    public readonly requestingTaskId: string,
  ) {
    super(`workspace sub-repo ${repoRelPath} acquisition is in progress for task ${holderTaskId}`);
    this.name = "WorkspaceRepoAcquireBusyError";
  }
}
