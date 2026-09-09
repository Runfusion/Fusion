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
/*
FNXC:NodeWorktreeIsolation 2026-07-26-09:10:
"planning" exists because FNXC:NodeWorktreeIsolation 2026-07-25-22:10 moved the triage/planning
session out of the shared checkout and into the TASK's own worktree, but planning never registered
that path here. Every liveness guard keyed on this registry — above all the FN-4819 skip in
`SelfHealingManager`'s self-owned-branch reclaim sweep (`isPathActive(task.worktree)`) — was
therefore blind to a live planner. Observed failure (FN-8600, 2026-07-26): the sweep saw a
zero-commit `fusion/fn-8600` whose tip trivially equals the integration ref, classified it
`tip-already-merged`, ran `git worktree remove --force` against the worktree a planning session was
running in, and escalated the resulting failure to `branch-conflict-unrecoverable` — parking a
healthy card `paused` with no operator action. A planner holding a worktree is a live session and
must be as visible as an executor or merger.
*/
/*
FNXC:TaskDeletionWorktrees 2026-09-07-12:44:
Deletion cleanup reserves each canonical target exclusively in the shared registry while Git removes it.
Unlike ordinary same-task session refreshes, neither a same-task session nor another cleanup may replace
this reservation, and cleanup cannot replace a session that won the race first.

FNXC:TaskDeletionWorktrees 2026-09-07-13:06:
An exclusive deletion claim has an opaque release token. Session teardown and stale-entry reconcilers may
still call the legacy path-only release after losing acquisition, but that call cannot clear the cleanup
claim while destructive Git work is in flight; only the cleanup owner holding the token can release it.
*/
export type ActiveSessionKind = "executor" | "planning" | "step-session" | "workflow-step" | "step-session-parallel" | "ai-merge" | "workspace-repo-acquire" | "workspace-repo-land" | "task-deletion-cleanup";

export interface ActiveSessionRegistration {
  taskId: string;
  kind: ActiveSessionKind;
  ownerKey: string;
}

export interface ActiveSessionRecord extends ActiveSessionRegistration {
  registeredAt: number;
}

export interface ActiveSessionPathLease {
  readonly path: string;
  readonly releaseToken: symbol;
}

export interface ReconcileStaleSelfOwnedResult {
  reconciled: boolean;
  reason: "no-entry" | "foreign-task" | "exclusive-reservation" | "reconciled";
}

export type LiveBindingProbe = (worktreePath: string, taskId: string) => boolean;
export type ProcessActiveProbe = (taskId: string) => boolean;

export type SelfOwnedReconcileOutcome =
  | { action: "no-entry" }
  | { action: "foreign-task"; ownerTaskId: string }
  | { action: "live-binding-refuses"; ownerTaskId: string }
  | { action: "process-active-refuses"; ownerTaskId: string }
  | { action: "too-recent-refuses"; ownerTaskId: string; ageMs: number; minIdleMs: number }
  | { action: "exclusive-reservation-refuses"; ownerTaskId: string }
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

export class ActiveSessionPathHeldError extends Error {
  constructor(
    public readonly path: string,
    public readonly holder: ActiveSessionRecord,
    public readonly requesting: ActiveSessionRegistration,
  ) {
    super(`active-session path ${path} is held by ${holder.kind} (${holder.ownerKey})`);
    this.name = "ActiveSessionPathHeldError";
  }
}

export class ActiveSessionRegistry {
  private readonly records = new Map<string, ActiveSessionRecord>();
  private readonly exclusiveReleaseTokens = new Map<string, symbol>();

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
    if (existing?.kind === "task-deletion-cleanup") {
      throw new ActiveSessionPathHeldError(worktreePath, existing, registration);
    }
    this.records.set(worktreePath, {
      ...registration,
      registeredAt: Date.now(),
    });
  }

  /** FNXC:TaskDeletionWorktrees 2026-09-07-13:06: Claim a path exclusively and return its only valid release proof. */
  registerPathExclusive(worktreePath: string, registration: ActiveSessionRegistration): ActiveSessionPathLease {
    const existing = this.records.get(worktreePath);
    if (existing) throw new ActiveSessionPathHeldError(worktreePath, existing, registration);
    const releaseToken = Symbol("active-session-exclusive-release");
    this.records.set(worktreePath, {
      ...registration,
      registeredAt: Date.now(),
    });
    this.exclusiveReleaseTokens.set(worktreePath, releaseToken);
    return { path: worktreePath, releaseToken };
  }

  unregisterPath(worktreePath: string, lease?: ActiveSessionPathLease): boolean {
    const requiredToken = this.exclusiveReleaseTokens.get(worktreePath);
    if (requiredToken !== undefined && (lease?.path !== worktreePath || lease.releaseToken !== requiredToken)) {
      return false;
    }
    this.exclusiveReleaseTokens.delete(worktreePath);
    return this.records.delete(worktreePath);
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

    if (!this.unregisterPath(worktreePath)) {
      return { reconciled: false, reason: "exclusive-reservation" };
    }
    return { reconciled: true, reason: "reconciled" };
  }

  clear(): void {
    this.records.clear();
    this.exclusiveReleaseTokens.clear();
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

/*
FNXC:SessionContention 2026-07-25-21:30 (contention prevention — foreign-stale reclaim):
Registration contention has exactly three shapes, and only one of them is legitimate:
  1. Two tasks on the SHARED repo root. Not real contention — read-only root-rooted sessions need no
     path exclusivity. Eliminated by construction: `sessionRegistryPath` task-scopes the root key.
  2. A LEAKED entry whose owning task is dead (crashed run, torn-down executor, engine restart that
     lost the session but not the map). Waiting for that holder is waiting forever — the holder will
     never release. Reclaim it, which is what this seam does.
  3. A LIVE holder on the same path. This is genuine serialization (the workspace sub-repo leases are
     built on it) and the caller must wait, never overwrite.
So: probe the holder for liveness, reclaim when it is provably dead AND the entry has aged past the
FN-5256 staleness floor (a just-registered entry belongs to a warming session whose maps are not
populated yet — treating it as dead would yank a live shell), and surface a typed contention error only
for case 3. `holderLiveProbe` returning true is always respected; an unknown/throwing probe must be
reported as LIVE by its caller so ambiguity refuses the reclaim.
*/
export type ForeignHolderLiveProbe = (holderTaskId: string, path: string) => boolean;

export type AcquireActiveSessionPathOutcome =
  | { action: "registered" }
  | { action: "reclaimed-stale-foreign"; holderTaskId: string; ageMs: number }
  | { action: "contended"; holderTaskId: string; holderKind: ActiveSessionKind; ageMs: number };

export interface AcquireActiveSessionPathOptions {
  /** Returns true when the foreign holder still has a live session/execution surface. */
  holderLiveProbe?: ForeignHolderLiveProbe;
  /**
   * Opt-in cross-phase fence. When set, a stale foreign holder of another kind
   * remains contended so acquire and land claims sharing a path never reclaim
   * each other. The default preserves the existing generic session behavior.
   */
  restrictReclaimToKind?: ActiveSessionKind;
  /** Minimum entry age before a foreign entry may be reclaimed. Defaults to `DEFAULT_SELF_OWNED_MIN_IDLE_MS`. */
  minIdleMs?: number;
  /** Test seam — defaults to `Date.now()`. */
  now?: () => number;
}

export function acquireActiveSessionPath(
  registry: ActiveSessionRegistry,
  path: string,
  registration: ActiveSessionRegistration,
  options: AcquireActiveSessionPathOptions = {},
): AcquireActiveSessionPathOutcome {
  const existing = registry.lookupByPath(path);
  if (!existing || existing.taskId === registration.taskId) {
    registry.registerPath(path, registration);
    return { action: "registered" };
  }

  const now = options.now?.() ?? Date.now();
  const ageMs = now - existing.registeredAt;
  const minIdleMs = options.minIdleMs ?? DEFAULT_SELF_OWNED_MIN_IDLE_MS;
  const holderIsLive = options.holderLiveProbe?.(existing.taskId, path) ?? true;
  if (existing.kind !== options.restrictReclaimToKind && options.restrictReclaimToKind !== undefined) {
    return { action: "contended", holderTaskId: existing.taskId, holderKind: existing.kind, ageMs };
  }
  if (holderIsLive || ageMs < minIdleMs) {
    return { action: "contended", holderTaskId: existing.taskId, holderKind: existing.kind, ageMs };
  }

  registry.unregisterPath(path);
  registry.registerPath(path, registration);
  return { action: "reclaimed-stale-foreign", holderTaskId: existing.taskId, ageMs };
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

  if (!registry.unregisterPath(worktreePath)) {
    return { action: "exclusive-reservation-refuses", ownerTaskId: requestingTaskId };
  }
  return { action: "reconciled" };
}

export const activeSessionRegistry = new ActiveSessionRegistry();

/** Opaque proof that one concrete implementation attempt owns a task. */
export interface ExecutingTaskLease {
  readonly taskId: string;
  readonly token: symbol;
}

export type ExecutingTaskCriticalResult<T> =
  | { executed: true; value: T }
  | { executed: false };

/*
FNXC:StuckSessionOwnership 2026-09-07-16:11:
FN-312 requires process-wide execution ownership to distinguish successive attempts for the same task. Every persistent or task-keyed cleanup performed during unwind must validate its opaque lease inside the same per-task FIFO critical section that remains held until the asynchronous operation settles. Forced stuck recovery invalidates through that FIFO before dispatching a successor, so an old check cannot race a later store mutation and an old finally cannot release the successor.

The critical section is deliberately non-reentrant. Its callback may await TaskStore APIs, but code holding a TaskStore transaction or advisory lock must never call back into this lock; the single order is execution critical section, then store API.

FNXC:StuckSessionOwnership 2026-09-07-17:15:
Forced replacement reserves its FIFO position before issuing synchronous interruption signals. This lets an already-entered owner finish safely while preventing any successor claim from publishing before abort settlement, task-keyed cleanup, and invalidation complete.
*/
const executingTaskOwners = new Map<string, ExecutingTaskLease>();
const executingTaskCriticalTails = new Map<string, Promise<void>>();

async function inExecutingTaskCriticalSection<T>(
  taskId: string,
  callback: () => Promise<T> | T,
  afterReservation?: () => void,
): Promise<T> {
  const previous = executingTaskCriticalTails.get(taskId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => current);
  executingTaskCriticalTails.set(taskId, tail);
  let reservationError: unknown;
  try {
    afterReservation?.();
  } catch (error) {
    reservationError = error;
  }
  await previous;
  try {
    if (reservationError !== undefined) throw reservationError;
    return await callback();
  } finally {
    release();
    if (executingTaskCriticalTails.get(taskId) === tail) {
      executingTaskCriticalTails.delete(taskId);
    }
  }
}

export const executingTaskLock = {
  has(taskId: string): boolean {
    return executingTaskOwners.has(taskId);
  },
  /** Claim ownership synchronously and return the attempt-specific proof. */
  claim(taskId: string): ExecutingTaskLease | null {
    if (executingTaskOwners.has(taskId)) return null;
    const lease = { taskId, token: Symbol(`executing-task:${taskId}`) };
    executingTaskOwners.set(taskId, lease);
    return lease;
  },
  /** Legacy boolean claim for bounded external repair owners. New execution paths use `claim`. */
  tryClaim(taskId: string): boolean {
    return this.claim(taskId) !== null;
  },
  owns(lease: ExecutingTaskLease): boolean {
    return executingTaskOwners.get(lease.taskId)?.token === lease.token;
  },
  async runIfOwner<T>(lease: ExecutingTaskLease, callback: () => Promise<T> | T): Promise<ExecutingTaskCriticalResult<T>> {
    return inExecutingTaskCriticalSection(lease.taskId, async () => {
      if (!this.owns(lease)) return { executed: false };
      return { executed: true, value: await callback() };
    });
  },
  async invalidate<T>(lease: ExecutingTaskLease, callback?: () => Promise<T> | T): Promise<ExecutingTaskCriticalResult<T | undefined>> {
    return inExecutingTaskCriticalSection(lease.taskId, async () => {
      if (!this.owns(lease)) return { executed: false };
      try {
        const value = await callback?.();
        return { executed: true, value };
      } finally {
        executingTaskOwners.delete(lease.taskId);
      }
    });
  },
  /** Reserve invalidation before synchronously interrupting work, then settle it inside that reservation. */
  async invalidateWithSignal<S, T>(
    lease: ExecutingTaskLease,
    signal: () => S,
    callback: (signalResult: S) => Promise<T> | T,
  ): Promise<ExecutingTaskCriticalResult<T>> {
    /*
    FNXC:StuckSessionOwnership 2026-09-07-18:08:
    A stuck timer retains the lease captured when it was armed. Ownership must be checked synchronously
    before reserving the FIFO and signaling abort, because a gracefully unwound attempt may already have
    installed its successor. The check and reservation share one JavaScript turn, so no successor can
    interleave; the queued check below remains the authority after earlier critical work settles.
    */
    if (!this.owns(lease)) return { executed: false };
    let signalResult!: S;
    return inExecutingTaskCriticalSection(lease.taskId, async () => {
      if (!this.owns(lease)) return { executed: false };
      /*
      FNXC:StuckSessionOwnership 2026-09-07-17:45:
      Once forced invalidation owns its FIFO turn, callback failure must not resurrect the attempt.
      Publication therefore occurs in finally; callers keep user-control reads fail-closed and may
      decline successor dispatch, but a failed auxiliary write can never strand the stale lease.
      */
      try {
        const value = await callback(signalResult);
        return { executed: true, value };
      } finally {
        executingTaskOwners.delete(lease.taskId);
      }
    }, () => {
      signalResult = signal();
    });
  },
  release(taskId: string, lease?: ExecutingTaskLease): void {
    if (lease && !this.owns(lease)) return;
    executingTaskOwners.delete(taskId);
  },
  currentLease(taskId: string): ExecutingTaskLease | null {
    return executingTaskOwners.get(taskId) ?? null;
  },
  /** Test-only: clear all entries and FIFO state. */
  _clearForTest(): void {
    executingTaskOwners.clear();
    executingTaskCriticalTails.clear();
  },
};
