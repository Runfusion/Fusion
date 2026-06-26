import { createHash } from "node:crypto";
import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  normalizeMergeIntegrationWorktreeMode,
} from "@fusion/core";
import type {
  MergeIntegrationWorktreeMode,
  MergeQueueReleaseOutcome,
  ProjectSettings,
  Task,
  TaskStore,
} from "@fusion/core";
import {
  activeSessionRegistry,
  executingTaskLock,
  reconcileSelfOwnedActiveSessionForRemoval,
} from "./active-session-registry.js";
import { attemptBranchAutocorrect } from "./branch-autocorrect.js";
import { isBranchAuthoritativeForTask } from "./branch-conflicts.js";
import { MeshLeaseManager } from "./mesh-lease-manager.js";
import {
  canonicalizePath,
  classifyTaskWorktree,
  getRegisteredWorktreeBranchMap,
  PoolDoubleLeaseError,
} from "./worktree-pool.js";
import { canonicalFusionBranchName } from "./worktree-names.js";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const MERGE_HANDOFF_WORKER_ID = "merger-reuse-handoff";

/** Shell-quote a value for safe interpolation into `git` command strings.
 *  Mirrors the `quoteArg` helper in merger.ts; kept local to avoid an
 *  import cycle. */
function quoteAutostashArg(value: string): string {
  return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}

export interface MergeIntegrationRootResolution {
  mode: MergeIntegrationWorktreeMode;
  // Sentinel: empty string means reuse mode is requested but no reusable
  // task.worktree is currently recorded; caller must reacquire before use.
  rootDir: string;
  branchName: string;
}

export interface ResolveMergeIntegrationRootInput {
  task: Pick<Task, "id" | "branch" | "worktree">;
  settings: Pick<ProjectSettings, "mergeIntegrationWorktree" | "worktrunk">;
  projectRoot: string;
}

export function resolveMergeIntegrationRoot(
  input: ResolveMergeIntegrationRootInput,
): MergeIntegrationRootResolution {
  const branchName = canonicalFusionBranchName(input.task.id);

  const mode = normalizeMergeIntegrationWorktreeMode(
    input.settings.mergeIntegrationWorktree,
  );

  const reusablePath = input.task.worktree?.trim() || "";
  return {
    mode,
    rootDir: mode === "reuse-task-worktree"
      ? reusablePath
      : input.projectRoot,
    branchName,
  };
}

export type MergeIntegrationRootPreflightResult =
  | { ok: true; resolution: MergeIntegrationRootResolution; checked: false | "reuse-task-worktree" }
  | {
    ok: false;
    resolution: MergeIntegrationRootResolution;
    checked: "reuse-task-worktree";
    reason: "missing-task-worktree" | "unusable-task-worktree";
    classification?: Awaited<ReturnType<typeof classifyTaskWorktree>>;
  };

export interface EnsureUsableMergeIntegrationRootInput {
  resolution: MergeIntegrationRootResolution;
  projectRoot: string;
}

/**
 * Preflight the merge integration cwd before any merge-runner git spawn.
 *
 * In cwd/project-root mode this is intentionally a no-op: the project root is
 * the stable repository checkout and the common path should not pay an extra
 * stat or git-worktree-list probe. In reuse-task-worktree mode the resolved
 * `task.worktree` is user/session mutable, so classify it before it can be
 * used as `cwd`; callers can then reacquire/recreate the worktree instead of
 * letting Node surface a misleading `spawn git ENOENT` for a vanished cwd.
 */
export async function ensureUsableMergeIntegrationRoot(
  input: EnsureUsableMergeIntegrationRootInput,
): Promise<MergeIntegrationRootPreflightResult> {
  if (input.resolution.mode !== "reuse-task-worktree") {
    return { ok: true, resolution: input.resolution, checked: false };
  }

  const reusableRoot = input.resolution.rootDir.trim();
  if (!reusableRoot) {
    return {
      ok: false,
      resolution: input.resolution,
      checked: "reuse-task-worktree",
      reason: "missing-task-worktree",
    };
  }

  const classification = await classifyTaskWorktree(input.projectRoot, reusableRoot);
  if (!classification.ok) {
    return {
      ok: false,
      resolution: input.resolution,
      checked: "reuse-task-worktree",
      reason: "unusable-task-worktree",
      classification,
    };
  }

  return { ok: true, resolution: input.resolution, checked: "reuse-task-worktree" };
}

export interface ResolveIntegrationRemoteInput {
  settings: Pick<ProjectSettings, "worktreeRebaseRemote">;
  rootDir: string;
  integrationBranch: string;
}

export async function resolveIntegrationRemote(
  input: ResolveIntegrationRemoteInput,
): Promise<string | undefined> {
  const configured = input.settings.worktreeRebaseRemote?.trim();
  if (configured) {
    return configured;
  }

  try {
    const { stdout } = await execAsync(
      `git config --get branch.${input.integrationBranch}.remote`,
      { cwd: input.rootDir, encoding: "utf-8" },
    );
    const branchRemote = stdout.trim();
    if (branchRemote) {
      return branchRemote;
    }
  } catch {
    // Fall through to repo remote discovery.
  }

  try {
    const { stdout } = await execAsync("git remote", {
      cwd: input.rootDir,
      encoding: "utf-8",
    });
    const remotes = stdout.trim().split(/\s+/).filter(Boolean);
    if (remotes.length === 1) {
      return remotes[0];
    }
    if (remotes.includes("origin")) {
      return "origin";
    }
  } catch {
    // No remote resolvable.
  }

  return "origin";
}

export class MergeHandoffRefusedError extends Error {
  readonly reason: string;
  readonly gate: string;
  readonly payload: Record<string, unknown>;

  constructor(gate: string, reason: string, payload: Record<string, unknown> = {}) {
    super(`Merge handoff refused (${gate}): ${reason}`);
    this.name = "MergeHandoffRefusedError";
    this.gate = gate;
    this.reason = reason;
    this.payload = payload;
  }
}

export interface ReuseHandoffSuccess {
  ok: true;
  taskId: string;
  worktreePath: string;
  branch: string;
  workerId: string;
  releaseLease: (outcome: MergeQueueReleaseOutcome) => void;
}

export type HandoffResult = ReuseHandoffSuccess;

export interface ReuseHandoffInput {
  task: Pick<
    Task,
    | "id"
    | "branch"
    | "worktree"
    | "checkedOutBy"
    | "checkedOutAt"
    | "checkoutLeaseRenewedAt"
    | "checkoutNodeId"
    | "checkoutRunId"
    | "checkoutLeaseEpoch"
  >;
  store: TaskStore;
  projectRoot: string;
  settings: ProjectSettings;
  worktreePath: string;
  auditEmit?: (event: { type: string; target?: string; metadata?: Record<string, unknown> }) => Promise<void> | void;
}

export async function snapshotDirtyFilesLocal(rootDir: string): Promise<Set<string>> {
  const paths = new Set<string>();
  try {
    const [unstagedOut, stagedOut, porcelainOut] = await Promise.all([
      execFileAsync("git", ["diff", "-z", "--name-only"], { cwd: rootDir, encoding: "utf-8" }).then(
        (r) => r.stdout,
        () => "",
      ),
      execFileAsync("git", ["diff", "-z", "--cached", "--name-only"], { cwd: rootDir, encoding: "utf-8" }).then(
        (r) => r.stdout,
        () => "",
      ),
      execFileAsync("git", ["status", "-z", "--porcelain"], { cwd: rootDir, encoding: "utf-8" }).then(
        (r) => r.stdout,
        () => "",
      ),
    ]);

    for (const entry of unstagedOut.split("\0")) {
      const path = entry.trim();
      if (path) paths.add(path);
    }
    for (const entry of stagedOut.split("\0")) {
      const path = entry.trim();
      if (path) paths.add(path);
    }
    for (const entry of porcelainOut.split("\0")) {
      if (!entry.startsWith("?? ")) continue;
      const path = entry.slice(3);
      if (path) paths.add(path);
    }
  } catch {
    // Best-effort gate input.
  }
  return paths;
}

export async function gitDirtyFingerprintLocal(rootDir: string): Promise<string> {
  try {
    const [diffOut, statusOut] = await Promise.all([
      execFileAsync("git", ["diff", "HEAD"], {
        cwd: rootDir,
        encoding: "utf-8",
        maxBuffer: 64 * 1024 * 1024,
      }).then((r) => r.stdout, () => ""),
      execFileAsync("git", ["status", "-z", "--porcelain"], { cwd: rootDir, encoding: "utf-8" }).then(
        (r) => r.stdout,
        () => "",
      ),
    ]);
    if (!diffOut && !statusOut) return "";
    return createHash("sha256").update(diffOut).update("\0").update(statusOut).digest("hex");
  } catch {
    return "";
  }
}

export interface IntegrationWorktreeProbeResult {
  userCheckout: {
    worktreePath: string;
    dirty: boolean;
    untrackedCount: number;
    dirtyPathSample: string[];
  } | null;
  dirtyFingerprint: string | null;
}

export interface ProbeIntegrationWorktreeStateInput {
  rootDir: string;
  integrationBranch: string;
  projectRoot: string;
}

export async function probeIntegrationWorktreeState(
  input: ProbeIntegrationWorktreeStateInput,
): Promise<IntegrationWorktreeProbeResult> {
  try {
    const branchMap = await getRegisteredWorktreeBranchMap(input.projectRoot);
    const caseInsensitiveMatches = Array.from(branchMap.entries())
      .filter(([branch]) => branch.toLowerCase() === input.integrationBranch.toLowerCase())
      .map(([, worktreePath]) => worktreePath);
    const registeredPath = branchMap.get(input.integrationBranch)
      ?? caseInsensitiveMatches.find((worktreePath) => canonicalizePath(worktreePath) === canonicalizePath(input.rootDir))
      ?? caseInsensitiveMatches[0]
      ?? null;
    if (!registeredPath) {
      return { userCheckout: null, dirtyFingerprint: null };
    }

    const dirtyPaths = Array.from(await snapshotDirtyFilesLocal(registeredPath)).sort();
    const dirtyFingerprint = await gitDirtyFingerprintLocal(registeredPath);
    let untrackedCount = 0;
    try {
      const { stdout } = await execFileAsync("git", ["status", "-z", "--porcelain"], {
        cwd: registeredPath,
        encoding: "utf-8",
      });
      untrackedCount = stdout.split("\0").filter((entry) => entry.startsWith("?? ")).length;
    } catch {
      // best-effort
    }

    return {
      userCheckout: {
        worktreePath: registeredPath,
        dirty: dirtyPaths.length > 0 || Boolean(dirtyFingerprint),
        untrackedCount,
        dirtyPathSample: dirtyPaths.slice(0, 20),
      },
      dirtyFingerprint: dirtyFingerprint || null,
    };
  } catch {
    return { userCheckout: null, dirtyFingerprint: null };
  }
}

async function findOtherWorktreeUser(store: TaskStore, worktreePath: string, excludeTaskId: string): Promise<string | null> {
  const tasks = await store.listTasks({ slim: true, includeArchived: false } as never);
  for (const task of tasks) {
    if (task.id === excludeTaskId) continue;
    if (task.worktree === worktreePath && task.column !== "done") {
      return task.id;
    }
  }
  return null;
}

function asCentralClaimAccessor(store: TaskStore): {
  projectId?: string;
  getTaskClaim?: (projectId: string, taskId: string) => { ownerAgentId?: string | null } | null;
} {
  const candidate = store as TaskStore & {
    projectId?: string;
    getTaskClaim?: (projectId: string, taskId: string) => { ownerAgentId?: string | null } | null;
  };
  return {
    projectId: typeof candidate.projectId === "string" ? candidate.projectId : undefined,
    getTaskClaim: typeof candidate.getTaskClaim === "function" ? candidate.getTaskClaim.bind(candidate) : undefined,
  };
}

export async function acquireReuseHandoff(input: ReuseHandoffInput): Promise<HandoffResult> {
  const expectedBranch = canonicalFusionBranchName(input.task.id);
  const worktreePath = input.worktreePath;
  const preflight = await ensureUsableMergeIntegrationRoot({
    resolution: {
      mode: "reuse-task-worktree",
      rootDir: worktreePath,
      branchName: expectedBranch,
    },
    projectRoot: input.projectRoot,
  });
  if (!preflight.ok) {
    throw new MergeHandoffRefusedError("integration-root-preflight", preflight.reason, {
      taskId: input.task.id,
      worktreePath,
      classification: preflight.classification ?? null,
    });
  }
  if (canonicalizePath(worktreePath) === canonicalizePath(input.projectRoot)) {
    throw new MergeHandoffRefusedError("reuse-misconfigured", "worktree-equals-project-root", {
      taskId: input.task.id,
      projectRoot: input.projectRoot,
      worktreePath,
    });
  }
  const dirtyPaths = Array.from(await snapshotDirtyFilesLocal(worktreePath)).sort();
  const dirtyFingerprint = await gitDirtyFingerprintLocal(worktreePath);
  if (dirtyPaths.length > 0 || dirtyFingerprint) {
    // Previously this refused the handoff and parked the task as
    // in-review:failed. Instead, autostash the dirty state so the merge can
    // proceed; the stash survives in the repo's stash list even after the
    // worktree is later torn down, so the developer can always recover.
    const stashLabel = `fusion-reuse-handoff-autostash:${input.task.id}:${Date.now()}`;
    let stashSha: string | null = null;
    let stashError: string | null = null;
    try {
      // Stage everything (including untracked) so `git stash create`
      // captures the full dirty tree.
      await execAsync("git add -A", { cwd: worktreePath });
      const { stdout: createOut } = await execAsync("git stash create", {
        cwd: worktreePath,
        encoding: "utf-8",
      });
      stashSha = String(createOut).trim() || null;
      if (stashSha) {
        await execAsync(
          `git stash store -m ${quoteAutostashArg(stashLabel)} ${stashSha}`,
          { cwd: worktreePath },
        );
        // Only reset/clean once the dirty content is safely captured by the
        // stash. If the stash failed (no SHA), leaving the working tree as-is
        // preserves the user's edits for manual recovery.
        await execAsync("git reset --hard HEAD", { cwd: worktreePath });
        await execAsync("git clean -fd", { cwd: worktreePath });
      }
    } catch (err: unknown) {
      stashError = err instanceof Error ? err.message : String(err);
    }

    if (!stashSha || stashError) {
      // Stash creation failed: do NOT proceed (the merge's destructive ops
      // would wipe the user's edits). Best-effort unstage so the worktree
      // isn't left with a half-staged index from the `git add -A` above.
      try {
        await execAsync("git reset", { cwd: worktreePath });
      } catch {
        // Nothing more we can do.
      }
      throw new MergeHandoffRefusedError("working-tree-dirty", "dirty-worktree-autostash-failed", {
        taskId: input.task.id,
        worktreePath,
        dirtyPaths,
        dirtyFingerprint,
        stashError,
      });
    }

    await input.auditEmit?.({
      type: "merge:reuse-handoff-autostash",
      target: worktreePath,
      metadata: {
        taskId: input.task.id,
        worktreePath,
        stashSha,
        stashLabel,
        dirtyPathCount: dirtyPaths.length,
        dirtyPathSample: dirtyPaths.slice(0, 20),
        recoverCommand: `cd ${worktreePath} && git stash apply ${stashSha}`,
      },
    });
  }

  const { stdout: headStdout } = await execAsync("git rev-parse --abbrev-ref HEAD", {
    cwd: worktreePath,
    encoding: "utf-8",
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  let observedBranch = headStdout.trim();
  if (observedBranch && observedBranch !== expectedBranch && observedBranch.toLowerCase() === expectedBranch.toLowerCase()) {
    const autocorrectResult = await attemptBranchAutocorrect({
      worktreePath,
      observedBranch,
      expectedBranch,
      rootDir: input.projectRoot,
    });
    if (autocorrectResult.status !== "failed") {
      await input.auditEmit?.({
        type: "branch:auto-canonicalize-case",
        target: worktreePath,
        metadata: {
          taskId: input.task.id,
          observed: observedBranch,
          expected: expectedBranch,
          worktreePath,
          mode: autocorrectResult.status,
        },
      });
      const { stdout: correctedHead } = await execAsync("git rev-parse --abbrev-ref HEAD", {
        cwd: worktreePath,
        encoding: "utf-8",
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      });
      observedBranch = correctedHead.trim();
    }
  }
  if (observedBranch !== expectedBranch) {
    // The worktree's HEAD points elsewhere (detached or different branch) but
    // the expected branch ref may still hold this task's authoritative work.
    // If the branch tip carries the task's Fusion-Task-Id trailer and the
    // range against base is contamination-free, re-attach via plain checkout
    // (worktree was already asserted clean above, so this is safe and
    // non-destructive — unlike `checkout -B` which would clobber the ref).
    const authority = await isBranchAuthoritativeForTask(
      input.projectRoot,
      expectedBranch,
      input.task.id,
    );
    if (authority.ok) {
      const reattach = await execAsync(`git checkout ${expectedBranch}`, {
        cwd: worktreePath,
        encoding: "utf-8",
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      }).then(
        () => ({ ok: true as const }),
        (err: unknown) => ({ ok: false as const, reason: err instanceof Error ? err.message : String(err) }),
      );
      if (reattach.ok) {
        const { stdout: reattachedHead } = await execAsync("git rev-parse --abbrev-ref HEAD", {
          cwd: worktreePath,
          encoding: "utf-8",
          timeout: 10_000,
          maxBuffer: 1024 * 1024,
        });
        observedBranch = reattachedHead.trim();
        await input.auditEmit?.({
          type: "branch:auto-reattach-authoritative",
          target: worktreePath,
          metadata: {
            taskId: input.task.id,
            previousHead: observedBranch === expectedBranch ? undefined : observedBranch,
            expectedBranch,
            worktreePath,
          },
        });
      }
    }
    if (observedBranch !== expectedBranch) {
      throw new MergeHandoffRefusedError("head-branch-mismatch", "unexpected-branch", {
        taskId: input.task.id,
        worktreePath,
        observedBranch,
        expectedBranch,
        authorityProbe: authority.ok ? "ok" : authority.reason,
      });
    }
  }

  const activeRecord = activeSessionRegistry.lookupByPath(worktreePath);
  if (activeRecord) {
    if (activeRecord.taskId === input.task.id) {
      // FN-5256: route through the hardened helper so the minIdleMs window and
      // processActiveProbe (executingTaskLock) gates apply — bare
      // `reconcileStaleSelfOwned` would race a warming-down session.
      const outcome = reconcileSelfOwnedActiveSessionForRemoval(
        activeSessionRegistry,
        worktreePath,
        input.task.id,
        () => false,
        { processActiveProbe: (probeTaskId) => executingTaskLock.has(probeTaskId) },
      );
      if (outcome.action !== "reconciled") {
        throw new MergeHandoffRefusedError("active-session-binding", "active-session-present", {
          taskId: input.task.id,
          worktreePath,
          activeRecord,
          executingTaskLockHeld: executingTaskLock.has(input.task.id),
          reconcileOutcome: outcome.action,
        });
      }
    } else {
      throw new MergeHandoffRefusedError("active-session-binding", "active-session-present", {
        taskId: input.task.id,
        worktreePath,
        activeRecord,
        executingTaskLockHeld: executingTaskLock.has(input.task.id),
      });
    }
  }

  const classification = await classifyTaskWorktree(input.projectRoot, worktreePath);
  if (!classification.ok) {
    throw new MergeHandoffRefusedError("branch-worktree-mapping", classification.classification, {
      taskId: input.task.id,
      worktreePath,
      classification,
    });
  }
  const otherTaskId = await findOtherWorktreeUser(input.store, worktreePath, input.task.id);
  if (otherTaskId) {
    throw new MergeHandoffRefusedError("branch-worktree-mapping", "foreign-task-worktree-owner", {
      taskId: input.task.id,
      worktreePath,
      otherTaskId,
    });
  }
  if (input.task.branch?.trim() && input.task.branch.trim().toLowerCase() !== expectedBranch.toLowerCase()) {
    throw new MergeHandoffRefusedError("branch-worktree-mapping", "task-branch-metadata-mismatch", {
      taskId: input.task.id,
      taskBranch: input.task.branch,
      expectedBranch,
    });
  }
  const branchMap = await getRegisteredWorktreeBranchMap(input.projectRoot);
  const registeredBranchPath = branchMap.get(expectedBranch);
  const canonicalWorktreePath = canonicalizePath(worktreePath);
  if (!registeredBranchPath || canonicalizePath(registeredBranchPath) !== canonicalWorktreePath) {
    throw new MergeHandoffRefusedError("branch-worktree-mapping", "registered-branch-mismatch", {
      taskId: input.task.id,
      worktreePath,
      expectedBranch,
      registeredBranchPath: registeredBranchPath ?? null,
    });
  }

  const staleCheck = new MeshLeaseManager({
    taskStore: input.store,
    getExecutingTaskIds: () => {
      const active = new Set<string>();
      if (executingTaskLock.has(input.task.id)) {
        active.add(input.task.id);
      }
      return active;
    },
  });
  if (input.task.checkedOutBy) {
    const recoverable = await staleCheck.isLeaseRecoverable(input.task as Task);
    if (!recoverable.recoverable) {
      throw new MergeHandoffRefusedError("lease-handoff-failed", "executor-lease-active", {
        taskId: input.task.id,
        checkedOutBy: input.task.checkedOutBy,
        checkoutNodeId: input.task.checkoutNodeId ?? null,
        checkoutRunId: input.task.checkoutRunId ?? null,
        reason: recoverable.reason ?? null,
      });
    }
  }
  if (executingTaskLock.has(input.task.id)) {
    throw new MergeHandoffRefusedError("lease-handoff-failed", "executor-lease-active", {
      taskId: input.task.id,
      worktreePath,
      reason: "active_local_execution",
    });
  }
  const centralAccessor = asCentralClaimAccessor(input.store);
  if (centralAccessor.projectId && centralAccessor.getTaskClaim) {
    const claim = centralAccessor.getTaskClaim(centralAccessor.projectId, input.task.id);
    if (claim?.ownerAgentId) {
      throw new MergeHandoffRefusedError("lease-handoff-failed", "central-conflict", {
        taskId: input.task.id,
        projectId: centralAccessor.projectId,
        ownerAgentId: claim.ownerAgentId,
      });
    }
  }

  let lease;
  try {
    // Non-atomic fallback: executor lease checks above race with mergeQueue lease acquisition.
    // TaskStore does not yet expose an atomic executor-lease absence check inside mergeQueue leasing.
    lease = await (input.store as TaskStore & {
      acquireMergeQueueLease(workerId: string, opts: { leaseDurationMs: number; now?: string; targetTaskId?: string }): Promise<unknown>;
    }).acquireMergeQueueLease(MERGE_HANDOFF_WORKER_ID, {
      leaseDurationMs: 15 * 60 * 1000,
      targetTaskId: input.task.id,
    });
  } catch (error) {
    if (error instanceof PoolDoubleLeaseError) {
      throw new MergeHandoffRefusedError("lease-handoff-failed", "pool-double-lease", {
        taskId: input.task.id,
        worktreePath,
        path: error.path,
        existingHolder: error.existingHolder,
        requestingTaskId: error.requestingTaskId,
        phase: error.phase,
      });
    }
    throw error;
  }
  if (!lease) {
    throw new MergeHandoffRefusedError("lease-handoff-failed", "target-not-queued", {
      taskId: input.task.id,
      worktreePath,
    });
  }

  if (!("taskId" in lease) || lease.taskId !== input.task.id) {
    const queueHead = await (input.store as TaskStore & {
      peekMergeQueueHead?: () => Promise<{ taskId: string; leasedBy: string | null; column: string | null } | null>;
    }).peekMergeQueueHead?.();
    throw new MergeHandoffRefusedError("lease-handoff-failed", "no-lease", {
      taskId: input.task.id,
      worktreePath,
      acquiredTaskId: "taskId" in lease ? lease.taskId : null,
      queueHeadTaskId: queueHead?.taskId ?? null,
      queueHeadLeasedBy: queueHead?.leasedBy ?? null,
    });
  }
  // Re-check executor lease after acquiring the merge-queue lease: the
  // checks above (lines ~362–391) are non-atomic with acquisition, so a
  // local executor could grab the task between them. Releasing here gives
  // a precise diagnostic instead of letting the merge proceed with a
  // conflicting executor lease and surfacing as a generic failure later.
  if (executingTaskLock.has(input.task.id)) {
    (input.store as TaskStore & {
      releaseMergeQueueLease(taskId: string, workerId: string, outcome: MergeQueueReleaseOutcome): Promise<void>;
    }).releaseMergeQueueLease(input.task.id, MERGE_HANDOFF_WORKER_ID, {
      kind: "failure",
      error: "executor-lease-acquired-after-queue-lease",
    });
    throw new MergeHandoffRefusedError("lease-handoff-failed", "executor-lease-race-detected", {
      taskId: input.task.id,
      worktreePath,
      reason: "executor_lease_acquired_after_queue_lease",
    });
  }

  return {
    ok: true,
    taskId: input.task.id,
    worktreePath,
    branch: expectedBranch,
    workerId: MERGE_HANDOFF_WORKER_ID,
    releaseLease: (outcome) => {
      void (input.store as TaskStore & {
        releaseMergeQueueLease(taskId: string, workerId: string, outcome: MergeQueueReleaseOutcome): Promise<void>;
      }).releaseMergeQueueLease(input.task.id, MERGE_HANDOFF_WORKER_ID, outcome);
    },
  };
}

export async function releaseReuseHandoff(input: {
  handoff: ReuseHandoffSuccess;
  outcome: string;
  auditEmit?: (event: { type: string; target?: string; metadata?: Record<string, unknown> }) => Promise<void> | void;
}): Promise<void> {
  input.handoff.releaseLease(
    input.outcome === "success"
      ? { kind: "success" }
      : { kind: "failure", error: input.outcome },
  );
  await input.auditEmit?.({
    type: "merge:reuse-handoff-released",
    target: input.handoff.worktreePath,
    metadata: {
      taskId: input.handoff.taskId,
      outcome: input.outcome,
      branch: input.handoff.branch,
      worktreePath: input.handoff.worktreePath,
    },
  });
}
