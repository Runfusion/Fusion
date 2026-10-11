import type { Task } from "../types.js";

/*
FNXC:TaskCacheMemory 2026-10-11-11:40:
`TaskStore.taskCache` used to be a plain `Map<string, Task>`. 64 write seams put a FULL task row
into it — including `log`, which production caps near 1000 entries / 3.9 MB per card — while only two
seams ever read it back and nothing evicted. Measured on the deployed board (24 projects, 2,417 cards,
ONE Node process hosting 24 ProjectEngine+TaskStore instances): the heap retained 2,103 distinct task
ids and ~415k TaskLogEntry-shaped objects, and a forced GC could not free them (heapUsed 7,677 ->
5,257 MiB at 36 minutes). That retained live set, not allocation churn, is what makes the process grow
to the RSS ceiling every ~2 hours: a ceiling below the live set converts one kill into a crash loop.

Why two bounds instead of one. Entry count alone does not bound the driver, because the driver is the
per-entry `log` array: 400 cached cards averaging 52 kB of log text is still ~60 MB per store and 24
stores run in the same heap. So the cache bounds BOTH the entry count and the aggregate number of log
entries held, evicting least-recently-used entries until both budgets fit. `log.length` is the cheap,
monotone proxy for what a cached entry actually costs; measuring JS object size is not available and
guessing it is how a bound becomes fiction.

Why eviction is not enough on its own. `task-deleted-outbox-consumer.ts` iterated `taskCache.values()`
as an INDEX of ids the store had ever observed, to emit `task:deleted` for a row that vanished without
an event (the reconciliation fallback). Bounding the map would therefore silently shrink deletion
detection to "cards still cached". `seenIds` keeps that index at id cost rather than row cost, and the
reconciliation pass re-reads an evicted row from the store instead of dropping the event. `seenIds` is
itself FIFO-bounded: coverage for a card last touched `seenIdCapacity` ids ago is not worth unbounded
memory either.
*/

/*
FNXC:TaskCacheMemory 2026-10-11-12:10:
The first bound was written per store and that was the wrong unit. This host runs 24
ProjectEngine+TaskStore pairs inside ONE Node process, so 500 rows / 25,000 log entries per store is a
process-wide allowance of 12,000 rows and 600,000 log entries - MORE than the 2,417-card board and
above the 415,949 TaskLogEntry objects the heap was already retaining. Measured after that deploy: the
RSS slope was still +75 MiB/min against a pre-fix ~+90, i.e. the bound was effectively inert. Budgets
are therefore set in per-store units that sum to a process budget: 50 rows and 2,000 log entries per
store, ~1,200 rows and ~48,000 entries across 24 stores - about 12% of what was retained. A store's
own hot working set is well under 50 rows; anything older than that is a cache miss by design, and a
miss costs a read, not a gigabyte.
*/
const DEFAULT_MAX_ENTRIES = 50;
const DEFAULT_MAX_LOGGED_ENTRIES = 2_000;
const DEFAULT_SEEN_ID_CAPACITY = 50_000;

function readPositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export interface BoundedTaskCacheOptions {
  maxEntries?: number;
  maxLoggedEntries?: number;
  seenIdCapacity?: number;
}

/** Environment overrides exist so an operator can retune without a rebuild; defaults are the measured ones. */
function resolveOptions(): Required<BoundedTaskCacheOptions> {
  return {
    maxEntries: readPositiveInt(process.env.FUSION_TASK_CACHE_MAX_ENTRIES, DEFAULT_MAX_ENTRIES),
    maxLoggedEntries: readPositiveInt(process.env.FUSION_TASK_CACHE_MAX_LOGGED, DEFAULT_MAX_LOGGED_ENTRIES),
    seenIdCapacity: readPositiveInt(process.env.FUSION_TASK_CACHE_SEEN_IDS, DEFAULT_SEEN_ID_CAPACITY),
  };
}

/**
 * A `Map<string, Task>` that bounds its own retained footprint. It stays a real Map on purpose: 70+
 * call sites use `get`/`set`/`delete`/`values` directly, and a wrapper class would have meant editing
 * every one of them to gain nothing. Object identity is preserved on eviction-order bookkeeping —
 * `get` re-inserts the SAME object, because one consumer mutates cached fields in place.
 */
export class BoundedTaskCache extends Map<string, Task> {
  /** Ids this store has ever cached, newest last. Read by the deleted-task reconciliation fallback. */
  readonly seenIds: string[] = [];
  private readonly seenIdSet = new Set<string>();
  private readonly maxEntriesValue: number;
  private readonly maxLoggedEntriesValue: number;
  private readonly seenIdCapacityValue: number;
  private loggedEntries = 0;

  constructor(options: BoundedTaskCacheOptions = {}) {
    const resolved = { ...resolveOptions(), ...stripUndefined(options) };
    super();
    this.maxEntriesValue = resolved.maxEntries;
    this.maxLoggedEntriesValue = resolved.maxLoggedEntries;
    this.seenIdCapacityValue = resolved.seenIdCapacity;
  }

  /** Aggregate count of `log` entries currently held by cached rows — the quantity the budget bounds. */
  get heldLoggedEntries(): number {
    return this.loggedEntries;
  }

  override set(id: string, task: Task): this {
    if (!task) {
      super.delete(id);
      return this;
    }
    this.rememberId(id);
    const previous = super.get(id);
    if (previous) this.loggedEntries -= logEntryCount(previous);
    super.delete(id);
    super.set(id, task);
    this.loggedEntries += logEntryCount(task);
    this.evictUntilWithinBudget(id);
    return this;
  }

  override get(id: string): Task | undefined {
    const task = super.get(id);
    if (task !== undefined) {
      // Recency bookkeeping only: delete+set on the SAME object, so the in-place mutator at
      // task-artifacts-ops.ts keeps writing to the instance it holds.
      super.delete(id);
      super.set(id, task);
    }
    return task;
  }

  override delete(id: string): boolean {
    const existing = super.get(id);
    if (existing) this.loggedEntries -= logEntryCount(existing);
    // seenIds deliberately keeps the id: that is the point of the index.
    return super.delete(id);
  }

  /**
   * `Map.clear()` would leave `loggedEntries` high, and the next `set` would then evict down to a
   * budget the cache no longer occupies — a bound that eats the cache for free. The two production
   * `taskCache.clear()` callers (lifecycle-ops.ts, task-artifacts-ops.ts) drop ROWS; the id index
   * stays, because that is what the deleted-task reconciliation fallback reads.
   */
  override clear(): void {
    super.clear();
    this.loggedEntries = 0;
  }

  private rememberId(id: string): void {
    if (this.seenIdSet.has(id)) {
      // Move to the newest position so FIFO eviction drops the coldest id, not the hottest.
      const at = this.seenIds.indexOf(id);
      if (at >= 0) this.seenIds.splice(at, 1);
    } else {
      this.seenIdSet.add(id);
    }
    this.seenIds.push(id);
    while (this.seenIds.length > this.seenIdCapacityValue) {
      const cold = this.seenIds.shift();
      if (cold !== undefined) this.seenIdSet.delete(cold);
    }
  }

  private evictUntilWithinBudget(justSetId: string): void {
    while (this.size > this.maxEntriesValue || this.loggedEntries > this.maxLoggedEntriesValue) {
      const oldest = this.keys().next().value as string | undefined;
      if (oldest === undefined || oldest === justSetId) break;
      this.delete(oldest);
    }
  }
}

function logEntryCount(task: Task): number {
  return Array.isArray(task.log) ? task.log.length : 0;
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}
