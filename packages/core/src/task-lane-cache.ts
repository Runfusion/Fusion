import type { TaskMoveLanes } from "./workflows/workflow-lifecycle-traits.js";

export interface TaskLaneCacheOptions {
  ttlMs?: number;
  maxSize?: number;
  now?: () => number;
}

interface TaskLaneCacheEntry {
  lanes: TaskMoveLanes | undefined;
  workflowId?: string;
  at: number;
}

/*
FNXC:WorkflowEvents 2026-08-01-06:11:
PostgreSQL deployments can rewrite a task workflow selection from another node, so an in-process lane
answer must expire as well as being invalidated by local selection writes. Returning an old answer
would make a synchronous listener confidently choose the wrong lane; a cache miss is deliberately
"unknown" and lets that listener retain its existing fallback.

The clock is injectable so TTL coverage advances a deterministic fake clock instead of sleeping. The
cache never resolves an IR: update-event decoration must remain a synchronous Map lookup on hot paths.
*/
export class TaskLaneCache {
  private readonly entries = new Map<string, TaskLaneCacheEntry>();
  private readonly ttlMs: number;
  private readonly maxSize: number;
  private readonly now: () => number;

  constructor({ ttlMs = 30_000, maxSize = 1_000, now = Date.now }: TaskLaneCacheOptions = {}) {
    this.ttlMs = ttlMs;
    this.maxSize = maxSize;
    this.now = now;
  }

  set(taskId: string, lanes: TaskMoveLanes | undefined, options: { workflowId?: string } = {}): void {
    this.entries.delete(taskId);
    this.entries.set(taskId, { lanes, workflowId: options.workflowId, at: this.now() });
    while (this.entries.size > this.maxSize) this.entries.delete(this.entries.keys().next().value!);
  }

  get(taskId: string): TaskMoveLanes | undefined {
    const entry = this.entries.get(taskId);
    if (!entry) return undefined;
    if (this.now() - entry.at >= this.ttlMs) {
      this.entries.delete(taskId);
      return undefined;
    }
    // Refresh insertion order without changing the recorded cache time.
    this.entries.delete(taskId);
    this.entries.set(taskId, entry);
    return entry.lanes;
  }

  invalidate(taskId: string): void {
    this.entries.delete(taskId);
  }

  clear(): void {
    this.entries.clear();
  }
}
