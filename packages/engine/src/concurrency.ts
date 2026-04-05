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

/**
 * A concurrency semaphore that gates all agentic activities (triage specification,
 * task execution, and merge operations) behind a shared slot limit.
 *
 * The semaphore ensures that the total number of concurrently running AI agents
 * never exceeds `maxConcurrent`, regardless of which subsystem spawned them.
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
    return this._active;
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
   * Release a previously acquired slot and unblock the next waiting caller
   * (if any).
   */
  release(): void {
    this._active--;
    this._drain();
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
