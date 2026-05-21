import { createHash } from "node:crypto";
import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";
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

export interface MergeIntegrationRootResolution {
  mode: MergeIntegrationWorktreeMode;
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

  if (input.settings.worktrunk?.enabled === true) {
    return {
      mode: "cwd-main",
      rootDir: input.projectRoot,
      branchName,
    };
  }

  const mode = input.settings.mergeIntegrationWorktree === "cwd-main"
    ? "cwd-main"
    : "reuse-task-worktree";

  return {
    mode,
    rootDir: mode === "reuse-task-worktree"
      ? input.task.worktree?.trim() || input.projectRoot
      : input.projectRoot,
    branchName,
  };
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

async function snapshotDirtyFilesLocal(rootDir: string): Promise<Set<string>> {
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

async function gitDirtyFingerprintLocal(rootDir: string): Promise<string> {
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
  const dirtyPaths = Array.from(await snapshotDirtyFilesLocal(worktreePath)).sort();
  const dirtyFingerprint = await gitDirtyFingerprintLocal(worktreePath);
  if (dirtyPaths.length > 0 || dirtyFingerprint) {
    throw new MergeHandoffRefusedError("working-tree-dirty", "dirty-worktree", {
      taskId: input.task.id,
      worktreePath,
      dirtyPaths,
      dirtyFingerprint,
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
    throw new MergeHandoffRefusedError("head-branch-mismatch", "unexpected-branch", {
      taskId: input.task.id,
      worktreePath,
      observedBranch,
      expectedBranch,
    });
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
    lease = (input.store as TaskStore & {
      acquireMergeQueueLease(workerId: string, opts: { leaseDurationMs: number; now?: string; targetTaskId?: string }): unknown;
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
  if (!lease || !("taskId" in lease) || lease.taskId !== input.task.id) {
    throw new MergeHandoffRefusedError("lease-handoff-failed", "no-lease", {
      taskId: input.task.id,
      worktreePath,
      acquiredTaskId: lease && "taskId" in lease ? lease.taskId : null,
    });
  }
  // Re-check executor lease after acquiring the merge-queue lease: the
  // checks above (lines ~362–391) are non-atomic with acquisition, so a
  // local executor could grab the task between them. Releasing here gives
  // a precise diagnostic instead of letting the merge proceed with a
  // conflicting executor lease and surfacing as a generic failure later.
  if (executingTaskLock.has(input.task.id)) {
    (input.store as TaskStore & {
      releaseMergeQueueLease(taskId: string, workerId: string, outcome: MergeQueueReleaseOutcome): void;
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
      (input.store as TaskStore & {
        releaseMergeQueueLease(taskId: string, workerId: string, outcome: MergeQueueReleaseOutcome): void;
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
