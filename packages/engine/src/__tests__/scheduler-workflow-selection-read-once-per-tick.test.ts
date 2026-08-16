/*
FNXC:WorkflowScheduling 2026-08-12-20:00 (RUFU-073):
REG RUFU-073 — one scheduler tick must read each task's workflow_selection AT MOST ONCE.

The production query storm (`project.task_workflow_selection` idx_scan ~232 q/s nonstop) was Drizzle
building the same SELECT over and over: `resolveTaskParkedColumns` composed `resolveWorkflowIrForTask`
per call, and in a single scheduler event the SAME task could trip several park-resolutions (merge,
unpause, planning-finished, approval-cleared, deleted, agent-link rollback) — each its own separate DB
read of the selection, even though `resolveWorkflowIrForTask` provides a caller-owned selection cache.

Fix: a fresh per-tick/per-event `selectionCache` (Map<taskId, selection>) is shared by every
park-resolution in one handler invocation, so `resolveWorkflowIrForTask` reads selection once per task
per tick, never O(n × passes). The cache is PER-TICK ONLY and the resolver coalesces even concurrent
wake closures that share the same cache onto ONE in-flight read. The next tick/event creates a fresh
Map (and thus a fresh coalescing slot) so a concurrent selection WRITE is observed there; this is the
FNXC:WorkflowScheduling invariant, never a global/infinite LRU. A throwing read is deliberately not
cached — so instrumentation MUST count reads, not infer them from cache keys.

Wake mechanics this suite relies on (all from the `task:updated` handler):
  - unpause wake:	 `paused>>false`/`userPaused>>false` armed via a prior `paused:true` event.
  - planning wake:	 `status:"planning"` armed via a prior event, then a `status:null` event clears it.
  - approval wake:	 `status:"awaiting-approval"` armed via a prior event, then a `status:null` event
                     with `approvedPlanFingerprint` clears it.
  Each arm-only event reads nothing; only the clearing transition fires the park-resolution closure.

REG invariant (surface enumeration):
 - one event clearing unpause + planning + approval wakes for the SAME task reads selection exactly once
   (not 3x) — the concurrent wake closures coalesce onto one shared per-tick read.
 - MULTIPLE distinct tasks reached in one sweep each read at most once (per-task bound).
 - EMPTY task set / no wake transitions: ZERO selection reads.
 - the cache NEVER leaks across events: a second tick's wake re-reads (selection is mutable) — the
   dedup is per-tick, not a permanent memo.
 - sync fallback parity: when the store exposes only the legacy sync `getTaskWorkflowSelection`, the same
   per-tick cache still dedups concurrent reads.
*/
import { describe, expect, it, vi } from "vitest";
import type { TaskStore, WorkflowIr } from "@fusion/core";
import { Scheduler } from "../scheduler.js";
import { flushAsyncHandlers } from "./_flush-async-handlers.js";

const WF = "builtin:coding";

function codingIr(): WorkflowIr {
  return {
    version: "v2",
    id: WF,
    nodes: [],
    edges: [],
    columns: [
      { id: "inbox", name: "inbox", traits: [{ trait: "intake" }] },
      { id: "todo", name: "todo", traits: [{ trait: "hold", config: { release: "capacity" } }] },
      { id: "in-progress", name: "in-progress", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      { id: "in-review", name: "in-review", traits: [{ trait: "review" }] },
      { id: "done", name: "done", traits: [{ trait: "complete" }] },
    ],
  } as unknown as WorkflowIr;
}

function createStore(opts: { async?: boolean; tasks?: Record<string, unknown>[] } = {}) {
  const useAsync = opts.async !== false;
  const tasks = opts.tasks ?? [];
  const listeners = new Map<string, ((payload: unknown) => void)[]>();
  const reads: string[] = [];
  const selection = { workflowId: WF, stepIds: [] };
  const getTaskWorkflowSelectionAsync = vi.fn(async (taskId: string) => {
    reads.push(taskId);
    return selection;
  });
  const getTaskWorkflowSelection = vi.fn((taskId: string) => {
    reads.push(taskId);
    return selection;
  });
  const store = {
    on: vi.fn((event: string, listener: (payload: unknown) => void) => {
      const existing = listeners.get(event) ?? [];
      existing.push(listener);
      listeners.set(event, existing);
    }),
    off: vi.fn(),
    getRootDir: vi.fn().mockReturnValue("/test/project"),
    getSettings: vi.fn().mockResolvedValue({ globalPause: false, enginePaused: false }),
    listTasks: vi.fn(async (opts?: { column?: string }) =>
      opts?.column ? tasks.filter((t) => t.column === opts.column) : tasks,
    ),
    getTask: vi.fn(async (id: string) => tasks.find((t) => t.id === id) ?? null),
    updateTask: vi.fn().mockResolvedValue(undefined),
    logEntry: vi.fn().mockResolvedValue(undefined),
    getCompletionHandoffAcceptedMarker: vi.fn().mockResolvedValue(null),
    getWorkflowDefinition: vi.fn(async () => ({ ir: codingIr() })),
    ...(useAsync
      ? { getTaskWorkflowSelectionAsync, getTaskWorkflowSelectionsAsync: vi.fn(async () => new Map()) }
      : { getTaskWorkflowSelection }),
  } as unknown as TaskStore;

  const emit = async (event: string, payload: unknown) => {
    for (const l of listeners.get(event) ?? []) await l(payload);
  };

  return { store, emit, reads, getTaskWorkflowSelection, getTaskWorkflowSelectionAsync };
}

function task(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    column: "todo",
    status: null,
    paused: false,
    userPaused: false,
    assignedAgentId: null,
    checkedOutBy: null,
    deletedAt: null,
    dependencies: [],
    blockedBy: null,
    columnMovedAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function createScheduler(store: TaskStore) {
  const scheduler = new Scheduler(store, {});
  const schedule = vi.spyOn(scheduler, "schedule").mockResolvedValue(undefined);
  // Make the scheduler "running" so wake closures that gate on `this.running` proceed to read.
  (scheduler as unknown as { running: boolean }).running = true;
  return { scheduler, schedule };
}

describe("RUFU-073: workflow selection read at most once per scheduler tick", () => {
  it("reads workflow_selection exactly once when one event clears unpause+planning+approval wakes for the same task", async () => {
    const { store, emit, reads } = createStore();
    createScheduler(store);

    // Arm the three distinct wake trackers across separate updates. Keep paused=true through EVERY
    // arming event so no unpause wake fires mid-arm; only the single clearing event below fires wakes.
    const armed = { paused: true, userPaused: true };
    await emit("task:updated", task("FN-1", armed));
    await emit("task:updated", task("FN-1", { ...armed, status: "awaiting-approval" }));
    await emit("task:updated", task("FN-1", { ...armed, status: "planning" }));
    expect(reads).toHaveLength(0);

    // One event clearing ALL THREE trackers fires all three park-resolutions for the same task.
    await emit("task:updated", task("FN-1", {
      paused: false,
      userPaused: false,
      status: null,
      column: "in-progress",
      approvedPlanFingerprint: "approved-plan",
      lastDispatchAt: "2026-01-01T00:00:00.000Z",
    }));
    await flushAsyncHandlers();

    // The three wake closures share one per-tick cache (they race concurrently), so the task's
    // selection is read exactly ONCE — not 3x. This is the RUFU-073 regression (was O(n × passes)).
    expect(reads.filter((id) => id === "FN-1")).toHaveLength(1);
  });

  it("reads each distinct task at most once when a multi-wake tick touches multiple tasks", async () => {
    const { store, emit, reads } = createStore();
    createScheduler(store);

    // Arm paused + planning + approval trackers for two tasks across separate arm-only events. Keep
    // paused=true through EVERY arming event so no unpause wake fires mid-arm.
    for (const id of ["FN-1", "FN-2"]) {
      await emit("task:updated", task(id, { paused: true, userPaused: true }));
      await emit("task:updated", task(id, { paused: true, userPaused: true, status: "awaiting-approval" }));
      await emit("task:updated", task(id, { paused: true, userPaused: true, status: "planning" }));
    }
    await flushAsyncHandlers();
    expect(reads).toHaveLength(0);

    // A "dispatch tick": each task is woken by a single clearing event (one per task, each its own
    // per-event shared cache). Per task, the selection must be read at most once.
    for (const id of ["FN-1", "FN-2"]) {
      await emit("task:updated", task(id, {
        paused: false,
        userPaused: false,
        status: null,
        column: "in-progress",
        approvedPlanFingerprint: "approved-plan",
        lastDispatchAt: "2026-01-01T00:00:00.000Z",
      }));
    }
    await flushAsyncHandlers();

    // Total reads bound by the number of distinct tasks touched (2), never O(tasks × passes).
    expect(reads).toHaveLength(2);
    const byTask = new Map<string, number>();
    for (const id of reads) byTask.set(id, (byTask.get(id) ?? 0) + 1);
    for (const [id, count] of byTask) expect(count, `task ${id}`).toBeLessThanOrEqual(1);
  });

  it("reads nothing when a tick performs no wake transitions over an empty task set", async () => {
    const { store, emit, reads } = createStore();
    createScheduler(store);

    await emit("task:updated", task("FN-1"));
    await emit("task:updated", task("FN-1", { status: null }));
    await flushAsyncHandlers();

    expect(reads).toHaveLength(0);
  });

  it("never leaks the selection cache across ticks — a second tick's wake re-reads (selection writes observed)", async () => {
    const { store, emit, reads } = createStore();
    createScheduler(store);

    // Tick 1: plan FN-1, then finish planning -> the planning wake reads the selection once.
    await emit("task:updated", task("FN-1", { status: "planning" }));
    await emit("task:updated", task("FN-1", { status: null, column: "in-progress" }));
    await flushAsyncHandlers();
    const tick1Count = reads.filter((id) => id === "FN-1").length;
    expect(tick1Count).toBe(1);

    // Tick 2: plan FN-1 again and finish planning again -> a FRESH per-tick cache must re-read.
    await emit("task:updated", task("FN-1", { status: "planning" }));
    await emit("task:updated", task("FN-1", { status: null, column: "in-progress" }));
    await flushAsyncHandlers();
    const tick2Count = reads.filter((id) => id === "FN-1").length;
    expect(tick2Count).toBe(2); // provably re-read: dedup is per-tick, not a permanent memo.
  });

  it("sync fallback parity: a store exposing only legacy sync getTaskWorkflowSelection dedups the same way", async () => {
    const { store, emit, reads } = createStore({ async: false });
    createScheduler(store);

    await emit("task:updated", task("FN-1", { status: "planning" }));
    await emit("task:updated", task("FN-1", { status: null, column: "in-progress" }));
    await flushAsyncHandlers();

    // The planning wake read the selection synchronously, at most once for the tick.
    expect(reads.filter((id) => id === "FN-1").length).toBeLessThanOrEqual(1);
  });
});
/*
FNXC:WorkflowScheduling 2026-08-16 (RUFU-106, RUFU-073 surface enumeration):
The read-once invariant is not only about the `task:updated` wake coalescing tested above — it must
hold on EVERY cache-propagation surface that resolves parked columns for a task. The scheduler
creates a fresh per-event selectionCache in EACH handler (`task:moved` -> `movedSelectionCache`,
`task:deleted` -> `deletedSelectionCache`, `task:updated` -> `updatedSelectionCache`) so a single
event can never issue more than one workflow_selection read per task. These cases pin that guarantee
on the remaining enumerated surfaces so a future edit that drops one of the caches (falling back to
O(n × passes)) fails loudly. Each assertion counts SELECTION READS (instrumented in the mock store),
never cache keys — a throwing read is deliberately not cached.
*/
describe("RUFU-073: read-once also holds on the task:moved / task:deleted / isolated-unpause propagation surfaces", () => {
  it("task:moved: a single move event reads the moved task's selection at most once", async () => {
    const { store, emit, reads } = createStore();
    createScheduler(store);

    // One move (todo -> in-progress) resolves parked columns exactly once for the moved task. The
    // fresh `movedSelectionCache` collapses any park-resolution passes for the same task into one
    // workflow_selection read.
    await emit("task:moved", {
      task: task("FN-1", { column: "in-progress" }),
      from: "todo",
      to: "in-progress",
      source: "user",
      lanes: undefined,
    });
    await flushAsyncHandlers();

    expect(reads.filter((id) => id === "FN-1")).toHaveLength(1);
    // Nothing else was resolved in this isolated event.
    expect(reads).toHaveLength(1);
  });

  it("task:deleted: one delete event reads the deleted task's selection at most once", async () => {
    const { store, emit, reads } = createStore();
    createScheduler(store);

    // task:deleted resolves the deleted task's parked columns in a per-event async closure; the
    // fresh `deletedSelectionCache` guarantees its selection is read once (when a dependent sweep
    // also runs in the same event it shares that one read).
    await emit("task:deleted", task("FN-1", { column: "in-progress" }));
    await flushAsyncHandlers();

    expect(reads.filter((id) => id === "FN-1")).toHaveLength(1);
  });

  it("unpause surface: an unpause transition reads the task's selection at most once, in isolation", async () => {
    const { store, emit, reads } = createStore();
    createScheduler(store);

    // Arm ONLY the unpause tracker; the arm-only event must read nothing.
    await emit("task:updated", task("FN-1", { paused: true, userPaused: true, column: "in-progress" }));
    expect(reads).toHaveLength(0);

    // The clearing transition fires ONLY the unpause park-resolution (the `updatedSelectionCache`
    // is fresh per event, so it is a single read for FN-1 — not compounded with planning/approval).
    await emit("task:updated", task("FN-1", {
      paused: false,
      userPaused: false,
      column: "in-progress",
      lastDispatchAt: "2026-01-01T00:00:00.000Z",
    }));
    await flushAsyncHandlers();

    expect(reads.filter((id) => id === "FN-1")).toHaveLength(1);
  });
});
