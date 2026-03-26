/**
 * A concurrency semaphore that gates all agentic activities (triage specification,
 * task execution, and merge operations) behind a shared slot limit.
 *
 * The semaphore ensures that the total number of concurrently running AI agents
 * never exceeds `maxConcurrent`, regardless of which subsystem spawned them.
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
 * });
 * ```
 */
export class AgentSemaphore {
  private _active = 0;
  private _waiters: Array<() => void> = [];
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
   *  if the limit was reduced below the current active count. */
  get availableCount(): number {
    return Math.max(0, this._getLimit() - this._active);
  }

  /** Current concurrency limit. */
  get limit(): number {
    return this._getLimit();
  }

  /**
   * Acquire a slot. Resolves immediately if a slot is available, otherwise
   * queues the caller and resolves in FIFO order when a slot is released.
   */
  acquire(): Promise<void> {
    if (this._active < this._getLimit()) {
      this._active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this._waiters.push(() => {
        this._active++;
        resolve();
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
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  /** Unblock waiters while slots are available. */
  private _drain(): void {
    while (this._waiters.length > 0 && this._active < this._getLimit()) {
      const next = this._waiters.shift()!;
      next();
    }
  }
}
