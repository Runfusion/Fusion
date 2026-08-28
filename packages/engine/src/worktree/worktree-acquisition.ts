import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { exec } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { acquireWorktreePathReservation, assertWorkspaceRepoRelPath, canonicalizeWorktreePath, classifyTaskBranchOrigin, isLegacyWorkspaceWorktreeLayout, resolveEngineIncarnationId, resolveEngineNodeId, resolveWorkspaceRepoWorktreePath, resolveWorkspaceTaskWorktreeDir, workspaceWorktreeGroupSegment, WORKSPACE_GROUP_MARKER_FILENAME, type RunMutationContext, type Settings, type Task, type TaskStore, type SecretsStore, type WorkspaceConfig, type WorkspaceLeaseHandle, type WorkspaceWorktreeContext } from "@fusion/core";
import { generateWorktreeName, resolveTaskWorkingBranchWithOrigin, slugify } from "./worktree-names.js";
import { resolveTaskWorktreePathForBackend, resolveWorktreesDir, WORKTREE_RECOVERY_DIRNAME } from "./worktree-paths.js";
import { hydrateWorktreeDb } from "./worktree-db-hydrate.js";
import { formatError } from "../logger.js";
import { classifyBootstrapMisbinding, isBranchConflictError, reanchorBranchToBase } from "../execution/branch-conflicts.js";
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
import { resolveWorkspaceReviewRemediationRepository } from "../executor/workspace-review-remediation.js";
import { generateSyntheticRunId, type RunAuditor } from "../util/run-audit.js";
import { emitBoundedRunAudit } from "../util/emit-bounded-run-audit.js";
import { reconcileSecretsEnvFingerprint, writeSecretsEnvFile } from "./secrets-env-writer.js";
import { removeDesktopBuildArtifacts } from "./worktree-desktop-artifacts.js";
import { installTaskWorktreeIdentityGuard } from "./worktree-hooks.js";
import { copyConfiguredWorktreeFiles, type WorktreeCopyFileResult } from "./worktree-copy-files.js";
import { resolveCapturedBaseCommitSha } from "../execution/base-commit-capture.js";
import { resolveIntegrationBranch } from "../merge/integration-branch.js";
import { recordWorkspaceBaseBranchDecision, resolveWorkspaceRepoBaseBranch } from "./workspace-base-branch.js";
import { acquireActiveSessionPath, activeSessionRegistry, executingTaskLock, type ActiveSessionRegistry } from "../agents/active-session-registry.js";
import { refreshReusedWorktreeBase, type WorktreeBaseRefreshResult } from "../worktree-base-refresh.js";
import { normalizeWorkspaceTaskRouting } from "../executor/workspace-config-resolver.js";

const execAsync = promisify(exec);
const WORKTREE_BACKEND_MARKER = "fusion-worktree-backend-kind";
const PRESERVED_ORPHAN_RETENTION_COUNT = 10;
const PRESERVED_ORPHAN_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

async function resolveWorktreeBackendMarkerPath(worktreePath: string): Promise<string> {
  const { stdout } = await execAsync(`git rev-parse --git-path ${JSON.stringify(WORKTREE_BACKEND_MARKER)}`, {
    cwd: worktreePath,
    encoding: "utf-8",
  });
  const markerPath = stdout.trim();
  return isAbsolute(markerPath) ? markerPath : resolve(worktreePath, markerPath);
}

async function persistWorktreeBackendKind(worktreePath: string, backendKind: WorktreeBackend["kind"]): Promise<void> {
  await writeFile(await resolveWorktreeBackendMarkerPath(worktreePath), `${backendKind}\n`, "utf-8");
}

async function readPersistedWorktreeBackendKind(worktreePath: string): Promise<WorktreeBackend["kind"] | undefined> {
  try {
    const backendKind = (await readFile(await resolveWorktreeBackendMarkerPath(worktreePath), "utf-8")).trim();
    return backendKind === "native" || backendKind === "worktrunk" ? backendKind : undefined;
  } catch {
    return undefined;
  }
}

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
  logger?: { log: (m: string) => void; warn: (m: string) => void; debug?: (m: string) => void; error?: (m: string) => void };
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
  /** Actual backend used by an injected creator when it differs from the configured backend. */
  createWorktreeBackendKind?: WorktreeBackend["kind"];
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
  /** Test seam for filesystem-device recovery behavior. */
  renameWorktreeDirectory?: typeof rename;
  /** Execution callers opt in; planning, review, and merge reuse remain unchanged. */
  refreshStaleBase?: boolean;
  /*
   * FNXC:Workspace 2026-08-15-04:28:
   * Workspace sub-repo acquisition must never persist its per-repo path or branch in the task's
   * singular worktree columns. Only that caller opts in; all single-repo callers retain the
   * existing persistence contract.
   */
  /** Suppress singular `worktree` and `branch` persistence for workspace sub-repo acquisition. */
  suppressSingularWorktreePersist?: boolean;
  /** Workspace-only layout context; native git operations still use rootDir (the sub-repository). */
  workspaceContext?: WorkspaceWorktreeContext;
  /** A workspace task directory names the exact child destination and bypasses pinned-name derivation. */
  forceWorktreePath?: boolean;
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
  baseRefresh?: WorktreeBaseRefreshResult;
}

/** A typed refresh refusal: callers must park before creating a coding session. */
export class WorkspaceWorktreeGroupConflictError extends Error {
  constructor(
    public readonly workspaceRootDir: string,
    public readonly existingWorkspaceRootDir: string,
    public readonly groupDir: string,
  ) {
    super(`Workspace worktree group conflict: ${workspaceRootDir} and ${existingWorkspaceRootDir} resolve to ${groupDir}. Configure a distinct worktreesDir for one of these projects, or rename one workspace directory.`);
    this.name = "WorkspaceWorktreeGroupConflictError";
  }
}

export class WorktreeBaseRefreshError extends Error {
  constructor(public readonly refresh: WorktreeBaseRefreshResult) {
    super(`Worktree base refresh blocked execution: ${refresh.kind}`);
    this.name = "WorktreeBaseRefreshError";
  }
}

type InitCommandResult = Awaited<ReturnType<NonNullable<AcquireTaskWorktreeOptions["runConfiguredCommand"]>>>;

export class RepoRootWorktreeError extends Error {
  constructor(public readonly taskId: string, public readonly rootDir: string, public readonly worktreePath: string, public readonly source: string) {
    super(`Refusing to return repo root as task worktree for ${taskId}: ${worktreePath} (${source}) canonicalizes to ${rootDir}`);
    this.name = "RepoRootWorktreeError";
  }
}

const INIT_OUTCOME_MAX_CHARS = 2_000;

async function ensureContainedDirectory(parentCanonicalPath: string, name: string): Promise<string> {
  const candidate = join(parentCanonicalPath, name);
  try {
    await mkdir(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const canonicalCandidate = await realpath(candidate);
  const candidateRelative = relative(parentCanonicalPath, canonicalCandidate);
  if (candidateRelative === "" || candidateRelative.startsWith("..") || isAbsolute(candidateRelative)) {
    throw new Error(`Refusing to use recovery directory outside ${parentCanonicalPath}: ${canonicalCandidate}`);
  }
  if (!(await stat(canonicalCandidate)).isDirectory()) {
    throw new Error(`Refusing to use non-directory recovery path: ${canonicalCandidate}`);
  }
  return canonicalCandidate;
}

interface PreservedOrphanCandidate {
  path: string;
  canonicalPath: string;
  mtimeMs: number;
}

async function inspectPreservedOrphanCandidate(
  canonicalRecoveryRoot: string,
  name: string,
): Promise<PreservedOrphanCandidate | null> {
  if (!PRESERVED_ORPHAN_NAME_PATTERN.test(name)) return null;
  const path = join(canonicalRecoveryRoot, name);
  try {
    const pathStat = await lstat(path);
    if (!pathStat.isDirectory() || pathStat.isSymbolicLink()) return null;
    const canonicalPath = await realpath(path);
    const candidateRelative = relative(canonicalRecoveryRoot, canonicalPath);
    if (candidateRelative !== name || candidateRelative.includes("/") || candidateRelative.includes("\\") || isAbsolute(candidateRelative)) {
      return null;
    }
    return { path, canonicalPath, mtimeMs: pathStat.mtimeMs };
  } catch {
    return null;
  }
}

/**
 * FNXC:TaskPinnedWorktrees 2026-08-10-01:12:
 * Each actual orphan-recovery root retains its newest ten generated task-id-plus-UUID directories. Pruning is fail-soft and removes only direct canonical non-symlink directories after an immediate active-session check; unknown, unstatable, or active entries are preserved.
 */
async function prunePreservedOrphanDirectories(
  canonicalRecoveryRoot: string,
  logger?: { warn: (message: string) => void },
): Promise<void> {
  try {
    const entries = await readdir(canonicalRecoveryRoot, { withFileTypes: true });
    const candidates = (await Promise.all(entries.map((entry) =>
      inspectPreservedOrphanCandidate(canonicalRecoveryRoot, entry.name))))
      .filter((candidate): candidate is PreservedOrphanCandidate => candidate !== null)
      .sort((left, right) => right.mtimeMs - left.mtimeMs || right.path.localeCompare(left.path));

    for (const candidate of candidates.slice(PRESERVED_ORPHAN_RETENTION_COUNT)) {
      try {
        const current = await inspectPreservedOrphanCandidate(canonicalRecoveryRoot, candidate.path.slice(canonicalRecoveryRoot.length + 1));
        if (!current || current.canonicalPath !== candidate.canonicalPath) continue;
        if (activeSessionRegistry.isPathActive(current.path) || activeSessionRegistry.isPathActive(current.canonicalPath)) continue;
        await rm(current.path, { recursive: true, force: true });
      } catch (error) {
        logger?.warn(`Failed to prune preserved orphan directory ${candidate.path}: ${formatError(error).message}`);
      }
    }
  } catch (error) {
    logger?.warn(`Failed to inspect preserved orphan retention root ${canonicalRecoveryRoot}: ${formatError(error).message}`);
  }
}

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

/*
FNXC:WorkspaceWorktree 2026-08-20-01:20:
A shared configured root needs an acquisition-time owner marker so equal workspace
basenames never share a derivable group. The marker rejects conflicts only; all path
resolution remains the pure core layout function and sweeps use marker presence only
as a deletion veto.
*/
async function ensureWorkspaceGroupOwnership(
  workspaceContext: WorkspaceWorktreeContext | undefined,
  settings: Partial<Settings>,
): Promise<void> {
  if (!workspaceContext || !settings.worktreesDir || settings.worktrunk?.enabled) return;
  const workspaceRootDir = resolve(workspaceContext.workspaceRootDir);
  const configuredRoot = resolveWorktreesDir(workspaceRootDir, settings);
  const rel = relative(workspaceRootDir, configuredRoot);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return;
  const groupDir = join(configuredRoot, workspaceWorktreeGroupSegment(workspaceRootDir));
  await mkdir(groupDir, { recursive: true });
  const marker = join(groupDir, WORKSPACE_GROUP_MARKER_FILENAME);
  try {
    await writeFile(marker, workspaceRootDir, { flag: "wx" });
  } catch (error: unknown) {
    const errorCode = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (errorCode !== "EEXIST") throw error;
    try {
      const existingRoot = resolve((await readFile(marker, "utf8")).trim());
      if (existingRoot !== workspaceRootDir) throw new WorkspaceWorktreeGroupConflictError(workspaceRootDir, existingRoot, groupDir);
    } catch (readError: unknown) {
      if (readError instanceof WorkspaceWorktreeGroupConflictError) throw readError;
      const readErrorCode = readError && typeof readError === "object" && "code" in readError ? readError.code : undefined;
      if (readErrorCode !== "ENOENT") throw readError;
      await writeFile(marker, workspaceRootDir, { flag: "wx" });
    }
  }
}

export async function acquireTaskWorktree(opts: AcquireTaskWorktreeOptions): Promise<AcquireTaskWorktreeResult> {
  const { task, rootDir, store, settings, pool, logger, audit, runContext, createWorktree, runConfiguredCommand, runInitCommand, taskEnv, secretsStore, workspaceContext } = opts;
  /*
   * FNXC:BranchWriteOrigin 2026-08-28-10:12:
   * #3523 review (Greptile P1): hardcoded `branchWriteOrigin: "engine"` stamps on branch-value
   * writes bypassed the classifier below, so operator-provided branches reaching fresh-create,
   * warm-reuse, pool-acquire, or merge-reuse persisted as Fusion-owned and became eligible for
   * engine cleanup of branches the operator supplied. Every branch-value write must derive its
   * origin through `classifyTaskBranchOrigin`; null clears keep explicit stamps because they
   * attribute the actor and cannot claim branch ownership.
   */
  const branchWriteOriginFor = (branch: string | null | undefined): "operator" | "engine" =>
    classifyTaskBranchOrigin(task, branch ?? undefined) === "operator-supplied" ? "operator" : "engine";
  /*
   * FNXC:BranchNaming 2026-08-21-09:09:
   * Singular assignment persistence is a real task-branch write. Derive its durable provenance
   * from the recorded operator override, never from a branch prefix; workspace writes strip both
   * singular fields and this transient provenance before publishing their per-repository entry.
   */
  const persistWorktreeAssignment = async (patch: Parameters<TaskStore["updateTask"]>[1]): Promise<void> => {
    const provenancePatch = patch.branch === undefined
      ? patch
      : {
          ...patch,
          branchWriteOrigin: patch.branchWriteOrigin ?? branchWriteOriginFor(patch.branch),
        };
    if (!opts.suppressSingularWorktreePersist) {
      await store.updateTask(task.id, provenancePatch);
      return;
    }
    const { worktree: _worktree, branch: _branch, branchWriteOrigin: _origin, ...nonSingularPatch } = provenancePatch;
    if (Object.keys(nonSingularPatch).length > 0) {
      await store.updateTask(task.id, nonSingularPatch);
    }
  };
  const renameWorktreeDirectory = opts.renameWorktreeDirectory ?? rename;
  const refreshExistingWorktree = async (
    path: string,
    backendKind: WorktreeBackend["kind"],
  ): Promise<WorktreeBaseRefreshResult | undefined> => {
    if (!opts.refreshStaleBase || backendKind === "worktrunk") return undefined;
    /*
     * FNXC:SecretsEnvMaterialization 2026-08-07-23:13:
     * Reconcile the v0.75.1 root record before strict porcelain checking. A malformed, conflicting, or
     * unresolvable record fails closed rather than hiding project dirt or authorizing unsafe secret cleanup.
     */
    let reconciliation: Awaited<ReturnType<typeof reconcileSecretsEnvFingerprint>>;
    try {
      reconciliation = await reconcileSecretsEnvFingerprint(path);
    } catch {
      // FNXC:SecretsEnvMaterialization 2026-08-08-02:00: A resolver I/O failure is an opaque but fixed
      // reconciliation outcome. Convert it to the same pre-refresh fail-closed path without recording OS
      // error text, paths, or any secret-derived value in the durable audit trail.
      reconciliation = { executionSafe: false, outcome: "git-dir-unavailable" };
    }
    if (!reconciliation.executionSafe) {
      const refresh: WorktreeBaseRefreshResult = { kind: "base-reconciliation-required", executionSafe: false, detail: reconciliation.outcome };
      await audit?.git?.({ type: "worktree:base-refresh-blocked", target: path, metadata: { taskId: task.id, outcome: refresh.kind, reconciliationOutcome: reconciliation.outcome } });
      await store.logEntry(task.id, `Worktree secrets record reconciliation blocked execution (${reconciliation.outcome})`, undefined, runContext);
      throw new WorktreeBaseRefreshError(refresh);
    }
    const refreshSettings = settings.worktrunk?.enabled === true
      ? { ...settings, worktrunk: { ...settings.worktrunk, enabled: false } }
      : settings;
    const refresh = await refreshReusedWorktreeBase({ task, rootDir, worktreePath: path, store, settings: refreshSettings, audit, logger });
    /*
    FNXC:WorktreeBaseRefresh 2026-08-09-23:49:
    A declined refresh is an unremarkable outcome, not an execution failure: the checkout is intact and the
    merge lane still rebases with conflict resolution before landing. Record it as a skip so the base staleness
    stays observable without parking the task or paging the operator.

    This matters more since the refresh was extended to freshly reacquired and pooled worktrees: that widened
    where a fail-closed refusal could fire, and every one of them reached the executor's terminal sink.
    */
    if (refresh.skipped) {
      await audit?.git({ type: refresh.kind === "stale-base-conflict" ? "worktree:base-refresh-conflict" : "worktree:base-refresh-skipped", target: path, metadata: { taskId: task.id, outcome: refresh.kind } });
      await store.logEntry(task.id, `Worktree base refresh skipped (${refresh.kind}) — kept local base; the merge-time rebase will retry with conflict resolution`, refresh.detail, runContext);
      return refresh;
    }
    if (!refresh.executionSafe) {
      await audit?.git({ type: "worktree:base-refresh-blocked", target: path, metadata: { taskId: task.id, outcome: refresh.kind } });
      await store.logEntry(task.id, `Worktree base refresh blocked execution (${refresh.kind})`, refresh.detail, runContext);
      throw new WorktreeBaseRefreshError(refresh);
    }
    return refresh;
  };
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
  await ensureWorkspaceGroupOwnership(workspaceContext, settings);
  const workingBranch = resolveTaskWorkingBranchWithOrigin(task);
  const branchName = workingBranch.branch;
  const resolveExistingWorktreeBackendKind = async (path: string): Promise<WorktreeBackend["kind"]> =>
    (await readPersistedWorktreeBackendKind(path)) ?? opts.createWorktreeBackendKind ?? backend.kind;
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
        : generateWorktreeName(rootDir, settings, workspaceContext);
    worktreePath = await resolveTaskWorktreePathForBackend(rootDir, worktreeName, settings, backend, branchName, workspaceContext);
  }

  // Grouped workspace paths have two container levels; native git requires the immediate parent to exist.
  if (workspaceContext && backend.kind !== "worktrunk") await mkdir(dirname(worktreePath), { recursive: true });
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
      await persistWorktreeAssignment({ worktree: null, branch: null, branchWriteOrigin: "engine" as const, sessionFile: null });
      const fallbackName = generateWorktreeName(rootDir, settings, workspaceContext);
      worktreePath = await resolveTaskWorktreePathForBackend(rootDir, fallbackName, settings, backend, branchName, workspaceContext);
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
  const createWorktreeWithoutReservation = async (
    createBranch: string,
    createPath: string,
    createTaskId: string,
    startPoint?: string,
    allowRename?: boolean,
    branchOrigin?: "engine-canonical" | "group-derived" | "operator-supplied",
  ): Promise<{ path: string; branch: string; backendKind: WorktreeBackend["kind"] }> => {
    try {
      const created = await backend.create({
        rootDir,
        branch: createBranch,
        worktreePath: createPath,
        startPoint,
        taskId: createTaskId,
        branchOrigin,
        allowSiblingBranchRename: allowRename,
      });
      if (backend.kind === "worktrunk") {
        await audit?.git({
          type: "worktree:worktrunk-create",
          target: created.path,
          metadata: { branch: created.branch },
        });
      }
      await persistWorktreeBackendKind(created.path, backend.kind);
      return { ...created, backendKind: backend.kind };
    } catch (error) {
      if (backend.kind !== "worktrunk" || !(error instanceof WorktrunkOperationError)) throw error;
      // FNXC:WorktreeAcquisition 2026-07-16-00:00: FN-8132 requires native fallback collision dispositions to be audited just like direct native acquisition.
      const nativeBackend = new NativeWorktreeBackend({ logger: logger ?? undefined, audit });
      const fallback = () => nativeBackend.create({
        rootDir,
        branch: createBranch,
        worktreePath: createPath,
        startPoint,
        taskId: createTaskId,
        branchOrigin,
        allowSiblingBranchRename: allowRename,
      });
      const created = await handleWorktrunkFailure("create", error, fallback) as { path: string; branch: string };
      await persistWorktreeBackendKind(created.path, "native");
      return { ...created, backendKind: "native" };
    }
  };

  const createWorktreeImpl = async (
    createBranch: string,
    createPath: string,
    createTaskId: string,
    startPoint?: string,
    allowRename?: boolean,
    reservationHeld = false,
    branchOrigin?: "engine-canonical" | "group-derived" | "operator-supplied",
  ): Promise<{ path: string; branch: string; backendKind: WorktreeBackend["kind"] }> => {
    if (createWorktree) {
      const created = await createWorktree(createBranch, createPath, createTaskId, startPoint, allowRename);
      return { ...created, backendKind: opts.createWorktreeBackendKind ?? backend.kind };
    }
    if (reservationHeld) return createWorktreeWithoutReservation(createBranch, createPath, createTaskId, startPoint, allowRename, branchOrigin);
    const reservation = await acquireWorktreePathReservation({
      canonicalPath: await canonicalizeWorktreePath(createPath),
      worktreesDir: resolveWorktreesDir(rootDir, settings, workspaceContext),
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
      return await createWorktreeWithoutReservation(createBranch, createPath, createTaskId, startPoint, allowRename, branchOrigin);
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
    created: { path: string; branch: string; backendKind: WorktreeBackend["kind"] },
    source: "fresh" | "pool",
    logOrigin: "normal" | "return-guard",
  ): Promise<AcquireTaskWorktreeResult> => {
    /*
     * FNXC:WorktreeLiveness 2026-06-22-18:30:
     * FN-6861 fixed the resume classifier path, but FN-6888 showed the repo root can still reach the executor through another acquisition return branch. FN-6922 makes acquisition itself enforce a return-value invariant: no resume, pool, or fresh branch may return the repo root, so the executor's realpath_matches_repo_root gate remains defense-in-depth instead of a requeue loop source.
     */
    if (isRepoRootPath(rootDir, created.path)) {
      await emitRepoRootReturnGuardAudit(created.path, source);
      await persistWorktreeAssignment({ worktree: null, branch: null, branchWriteOrigin: "engine" as const, sessionFile: null });
      throw new RepoRootWorktreeError(task.id, rootDir, created.path, `fresh-create:${logOrigin}`);
    }

    worktreePath = created.path;
    branch = created.branch;
    /*
     * FNXC:BranchWriteOrigin 2026-08-20-14:40: FN-9161's store validation requires an explicit write origin on every branch write.
     * FNXC:BranchWriteOrigin 2026-08-28-10:12: the stamp derives from the classifier — an operator override branch reaching
     * fresh-create finalize must persist "operator" provenance, not engine ownership.
     */
    try {
      await persistWorktreeAssignment({ worktree: created.path, branch: created.branch, branchWriteOrigin: branchWriteOriginFor(created.branch) });
    } catch (error) {
      /*
       * FNXC:WorktreeAcquisition 2026-08-21-09:09:
       * Git creation precedes the PostgreSQL assignment. Compensate only the checkout created by
       * this attempt via the backend-aware remover; never invoke conflict cleanup or delete its branch.
       */
      try {
        await removeWorktree({
          worktreePath: created.path,
          rootDir,
          settings,
          taskId: task.id,
          reason: RemovalReason.ExecutorDispose,
        });
      } catch (cleanupError) {
        logger?.warn(`${task.id}: failed to compensate unpersisted worktree ${created.path}: ${formatError(cleanupError)}`);
      }
      throw error;
    }
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

    // FNXC:WorktreeBaseRefresh 2026-08-09-03:30: Execution can recreate an existing task branch after its
    // dependency branch was merged and deleted. Refresh fresh acquisitions too so that branch cannot resume
    // from its stale pre-dependency tip.
    const baseRefresh = await refreshExistingWorktree(worktreePath, created.backendKind);

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
    return { worktreePath, branch, source, hydrated, isResume: false, baseRefresh };
  };

  const createFreshWorktreeFromReturnGuard = async (guardedPath: string, source: string): Promise<AcquireTaskWorktreeResult> => {
    await emitRepoRootReturnGuardAudit(guardedPath, source);
    logger?.warn(`${task.id}: acquisition ${source} returned repo root; clearing assignment and creating a fresh worktree`);
    await store.logEntry(task.id, "Acquisition attempted to return the project root as a task worktree; creating a fresh worktree instead", guardedPath, runContext);
    await persistWorktreeAssignment({ worktree: null, branch: null, branchWriteOrigin: "engine" as const, sessionFile: null });
    const fallbackName = generateWorktreeName(rootDir, settings, workspaceContext);
    const fallbackPath = await resolveTaskWorktreePathForBackend(rootDir, fallbackName, settings, backend, branchName, workspaceContext);
    const created = await createWorktreeImpl(branchName, fallbackPath, task.id, freshStartPoint, allowSiblingBranchRename, false, workingBranch.origin);
    return finalizeCreatedWorktree(created, "fresh", "return-guard");
  };

  const guardAcquisitionReturn = async (result: AcquireTaskWorktreeResult): Promise<AcquireTaskWorktreeResult> => {
    if (!isRepoRootPath(rootDir, result.worktreePath)) return result;
    return createFreshWorktreeFromReturnGuard(result.worktreePath, result.source);
  };

  /** Warm-reuse an existing, usable, branch-matched worktree (mirrors the resume path). */
  const reuseWarmWorktree = async (path: string, resumedBranch: string, source: "existing"): Promise<AcquireTaskWorktreeResult> => {
    // FNXC:EngineDiagnostics 2026-08-03-05:54: warm reuse is the common healthy path; Worktree created stays info.
    if (logger?.debug) logger.debug(`Reusing existing worktree: ${path}`);
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
    const baseRefresh = await refreshExistingWorktree(path, await resolveExistingWorktreeBackendKind(path));
    return guardAcquisitionReturn({ worktreePath: path, branch: resumedBranch, source, hydrated, isResume: true, baseRefresh });
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
    const pinnedPath = pinnedWorktreePathForTask(task.id, settings, rootDir, workspaceContext);
    const resumedBranch = task.branch ?? branchName;

    if (task.worktree && canonicalizePath(task.worktree) !== canonicalizePath(pinnedPath)) {
      await audit?.git({
        type: "worktree:pin-rederived",
        target: pinnedPath,
        metadata: { taskId: task.id, previous: task.worktree, derived: pinnedPath, source: "acquire" },
      });
      await store.logEntry(task.id, "Re-derived task-pinned worktree path from task id", `${task.worktree} -> ${pinnedPath}`, runContext);
      await persistWorktreeAssignment({ worktree: pinnedPath });
    }

    const reservation = await acquireWorktreePathReservation({
      canonicalPath: await canonicalizeWorktreePath(pinnedPath),
      worktreesDir: resolveWorktreesDir(rootDir, settings, workspaceContext),
      rootDir,
      isLiveWorktree: async () => {
        if (activeSessionRegistry.isPathActive(pinnedPath)) return true;
        return (await classifyTaskWorktree(rootDir, pinnedPath)).ok;
      },
      /*
       * FNXC:TaskPinnedWorktrees 2026-08-10-01:12:
       * Pinned acquisition owns the reservation through classification, orphan preservation, quarantine reconciliation, and recreation. Preserve an existing directory for classification; for an absent path, fail closed on containment or active in-process ownership before reusing the guarded backend removal path.
       */
      reconcileQuarantined: async () => {
        if (existsSync(pinnedPath)) return;
        if (!isInsideWorktreesDir(rootDir, pinnedPath, settings, workspaceContext)) {
          throw new Error(`Refusing to reconcile quarantined task-pinned worktree outside configured worktrees directory: ${pinnedPath}`);
        }
        if (activeSessionRegistry.isPathActive(pinnedPath)) {
          throw new Error(`Refusing to reconcile absent task-pinned worktree owned by an active session: ${pinnedPath}`);
        }
        await removeWorktree({
          worktreePath: pinnedPath,
          rootDir,
          settings,
          taskId: task.id,
          reason: RemovalReason.ExecutorDispose,
          force: true,
        });
      },
    });
    try {
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
          // FNXC:BranchWriteOrigin 2026-08-28-10:12: warm reuse can adopt an operator-override branch; derive origin (#3523 Greptile P1).
          await persistWorktreeAssignment({ worktree: pinnedPath, branch: resumedBranch, branchWriteOrigin: branchWriteOriginFor(resumedBranch) });
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
      if (isInsideWorktreesDir(rootDir, pinnedPath, settings, workspaceContext)) {
        try {
          const preserveAsOrphanDirectory = !classification.ok
            && (classification.classification === "incomplete" || classification.classification === "unregistered")
            && !activeSessionRegistry.isPathActive(pinnedPath);
          if (preserveAsOrphanDirectory) {
            const canonicalRoot = await realpath(rootDir);
            /*
             * FNXC:TaskPinnedWorktrees 2026-08-10-01:12:
             * Recovery directory components must resolve inside their canonical parent. A symlinked ancestor or container fails closed before orphan contents move.
             */
            const fusionRoot = await ensureContainedDirectory(canonicalRoot, ".fusion");
            const recoveryRoot = await ensureContainedDirectory(fusionRoot, "recovery");
            let actualRecoveryRoot = await ensureContainedDirectory(recoveryRoot, "worktrees");
            // FNXC:TaskPinnedWorktrees 2026-08-10-01:12: The reservation serializes cross-process recovery; recheck in-process liveness immediately before the rename so a newly registered owner is never displaced.
            if (activeSessionRegistry.isPathActive(pinnedPath)) {
              throw new Error(`Task-pinned worktree ${pinnedPath} became active during orphan recovery`);
            }
            let preservedPath = join(actualRecoveryRoot, `${task.id.toLowerCase()}-${randomUUID()}`);
            try {
              await renameWorktreeDirectory(pinnedPath, preservedPath);
            } catch (renameError) {
              if ((renameError as NodeJS.ErrnoException).code !== "EXDEV") throw renameError;
              /*
               * FNXC:TaskPinnedWorktrees 2026-08-09-03:20:
               * Configured worktrees may live on another filesystem. Preserve atomically beside the
               * configured worktree root instead of weakening recovery to recursive copy-and-delete.
               */
              const canonicalWorktreesRoot = await realpath(resolveWorktreesDir(rootDir, settings, workspaceContext));
              const localRecoveryRoot = await ensureContainedDirectory(canonicalWorktreesRoot, WORKTREE_RECOVERY_DIRNAME);
              const localRecoveryWorktrees = await ensureContainedDirectory(localRecoveryRoot, "worktrees");
              actualRecoveryRoot = localRecoveryWorktrees;
              preservedPath = join(localRecoveryWorktrees, `${task.id.toLowerCase()}-${randomUUID()}`);
              await renameWorktreeDirectory(pinnedPath, preservedPath);
            }
            /*
             * FNXC:TaskPinnedWorktrees 2026-08-10-01:12:
             * Once rename has preserved the orphan, audit, task-log, and retention work are independent best-effort observability/housekeeping. Their failures must not strand the pinned path or block recreation, and warnings must retain the concrete formatted failure message.
             */
            try {
              await audit?.filesystem({
                type: "file:write",
                target: preservedPath,
                metadata: {
                  taskId: task.id,
                  classification: classification.classification,
                  reason: "task-pinned-orphan-preserved",
                  sourcePath: pinnedPath,
                },
              });
            } catch (error) {
              logger?.warn(`${task.id}: failed to audit preserved orphan ${preservedPath}: ${formatError(error).message}`);
            }
            try {
              await store.logEntry(
                task.id,
                `Preserved orphaned task-pinned directory ${pinnedPath} before recreation`,
                preservedPath,
                runContext,
              );
            } catch (error) {
              logger?.warn(`${task.id}: failed to log preserved orphan ${preservedPath}: ${formatError(error).message}`);
            }
            await prunePreservedOrphanDirectories(actualRecoveryRoot, logger);
          } else {
            await removeWorktree({
              rootDir,
              worktreePath: pinnedPath,
              settings,
              reason: RemovalReason.PoolPrune,
              taskId: task.id,
              audit: undefined,
            });
          }
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

      const created = await createWorktreeImpl(branchName, pinnedPath, task.id, freshStartPoint, allowSiblingBranchRename, true, workingBranch.origin);
      return await finalizeCreatedWorktree(created, "fresh", "normal");
    } finally {
      if (reservation.state === "held") await reservation.release();
    }
  };

  if (pinned && !opts.forceWorktreePath) {
    return acquirePinnedWorktree();
  }

  if (!workspaceContext && !task.worktree && !(pool && settings.recycleWorktrees)) {
    const registeredMatches = (await getRegisteredWorktreeBranches(rootDir))
      .filter((entry) => entry.branch === branchName);
    if (registeredMatches.length === 1) {
      const registeredPath = registeredMatches[0].worktreePath;
      const classification = await classifyTaskWorktree(rootDir, registeredPath);
      if (classification.ok) {
        /*
         * FNXC:WorktreeAcquisition 2026-08-21-09:36:
         * FN-107 repairs installations that created a Git checkout before the former task-row
         * provenance validation rejected its assignment. Adopt the one registered checkout already
         * on this task's selected branch before attempting `git worktree add`; this preserves its
         * commits and avoids treating a recoverable registration as a branch conflict. Workspace
         * members remain map-owned and never enter the singular adoption path.
         */
        await persistWorktreeAssignment({ worktree: registeredPath, branch: branchName });
        return reuseWarmWorktree(registeredPath, branchName, "existing");
      }
    }
  }

  if (task.worktree && isResume) {
    // FNXC:EngineDiagnostics 2026-08-03-05:54: resume reuses the pinned path — expected, not a default-visible event.
    if (logger?.debug) logger.debug(`Reusing existing worktree: ${worktreePath}`);
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
    const baseRefresh = await refreshExistingWorktree(worktreePath, await resolveExistingWorktreeBackendKind(worktreePath));
    return guardAcquisitionReturn({ worktreePath, branch: resumedBranch, source: "existing", hydrated, isResume: true, baseRefresh });
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
      let poolAssignmentPersistenceStarted = false;
      try {
        const preparedRaw = await pool.prepareForTask(pooled, branchName, freshStartPoint, {
          allowSiblingBranchRename,
          repoDir: rootDir,
          requestingTaskId: task.id,
          branchOrigin: workingBranch.origin,
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
          const fallbackName = generateWorktreeName(rootDir, settings, workspaceContext);
          worktreePath = await resolveTaskWorktreePathForBackend(rootDir, fallbackName, settings, backend, branchName, workspaceContext);
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
            expectedBranch: branch,
            commitMsgHookEnabled: settings.commitMsgHookEnabled,
            taskPrefix: settings.taskPrefix,
            taskAttributionTrailerName: settings.taskAttributionTrailerNames?.[0],
            commitAuthorEnabled: settings.commitAuthorEnabled,
            commitAuthorName: settings.commitAuthorName,
            commitAuthorEmail: settings.commitAuthorEmail,
          });
          acquiredFromPool = true;
          logger?.log(`Acquired worktree from pool: ${worktreePath}`);
          /*
           * FNXC:WorktreeAcquisition 2026-08-21-09:32:
           * A lease-backed checkout is not a conflict or a candidate for fresh fallback when its
           * task-row assignment fails. The outer handler releases the lease and preserves that error.
           */
          poolAssignmentPersistenceStarted = true;
          // FNXC:BranchWriteOrigin 2026-08-28-10:12: the pool may hand off an operator-override branch; derive origin (#3523 Greptile P1).
          await persistWorktreeAssignment({ worktree: worktreePath, branch, branchWriteOrigin: branchWriteOriginFor(branch) });
          poolAssignmentPersistenceStarted = false;
          await audit?.git({ type: "worktree:reuse", target: worktreePath, metadata: { branch, reclaimed: prepared.reclaimed } });
          if (prepared.reclaimed) {
            await store.logEntry(task.id, `Acquired reclaimed worktree from pool: ${worktreePath} (${prepared.strandedCommitCount ?? 0} commits preserved)`, undefined, runContext);
          } else if (branch !== branchName) {
            logger?.log(`Branch conflict resolved: using ${branch} instead of ${branchName}`);
            await store.logEntry(task.id, `Acquired worktree from pool: ${worktreePath} (branch conflict: using ${branch})`, undefined, runContext);
          } else {
            await store.logEntry(task.id, `Acquired worktree from pool: ${worktreePath}`, undefined, runContext);
          }
          const baseRefresh = await refreshExistingWorktree(worktreePath, "native");
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
            baseRefresh,
            reclaimed: prepared.reclaimed
              ? {
                  existingTipSha: prepared.existingTipSha,
                  strandedCommitCount: prepared.strandedCommitCount,
                }
              : undefined,
          });
        }
      } catch (poolErr) {
        if (poolAssignmentPersistenceStarted) {
          pool.release(pooled, task.id);
          throw poolErr;
        }
        if (poolErr instanceof WorktreeBaseRefreshError) {
          // FNXC:WorktreeBaseRefresh 2026-08-09-03:30: Clear every durable resume binding before returning the
          // checkout to the pool. If persistence fails, retain the lease so no other task can mutate it.
          await persistWorktreeAssignment({ worktree: null, branch: null, branchWriteOrigin: "engine" as const, sessionFile: null });
          pool.release(pooled, task.id);
          throw poolErr;
        }
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
  const created = await createWorktreeImpl(
    branchName,
    worktreePath,
    task.id,
    freshStartPoint,
    allowSiblingBranchRename,
    false,
    workingBranch.origin,
  );
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

export interface AcquireWorkspaceTaskWorktreesOptions {
  workspaceConfig: Pick<WorkspaceConfig, "repos">;
  workspaceRootDir: string;
  task: Task;
  store: TaskStore;
  settings: Partial<Settings>;
  logger?: AcquireWorkspaceRepoWorktreeOptions["logger"];
  secretsStore?: AcquireWorkspaceRepoWorktreeOptions["secretsStore"];
  audit?: AcquireWorkspaceRepoWorktreeOptions["audit"];
  runContext?: RunMutationContext;
  registry?: ActiveSessionRegistry;
  runConfiguredCommand?: AcquireTaskWorktreeOptions["runConfiguredCommand"];
  taskEnv?: NodeJS.ProcessEnv;
  addActiveWorktree?: (taskId: string, path: string) => void;
  /** Limit acquisition to the confirmed repository scope; omitted retains the declared manifest. */
  repoRelPaths?: readonly string[];
  holderLiveProbe?: AcquireWorkspaceRepoWorktreeOptions["holderLiveProbe"];
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
  /**
   * Proves a foreign acquisition holder is still alive. Ambiguous/throwing probes
   * deliberately read live so a cache reclaim never steals a real critical section.
   */
  holderLiveProbe?: (holderTaskId: string, path: string) => boolean;
  runConfiguredCommand?: AcquireTaskWorktreeOptions["runConfiguredCommand"];
  taskEnv?: NodeJS.ProcessEnv;
  /**
   * FNXC:WorkspaceWorktree 2026-08-20-06:26:34: Revalidate caller-owned admission policy immediately
   * before worktree creation. The callback runs under the TaskStore's local mutex and durable task
   * advisory transaction lock.
   */
  validateTaskBeforeCreate?: (freshTask: Task) => Promise<void>;
  /** Explicit destination used by a workspace task-directory acquisition. */
  worktreePath?: string;
}

/*
FNXC:WorkspaceWorktree 2026-06-22-00:00:
`repoRelPath` is an exported, caller-trusted parameter that is joined onto `workspaceRootDir`.
An absolute path or a `..` escape (`../outside`) would resolve a worktree outside the workspace
root. Validate it is a normalized, relative, in-root path before resolving the absolute path.
*/
function assertInRootRepoRelPath(repoRelPath: string): void {
  assertWorkspaceRepoRelPath(repoRelPath);
}

/*
FNXC:WorkspaceWorktree 2026-08-20-07:02:
Both the caller snapshot and the task-locked re-read must apply the same remembered-worktree
liveness contract. Path existence alone is insufficient because a pruned or interrupted checkout
can leave a directory that is no longer a registered, usable git worktree.
*/
async function isRememberedWorkspaceWorktreeLive(repoRootDir: string, worktreePath: string): Promise<boolean> {
  if (!existsSync(worktreePath)) return false;
  try {
    return (await classifyTaskWorktree(repoRootDir, worktreePath)).ok;
  } catch {
    return false;
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
  const { repoRelPath, workspaceRootDir, task, store, settings, logger, secretsStore, audit, runContext, runConfiguredCommand, taskEnv, validateTaskBeforeCreate } = opts;
  const registry = opts.registry ?? activeSessionRegistry;
  const { join } = await import("node:path");

  // FNXC:WorkspaceWorktree 2026-06-22-00:00: reject absolute / `..`-escaping repo paths before resolving.
  assertInRootRepoRelPath(repoRelPath);
  const repoAbsPath = join(workspaceRootDir, repoRelPath);

  let durableAcquireLease: WorkspaceLeaseHandle | undefined;
  let acquireLeaseLost = false;
  let acquireLeaseRenewalInFlight: Promise<void> | undefined;
  let acquireLeaseRenewalTimer: ReturnType<typeof setInterval> | undefined;

  const assertAcquireLeaseLive = (): void => {
    if (acquireLeaseLost) {
      throw new WorkspacePreparationError(repoRelPath, "acquire", "durable workspace acquire lease renewal was lost");
    }
  };

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
    const live = await isRememberedWorkspaceWorktreeLive(repoAbsPath, existing.worktreePath);
    if (live) {
      return { ...existing, alreadyAcquired: true };
    }
    logger?.warn(`${task.id}: remembered workspace worktree for ${repoRelPath} is missing/unusable (${existing.worktreePath}); re-acquiring`);
    await store.logEntry(task.id, `Remembered workspace worktree for ${repoRelPath} is no longer usable; re-acquiring`, existing.worktreePath, runContext);
  }

  /*
  FNXC:WorkspaceWorktree 2026-08-23-06:25:
  The durable acquire lease is the sole cross-process admission authority. It is
  renewed while legitimate preparation runs; the local registry is only a derived
  same-process guard and must never outlive a lost or released lease.
  */
  try {
    const acquireWorkspaceLease = (store as Partial<TaskStore>).acquireWorkspaceLease;
    /*
    FNXC:Workspace 2026-08-15-08:47:
    Production TaskStore instances always expose the durable API. Structural
    in-memory test stores predate it and remain single-process fixtures, so they
    retain the registry fast path; a present API that errors still fails closed.
    */
    if (typeof acquireWorkspaceLease === "function") {
      const claim = await acquireWorkspaceLease.call(store, {
        leaseKey: `repo:${repoRelPath}`,
        kind: "acquire",
        owner: { taskId: task.id, nodeId: resolveEngineNodeId(), incarnationId: resolveEngineIncarnationId() },
        leaseMs: 5 * 60_000,
      });
      if (claim.outcome === "conflict") {
        throw new WorkspaceRepoAcquireBusyError(repoRelPath, claim.conflict.taskId, task.id);
      }
      durableAcquireLease = claim.handle;
      const renewWorkspaceLease = (store as Partial<TaskStore>).renewWorkspaceLease;
      if (typeof renewWorkspaceLease === "function") {
        const renew = async (): Promise<void> => {
          if (!durableAcquireLease || acquireLeaseLost) return;
          try {
            const renewed = await renewWorkspaceLease.call(store, durableAcquireLease, 5 * 60_000);
            if (!renewed) throw new Error("Workspace acquire lease renewal was refused");
            durableAcquireLease = renewed;
          } catch {
            acquireLeaseLost = true;
          }
        };
        acquireLeaseRenewalTimer = setInterval(() => {
          if (!acquireLeaseRenewalInFlight) {
            acquireLeaseRenewalInFlight = renew().finally(() => { acquireLeaseRenewalInFlight = undefined; });
          }
        }, 60_000);
        acquireLeaseRenewalTimer.unref?.();
      }
    }
  } catch (error) {
    if (error instanceof WorkspaceRepoAcquireBusyError) throw error;
    // The database is authoritative for cross-node claims; unknown must never degrade to no holder.
    throw new WorkspaceRepoAcquireBusyError(repoRelPath, "durable-workspace-lease", task.id);
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
  /*
  FNXC:WorkspaceWorktree 2026-08-23-06:25:
  Keep the local check/register decision synchronous (F9), but make it a derived
  cache gate. The durable lease has already decided cross-process admission; this
  guard only prevents two same-process calls interleaving in this JavaScript turn.
  A missing or throwing liveness probe is deliberately live/fail-closed.
  */
  const holderLiveProbe = (holderTaskId: string, path: string): boolean => {
    try {
      return opts.holderLiveProbe?.(holderTaskId, path) ?? executingTaskLock.has(holderTaskId);
    } catch {
      return true;
    }
  };
  let registryClaim = acquireActiveSessionPath(registry, repoAbsPath, {
    taskId: task.id,
    kind: "workspace-repo-acquire",
    ownerKey: WORKSPACE_REPO_ACQUIRE_OWNER_KEY,
  }, {
    holderLiveProbe,
    restrictReclaimToKind: "workspace-repo-acquire",
  });

  /*
  FNXC:WorkspaceWorktree 2026-08-23-06:51 (FN-179):
  A successful durable acquire lease proves that any same-kind local entry is a
  stale cache, even when its liveness probe is conservatively LIVE. Never let the
  cache veto the authority; retain the cross-kind land fence so acquire cannot
  clobber a live merge claim on the same repository path.
  */
  if (durableAcquireLease && registryClaim.action === "contended" && registryClaim.holderKind === "workspace-repo-acquire") {
    const staleHolderTaskId = registryClaim.holderTaskId;
    const staleAgeMs = registryClaim.ageMs;
    registry.unregisterPath(repoAbsPath);
    registryClaim = acquireActiveSessionPath(registry, repoAbsPath, {
      taskId: task.id,
      kind: "workspace-repo-acquire",
      ownerKey: WORKSPACE_REPO_ACQUIRE_OWNER_KEY,
    }, {
      holderLiveProbe,
      restrictReclaimToKind: "workspace-repo-acquire",
    });
    void emitBoundedRunAudit(store, {
      taskId: task.id,
      agentId: runContext?.agentId ?? "workspace-acquire",
      runId: runContext?.runId ?? generateSyntheticRunId("workspace-acquire", task.id),
      domain: "git",
      mutationType: "worktree:workspace-repo-acquire-reclaimed",
      target: repoRelPath,
      metadata: { taskId: task.id, repoRelPath, holderTaskId: staleHolderTaskId, ageMs: staleAgeMs, outcome: "lease-authority" },
    });
  }
  if (registryClaim.action === "contended") {
    const err = new WorkspaceRepoAcquireBusyError(repoRelPath, registryClaim.holderTaskId, task.id);
    try {
      const message = `sub-repo ${repoRelPath} is being acquired by ${registryClaim.holderTaskId}; serializing concurrent workspace acquisition`;
      logger?.warn(`${task.id}: ${message}`);
      await store.logEntry(task.id, message, undefined, runContext);
      await audit?.git({
        type: "worktree:workspace-repo-acquire-busy",
        target: repoAbsPath,
        metadata: { repoRelPath, holderTaskId: registryClaim.holderTaskId, requestingTaskId: task.id },
      });
    } catch {
      // best-effort observability only — never mask the busy error
    }
    if (durableAcquireLease) await store.releaseWorkspaceLease(durableAcquireLease).catch(() => undefined);
    throw err;
  }

  try {
    /*
    FNXC:Workspace 2026-08-15-04:28:
    No persisted intermediate state may make a workspace task read as single-repo. Dashboard
    `isWorkspaceTask`, self-healing sweeps, and executor `hadAssignedWorktree` all read this row,
    so suppress singular persistence as well as stripping the helper's in-memory task copy.

    FNXC:WorkspaceWorktree 2026-06-21-19:05:
    Workspace mode acquires one worktree per sub-repo for a single task. `acquireTaskWorktree`
    is single-repo: it reads `task.worktree`/`task.branch` to decide resume-vs-fresh. Passing the
    live task through means a later repo can reuse the first repo's worktree. Clear singular fields
    on the copy so every sub-repo acquires freshly; per-repo state is `task.workspaceWorktrees`.
    */
    /*
    FNXC:Workspace 2026-08-20-00:56:
    executionStartBranch belongs to the root-repository dependency chain and can be a fusion/fn-*
    sibling absent from this sub-repo. Resolve task.baseBranch per repo instead, then overwrite the
    copied task's start point so acquireTaskWorktree never forwards that sibling ref to git worktree add.
    */
    let acquisitionResult: { worktreePath: string; branch: string; baseCommitSha?: string; alreadyAcquired: boolean } | undefined;
    let baseResolution: Awaited<ReturnType<typeof resolveWorkspaceRepoBaseBranch>> | undefined;
    const deferredTaskMutations: Array<() => Promise<unknown>> = [];
    let mergeError: unknown;
    try {
      await store.mergeWorkspaceWorktreeEntry(
        task.id,
        repoRelPath,
        async (freshTask) => {
          /*
          FNXC:WorkspaceWorktree 2026-08-20-06:26:34: The per-repository lock is already held.
          mergeWorkspaceWorktreeEntry adds the TaskStore's in-process mutex and PostgreSQL task
          advisory transaction lock, the same lock lifecycle moves use. Revalidate after both locks
          are held, then keep them through creation and persistence. The acquisition helper normally
          logs through TaskStore and may request metadata cleanup; defer those lock-taking mutations
          until this callback releases the non-reentrant task lock.
          */
          const callbackStore = new Proxy(store, {
            get(target, property) {
              if (property === "logEntry") {
                return async (...args: Parameters<TaskStore["logEntry"]>): Promise<void> => {
                  deferredTaskMutations.push(() => store.logEntry(...args));
                };
              }
              if (property === "updateTask") {
                return async (...args: Parameters<TaskStore["updateTask"]>): Promise<void> => {
                  const [id, patch] = args;
                  if (id !== task.id) throw new Error(`Workspace acquisition attempted to mutate unexpected task ${id}`);
                  deferredTaskMutations.push(() => store.updateTask(...args));
                  Object.assign(freshTask, patch);
                };
              }
              if (property === "pauseTask") {
                return async (...args: Parameters<TaskStore["pauseTask"]>): Promise<Task> => {
                  const [id, paused] = args;
                  if (id !== task.id) throw new Error(`Workspace acquisition attempted to pause unexpected task ${id}`);
                  deferredTaskMutations.push(() => store.pauseTask(...args));
                  Object.assign(freshTask, { paused });
                  return freshTask;
                };
              }
              const value = Reflect.get(target, property, target);
              if (typeof value !== "function") return value;
              if (property === "getTask") return value.bind(target);
              /*
              FNXC:WorkspaceWorktree 2026-08-20-07:02:
              The acquisition callback holds a non-reentrant task lock. Forwarding a newly added
              TaskStore method by default could silently reintroduce same-task deadlock, so only the
              audited read seam is forwarded and every other method fails closed until classified.
              */
              return async (): Promise<never> => {
                throw new Error(`Workspace acquisition cannot call unsupported TaskStore method ${String(property)} while the task lock is held`);
              };
            },
          }) as TaskStore;

          const concurrentExisting = freshTask.workspaceWorktrees?.[repoRelPath];
          if (concurrentExisting && await isRememberedWorkspaceWorktreeLive(repoAbsPath, concurrentExisting.worktreePath)) {
            acquisitionResult = { ...concurrentExisting, alreadyAcquired: true };
            return concurrentExisting;
          }

          await validateTaskBeforeCreate?.(freshTask);
        const resolvedBase = await resolveWorkspaceRepoBaseBranch({
      mode: "acquire",
      repoRootDir: repoAbsPath,
      repoRelPath,
      task: freshTask,
      settings,
      logger,
    });
        baseResolution = resolvedBase;
    /*
    FNXC:WorkspaceBranches 2026-08-20-03:38:
    FN-9161 uses one explicit operator branch in every workspace repository.
    Keep only that branch through the singular-worktree isolation copy; derived
    and canonical assignments retain the existing per-repository behavior.
    */
    const workspaceWorkingBranch = resolveTaskWorkingBranchWithOrigin(freshTask);
    const result = await acquireTaskWorktree({
      task: {
        ...freshTask,
        worktree: opts.worktreePath,
        branch: workspaceWorkingBranch.origin === "operator-supplied" ? workspaceWorkingBranch.branch : undefined,
        executionStartBranch: resolvedBase.branch,
      },
      suppressSingularWorktreePersist: true,
      workspaceContext: { workspaceRootDir, repoRelPath },
      forceWorktreePath: Boolean(opts.worktreePath),
      rootDir: repoAbsPath,
      store: callbackStore,
      // FNXC:Workspace 2026-07-07-08:40 (FN-7360 regression — strip shared branch overrides for per-repo start-point):
      // FN-7360 pinned fresh task worktree creation to `resolveIntegrationBranch(rootDir, settings)`
      // when no executionStartBranch is present, so new branches never inherit an ambient root HEAD.
      // For a workspace sub-repo, `settings` carries the SHARED project integrationBranch/baseBranch;
      // honoring it resolves a branch absent from this sub-repo and fails `git worktree add` with
      // "invalid reference". Keep both overrides stripped: the per-repository resolver above
      // has already verified this repo's base and supplies it as executionStartBranch.
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
        expectedBranch: result.branch,
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
        await callbackStore.logEntry(task.id, `Workspace sub-repo identity-guard install failed for ${repoRelPath} (non-fatal): ${message}`, undefined, runContext);
        await audit?.git({
          type: "worktree:workspace-repo-acquire-failed",
          target: repoAbsPath,
          metadata: { repoRelPath, taskId: task.id, error: message, stage: "identity-guard" },
        });
      });
    }

    /*
    FNXC:Workspace 2026-06-21-20:10:
    Per-repo base SHA (KTD3): capture against the same verified per-repository base used to
    create this worktree. This keeps the fork point and contamination anchor aligned while the
    resolver retains the FN-7360 fallback to this repo's own integration branch.
    */
    let baseCommitSha: string | undefined;
    try {
      baseCommitSha = await resolveCapturedBaseCommitSha(result.worktreePath, logger, resolvedBase.branch);
    } catch (baseErr) {
      // FNXC:Workspace 2026-06-21-22:30: F3 — base-SHA capture is non-fatal; an undefined baseCommitSha is an accepted state.
      // FNXC:Workspace 2026-06-22-00:00: guard the best-effort logEntry/audit so a logging throw cannot promote this
      // non-fatal capture failure into a fatal acquisition failure (parity with the F6 busy-path defensive wrap).
      const message = baseErr instanceof Error ? baseErr.message : String(baseErr);
      logger?.warn(`${task.id}: base-SHA capture failed for sub-repo ${repoRelPath} (non-fatal): ${message}`);
      // FNXC:Workspace 2026-06-22-09:00: same non-fatal contract as the identity-guard catch —
      // the awaited observability writes must not re-escalate a non-fatal base-capture failure.
      await safeObserve(async () => {
        await callbackStore.logEntry(task.id, `Workspace sub-repo base-SHA capture failed for ${repoRelPath} (non-fatal): ${message}`, undefined, runContext);
        await audit?.git({
          type: "worktree:workspace-repo-acquire-failed",
          target: repoAbsPath,
          metadata: { repoRelPath, taskId: task.id, error: message, stage: "base-sha-capture" },
        });
      });
    }

    /*
    FNXC:Workspace 2026-08-15-07:51:
    F5 Phase B is implemented by mergeWorkspaceWorktreeEntry: its advisory-locked,
    per-key database merge retains sibling sub-repo entries across concurrent processes.
    Do not restore a wholesale workspaceWorktrees update here; that reopens the silent
    sibling-clobber race which leaves an on-disk worktree invisible to workspace landing.
    */
    /*
    FNXC:Workspace 2026-08-15-04:28:
    F10 — this is the one durable acquisition-state write. The helper suppresses every earlier
    singular assignment, so null worktree/branch are an idempotent defensive re-assertion rather
    than cleanup after a visible pollution window. A failed write leaves the row unchanged and
    never makes dashboard workspace rendering, self-healing, or executor dispatch read it as
    single-repo.
    */
        assertAcquireLeaseLive();
        acquisitionResult = {
          worktreePath: result.worktreePath,
          branch: result.branch,
          baseCommitSha,
          alreadyAcquired: false,
        };
        return {
          worktreePath: result.worktreePath,
          branch: result.branch,
          baseCommitSha,
          ...(resolvedBase.requested
            ? {
                baseBranch: resolvedBase.branch,
                ...(resolvedBase.fallbackReason ? { baseBranchFallbackFrom: resolvedBase.requested } : {}),
              }
            : {}),
        };
        },
        {
          clearSingularWorktree: true,
          /*
          FNXC:WorkspaceWorktree 2026-08-23-08:12:
          The callback's earlier check cannot fence an interval renewal that loses its lease
          while the persist transaction awaits I/O. Re-check at the transaction's existing
          lifecycle-validation seam immediately before the fresh-row update publishes this entry.
          */
          validateBeforePersist: async (current) => {
            assertAcquireLeaseLive();
            await validateTaskBeforeCreate?.(current);
          },
        },
      );
    } catch (error) {
      mergeError = error;
    }
    let deferredMutationError: unknown;
    try {
      for (const mutation of deferredTaskMutations) await mutation();
    } catch (error) {
      deferredMutationError = error;
    }
    if (mergeError) {
      /*
      FNXC:WorkspaceWorktree 2026-08-20-07:08:
      A cross-process lifecycle move can win while filesystem preparation runs outside the database
      transaction. If authoritative pre-persist validation then refuses the row update, remove only
      the newly created, not-yet-published worktree so the rejected acquisition cannot leave an orphan.
      */
      if (acquisitionResult && !acquisitionResult.alreadyAcquired) {
        await removeWorktree({
          rootDir: repoAbsPath,
          worktreePath: acquisitionResult.worktreePath,
          settings,
          reason: RemovalReason.WorkspaceAcquireRollback,
          taskId: task.id,
          force: true,
        }).catch((cleanupError: unknown) => {
          logger?.warn(`${task.id}: failed to roll back rejected workspace acquisition at ${acquisitionResult?.worktreePath}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
        });
      }
      throw mergeError;
    }
    if (deferredMutationError) throw deferredMutationError;
    if (!acquisitionResult) {
      throw new Error(`Workspace sub-repo acquisition for ${repoRelPath} completed without a durable result`);
    }
    if (acquisitionResult.alreadyAcquired) return acquisitionResult;
    if (!baseResolution) {
      throw new Error(`Workspace sub-repo acquisition for ${repoRelPath} completed without a base resolution`);
    }
    await recordWorkspaceBaseBranchDecision({
      store,
      audit,
      task,
      repoRelPath,
      repoAbsPath,
      resolution: baseResolution,
      stage: "acquire",
      runContext,
    });

    assertAcquireLeaseLive();
    return acquisitionResult;
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
    if (err instanceof WorkspaceRepoAcquireBusyError || err instanceof WorkspacePreparationError) throw err;
    throw new WorkspacePreparationError(
      repoRelPath,
      "acquire",
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    if (acquireLeaseRenewalTimer) clearInterval(acquireLeaseRenewalTimer);
    await acquireLeaseRenewalInFlight?.catch(() => undefined);
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
    if (durableAcquireLease) {
      await store.releaseWorkspaceLease(durableAcquireLease).catch((releaseError: unknown) => {
        logger?.warn(`${task.id}: durable workspace acquire lease release refused: ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`);
      });
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
/*
 * FNXC:WorkspacePreparation 2026-08-21-19:39:
 * A Git/base-ref failure while acquiring a workspace repository is environment preparation,
 * not a reviewer/provider failure. Preserve the repository and original Git cause so graph
 * routing can recover without spending a model retry budget.
 */
export class WorkspacePreparationError extends Error {
  constructor(
    public readonly repoRelPath: string,
    public readonly stage: "acquire",
    public readonly causeMessage: string,
  ) {
    super(`Workspace repository preparation failed for ${repoRelPath} during ${stage}: ${causeMessage}`);
    this.name = "WorkspacePreparationError";
  }
}

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

/**
 * FNXC:WorkspaceRootRouting 2026-08-19-12:15:
 * A workspace task needs a complete durable per-repository worktree set before any planning,
 * execution, or review session starts. Acquire/reuse only the declared repositories, register each
 * real sub-repository path, and return one deterministic coordinator cwd; never synthesize a root
 * worktree or use the non-Git workspace directory as a session fallback.
 */
export async function acquireWorkspaceTaskWorktrees(
  opts: AcquireWorkspaceTaskWorktreesOptions,
): Promise<{ task: Task; taskWorktreeDir: string }> {
  const repoRelPaths = [...new Set(opts.repoRelPaths ?? opts.workspaceConfig.repos)];
  if (repoRelPaths.length === 0) {
    throw new Error(`Workspace task ${opts.task.id} has no declared repositories`);
  }
  if (repoRelPaths.some((repoRelPath) => !opts.workspaceConfig.repos.includes(repoRelPath))) {
    throw new Error(`Workspace task ${opts.task.id} requested an undeclared repository`);
  }

  let current = await normalizeWorkspaceTaskRouting(opts.store, opts.task.id);
  // Validate a durable remediation target without allowing it to choose session cwd.
  resolveWorkspaceReviewRemediationRepository(current, repoRelPaths);
  const taskWorktreeDir = resolveWorkspaceTaskWorktreeDir(opts.workspaceRootDir, opts.settings, current.id);
  const legacyLayout = isLegacyWorkspaceWorktreeLayout(current, taskWorktreeDir);
  if (!legacyLayout) await mkdir(taskWorktreeDir, { recursive: true });

  for (const repoRelPath of repoRelPaths) {
    const acquired = await acquireWorkspaceRepoWorktree({
      repoRelPath,
      workspaceRootDir: opts.workspaceRootDir,
      task: current,
      store: opts.store,
      settings: opts.settings,
      logger: opts.logger,
      secretsStore: opts.secretsStore,
      audit: opts.audit,
      runContext: opts.runContext,
      registry: opts.registry,
      holderLiveProbe: opts.holderLiveProbe,
      runConfiguredCommand: opts.runConfiguredCommand,
      taskEnv: opts.taskEnv,
      worktreePath: legacyLayout ? undefined : resolveWorkspaceRepoWorktreePath(taskWorktreeDir, repoRelPath),
    });
    opts.addActiveWorktree?.(opts.task.id, acquired.worktreePath);
    current = await opts.store.getTask(opts.task.id);
  }

  if (legacyLayout) {
    // FNXC:WorkspaceWorktree 2026-08-22-22:05: In-flight legacy tasks keep their
    // persisted positional session root so one task never straddles layouts.
    const legacySessionRoot = opts.workspaceConfig.repos
      .map((repoRelPath) => current.workspaceWorktrees?.[repoRelPath]?.worktreePath)
      .find((path): path is string => typeof path === "string" && path.length > 0);
    if (!legacySessionRoot) throw new Error(`Legacy workspace task ${current.id} has no acquired repository worktree`);
    return { task: current, taskWorktreeDir: legacySessionRoot };
  }
  return { task: current, taskWorktreeDir };
}
