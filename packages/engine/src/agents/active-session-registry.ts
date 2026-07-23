/*
FNXC:Workspace 2026-06-21-20:10:
"workspace-repo-acquire" is a DISTINCT registry kind reserved for the
acquisition-time same-sub-repo exclusivity entry (U2/KTD4). It is keyed by the
sub-repo absolute path (NOT the worktree path) so two concurrent workspace tasks
contending for the SAME sub-repo are serialized. Keeping it distinct from
"executor"/"step-session" means it does not collide with the executor's later
session registration on the produced worktree path.

FNXC:Workspace 2026-06-22-02:10 (Phase C U3, KTD4):
"workspace-repo-land" is a DISTINCT registry kind for the LAND-time (merge phase)
same-sub-repo lease. Like the acquire kind it is keyed by the sub-repo ABSOLUTE
path, but it guards a different lifecycle scope: two workspace tasks landing the
SAME sub-repo onto its local integration ref are serialized so their clean-room
ai-merge worktrees do not collide. This lease is for SERIALIZATION / clean-room-
collision avoidance only — it is NOT what makes the interleaved `update-ref`
correct. `advanceIntegrationBranchRef`'s CAS already makes a concurrent advance
safe by construction (concurrent-advance → rebuild). The acquire lease (execution
phase) and the land lease (merge phase) never overlap in time on the same path, so
keeping them distinct kinds (each released in its own `finally`) means a stale
entry of one kind can never be mistaken for a live hold of the other.
*/
export type ActiveSessionKind = "executor" | "step-session" | "workflow-step" | "step-session-parallel" | "ai-merge" | "workspace-repo-acquire" | "workspace-repo-land";

export interface ActiveSessionRegistration {
  taskId: string;
  kind: ActiveSessionKind;
  ownerKey: string;
}

export interface ActiveSessionRecord extends ActiveSessionRegistration {
  registeredAt: number;
}

export interface ReconcileStaleSelfOwnedResult {
  reconciled: boolean;
  reason: "no-entry" | "foreign-task" | "reconciled";
}

export type LiveBindingProbe = (worktreePath: string, taskId: string) => boolean;
export type ProcessActiveProbe = (taskId: string) => boolean;

export type SelfOwnedReconcileOutcome =
  | { action: "no-entry" }
  | { action: "foreign-task"; ownerTaskId: string }
  | { action: "live-binding-refuses"; ownerTaskId: string }
  | { action: "process-active-refuses"; ownerTaskId: string }
  | { action: "too-recent-refuses"; ownerTaskId: string; ageMs: number; minIdleMs: number }
  | { action: "reconciled" };

/**
 * FN-5256: default minimum age before a self-owned registry entry can be classified
 * as stale. Recently-registered entries belong to an executor cycle that is still
 * warming up (e.g., a pause/resume that hasn't repopulated activeWorktrees yet), so
 * dropping them races with the live shell that just attached to the worktree.
 */
export const DEFAULT_SELF_OWNED_MIN_IDLE_MS = 5000;

/*
FNXC:Workspace 2026-06-22-04:10 (Phase C review A2):
Thrown by registerPath when a register would overwrite an entry held by a DIFFERENT
task on the same path. Surfacing this (rather than silently clobbering) is what stops a
merging task's land lease from yanking an executing task's acquire lease on a shared
sub-repo. Same-task re-registration is allowed and never throws.
*/
export class ActiveSessionPathHeldByForeignTaskError extends Error {
  constructor(
    public readonly path: string,
    public readonly holderTaskId: string,
    public readonly requestingTaskId: string,
  ) {
    super(
      `active-session path ${path} is held by task ${holderTaskId}; task ${requestingTaskId} may not overwrite it`,
    );
    this.name = "ActiveSessionPathHeldByForeignTaskError";
  }
}

export class ActiveSessionRegistry {
  private readonly records = new Map<string, ActiveSessionRecord>();

  /*
  FNXC:Workspace 2026-06-22-04:10 (Phase C review A2 — taskId-aware lease across kinds):
  registerPath previously OVERWROTE any existing entry on the path (only console.warn).
  Because the land lease ("workspace-repo-land") and the execution acquire lease
  ("workspace-repo-acquire") key the SAME sub-repo absolute path, an overwrite let a
  MERGING task clobber an EXECUTING task's acquire-lease on a shared sub-repo (cross-phase
  clobber). We now REJECT a register that would overwrite an entry held by a DIFFERENT
  taskId — regardless of kind — by throwing. Only the SAME task may re-register its own
  path (idempotent re-registration stays working; this is how an executor re-claims/refreshes
  its own entry). Callers that may contend (the land lease) must lookupByPath-then-throw a
  domain busy error BEFORE calling registerPath so they surface contention as a retryable
  condition rather than this raw guard throw; this guard is the last-line safety net.
  */
  registerPath(worktreePath: string, registration: ActiveSessionRegistration): void {
    const existing = this.records.get(worktreePath);
    if (existing && existing.taskId !== registration.taskId) {
      throw new ActiveSessionPathHeldByForeignTaskError(worktreePath, existing.taskId, registration.taskId);
    }
    this.records.set(worktreePath, {
      ...registration,
      registeredAt: Date.now(),
    });
  }

  unregisterPath(worktreePath: string): void {
    this.records.delete(worktreePath);
  }

  lookupByPath(worktreePath: string): ActiveSessionRecord | null {
    return this.records.get(worktreePath) ?? null;
  }

  isPathActive(worktreePath: string): boolean {
    return this.records.has(worktreePath);
  }

  pathsForTask(taskId: string): string[] {
    const paths: string[] = [];
    for (const [path, record] of this.records.entries()) {
      if (record.taskId === taskId) {
        paths.push(path);
      }
    }
    return paths;
  }

  /*
  FNXC:Workspace 2026-06-22-09:30 (Phase D U1, KTD3 — enumeration seam for phantom-lease reclaim):
  The existing accessors are path-first (lookupByPath / isPathActive) or task-first
  (pathsForTask). Phantom-lease reclaim needs the inverse: enumerate every live entry of a
  given KIND so self-healing can find a leaked "workspace-repo-land" lease whose owning task is
  already terminal/dead. A dead task is gone from the in-progress lists, so FN-6736's
  iterate-tasks approach cannot surface the lease — it must be discovered from the registry
  itself. Returns shallow copies (path + the full record fields incl. `registeredAt`, already
  tracked) so callers can age-gate against the FN-6736 staleness floor without holding a
  reference into the internal map.
  */
  entriesByKind(kind: ActiveSessionKind): Array<{ path: string; taskId: string; kind: ActiveSessionKind; registeredAt: number }> {
    const out: Array<{ path: string; taskId: string; kind: ActiveSessionKind; registeredAt: number }> = [];
    for (const [path, record] of this.records.entries()) {
      if (record.kind === kind) {
        out.push({ path, taskId: record.taskId, kind: record.kind, registeredAt: record.registeredAt });
      }
    }
    return out;
  }

  reconcileStaleSelfOwned(worktreePath: string, expectedTaskId: string): ReconcileStaleSelfOwnedResult {
    const record = this.lookupByPath(worktreePath);
    if (!record) {
      return { reconciled: false, reason: "no-entry" };
    }
    if (record.taskId !== expectedTaskId) {
      return { reconciled: false, reason: "foreign-task" };
    }

    this.unregisterPath(worktreePath);
    return { reconciled: true, reason: "reconciled" };
  }

  clear(): void {
    this.records.clear();
  }
}

export interface SelfOwnedReconcileOptions {
  /**
   * Process-wide "executor still owns this task" probe. When this returns true the
   * caller's task is still in the middle of an `execute()` invocation, so dropping
   * the registry entry would yank the worktree from a live shell (FN-5256).
   */
  processActiveProbe?: ProcessActiveProbe;
  /**
   * Minimum age (ms since `registeredAt`) before a same-task entry is eligible for
   * stale reconciliation. Recently-registered entries belong to a warming executor
   * cycle and must be left alone. Defaults to `DEFAULT_SELF_OWNED_MIN_IDLE_MS`.
   */
  minIdleMs?: number;
  /** Test seam — defaults to `Date.now()`. */
  now?: () => number;
}

export function reconcileSelfOwnedActiveSessionForRemoval(
  registry: ActiveSessionRegistry,
  worktreePath: string,
  requestingTaskId: string,
  liveBindingProbe: LiveBindingProbe,
  options: SelfOwnedReconcileOptions = {},
): SelfOwnedReconcileOutcome {
  const record = registry.lookupByPath(worktreePath);
  if (!record) {
    return { action: "no-entry" };
  }

  if (record.taskId !== requestingTaskId) {
    return { action: "foreign-task", ownerTaskId: record.taskId };
  }

  if (liveBindingProbe(worktreePath, requestingTaskId)) {
    return { action: "live-binding-refuses", ownerTaskId: requestingTaskId };
  }

  if (options.processActiveProbe?.(requestingTaskId)) {
    return { action: "process-active-refuses", ownerTaskId: requestingTaskId };
  }

  const minIdleMs = options.minIdleMs ?? DEFAULT_SELF_OWNED_MIN_IDLE_MS;
  if (minIdleMs > 0) {
    const now = options.now?.() ?? Date.now();
    const ageMs = now - record.registeredAt;
    if (ageMs < minIdleMs) {
      return { action: "too-recent-refuses", ownerTaskId: requestingTaskId, ageMs, minIdleMs };
    }
  }

  registry.unregisterPath(worktreePath);
  return { action: "reconciled" };
}

export const activeSessionRegistry = new ActiveSessionRegistry();

/**
 * FN-4811 follow-up: process-wide "executing" lock for `TaskExecutor.execute()`.
 *
 * Per-instance `executing: Set<string>` is insufficient when there can be more than
 * one TaskExecutor instance in the same Node process (e.g., multi-project setups,
 * engine restarts that race with old instance teardown, hybrid-executor path).
 * Production failure shape: two execute() invocations for the same task ID both
 * generated runIds (y2nb + 9gde for FN-4809), both reached "Executor detected stale
 * merge state" (executor.ts:2661), both attempted worktree creation — producing
 * duplicate "Worktree created at /..." log entries within the same second
 * (FN-4809, FN-4814, FN-4781, FN-4804, FN-4811).
 *
 * This module-level Set is shared across all TaskExecutor instances in the process,
 * providing a process-wide claim. Values are taskId strings; presence means
 * "someone is actively executing this task". Callers MUST claim synchronously
 * via `tryClaim()` and MUST release on every exit path.
 */
const executingTasks = new Set<string>();

export const executingTaskLock = {
  has(taskId: string): boolean {
    return executingTasks.has(taskId);
  },
  /** Synchronously claim the lock. Returns true if claimed, false if already held. */
  tryClaim(taskId: string): boolean {
    if (executingTasks.has(taskId)) return false;
    executingTasks.add(taskId);
    return true;
  },
  release(taskId: string): void {
    executingTasks.delete(taskId);
  },
  /** Test-only: clear all entries. */
  _clearForTest(): void {
    executingTasks.clear();
  },
};
