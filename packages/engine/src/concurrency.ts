import type { Task } from "@fusion/core";
import { createLogger } from "./logger.js";

const concurrencyLog = createLogger("concurrency");

/** Priority level for merge agents — served first. */
export const PRIORITY_MERGE = 2;
/** Priority level for execution agents — served after merge, before specify. */
export const PRIORITY_EXECUTE = 1;
/** Priority level for specification/triage agents — served last (default). */
export const PRIORITY_SPECIFY = 0;

/** A waiter entry that tracks both the priority and the resolve callback. */
interface PriorityWaiter {
  priority: number;
  resolve: () => void;
}

export const IDLE_SEMAPHORE_LEAK_REPAIR_MS = 5_000;

export function persistedTopLevelAgentSlots(tasks: Task[]): number {
  return tasks.filter((task) => (
    task.column === "in-progress"
    || (task.column === "triage" && task.status === "planning" && !task.paused)
    || (task.column === "in-review" && ["merging", "reviewing", "fixing"].includes(String(task.status ?? "")))
  )).length;
}

export interface IdleSemaphoreLeakRecoveryResult {
  candidateSinceMs: number | null;
  reconciliation?: { before: number; after: number; changed: boolean };
}

export function recoverIdleSemaphoreLeakCandidate(params: {
  semaphore: AgentSemaphore | undefined;
  tasks: Task[];
  candidateSinceMs: number | null;
  inFlightCount?: number;
  nowMs?: number;
  repairAfterMs?: number;
}): IdleSemaphoreLeakRecoveryResult {
  const {
    semaphore,
    tasks,
    candidateSinceMs,
    inFlightCount = 0,
    nowMs = Date.now(),
    repairAfterMs = IDLE_SEMAPHORE_LEAK_REPAIR_MS,
  } = params;

  if (!semaphore) return { candidateSinceMs: null };

  const persistedActive = persistedTopLevelAgentSlots(tasks);
  if (persistedActive !== 0 || semaphore.activeCount <= 0 || inFlightCount > 0) {
    return { candidateSinceMs: null };
  }

  if (candidateSinceMs === null) {
    return { candidateSinceMs: nowMs };
  }

  if (nowMs - candidateSinceMs < repairAfterMs) {
    return { candidateSinceMs };
  }

  return {
    candidateSinceMs: null,
    reconciliation: semaphore.reconcileActiveCount(0),
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
   */
  acquire(priority: number = 0): Promise<void> {
    const limit = this.limit; // Uses the guarded getter (returns min 1)
    if (this._active < limit) {
      this._active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this._waiters.push({
        priority,
        resolve: () => {
          this._active++;
          resolve();
        },
      });
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
    this._active++;
    try {
      return await fn();
    } finally {
      this.returnSlot("runNested");
    }
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
