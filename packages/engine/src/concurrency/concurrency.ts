import {
  compareTaskIdNumeric,
  countRunningAgentTasks,
  enrichRunningAgentTaskShape,
  resolveWorkflowIrForTask,
  type Task,
  type WorkflowIrResolverStore,
} from "@fusion/core";
import { createLogger } from "../logger.js";

const concurrencyLog = createLogger("concurrency");

/** Priority level for merge agents — served first. */
export const PRIORITY_MERGE = 2;
/** Priority level for execution agents — served after merge, before specify. */
export const PRIORITY_EXECUTE = 1;
/** Priority level for specification/triage agents — served last (default). */
export const PRIORITY_SPECIFY = 0;

/** A task waiting to enter one of the top-level agent lanes. */
export interface AdmissionCandidate {
  taskId: string;
  projectId: string;
  createdAt?: string;
  /** Records ownership of the host reservation before the lane starts. */
  reserve?: () => void;
  /**
   * Starts the owning lane after this coordinator has atomically reserved a slot.
   * Return `false` when the lane rejects the handoff before it has accepted the
   * reservation; this makes the coordinator release capacity in one place.
   */
  start: () => Promise<boolean | void>;
}

/** A lane contributes its current ready work on every project admission pass. */
export interface AdmissionProvider {
  projectId: string;
  refresh: () => Promise<AdmissionCandidate[]>;
}

/**
 * Deterministic oldest-first ordering used for all task-lane admission.
 * Invalid/missing timestamps deliberately sort after valid timestamps; numeric
 * task ids break normal ties before lexical ids so a malformed fixture cannot
 * make Array.sort's NaN handling decide capacity admission.
 */
export function compareAdmissionCandidates(a: Pick<AdmissionCandidate, "taskId" | "createdAt">, b: Pick<AdmissionCandidate, "taskId" | "createdAt">): number {
  const aTime = a.createdAt ? Date.parse(a.createdAt) : Number.NaN;
  const bTime = b.createdAt ? Date.parse(b.createdAt) : Number.NaN;
  const aValid = Number.isFinite(aTime);
  const bValid = Number.isFinite(bTime);
  if (aValid !== bValid) return aValid ? -1 : 1;
  if (aValid && aTime !== bTime) return aTime - bTime;
  const numeric = compareTaskIdNumeric(a.taskId, b.taskId);
  return numeric !== 0 ? numeric : a.taskId.localeCompare(b.taskId);
}

/*
FNXC:ConcurrencyAdmission 2026-08-03-12:00:
FN-8453 / #2359 requires a per-project oldest-first authority rather than
independent triage/execute/merge polls or semaphore lane priority. Lanes refresh
candidates then hand their starts here; nested runNested helpers are deliberately
not candidates because they remain parent-internal soft breaches.
*/
export class ProjectAdmissionCoordinator {
  private draining = new Map<string, Promise<void>>();
  private providers = new Map<string, Map<string, AdmissionProvider>>();
  /**
   * Reservations bridge coordinator selection and durable task liveness. They
   * are deliberately project-scoped, so a prompt handoff cannot let a second
   * same-project admission observe stale persisted rows and exceed maxConcurrent.
   */
  private reservations = new Map<string, Set<string>>();

  private reserve(projectId: string, taskId: string): void {
    const tasks = this.reservations.get(projectId) ?? new Set<string>();
    tasks.add(taskId);
    this.reservations.set(projectId, tasks);
  }

  releaseReservation(taskId: string): void {
    for (const [projectId, tasks] of this.reservations) {
      if (!tasks.delete(taskId)) continue;
      if (tasks.size === 0) this.reservations.delete(projectId);
      return;
    }
  }

  private reservationCount(projectId: string): number {
    return this.reservations.get(projectId)?.size ?? 0;
  }

  /** Register a lane's refresh source. Re-registering replaces its prior source. */
  registerProvider(providerId: string, provider: AdmissionProvider): () => void {
    const projectProviders = this.providers.get(provider.projectId) ?? new Map<string, AdmissionProvider>();
    projectProviders.set(providerId, provider);
    this.providers.set(provider.projectId, projectProviders);
    return () => {
      const current = this.providers.get(provider.projectId);
      current?.delete(providerId);
      if (current?.size === 0) this.providers.delete(provider.projectId);
    };
  }

  async admitOldest(params: {
    projectId: string;
    maxConcurrent: number;
    claimed: () => Promise<number> | number;
    /** One-shot source for callers that do not hold a durable lane registration. */
    refresh?: () => Promise<AdmissionCandidate[]>;
    semaphore?: Pick<AgentSemaphore, "tryAcquire" | "release">;
  }): Promise<string | undefined> {
    const existing = this.draining.get(params.projectId);
    if (existing) await existing;
    let admitted: string | undefined;
    const drain = (async () => {
      const providers = [...(this.providers.get(params.projectId)?.values() ?? [])];
      if (params.refresh) providers.push({ projectId: params.projectId, refresh: params.refresh });
      const candidates = (await Promise.all(providers.map((provider) => provider.refresh())))
        .flat()
        .filter((candidate) => candidate.projectId === params.projectId)
        .sort(compareAdmissionCandidates);
      // FNXC:ConcurrencyAdmission 2026-08-06-12:00: FN-8453/#2359 requires
      // in-memory handoffs to count until they either become live or are dropped.
      // Persisted task rows lag a fire-and-forget lane start, so omitting these
      // reservations lets a second coordinator pass over-admit one project.
      if (candidates.length === 0 || (await params.claimed()) + this.reservationCount(params.projectId) >= params.maxConcurrent) return;
      const winner = candidates[0];
      // Older test/runtime semaphore wrappers predate tryAcquire. They still
      // exercise project admission, while production semaphores atomically take
      // the host slot here.
      const hasReservableHostSlot = typeof params.semaphore?.tryAcquire === "function";
      const acquiredHostSlot = hasReservableHostSlot
        ? params.semaphore!.tryAcquire()
        : true;
      if (!acquiredHostSlot) return;
      // Compatibility-only semaphore shims cannot hold a reservation. Their
      // lane tests provide claimed() synchronously, while real host semaphores
      // use this durable marker until take/drop below.
      if (hasReservableHostSlot) this.reserve(params.projectId, winner.taskId);
      try {
        winner.reserve?.();
        const accepted = await winner.start();
        if (accepted === false) {
          this.releaseReservation(winner.taskId);
          params.semaphore?.release();
          return;
        }
        admitted = winner.taskId;
      } catch (error) {
        this.releaseReservation(winner.taskId);
        params.semaphore?.release();
        throw error;
      }
    })();
    this.draining.set(params.projectId, drain);
    try {
      await drain;
      return admitted;
    } finally {
      if (this.draining.get(params.projectId) === drain) this.draining.delete(params.projectId);
    }
  }
}

/** Shared coordinator instance used by lane polls in this engine process. */
export const projectAdmissionCoordinator = new ProjectAdmissionCoordinator();

/** A waiter entry that tracks both the priority and the resolve callback. */
interface PriorityWaiter {
  priority: number;
  resolve: () => void;
  /** Optional reject for abortable acquires — not used by the priority drain path. */
  reject?: (err: Error) => void;
}

export const IDLE_SEMAPHORE_LEAK_REPAIR_MS = 5_000;

/**
 * FNXC:GlobalConcurrencyControls 2026-07-16-00:00:
 * Repair window for the NON-idle stale-excess case (semaphore holds more slots
 * than persisted running tasks + caller in-flight sessions while some agent
 * work is still persisted-running). Deliberately much longer than the idle
 * window: nested helper agents ({@link AgentSemaphore.runNested}) legitimately
 * push `activeCount` above the persisted top-level count for the duration of a
 * nested run, so an excess must persist far longer than any plausible nested
 * session before it is treated as leaked. A real leak (observed in production:
 * slots pinned at the limit for days with planning=0/processing=0 while a few
 * zombie in-progress rows kept the idle valve from ever firing) survives this
 * window trivially; a live nested reviewer does not.
 */
export const STALE_SEMAPHORE_EXCESS_REPAIR_MS = 600_000;

function createAbortError(): Error {
  if (typeof DOMException === "function") {
    try {
      return new DOMException("The operation was aborted", "AbortError");
    } catch {
      // fall through
    }
  }
  const err = new Error("The operation was aborted");
  err.name = "AbortError";
  return err;
}

/*
FNXC:GlobalConcurrencyControls 2026-07-14-18:30:
Operators reported live running-agent counts above the global concurrency cap (e.g. 5 running with cap 4). Live utilization counts every top-level slot holder (in-progress, planning triage, active in-review), but the scheduler only preflighted capacity and acquired the shared semaphore later inside the executor — so a card could sit in-progress (and count as running) while triage still saw free semaphore slots and filled the rest of the cap. Pre-held executor slots close that gap: tryAcquire before todo→in-progress, keep the slot until the executor/graph run claims and releases it, and admit triage against max(semaphore.activeCount, live running count).

FNXC:GlobalConcurrencyControls 2026-07-15-03:50:
Hard invariant: registerPreHeldExecutorSlot may only run immediately after a successful semaphore.tryAcquire() for that same task, and every registration must later be either take()d (caller releases the semaphore) or drop()d (releases the semaphore). The Set is process-local soft state decoupled from activeCount except via this discipline — acquire-without-register or register-without-acquire desyncs capacity accounting.
*/
const preHeldExecutorSlots = new Set<string>();

/**
 * Register a semaphore slot that was **just** acquired via `tryAcquire` for a task about to enter in-progress.
 * Must not be called without a matching prior acquire; pair with take() or drop().
 */
export function registerPreHeldExecutorSlot(taskId: string): void {
  preHeldExecutorSlots.add(taskId);
}

/**
 * Transfer ownership of a pre-held executor slot to the caller.
 * Returns true when a slot was registered; the caller MUST release the underlying semaphore in its finally path.
 */
export function takePreHeldExecutorSlot(taskId: string): boolean {
  const taken = preHeldExecutorSlots.delete(taskId);
  if (taken) projectAdmissionCoordinator.releaseReservation(taskId);
  return taken;
}

/** Drop a pre-held slot without transferring ownership (failed reserve / cancelled dispatch). Optionally releases the semaphore. */
export function dropPreHeldExecutorSlot(taskId: string, semaphore?: { release(): void }): void {
  if (!preHeldExecutorSlots.delete(taskId)) return;
  // FNXC:ConcurrencyAdmission 2026-08-06-12:00: every rejection path funnels
  // through this helper, so releasing the matching coordinator marker here
  // prevents early scheduler/triage returns from permanently consuming a slot.
  projectAdmissionCoordinator.releaseReservation(taskId);
  semaphore?.release();
}

/** Test/helper: whether a task currently has an unclaimed pre-held executor slot. */
export function hasPreHeldExecutorSlot(taskId: string): boolean {
  return preHeldExecutorSlots.has(taskId);
}

/** Test helper: clear all pre-held registrations without releasing semaphore slots. */
export function clearPreHeldExecutorSlotsForTests(): void {
  preHeldExecutorSlots.clear();
}

/**
 * FNXC:GlobalConcurrencyControls 2026-06-27-00:00:
 * Persisted semaphore repair must use the same top-level slot predicate as dashboard and CLI live counts, including active in-review agents, so read-layer utilization and engine recovery cannot drift.
 */
export function persistedTopLevelAgentSlots(tasks: Task[]): number {
  return countRunningAgentTasks(tasks);
}

/**
 * Store-backed claim counts must enrich workflow traits before using the pure
 * predicate; raw `persistedTopLevelAgentSlots` remains for pre-enriched tests
 * and callers that cannot resolve an IR.
 */
export async function persistedTopLevelAgentSlotsFromStore(store: WorkflowIrResolverStore, tasks: Task[]): Promise<number> {
  const irCache = new Map();
  const enriched = await Promise.all(tasks.map(async (task) => {
    const ir = await resolveWorkflowIrForTask(store, task.id, irCache);
    return enrichRunningAgentTaskShape(task, ir);
  }));
  return countRunningAgentTasks(enriched);
}

/**
 * FNXC:GlobalConcurrencyControls 2026-07-14-18:30:
 * Admission control for new top-level agents must use the same running-agent predicate the dashboard shows next to the global/project caps. Prefer the larger of live task-based holders and in-memory semaphore activeCount so neither under-counts the other during the brief window between column/status writes and acquire/release.
 */
export function computeTopLevelConcurrencyClaimed(params: {
  tasks: readonly Task[];
  /**
   * Retained for compatibility but intentionally excluded from this
   * project-local claim. The host semaphore is a separate process-wide gate.
   */
  semaphoreActiveCount?: number;
  /** specifyTask calls that have entered `processing` but not yet written status:"planning". */
  pendingSpecifyCount?: number;
}): number {
  const persisted = countRunningAgentTasks(params.tasks);
  const pending = Math.max(0, Math.floor(params.pendingSpecifyCount ?? 0));
  return persisted + pending;
}

/**
 * Store-backed production counterpart to {@link computeTopLevelConcurrencyClaimed}.
 *
 * FNXC:ConcurrencyAdmission 2026-08-03-12:00:
 * FN-8453 forbids admission from raw task rows whenever workflow IR is available:
 * custom complete/archived columns can retain stale session metadata, so each row
 * must be trait-enriched before it is allowed to occupy a top-level capacity slot.
 */
export async function computeTopLevelConcurrencyClaimedFromStore(params: {
  store: WorkflowIrResolverStore;
  tasks: Task[];
  /** Host semaphore activity must never consume this project's capacity. */
  semaphoreActiveCount?: number;
  pendingSpecifyCount?: number;
}): Promise<number> {
  const persisted = await persistedTopLevelAgentSlotsFromStore(params.store, params.tasks);
  const pending = Math.max(0, Math.floor(params.pendingSpecifyCount ?? 0));
  return persisted + pending;
}

export interface IdleSemaphoreLeakRecoveryResult {
  candidateSinceMs: number | null;
  reconciliation?: { before: number; after: number; changed: boolean };
}

/*
FNXC:GlobalConcurrencyControls 2026-07-16-00:00:
Generalized from the idle-only valve. The previous guard (`persistedActive !== 0
|| inFlightCount > 0` → reset) meant leaked slots were only ever reclaimed when
the WHOLE system quiesced. In production a handful of zombie in-progress rows
kept `persistedActive` nonzero indefinitely, so slots leaked by abnormal agent
teardown accumulated until `activeCount` pinned the limit — the engine then sat
fully idle ("Hold release … no reservable slot" on every sweep, planning=0,
processing=0, merge queue growing) until a process restart. The valve now
clamps `activeCount` down to the persisted+in-flight bound whenever the
semaphore over-holds CONTINUOUSLY for the repair window: the strict idle case
keeps its fast 5s window (same behavior as before), while the non-idle case
uses the conservative {@link STALE_SEMAPHORE_EXCESS_REPAIR_MS} so legitimate
nested-agent overshoot is never touched. `reconcileActiveCount` only lowers
the count, and the candidate timestamp resets the moment the excess clears.
*/
export function recoverIdleSemaphoreLeakCandidate(params: {
  semaphore: AgentSemaphore | undefined;
  tasks: Task[];
  candidateSinceMs: number | null;
  inFlightCount?: number;
  nowMs?: number;
  repairAfterMs?: number;
  /** Override for the non-idle stale-excess window (tests). */
  staleExcessRepairAfterMs?: number;
}): IdleSemaphoreLeakRecoveryResult {
  const {
    semaphore,
    tasks,
    candidateSinceMs,
    inFlightCount = 0,
    nowMs = Date.now(),
    repairAfterMs = IDLE_SEMAPHORE_LEAK_REPAIR_MS,
    staleExcessRepairAfterMs = STALE_SEMAPHORE_EXCESS_REPAIR_MS,
  } = params;

  if (!semaphore) return { candidateSinceMs: null };

  const persistedActive = persistedTopLevelAgentSlots(tasks);
  const bound = persistedActive + Math.max(0, Math.floor(inFlightCount));
  /*
  FNXC:GlobalConcurrencyControls 2026-07-17-00:00:
  Exclude live nested helper-agent slots from the reclaimable excess (and from
  the reconcile target). Nested runs legitimately hold slots above `bound`, so
  counting them as excess would let a leaked slot's continuous-excess timer
  reclaim a nested slot that only just started — reconciling away live work and
  admitting an extra session (Greptile PR #2265, "Candidate Outlives Slot
  Ownership"). With nested excluded, `excess` reflects only slots the semaphore
  holds beyond persisted top-level work + caller in-flight + live nested runs —
  i.e. genuinely leaked slots — and the reclaim floor keeps nested runs intact.
  */
  const nestedActive = Math.max(0, semaphore.nestedActiveCount);
  const reclaimFloor = bound + nestedActive;
  const excess = semaphore.activeCount - reclaimFloor;
  if (excess <= 0) {
    return { candidateSinceMs: null };
  }

  if (candidateSinceMs === null) {
    return { candidateSinceMs: nowMs };
  }

  // The strict-idle case (no persisted + no in-flight top-level work) keeps the
  // fast idle window; any live top-level work uses the conservative stale window.
  const windowMs = bound === 0 ? repairAfterMs : staleExcessRepairAfterMs;
  if (nowMs - candidateSinceMs < windowMs) {
    return { candidateSinceMs };
  }

  return {
    candidateSinceMs: null,
    reconciliation: semaphore.reconcileActiveCount(reclaimFloor),
  };
}

/**
 * A concurrency semaphore that gates all agentic activities (triage specification,
 * task execution, and merge operations) behind a shared slot limit.
 *
 * The semaphore ensures that the total number of concurrently running
 * **top-level** AI agents never exceeds `maxConcurrent`, regardless of which
 * subsystem spawned them. Nested helper agents (reviewers spawned from
 * inside a parent's tool call) are admitted via {@link runNested} without
 * entering the wait queue: they bump `activeCount` for honest observability
 * and respect the parent's slot, but can transiently push the count above
 * the configured limit. This is intentional — see {@link runNested} for the
 * fairness/deadlock rationale.
 *
 * **Priority-based draining:** When a slot becomes available and multiple agents
 * are waiting, the waiter with the highest `priority` value is served first.
 * Among waiters with the same priority, FIFO order is preserved. The built-in
 * priority constants are:
 *
 * - {@link PRIORITY_MERGE} (`2`) — merge agents (highest)
 * - {@link PRIORITY_EXECUTE} (`1`) — execution agents
 * - {@link PRIORITY_SPECIFY} (`0`) — specification/triage agents (lowest, default)
 *
 * The limit is read dynamically at `acquire()` time via a getter callback, so
 * live changes to `settings.maxConcurrent` take effect on the next acquire
 * without restarting the engine. Reducing the limit below the current
 * `activeCount` does not evict running agents — it simply blocks new acquires
 * until enough releases bring the active count below the new limit.
 *
 * @example
 * ```ts
 * const sem = new AgentSemaphore(() => store.getSettings().then(s => s.maxConcurrent));
 * await sem.run(async () => {
 *   // at most maxConcurrent agents run this block concurrently
 * }, PRIORITY_EXECUTE);
 * ```
 */
export class AgentSemaphore {
  private _active = 0;
  /**
   * FNXC:GlobalConcurrencyControls 2026-07-17-00:00:
   * Count of slots currently held by nested helper agents ({@link runNested}).
   * Nested runs legitimately push `_active` above the persisted top-level bound,
   * so stale-semaphore recovery must exclude them from the reclaimable excess —
   * otherwise a leaked slot's repair-window timer (continuous positive excess)
   * could reclaim a live nested slot that only just started (Greptile PR #2265,
   * "Candidate Outlives Slot Ownership"). Tracked separately from `_active` so
   * recovery can compute `active - (bound + nested)` = truly-leaked excess only.
   */
  private _nestedActive = 0;
  private _waiters: PriorityWaiter[] = [];
  private _getLimit: () => number;
  private _excessReleaseWarned = false;

  /**
   * @param limit - Either a static number or a getter that returns the current
   *   `maxConcurrent` value. When a getter is provided the limit is re-read on
   *   every `acquire()` call, allowing live setting changes.
   */
  constructor(limit: number | (() => number)) {
    this._getLimit = typeof limit === "function" ? limit : () => limit;
  }

  /** Number of slots currently held by running agents. */
  get activeCount(): number {
    return Math.max(0, this._active);
  }

  /**
   * Number of slots currently held by nested helper agents ({@link runNested}).
   * Clamped into `[0, activeCount]` so it can never over-report the legitimate
   * overshoot that stale-semaphore recovery excludes from reclaimable excess.
   */
  get nestedActiveCount(): number {
    return Math.max(0, Math.min(this._nestedActive, this._active));
  }

  /** Number of callers currently queued for a semaphore slot. */
  get waitingCount(): number {
    return this._waiters.length;
  }

  /** Snapshot of current semaphore pressure for diagnostics. */
  snapshot(): { activeCount: number; waitingCount: number; availableCount: number; limit: number } {
    return {
      activeCount: this.activeCount,
      waitingCount: this.waitingCount,
      availableCount: this.availableCount,
      limit: this.limit,
    };
  }

  /**
   * Clamp stale active-slot accounting to a persisted upper bound.
   *
   * This is a recovery valve for crash/abort paths where the task/session that
   * acquired a slot is gone but the in-memory semaphore did not observe its
   * normal `finally` release. The caller owns the persisted-state judgment.
   */
  reconcileActiveCount(maxActive: number): { before: number; after: number; changed: boolean } {
    const bounded = Math.max(0, Math.floor(maxActive));
    const before = this._active;
    if (before > bounded) {
      this._active = bounded;
      this._drain();
    }
    return { before, after: this._active, changed: before !== this._active };
  }

  /** Number of slots available for immediate acquisition. May be 0 or negative
   *  if the limit was reduced below the current active count.
   *  Returns 0 when the limit is not a valid positive number (defensive guard). */
  get availableCount(): number {
    const limit = this._getLimit();
    if (!Number.isFinite(limit) || limit <= 0) return 0;
    return Math.max(0, limit - this._active);
  }

  /** Current concurrency limit.
   *  Returns a minimum of 1 to prevent indefinite blocking. */
  get limit(): number {
    const limit = this._getLimit();
    if (!Number.isFinite(limit) || limit <= 0) return 1;
    return limit;
  }

  /**
   * Acquire a slot. Resolves immediately if a slot is available, otherwise
   * queues the caller and resolves when a slot is released.
   *
   * When multiple callers are waiting, the highest-priority waiter is served
   * first. Among waiters with equal priority, FIFO order is preserved.
   *
   * @param priority - Numeric priority (higher = served first). Defaults to `0`
   *   ({@link PRIORITY_SPECIFY}). Use {@link PRIORITY_MERGE} (`2`) for merge
   *   agents and {@link PRIORITY_EXECUTE} (`1`) for execution agents.
   * @param signal - Optional AbortSignal. When aborted while queued, the waiter
   *   is removed and the promise rejects with an AbortError so cancelled
   *   verification/merge work does not block the queue forever.
   */
  acquire(priority: number = 0, signal?: AbortSignal): Promise<void> {
    const limit = this.limit; // Uses the guarded getter (returns min 1)
    if (signal?.aborted) {
      return Promise.reject(createAbortError());
    }
    if (this._active < limit) {
      this._active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const waiter: PriorityWaiter = {
        priority,
        resolve: () => {
          if (settled) return;
          settled = true;
          cleanup();
          this._active++;
          resolve();
        },
        reject: (err: Error) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(err);
        },
      };
      const onAbort = () => {
        const idx = this._waiters.indexOf(waiter);
        if (idx >= 0) this._waiters.splice(idx, 1);
        waiter.reject?.(createAbortError());
      };
      const cleanup = () => {
        signal?.removeEventListener("abort", onAbort);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this._waiters.push(waiter);
    });
  }

  /**
   * Synchronously reserve a slot if one is immediately available, without
   * queuing. Returns true (and bumps `activeCount`) when a slot was taken,
   * false when the semaphore is full. Used by the U6 hold/release sweep's
   * reservation-first ordering (KTD-10): reserve worktree + semaphore BEFORE
   * issuing a release move, and {@link release} the reservation if the move
   * rejects on capacity. Unlike {@link acquire} it never enqueues a waiter.
   */
  tryAcquire(): boolean {
    if (this._active < this.limit) {
      this._active++;
      return true;
    }
    return false;
  }

  /**
   * Release a previously acquired slot and unblock the next waiting caller
   * (if any).
   */
  release(): void {
    this.returnSlot("release");
  }

  /**
   * Convenience wrapper: acquires a slot, runs `fn`, and releases the slot
   * when `fn` settles (whether it resolves or rejects).
   *
   * @param fn - The async function to run while holding the slot.
   * @param priority - Numeric priority forwarded to {@link acquire}. Defaults
   *   to `0` ({@link PRIORITY_SPECIFY}).
   */
  async run<T>(fn: () => Promise<T>, priority: number = 0): Promise<T> {
    await this.acquire(priority);
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  /**
   * Run a nested helper agent within the current caller's slot context.
   *
   * Unlike {@link run}, `runNested` does NOT enter the wait queue — it bumps
   * `_active` directly so the helper begins immediately. The bump keeps
   * {@link activeCount} an honest report of how many agent sessions exist
   * right now, even though the helper bypasses the usual fairness queue.
   *
   * Intended use: a parent agent (executor, triage) is suspended awaiting a
   * synchronous sub-agent's tool result (typically a reviewer). The parent
   * makes no LLM calls while suspended, so the total number of LLM-active
   * agents at any moment is still bounded by `maxConcurrent` — but two agent
   * sessions exist, which `runNested` reflects in `activeCount`. This is
   * intentionally a soft breach of the limit: it preserves forward-progress
   * fairness for the in-flight task (no queue stealing) and avoids the
   * deadlock that would occur if both parent and child needed a queued slot.
   */
  async runNested<T>(fn: () => Promise<T>): Promise<T> {
    this.acquireNestedSlot();
    try {
      return await fn();
    } finally {
      this.releaseNestedSlot();
    }
  }

  /** Reserve a nested helper-agent slot without queueing. */
  acquireNestedSlot(): void {
    this._active++;
    this._nestedActive++;
  }

  /** Return a nested helper-agent slot. */
  releaseNestedSlot(): void {
    if (this._nestedActive > 0) this._nestedActive--;
    this.returnSlot("runNested");
  }

  /**
   * FNXC:Scheduler-Concurrency 2026-06-13-19:58:
   * FN-6423 requires excess slot returns to remain observable without corrupting scheduler capacity accounting. Clamp the active slot count at zero and warn once so a release leak cannot surface as negative `activeCount` or a negative `semaphore used=` diagnostic.
   */
  private returnSlot(source: "release" | "runNested"): void {
    if (this._active <= 0) {
      this._active = 0;
      if (!this._excessReleaseWarned) {
        this._excessReleaseWarned = true;
        concurrencyLog.warn(`AgentSemaphore excess slot return ignored from ${source}; activeCount already 0`);
      }
      this._drain();
      return;
    }

    this._active--;
    this._drain();
  }

  /**
   * Unblock waiters while slots are available.
   *
   * Picks the highest-priority waiter first. Among waiters with the same
   * priority, the one that was enqueued first (FIFO) is chosen.
   */
  private _drain(): void {
    const limit = this.limit; // Uses the guarded getter (returns min 1)
    while (this._waiters.length > 0 && this._active < limit) {
      const idx = this._highestPriorityIndex();
      const [waiter] = this._waiters.splice(idx, 1);
      waiter.resolve();
    }
  }

  /**
   * Find the index of the highest-priority waiter. When multiple waiters
   * share the highest priority, the first one (lowest index = earliest
   * enqueued) is returned, preserving FIFO within the same priority level.
   */
  private _highestPriorityIndex(): number {
    let bestIdx = 0;
    let bestPriority = this._waiters[0].priority;
    for (let i = 1; i < this._waiters.length; i++) {
      if (this._waiters[i].priority > bestPriority) {
        bestPriority = this._waiters[i].priority;
        bestIdx = i;
      }
    }
    return bestIdx;
  }
}

/**
 * FNXC:Scheduler-Concurrency 2026-06-27-19:50:
 * Project engines share one global AgentSemaphore, so each runtime needs scope-local slot accounting. When a project stops or pauses after abort+drain, return only that project's residual held slots to the shared pool so other projects regain capacity without releasing slots held by still-running projects.
 */
export class ScopedAgentSemaphore extends AgentSemaphore {
  private readonly delegate: AgentSemaphore;
  private _held = 0;

  constructor(delegate: AgentSemaphore) {
    super(() => delegate.limit);
    this.delegate = delegate;
  }

  /** Number of slots this scope currently owns in the delegated semaphore. */
  get heldCount(): number {
    return this._held;
  }

  /** Shared-pool active count, preserving scheduler/metrics semantics. */
  override get activeCount(): number {
    return this.delegate.activeCount;
  }

  /**
   * Shared-pool nested count, kept in the same frame of reference as
   * {@link activeCount} (both read the delegate). Nested slots reserved through
   * this scope's {@link runNested} bump the delegate, so recovery reading the
   * delegate's nested total never treats a live nested slot as leaked excess.
   */
  override get nestedActiveCount(): number {
    return this.delegate.nestedActiveCount;
  }

  override get waitingCount(): number {
    return this.delegate.waitingCount;
  }

  override get availableCount(): number {
    return this.delegate.availableCount;
  }

  override get limit(): number {
    return this.delegate.limit;
  }

  override snapshot(): { activeCount: number; waitingCount: number; availableCount: number; limit: number } {
    return this.delegate.snapshot();
  }

  override reconcileActiveCount(maxActive: number): { before: number; after: number; changed: boolean } {
    const bounded = Math.max(0, Math.floor(maxActive));
    const before = this._held;
    if (before > bounded) {
      const returned = before - bounded;
      this._held = bounded;
      for (let i = 0; i < returned; i++) {
        this.delegate.release();
      }
    }
    return { before, after: this._held, changed: before !== this._held };
  }

  override async acquire(priority: number = 0): Promise<void> {
    await this.delegate.acquire(priority);
    this._held++;
  }

  override tryAcquire(): boolean {
    const acquired = this.delegate.tryAcquire();
    if (acquired) this._held++;
    return acquired;
  }

  override release(): void {
    if (this._held <= 0) return;
    this._held--;
    this.delegate.release();
  }

  override async run<T>(fn: () => Promise<T>, priority: number = 0): Promise<T> {
    await this.acquire(priority);
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  override async runNested<T>(fn: () => Promise<T>): Promise<T> {
    this.delegate.acquireNestedSlot();
    this._held++;
    try {
      return await fn();
    } finally {
      if (this._held > 0) {
        this._held--;
        this.delegate.releaseNestedSlot();
      }
    }
  }

  /**
   * Return every slot still attributed to this scope.
   *
   * Late normal releases from already-aborted agents become no-ops because the
   * scope's held count is zeroed before returning residual slots to the pool.
   */
  returnAllHeldSlots(): number {
    const residual = this._held;
    if (residual <= 0) return 0;

    this._held = 0;
    for (let i = 0; i < residual; i++) {
      this.delegate.release();
    }
    return residual;
  }
}
