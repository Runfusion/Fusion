import { exec, execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { access, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import type { Settings, WorktreeContentClassification } from "@fusion/core";
import {
  activeSessionRegistry,
  reconcileSelfOwnedActiveSessionForRemoval,
  type LiveBindingProbe,
  type ProcessActiveProbe,
} from "../agents/active-session-registry.js";
import type { RunAuditor } from "../util/run-audit.js";
import { resolveTaskWorktreePath } from "./worktree-paths.js";
import { inspectBareBranchCollision, inspectBranchConflict } from "../execution/branch-conflicts.js";
import { resolveIntegrationBranch } from "../merge/integration-branch.js";
import { formatError } from "../logger.js";
import { installTaskWorktreeIdentityGuard } from "./worktree-hooks.js";
import { pruneWorktreeAdminEntries } from "./worktree-prune.js";
import { isRetryableRemovalError, removeDirectoryWithRetry } from "./worktree-removal-retry.js";
import {
  StaleWorktreeIndexLockError,
  classifyStaleLock,
  parseIndexLockPath,
  tryRemoveStaleLock,
} from "./worktree-stale-lock.js";
import { parseStaleRegistrationPath, recoverStaleRegistration } from "./worktree-stale-registration.js";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const NATIVE_TIMEOUT_MS = 120_000;
const REMOVE_TIMEOUT_MS = 60_000;
const MAX_BUFFER = 10 * 1024 * 1024;


export type WorktreeRemoveOutcome =
  | { removed: true; classification: "removed" }
  | {
      removed: false;
      harmless: true;
      classification: "not-registered-after-prune";
      message: string;
      stderrPreview: string;
      pathExists: boolean;
      gitFileExists: boolean;
    };

const HARMLESS_MERGE_REMOVE_ERROR_PATTERNS = [
  /validation failed, cannot remove working tree/i,
  /is not a \.git file/i,
  /is not a working tree/i,
  /not a git repository/i,
  /No such file or directory/i,
] as const;

function previewError(error: unknown): string {
  const stderr = getErrorStderr(error);
  const message = error instanceof Error ? error.message : String(error);
  return (stderr || message).slice(0, 4096);
}

function normalizeComparablePath(value: string): string {
  const resolved = resolve(value);
  return resolved.startsWith("/private/var/") ? resolved.slice("/private".length) : resolved;
}

function porcelainContainsWorktree(stdout: string, worktreePath: string): boolean {
  const target = normalizeComparablePath(worktreePath);
  const privateTarget = target.startsWith("/var/") ? `/private${target}` : target;
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    const candidate = normalizeComparablePath(line.slice("worktree ".length).trim());
    if (candidate === target || candidate === privateTarget) return true;
  }
  return false;
}

function isMergeTempCleanupCandidate(input: { worktreePath: string; reason: RemovalReason }, error: unknown): boolean {
  if (input.reason !== RemovalReason.MergerCleanup && input.reason !== RemovalReason.MergerPostMerge) return false;
  const base = basename(input.worktreePath);
  const looksLikeFusionMergeTemp = base.startsWith("fusion-ai-merge-") || base.startsWith("post-merge-");
  if (!looksLikeFusionMergeTemp) return false;
  const detail = previewError(error);
  return HARMLESS_MERGE_REMOVE_ERROR_PATTERNS.some((pattern) => pattern.test(detail));
}

async function classifyHarmlessMergeRemoveFailure(input: {
  rootDir: string;
  worktreePath: string;
  reason: RemovalReason;
  taskId?: string;
  audit?: RunAuditor;
}, error: unknown): Promise<WorktreeRemoveOutcome | null> {
  if (!isMergeTempCleanupCandidate(input, error)) return null;

  const stderrPreview = previewError(error);
  const pathExists = existsSync(input.worktreePath);
  const gitFileExists = existsSync(resolve(input.worktreePath, ".git"));

  let stdout: string;
  try {
    await execAsync("git worktree prune", {
      cwd: input.rootDir,
      encoding: "utf-8",
      timeout: NATIVE_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    });

    const listResult = await execAsync("git worktree list --porcelain", {
      cwd: input.rootDir,
      encoding: "utf-8",
      timeout: 10_000,
      maxBuffer: MAX_BUFFER,
    });
    stdout = typeof listResult === "string" ? listResult : String(listResult.stdout ?? "");
  } catch (probeError) {
    await input.audit?.git({
      type: "worktree:remove-classification-probe-failed",
      target: input.worktreePath,
      metadata: {
        taskId: input.taskId,
        reason: input.reason,
        stderrPreview,
        probeError: previewError(probeError),
        pathExists,
        gitFileExists,
      },
    });
    return null;
  }
  const registeredAfterPrune = porcelainContainsWorktree(stdout, input.worktreePath);

  if (registeredAfterPrune) {
    await input.audit?.git({
      type: "worktree:remove-leaked-registered-worktree",
      target: input.worktreePath,
      metadata: {
        taskId: input.taskId,
        reason: input.reason,
        registeredAfterPrune: true,
        stderrPreview,
        pathExists,
        gitFileExists,
      },
    });
    return null;
  }

  const message = pathExists
    ? "cleanup remove failed, but no registered worktree remains after prune; leftover directory was not deleted automatically"
    : "cleanup remove failed, but no registered worktree remains after prune";
  await input.audit?.git({
    type: "worktree:remove-classified-harmless",
    target: input.worktreePath,
    metadata: {
      taskId: input.taskId,
      reason: input.reason,
      classification: "not-registered-after-prune",
      registeredAfterPrune: false,
      stderrPreview,
      pathExists,
      gitFileExists,
      nextAction: pathExists
        ? "inspect the leftover temp directory before deleting filesystem residue"
        : "no operator action required",
    },
  });

  return {
    removed: false,
    harmless: true,
    classification: "not-registered-after-prune",
    message,
    stderrPreview,
    pathExists,
    gitFileExists,
  };
}

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
  /** FNXC:WorkspaceBranches 2026-08-20-03:38: provenance controls safe existing-branch attachment. */
  branchOrigin?: "engine-canonical" | "group-derived" | "operator-supplied";
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
  force?: boolean;
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

const WORKTREE_BACKEND_MARKER = "fusion-worktree-backend-kind";

/*
FNXC:WorktreeBackend 2026-10-04-14:56:
Backend-marker discovery is a managed Git subprocess and must remain bounded like every other
worktree operation so a locked or unavailable checkout cannot retain lifecycle cleanup forever.
*/
async function resolveWorktreeBackendMarkerPath(worktreePath: string): Promise<string> {
  const { stdout } = await execAsync(`git rev-parse --git-path ${JSON.stringify(WORKTREE_BACKEND_MARKER)}`, {
    cwd: worktreePath,
    encoding: "utf-8",
    /*
    FNXC:WorktreeBackend 2026-10-04-14:56 (upstream, kept deliberately over NATIVE_TIMEOUT_MS):
    Backend-marker discovery is a managed Git subprocess and must stay bounded like every other worktree
    operation, so a locked or unavailable checkout cannot retain lifecycle cleanup. NATIVE_TIMEOUT_MS is
    the long-running worktree budget and belongs to the other call sites in this file, not to a probe
    whose only job is to answer or fail fast.
    */
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  const markerPath = stdout.trim();
  return isAbsolute(markerPath) ? markerPath : resolve(worktreePath, markerPath);
}

export async function persistWorktreeBackendKind(
  worktreePath: string,
  backendKind: WorktreeBackend["kind"],
): Promise<void> {
  await writeFile(await resolveWorktreeBackendMarkerPath(worktreePath), `${backendKind}\n`, "utf-8");
}

export async function readPersistedWorktreeBackendKind(
  worktreePath: string,
): Promise<WorktreeBackend["kind"] | undefined> {
  try {
    const backendKind = (await readFile(await resolveWorktreeBackendMarkerPath(worktreePath), "utf-8")).trim();
    return backendKind === "native" || backendKind === "worktrunk" ? backendKind : undefined;
  } catch {
    return undefined;
  }
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

function getErrorMessageWithStderr(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : error && typeof error === "object" && "message" in error
        ? String((error as { message?: unknown }).message)
        : String(error);
  const stderr = getErrorStderr(error);
  return stderr ? `${message}\n${stderr}` : message;
}

function isRecoverableNativeWorktreeRemoveError(error: unknown): boolean {
  const message = getErrorMessageWithStderr(error);
  return isRetryableRemovalError(error) || /Directory not empty/i.test(message) || /failed to delete/i.test(message) || /contains modified or untracked files/i.test(message);
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

/*
FNXC:ZeroCommitLandingProof 2026-09-25-11:17 (RUFU-274):
RUFU-274 needs to answer "did any checkout of this repository still hold this card's branch?" before
it can call a worktree's content absent: the recorded path being gone is only half of
`provably gone`, and a branch checked out in a second worktree means the content still exists.
Existed privately inside the native backend's registration scan; exported so the landing-proof
classifier reads the same registry the backend maintains rather than a second `git worktree list`
interpretation.
*/
/** Every checkout registered in `repoDir`, with the local branch it has checked out when one does. */
export async function listWorktreeRegistrations(repoDir: string): Promise<Array<{ path: string; branch?: string }>> {
  const { stdout } = await execFileAsync("git", ["worktree", "list", "--porcelain"], {
    cwd: repoDir,
    encoding: "utf-8",
    timeout: 15_000,
    maxBuffer: MAX_BUFFER,
  });
  return parseWorktreesFromPorcelain(stdout);
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
      settings?: Partial<Pick<Settings, "worktreesDir" | "commitMsgHookEnabled" | "taskPrefix" | "taskAttributionTrailerNames" | "commitAuthorEnabled" | "commitAuthorName" | "commitAuthorEmail">>;
      audit?: Pick<RunAuditor, "git">;
    } = {},
  ) {}

  async create(input: WorktreeCreateInput): Promise<WorktreeCreateResult> {
    const startArg = input.startPoint ? ` ${quoteShellArg(input.startPoint)}` : "";
    const installGuardOrCleanup = async (worktreePath: string, expectedBranch: string) => {
      try {
        await installTaskWorktreeIdentityGuard({
          worktreePath,
          taskId: input.taskId,
          // The hook must follow the branch Git actually checked out: sibling collision recovery can rename it.
          expectedBranch,
          commitMsgHookEnabled: this.deps.settings?.commitMsgHookEnabled,
          taskPrefix: this.deps.settings?.taskPrefix,
          taskAttributionTrailerName: this.deps.settings?.taskAttributionTrailerNames?.[0],
          commitAuthorEnabled: this.deps.settings?.commitAuthorEnabled,
          commitAuthorName: this.deps.settings?.commitAuthorName,
          commitAuthorEmail: this.deps.settings?.commitAuthorEmail,
        });
      } catch (error) {
        await rm(worktreePath, { recursive: true, force: true }).catch(() => undefined);
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
    const attachExistingBranch = async (): Promise<WorktreeCreateResult> => {
      await execAsync(`git worktree add ${quoteShellArg(input.worktreePath)} ${quoteShellArg(input.branch)}`, {
        cwd: input.rootDir,
        encoding: "utf-8",
        timeout: NATIVE_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
      });
      return { path: input.worktreePath, branch: input.branch };
    };
    const cleanupPartialCollisionRecovery = async () => {
      await rm(input.worktreePath, { recursive: true, force: true }).catch(() => undefined);
      await pruneWorktreeAdminEntries({
        rootDir: input.rootDir,
        auditor: this.deps.audit,
        reason: "backend-branch-collision-recovery-failed",
        target: input.worktreePath,
        logger: this.deps.logger,
      }).catch(() => undefined);
    };

    let staleLockRecoveryAttempted = false;
    let staleRegistrationRecoveryAttempted = false;
    try {
      const created = await createWithBranch(input.branch);
      await installGuardOrCleanup(created.path, created.branch);
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
              await installGuardOrCleanup(created.path, created.branch);
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
            await installGuardOrCleanup(created.path, created.branch);
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
              await installGuardOrCleanup(created.path, created.branch);
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

      const isBareBranchCollision = /(?:a\s+)?branch named ["']?.+["']? already exists|branch ["']?.+["']? already exists/i.test(combinedErrorOutput);
      if (isBareBranchCollision) {
          /*
           * FNXC:WorkspaceBranches 2026-08-20-03:38:
           * FN-9161 preserves explicit operator branch ownership, including
           * Fusion-shaped names. Attach its existing bare branch directly;
           * Git still rejects a branch checked out by another live worktree.
           */
          if (input.branchOrigin === "operator-supplied") {
            try {
              const created = await attachExistingBranch();
              await installGuardOrCleanup(created.path, created.branch);
              await this.deps.audit?.git({
                type: "worktree:branch-collision-recovery",
                target: input.worktreePath,
                metadata: { taskId: input.taskId, disposition: "attach-operator-branch" },
              });
              return created;
            } catch (attachError) {
              await cleanupPartialCollisionRecovery();
              throw attachError;
            }
          }
          /*
           * FNXC:WorktreeAcquisition 2026-07-16-00:00:
           * FN-8132 / #2232 recovers only a bare branch-name collision after the
           * stale-lock and stale-registration ladder. A live foreign checkout still
           * fails even when this target path is absent. Unregistered branches are
           * attached only when every unique commit belongs to this task; merged or
           * empty branches are recreated from the caller-pinned startPoint, while
           * any foreign/unattributed (including mixed) history is never deleted.
           */
          const inspection = await inspectBareBranchCollision({
            repoDir: input.rootDir,
            branchName: input.branch,
            conflictingWorktreePath: input.worktreePath,
            requestingTaskId: input.taskId,
            startPoint: input.startPoint,
            integrationRef: await resolveIntegrationBranch(input.rootDir, undefined),
          });
          if (inspection.kind === "live-foreign") {
            await this.deps.audit?.git({
              type: "worktree:branch-collision-recovery",
              target: input.worktreePath,
              metadata: { taskId: input.taskId, disposition: "threw-live-foreign" },
            });
            throw inspection.error;
          }
          if (inspection.kind === "foreign-unmerged") {
            await this.deps.audit?.git({
              type: "worktree:branch-collision-recovery",
              target: input.worktreePath,
              /*
              FNXC:BranchPhantomEcho 2026-10-19-15:43 (RUFU-376):
              The refused destination stays recoverable here — this is the audit trail, the one surface
              the contract allows the requested path on — recorded under `desiredWorktreePath` and tagged
              `conflictShape: "bare-branch-collision"` so a reader knows no checkout was ever involved.
              No key naming a checkout location carries it: the error object this row accompanies now
              carries an empty `conflictingWorktreePath` for exactly that reason.
              */
              metadata: {
                taskId: input.taskId,
                disposition: "refused-foreign-unmerged",
                uniqueCommitCount: inspection.uniqueCommitCount,
                conflictShape: "bare-branch-collision",
                desiredWorktreePath: inspection.desiredWorktreePath,
              },
            });
            throw inspection.error;
          }
          if (inspection.kind === "reclaimable") {
            try {
              const created = await attachExistingBranch();
              await installGuardOrCleanup(created.path, created.branch);
              await this.deps.audit?.git({
                type: "worktree:branch-collision-recovery",
                target: input.worktreePath,
                metadata: { taskId: input.taskId, disposition: "reuse-existing-branch", uniqueCommitCount: inspection.uniqueCommitCount },
              });
              return created;
            } catch (recoveryError) {
              await cleanupPartialCollisionRecovery();
              throw recoveryError;
            }
          }
          if (inspection.kind === "tip-already-merged" || inspection.kind === "fully-subsumed") {
            try {
              await execAsync(`git branch -D ${quoteShellArg(input.branch)}`, {
                cwd: input.rootDir,
                encoding: "utf-8",
                timeout: NATIVE_TIMEOUT_MS,
                maxBuffer: MAX_BUFFER,
              });
              const created = await createWithBranch(input.branch);
              await installGuardOrCleanup(created.path, created.branch);
              await this.deps.audit?.git({
                type: "worktree:branch-collision-recovery",
                target: input.worktreePath,
                metadata: { taskId: input.taskId, disposition: "recreate-from-startpoint" },
              });
              return created;
            } catch (recoveryError) {
              await cleanupPartialCollisionRecovery();
              throw recoveryError;
            }
          }
      }

      if (!input.allowSiblingBranchRename) {
        throw error;
      }

      for (let suffix = 2; suffix <= 50; suffix += 1) {
        const candidateBranch = `${input.branch}-${suffix}`;
        try {
          const created = await createWithBranch(candidateBranch);
          await installGuardOrCleanup(created.path, created.branch);
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
          integrationRef: await resolveIntegrationBranch(input.rootDir, undefined),
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
    try {
      await execAsync(`git worktree remove${input.force === false ? "" : " --force"} ${quoteShellArg(input.worktreePath)}`, {
        cwd: input.rootDir,
        encoding: "utf-8",
        timeout: REMOVE_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
      });
      return;
    } catch (error) {
      const missingPathError = /is not a working tree|no such file or directory|does not exist/i.test(getErrorMessageWithStderr(error));
      /*
      FNXC:WorktreeReservationRecovery 2026-09-24-06:01:
      A missing pinned checkout with Git's matching unregistered-path response is
      already removed. Every caller, including forceful quarantine recovery, must
      prune stale administration and succeed without attempting filesystem deletion.
      */
      if (!existsSync(input.worktreePath) && missingPathError) {
        await pruneWorktreeAdminEntries({
          rootDir: input.rootDir,
          auditor: this.deps.audit,
          reason: "remove-missing-fallback",
          target: input.worktreePath,
          logger: this.deps.logger,
        });
        return;
      }
      // Defensive callers rely on Git's deletion-boundary dirty check. Never turn
      // that refusal into the recursive filesystem fallback below.
      if (input.force === false) {
        throw error;
      }
      if (!isRecoverableNativeWorktreeRemoveError(error)) {
        throw error;
      }

      const errorMessage = getErrorMessageWithStderr(error);
      this.deps.logger?.warn?.(
        `[worktree-backend] git worktree remove failed for ${input.worktreePath}: ${errorMessage} — falling back to filesystem removal`,
      );
      /*
      FNXC:WorktreeCleanup 2026-08-20-02:04:
      Native removal retains its non-recoverable Git-error throw contract (notably stale registrations). Once Git reports a recoverable filesystem failure, use the same bounded retry as clean rooms without changing this surface's single prune placement.
      */
      const removal = await removeDirectoryWithRetry({
        path: input.worktreePath,
        rm,
        log: (message) => this.deps.logger?.warn?.(`[worktree-backend] ${message}`),
      });
      await this.deps.audit?.git({
        type: "worktree:remove-fallback",
        target: input.worktreePath,
        metadata: {
          fallback: "filesystem-non-empty",
          error: errorMessage,
          ...(removal.removed ? {} : { attempts: removal.attempts, residual: true, registrationRetained: true }),
        },
      });
      if (!removal.removed) throw removal.lastFailure ?? new Error(removal.lastError ?? "filesystem removal failed");

      await pruneWorktreeAdminEntries({
        rootDir: input.rootDir,
        auditor: this.deps.audit,
        reason: "remove-non-empty-fallback",
        target: input.worktreePath,
        logger: this.deps.logger,
      });
    }
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
      settings?: Partial<Pick<Settings, "commitMsgHookEnabled" | "taskPrefix" | "taskAttributionTrailerNames" | "commitAuthorEnabled" | "commitAuthorName" | "commitAuthorEmail">>;
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
        expectedBranch: input.branch,
        commitMsgHookEnabled: this.deps.settings?.commitMsgHookEnabled,
        taskPrefix: this.deps.settings?.taskPrefix,
        taskAttributionTrailerName: this.deps.settings?.taskAttributionTrailerNames?.[0],
        commitAuthorEnabled: this.deps.settings?.commitAuthorEnabled,
        commitAuthorName: this.deps.settings?.commitAuthorName,
        commitAuthorEmail: this.deps.settings?.commitAuthorEmail,
      });
    } catch (error) {
      await rm(resolvedPath, { recursive: true, force: true }).catch(() => undefined);
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
      await this.runWorktrunk(["remove", "--foreground", ...(input.force === true ? ["--force"] : []), target], {
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
      const trunk = input.trunk ?? await resolveIntegrationBranch(input.rootDir, undefined);
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
  SelfHealingIdleSweep: "self-healing-idle-sweep",
  PoolPrune: "pool-prune",
  TaskReset: "task-reset",
  WorkspaceAcquireRollback: "workspace-acquire-rollback",
  CompletionLandedCleanup: "completion-landed-cleanup",
  TaskDeletion: "task-deletion",
  /*
  FNXC:OverlapAcquisitionPark 2026-11-04-01:25 (RUFU-373):
  Worktree acquisition refused to START execution (a file-scope predecessor had not delivered yet), so the
  checkout it had just registered holds no execution session and no task-authored content by construction.
  It is released with the same proof-gated authority the other no-owner reasons use, never with force.
  */
  AcquisitionRefused: "acquisition-refused",
} as const;

export type RemovalReason = typeof RemovalReason[keyof typeof RemovalReason];

/*
FNXC:TaskDeletionWorktrees 2026-09-07-12:00:
Explicit task deletion may force-discard a proven task-owned checkout, including dirty content, but it
never inherits executor teardown's authority to remove a currently registered session worktree.
*/
const ALLOWED_FORCE_REASONS = new Set<RemovalReason>([
  RemovalReason.HardCancel,
  RemovalReason.ExecutorDispose,
  RemovalReason.ExecutorTransientRetry,
  RemovalReason.ExecutorStuckKilled,
  RemovalReason.WorkspaceAcquireRollback,
  RemovalReason.TaskDeletion,
]);

const DEFENSIVE_REMOVAL_REASONS = new Set<RemovalReason>([
  RemovalReason.MergerCleanup,
  RemovalReason.MergerPostMerge,
  RemovalReason.PoolPrune,
  RemovalReason.SelfHealingBranchConflict,
  RemovalReason.SelfHealingIdleSweep,
  RemovalReason.SelfHealingReclaim,
  RemovalReason.SelfHealingStaleActiveBranch,
  RemovalReason.StepSessionCleanup,
  RemovalReason.CompletionLandedCleanup,
  // FNXC:OverlapAcquisitionPark 2026-11-04-01:25 (RUFU-373): a refusal-before-execution leaks nothing; see the reason's declaration.
  RemovalReason.AcquisitionRefused,
]);

const POST_LANDING_PROOF_REASONS = new Set<RemovalReason>([
  RemovalReason.CompletionLandedCleanup,
]);

export class InvalidForceUsageError extends Error {
  constructor(reason: RemovalReason) {
    super(`force=true is not allowed for removal reason '${reason}'`);
    this.name = "InvalidForceUsageError";
  }
}

export class InvalidPostLandingProofUsageError extends Error {
  constructor(reason: RemovalReason) {
    super(`postLandingProof is not allowed for removal reason '${reason}'`);
    this.name = "InvalidPostLandingProofUsageError";
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

/*
FNXC:WorktreeCleanup 2026-09-25-19:30:
A preservation refusal is a deliberate policy outcome, not a removal failure — but while both surface as a
bare `Error` no caller can tell them apart. RUFU-278 measured the cost: pinned-worktree reclaim terminalised
RUFU-260 over two *generated* git-ignored directories (`packages/core/.gate-bundle`,
`packages/dashboard/app/locales`), and that card's retained checkout then head-of-line blocked 14 other
RunFusion cards through the file-scope dispatch gate. The cap-enforcement sweep already treats the identical
condition as a no-op (`FNXC:WorktreeCleanup 2026-09-08-06:13`), so the policy was right and only the missing
type distinction was wrong. Callers that own a safe preserve path must discriminate by type: matching the
message would stop working the moment the wording changes, so the message text is preserved verbatim.
*/
export class WorktreeContentPreservationError extends Error {
  constructor(public readonly worktreePath: string) {
    super(`preserving ${worktreePath}: uncommitted or ignored content present`);
    this.name = "WorktreeContentPreservationError";
  }
}

/*
FNXC:WorktreeCleanup 2026-09-01-06:09:
FN-9233 permits automatic cleanup of only well-known regenerable dependency and build directories.
Ignored paths outside this narrow allowlist can contain operator-owned local content and retain FN-251's
proof gate; quoted porcelain paths are deliberately unparseable and therefore fail closed.
*/
/** Directory basenames whose ignored contents are reproducible project output. */
export const REGENERABLE_IGNORED_DIR_NAMES = new Set([
  "node_modules", "dist", "build", "out", "target", "bin", "obj", "coverage",
  ".next", ".nuxt", ".turbo", ".svelte-kit", ".parcel-cache", ".pytest_cache",
  ".mypy_cache", "__pycache__", ".gradle", ".venv", "venv",
]);

export type WorktreeRemovalContentClassification = "clean" | "regenerable-ignored" | "ignored-only" | "deliverable";

/*
FNXC:WorktreeCleanup 2026-09-08-06:13:
pnpm build writes .fusion/cache/plugin-build-cache.json, which made built task worktrees permanently
unreclaimable. Scratch is top-level and child-probed rather than basename-allowlisted because .fusion
can hold authoritative operator board state and nested .fusion directories are never project scratch.
*/
export const FUSION_SCRATCH_REGENERABLE_CHILDREN: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  [".fusion", new Set(["cache"])],
]);

/** Return true only for a known scratch root whose immediate children are all regenerable. */
export function isRegenerableScratchDirectory(entryName: string, childNames: readonly string[]): boolean {
  const allowedChildren = FUSION_SCRATCH_REGENERABLE_CHILDREN.get(entryName);
  return allowedChildren !== undefined && childNames.every((childName) => allowedChildren.has(childName));
}

function isTopLevelUnquotedDirectoryEntry(entry: string, entryName: string): boolean {
  return entry === `!! ${entryName}/`;
}

function isRegenerableIgnoredPorcelainEntry(entry: string, provenScratchRootEntries?: ReadonlySet<string>): boolean {
  const path = entry.slice(3).replace(/\/$/, "");
  if (!path || path.startsWith('"')) return false;
  if (provenScratchRootEntries?.has(path) && isTopLevelUnquotedDirectoryEntry(entry, path)) return true;
  const lastSegment = path.split("/").at(-1);
  return lastSegment !== undefined && REGENERABLE_IGNORED_DIR_NAMES.has(lastSegment);
}

/** Classify porcelain output without allowing ignored entries to mask deliverable content. */
export function classifyWorktreeRemovalContent(
  porcelain: string,
  options?: { provenScratchRootEntries?: ReadonlySet<string> },
): WorktreeRemovalContentClassification {
  const entries = porcelain.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (entries.length === 0) return "clean";
  if (entries.some((line) => !line.startsWith("!! "))) return "deliverable";
  return entries.every((entry) => isRegenerableIgnoredPorcelainEntry(entry, options?.provenScratchRootEntries))
    ? "regenerable-ignored"
    : "ignored-only";
}

export interface DefensiveRemovalContentProbe {
  classification: WorktreeRemovalContentClassification;
  entryCount: number;
  /*
  FNXC:ZeroCommitLandingProof 2026-09-25-11:17 (RUFU-274):
  The non-ignored paths behind a `deliverable` classification, so a refusal can NAME them on the row.
  RUFU-274's refusal sentence has to say which files survived; the removal gate only ever needed a
  yes/no, so this is the probe's only addition over it. Capped — the row stays readable on a 400-file
  tree and the count carries the rest.
  */
  uncommittedPaths: string[];
  /** `classified` ran the probe; `path-absent` means nothing is on disk; `probe-failed` means the tree could not be read. */
  status: "classified" | "path-absent" | "probe-failed";
  /** Present when `status === "probe-failed"`, for the removal gate's own message. */
  probeError?: string;
  /*
  FNXC:ZeroCommitLandingProof 2026-09-26-01:30 (RUFU-274):
  Modified vs untracked split of the NON-ignored entries. The removal gate only ever needed a yes/no,
  but a refusal has to state its evidence: run-audit metadata and the `deliveryUnproven` marker carry
  counts, not paths, so the counts must come from the same probe that produced the classification —
  never from a second `git status` that could disagree with it.
  */
  modifiedCount: number;
  untrackedCount: number;
}

/** Cap on paths a refusal may name, so a huge tree cannot make the row unreadable. */
const MAX_REPORTED_UNCOMMITTED_PATHS = 25;

/**
 * Extract the first path of a non-ignored porcelain entry.
 *
 * FNXC:ZeroCommitLandingProof 2026-09-25-11:17 (RUFU-274):
 * `git status --porcelain=v1` fields are `XY<space>path`, with renames as `old -> new` and
 * non-ASCII/quote-needing paths wrapped in double quotes. Only the FIRST path is named — it is the
 * one an operator acts on — and quotes are stripped so the row shows a path, not git's escaping.
 */
function porcelainEntryPath(entry: string): string {
  const raw = entry.slice(3).trim();
  const arrowSplit = raw.split(" -> ")[0] ?? raw;
  return arrowSplit.replace(/^"|"$/g, "");
}

/**
 * Non-throwing worktree-content classification — the evidence half of the durable landing-proof
 * predicate. `assertCleanForDefensiveRemoval` is this probe plus the removal gate's refusals; the
 * finalization lanes need the classification WITHOUT the throw, because their answer for a dirty
 * tree is "hold the card for a human and keep the worktree", not "skip the removal".
 *
 * FNXC:ZeroCommitLandingProof 2026-09-25-11:17 (RUFU-274):
 * Exported rather than duplicated so the removal gate and the finalization guard read the tree the
 * same way. A second implementation is how `assertCleanForDefensiveRemoval` ended up with seven
 * call sites passing inconsistent options.
 */
export async function probeWorktreeRemovalContent(worktreePath: string): Promise<DefensiveRemovalContentProbe> {
  // Nothing on disk means nothing to preserve — stale registrations prune normally below.
  if (!existsSync(worktreePath)) {
    return { classification: "clean", entryCount: 0, uncommittedPaths: [], status: "path-absent", modifiedCount: 0, untrackedCount: 0 };
  }
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("git", ["status", "--porcelain=v1", "--ignored=matching", "--untracked-files=normal"], {
      cwd: worktreePath,
      encoding: "utf-8",
      timeout: 15_000,
      maxBuffer: MAX_BUFFER,
    }));
  } catch (error) {
    return {
      classification: "ignored-only",
      entryCount: 0,
      uncommittedPaths: [],
      status: "probe-failed",
      modifiedCount: 0,
      untrackedCount: 0,
      probeError: error instanceof Error ? error.message : String(error),
    };
  }
  const provenScratchRootEntries = new Set<string>();
  const entries = stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
  await Promise.all([...FUSION_SCRATCH_REGENERABLE_CHILDREN.keys()].map(async (entryName) => {
    if (!entries.includes(`!! ${entryName}/`)) return;
    try {
      const childNames = await readdir(resolve(worktreePath, entryName));
      if (isRegenerableScratchDirectory(entryName, childNames)) provenScratchRootEntries.add(entryName);
    } catch {
      // An unreadable scratch directory is operator content until proven otherwise.
    }
  }));
  const classification = classifyWorktreeRemovalContent(stdout, { provenScratchRootEntries });
  /*
  FNXC:WorktreeCleanup 2026-09-29-22:04 (fusion/rufu-274 squash merge):
  RUFU-278's typed `WorktreeContentPreservationError` refusal for a `deliverable` tree lives in
  `assertCleanForDefensiveRemoval` (below), not here: this probe is deliberately non-throwing so the
  finalization lanes can read the classification of a dirty tree instead of catching a refusal.
  */
  const deliverableEntries = entries.filter((line) => !line.startsWith("!! "));
  return {
    classification,
    entryCount: entries.length,
    uncommittedPaths: deliverableEntries.slice(0, MAX_REPORTED_UNCOMMITTED_PATHS).map(porcelainEntryPath).filter(Boolean),
    status: "classified",
    /*
    FNXC:ZeroCommitLandingProof 2026-09-26-01:30 (RUFU-274):
    Porcelain `XY` codes: `??` is untracked, every other non-ignored code is a tracked change. Ignored
    (`!!`) entries are counted by `entryCount` instead, because FN-9234's rule is that an ignored-only
    tree is not uncommitted delivery.
    */
    modifiedCount: deliverableEntries.filter((line) => !line.startsWith("?? ")).length,
    untrackedCount: deliverableEntries.filter((line) => line.startsWith("?? ")).length,
  };
}

/*
FNXC:WorktreeCleanup 2026-10-09-13:10 (RUFU-329 — one seam decides, the other only reports):
There is deliberately no "would this removal refuse?" boolean beside this guard. RUFU-278 shipped one for the
pinned-worktree reclaim; RUFU-298 moved that caller onto `probeWorktreeRemovalContent`'s classification, which
carries strictly more information (remove / preserve aside / fail closed), and RUFU-329 deleted the wrapper once it
had no callers left. A second API expressing half of another API's contract is a second call site every future
content class must be threaded through, so the choice stays here (throw) or on the probe (report), never in between.
It was never exported from `packages/engine/src/index.ts`, so its removal ships no API change and no changeset; the
deletion commit carries the evidence (zero production callers, zero plugin consumers).
*/

/*
FNXC:CardOwnershipGuard 2026-09-26-05:16:
STAS-273's card-ownership preservation guard (its `WorktreeCardOwnershipError`, the `store`/`branch`/
`triggeredBy` funnel inputs, the worktree-pool prune gate, and the `worktree:removed-card-owned` /
`worktree:card-ownership-gate-skipped` audit types) was withdrawn from `main` by explicit operator
decision, so every automatic removal below is ownership-blind again — a removal no longer checks whether
another live card still needs the checkout. This note exists because the guard's own FNXC blocks were
deleted with it and the work was never board-delivered (the STAS-273 card is still `todo/queued`), so no
task record explains the absence. Re-adding an ownership check needs a new card plus operator approval.
*/

/*
FNXC:ZeroCommitLandingProof 2026-09-26-01:30 (RUFU-274):
The ONE exported worktree-content classification (RUFU-274 Step 5), built here rather than in a new
module on purpose: `probeWorktreeRemovalContent` is already what the removal gate reads the tree with,
so the guard call sites, the cleanup gate, and the refusal marker all resolve to this single probe and
cannot drift into disagreeing about what the same tree held. The core type
(`WorktreeContentClassification` in `@fusion/core`) stays the vocabulary so the pure decision table and
the git observation cannot name different states.
*/

/** Map a removal-content probe onto the shared worktree-content classification. */
export function worktreeContentClassificationFromProbe(
  probe: DefensiveRemovalContentProbe,
): WorktreeContentClassification {
  if (probe.status === "probe-failed") {
    return { state: "unverifiable", probeDetail: probe.probeError ? "status-probe-failed" : undefined };
  }
  if (probe.status === "path-absent") return { state: "absent" };
  switch (probe.classification) {
    case "clean":
      return { state: "clean" };
    case "regenerable-ignored":
      return { state: "regenerable-ignored", scratchEntryCount: probe.entryCount };
    case "ignored-only":
      return { state: "ignored-only", entryCount: probe.entryCount };
    case "deliverable":
      return {
        state: "deliverable",
        modifiedCount: probe.modifiedCount,
        untrackedCount: probe.untrackedCount,
        paths: probe.uncommittedPaths,
      };
  }
}

/** Why a content classification came from the route it did — fixed vocabulary, safe to log and audit. */
export type WorktreeContentEvidenceBasis =
  | "recorded-worktree-classified"
  | "recorded-worktree-absent-from-disk"
  | "branch-checked-out-in-other-worktree"
  | "other-worktree-classified"
  | "worktree-registrations-unreadable"
  | "status-probe-failed"
  | "singular-checkout-not-exclusively-owned"
  | "no-recorded-worktree";

export interface TaskWorktreeContentEvidence {
  content: WorktreeContentClassification;
  basis: WorktreeContentEvidenceBasis;
}

export interface TaskWorktreeContentEvidenceInput {
  /** Repository root; also the singular checkout a task must never be finalised from by accident. */
  rootDir: string;
  taskId: string;
  /** `task.worktree` as recorded on the row. */
  worktreePath?: string | null;
  /** `task.branch` as recorded on the row. */
  branch?: string | null;
  /**
   * Prove that a checkout shared with the project root belongs exclusively to this card
   * (RUFU-200's singular-worktree ownership). Without a proof the tree's content is another card's or
   * the operator's and CANNOT justify a refusal, so it is reported as holding nothing deliverable.
   */
  proveExclusiveSingularCheckout?: (worktreePath: string) => Promise<boolean>;
}

/**
 * Classify what a card's checkout holds, honouring both halves of `absent`: the recorded path is
 * provably gone AND no other registered checkout has the card's branch. A branch checked out twice
 * means the work still exists on disk, so the surviving tree is classified instead.
 */
export async function classifyTaskWorktreeContent(
  input: TaskWorktreeContentEvidenceInput,
): Promise<TaskWorktreeContentEvidence> {
  const recorded = input.worktreePath?.trim();

  if (!recorded) {
    const branch = input.branch?.trim();
    const holder = branch ? await findOtherCheckoutHoldingBranch(input.rootDir, branch) : undefined;
    if (holder === "unreadable") {
      return { content: { state: "unverifiable", probeDetail: "registrations-unreadable" }, basis: "worktree-registrations-unreadable" };
    }
    if (holder === undefined) return { content: { state: "absent" }, basis: "no-recorded-worktree" };
    return classifyOtherCheckout(holder, "branch-checked-out-in-other-worktree");
  }

  if (resolve(recorded) === resolve(input.rootDir)) {
    const exclusive = (await input.proveExclusiveSingularCheckout?.(recorded).catch(() => false)) ?? false;
    if (!exclusive) {
      return { content: { state: "clean" }, basis: "singular-checkout-not-exclusively-owned" };
    }
  }

  const probe = await probeWorktreeRemovalContent(recorded);
  if (probe.status === "classified") {
    return { content: worktreeContentClassificationFromProbe(probe), basis: "recorded-worktree-classified" };
  }
  if (probe.status === "probe-failed") {
    return { content: worktreeContentClassificationFromProbe(probe), basis: "status-probe-failed" };
  }

  /*
  FNXC:ZeroCommitLandingProof 2026-09-25-11:26 (RUFU-274):
  The recorded directory is gone. That is only half of `provably gone`: the same branch can be checked
  out in a second worktree, and then the work is very much still on disk. Reading the registry is a
  git read of the project root, so a failure there is the absence of proof, not proof of absence.
  */
  const branch = input.branch?.trim();
  if (!branch) return { content: { state: "absent" }, basis: "recorded-worktree-absent-from-disk" };
  const holder = await findOtherCheckoutHoldingBranch(input.rootDir, branch, recorded).catch(() => "unreadable" as const);
  if (holder === "unreadable") {
    return { content: { state: "unverifiable", probeDetail: "registrations-unreadable" }, basis: "worktree-registrations-unreadable" };
  }
  if (holder === undefined) return { content: { state: "absent" }, basis: "recorded-worktree-absent-from-disk" };
  return classifyOtherCheckout(holder, "branch-checked-out-in-other-worktree");
}

/** Re-classify a surviving checkout that holds the card's branch. */
async function classifyOtherCheckout(
  worktreePath: string,
  basis: WorktreeContentEvidenceBasis,
): Promise<TaskWorktreeContentEvidence> {
  const probe = await probeWorktreeRemovalContent(worktreePath);
  return {
    content: worktreeContentClassificationFromProbe(probe),
    basis: probe.status === "classified" ? "other-worktree-classified" : basis,
  };
}

/**
 * A registered checkout other than `excludePath` that has `branch` checked out.
 * `undefined` = none holds it; `"unreadable"` = the registry could not be read.
 */
export async function findOtherCheckoutHoldingBranch(
  rootDir: string,
  branch: string,
  excludePath?: string,
): Promise<string | undefined | "unreadable"> {
  let registrations: Array<{ path: string; branch?: string }>;
  try {
    registrations = await listWorktreeRegistrations(rootDir);
  } catch {
    return "unreadable";
  }
  const match = registrations.find((entry) => {
    if (entry.branch !== branch) return false;
    if (excludePath && resolve(entry.path) === resolve(excludePath)) return false;
    return true;
  });
  return match ? match.path : undefined;
}

/**
 * Commits on the card's branch that the integration branch does not already have.
 *
 * `null` is the honest answer whenever git cannot produce the count — the branch is gone, the
 * integration ref does not resolve, the repository is mid-operation. The predicate reads `null` as
 * "zero-ness is unproven" and stays out of the way, which is what keeps an unreadable repository from
 * turning into a fabricated refusal on a card that does have commits.
 */
export async function measureAheadCommitCount(input: {
  repoDir: string;
  integrationBranch: string;
  branch: string;
}): Promise<number | null> {
  const range = `${input.integrationBranch}..${input.branch}`;
  try {
    const { stdout } = await execFileAsync("git", ["rev-list", "--count", range], {
      cwd: input.repoDir,
      encoding: "utf-8",
      timeout: 15_000,
      maxBuffer: MAX_BUFFER,
    });
    const count = Number.parseInt(stdout.trim(), 10);
    return Number.isFinite(count) && count >= 0 ? count : null;
  } catch {
    return null;
  }
}

/**
 * Prove a commit is already contained in the integration branch, which is what turns a recorded
 * `mergeDetails.commitSha` into durable landing proof rather than a remembered string.
 */
export async function isCommitContainedInBranch(input: {
  repoDir: string;
  commitSha: string;
  integrationBranch: string;
}): Promise<boolean> {
  try {
    await execFileAsync("git", ["merge-base", "--is-ancestor", input.commitSha, input.integrationBranch], {
      cwd: input.repoDir,
      encoding: "utf-8",
      timeout: 15_000,
      maxBuffer: MAX_BUFFER,
    });
    return true;
  } catch {
    return false;
  }
}

/** Fail closed when an automatic sweep cannot prove the checkout is empty of user content. */
async function assertCleanForDefensiveRemoval(rootDir: string, worktreePath: string): Promise<DefensiveRemovalContentProbe> {
  if (resolve(worktreePath) === resolve(rootDir)) {
    throw new Error(`preserving ${worktreePath}: refusing to remove the project root checkout`);
  }
  const probe = await probeWorktreeRemovalContent(worktreePath);
  if (probe.status === "probe-failed") {
    throw new Error(`preserving ${worktreePath}: status probe failed (${probe.probeError})`);
  }
  if (probe.classification === "deliverable") {
    /*
    FNXC:WorktreeCleanup 2026-09-29-22:04 (fusion/rufu-274 squash merge):
    RUFU-274 moved the tree read into the non-throwing `probeWorktreeRemovalContent`; RUFU-278's typed
    `WorktreeContentPreservationError` stays on this refusal so callers that own a safe preserve path can still
    discriminate by type. The class reproduces the original message verbatim, so nothing matching on the wording
    changed either.

    FNXC:WorktreeCleanup 2026-10-09-13:10 (RUFU-329):
    That safe preserve path is the pinned-worktree reclaim, and since RUFU-298 it decides from
    `probeWorktreeRemovalContent`'s classification instead of asking a helper whether removal would refuse, so no
    production caller discriminates this class by `instanceof` any more. It stays a typed error because its contract
    is a typed, byte-stable refusal at the removal door — the real-git suites match its `preserving` wording — and a
    future caller that must tell a content refusal from a lock refusal can do so without a regex.
    */
    throw new WorktreeContentPreservationError(worktreePath);
  }
  return probe;
}


/**
 * FNXC:WorkspaceWorktree 2026-08-20-07:08:
 * Force removal is reserved for explicit executor teardown paths and workspace-acquisition rollback
 * before the rejected checkout has been published to task state.
 */
export async function removeWorktree(input: {
  worktreePath: string;
  rootDir: string;
  settings: Partial<Settings>;
  reason: RemovalReason;
  taskId?: string;
  audit?: RunAuditor;
  /** Durable landing proof permits ignored-only content, never force removal. */
  postLandingProof?: { landedSha?: string; source: string };
  force?: boolean;
  timeout?: number;
  expectedOwnerTaskId?: string;
  liveOwnerProbe?: LiveBindingProbe;
  processActiveProbe?: ProcessActiveProbe;
  reconcileMinIdleMs?: number;
}): Promise<WorktreeRemoveOutcome> {
  const logger = {
    log: (_message: string): void => {},
    warn: (_message: string): void => {},
  };

  if (input.force === true && !ALLOWED_FORCE_REASONS.has(input.reason)) {
    throw new InvalidForceUsageError(input.reason);
  }
  if (input.postLandingProof && !POST_LANDING_PROOF_REASONS.has(input.reason)) {
    throw new InvalidPostLandingProofUsageError(input.reason);
  }

  const requiresCleanWorktree = DEFENSIVE_REMOVAL_REASONS.has(input.reason);

  /*
  FNXC:WorktreeCleanup 2026-09-01-06:09:
  FN-9233 lets all defensive sweeps discard only allowlisted regenerable ignored output, while
  non-allowlisted ignored content retains FN-251's durable landing-proof gate. Deliverable,
  unverifiable, and live-session content remain fail-closed for every caller.
  */
  let contentClassification: WorktreeRemovalContentClassification | undefined;
  let contentEntryCount = 0;
  if (requiresCleanWorktree) {
    try {
      const contentProbe = await assertCleanForDefensiveRemoval(input.rootDir, input.worktreePath);
      contentClassification = contentProbe.classification;
      contentEntryCount = contentProbe.entryCount;
    } catch (error) {
      const classification = error instanceof Error && error.message.includes(": status probe failed (")
        ? "unverifiable"
        : "deliverable";
      await input.audit?.git({
        type: "worktree:removal-preserved",
        target: input.worktreePath,
        metadata: {
          taskId: input.taskId,
          reason: input.reason,
          source: input.postLandingProof?.source,
          classification,
          hasPostLandingProof: input.postLandingProof !== undefined,
        },
      }).catch(() => undefined);
      throw error;
    }
    if (contentClassification === "ignored-only" && !input.postLandingProof) {
      await input.audit?.git({
        type: "worktree:removal-preserved",
        target: input.worktreePath,
        metadata: {
          taskId: input.taskId,
          reason: input.reason,
          source: undefined,
          classification: "ignored-only",
          hasPostLandingProof: false,
        },
      }).catch(() => undefined);
      throw new WorktreeContentPreservationError(input.worktreePath);
    }
  }

  const recordIgnoredOnlyDiscard = async (): Promise<void> => {
    if (contentClassification !== "ignored-only" || !input.postLandingProof) return;
    try {
      await input.audit?.git({
        type: "worktree:post-landing-ignored-content-discarded",
        target: input.worktreePath,
        metadata: {
          taskId: input.taskId,
          reason: input.reason,
          source: input.postLandingProof.source,
          landedSha: input.postLandingProof.landedSha,
        },
      });
    } catch {
      // Audit persistence must not change worktree cleanup outcomes.
    }
  };

  const recordRegenerableDiscard = async (): Promise<void> => {
    if (contentClassification !== "regenerable-ignored") return;
    try {
      await input.audit?.git({
        type: "worktree:removal-discarded-regenerable-content",
        target: input.worktreePath,
        metadata: { taskId: input.taskId, reason: input.reason, entryCount: contentEntryCount },
      });
    } catch {
      // Audit persistence must not change worktree cleanup outcomes.
    }
  };

  if (input.expectedOwnerTaskId && input.liveOwnerProbe) {
    const reconciled = reconcileSelfOwnedActiveSessionForRemoval(
      activeSessionRegistry,
      input.worktreePath,
      input.expectedOwnerTaskId,
      input.liveOwnerProbe,
      {
        processActiveProbe: input.processActiveProbe,
        minIdleMs: input.reconcileMinIdleMs,
      },
    );
    if (reconciled.action === "reconciled") {
      await input.audit?.git({
        type: "worktree:active-session-reconciled",
        target: input.worktreePath,
        metadata: { taskId: input.expectedOwnerTaskId, source: "removeWorktree-defensive" },
      });
    }
  }

  const active = activeSessionRegistry.lookupByPath(input.worktreePath);
  const ownsDeletionReservation = input.reason === RemovalReason.TaskDeletion
    && active?.kind === "task-deletion-cleanup"
    && active.taskId === input.taskId;
  const mayBypassActiveSession = ownsDeletionReservation
    || (input.force === true && input.reason !== RemovalReason.TaskDeletion);
  if (active && !mayBypassActiveSession) {
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

  if (active && mayBypassActiveSession && !ownsDeletionReservation) {
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
    force: requiresCleanWorktree ? false : input.force,
  };

  if (input.force === false || typeof input.timeout === "number") {
    // Backwards-compatible helper signature for callers that carried raw git flags/timeouts.
    // Current backend remove implementations are forceful and use backend-owned timeouts.
  }

  try {
    await backend.remove(removeInput);
    await recordIgnoredOnlyDiscard();
    await recordRegenerableDiscard();
    if (input.audit) {
      await input.audit.git({
        type: backend.kind === "worktrunk" ? "worktree:worktrunk-remove" : "worktree:remove",
        target: input.worktreePath,
      });
    }
    return { removed: true, classification: "removed" };
  } catch (error) {
    const classified = await classifyHarmlessMergeRemoveFailure(input, error);
    if (classified) return classified;

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
    try {
      await native.remove(removeInput);
      await recordIgnoredOnlyDiscard();
      await recordRegenerableDiscard();
      await input.audit?.git({ type: "worktree:remove", target: input.worktreePath });
      return { removed: true, classification: "removed" };
    } catch (nativeError) {
      const classified = await classifyHarmlessMergeRemoveFailure(input, nativeError);
      if (classified) return classified;
      throw nativeError;
    }
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
      settings,
    });
  }

  return new NativeWorktreeBackend({ logger: deps.logger, settings, audit: deps.audit });
}
