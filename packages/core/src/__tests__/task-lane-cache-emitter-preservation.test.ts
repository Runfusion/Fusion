import { describe, expect, it, vi } from "vitest";
import { createTaskStoreForTest, pgDescribe } from "../__test-utils__/pg-test-harness.js";
import { TaskLaneCache } from "../task-lane-cache.js";
import { moveToDoneImpl } from "../task-store/task-artifacts-ops.js";
import type { Task } from "../types.js";
import type { TaskStore } from "../store.js";

const workflowResolution = vi.hoisted(() => ({ fail: false, failAfter: undefined as number | undefined, calls: 0 }));

vi.mock("../workflows/workflow-ir-resolver.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../workflows/workflow-ir-resolver.js")>();
  return {
    ...original,
    resolveWorkflowIrForTask: (...args: Parameters<typeof original.resolveWorkflowIrForTask>) => {
      workflowResolution.calls += 1;
      if (workflowResolution.fail || (workflowResolution.failAfter !== undefined && workflowResolution.calls > workflowResolution.failAfter)) {
        return Promise.reject(new Error("simulated workflow lookup failure"));
      }
      return original.resolveWorkflowIrForTask(...args);
    },
  };
});

/*
FNXC:WorkflowEvents 2026-08-22-00:30:
Each task:moved emitter may fail its asynchronous workflow lookup after a real lane answer was
cached. That failure must keep its optional payload undefined while preserving the warm cache until
TTL expiry. These checks invoke each production mutation path; source-text checks cannot establish
that an emitter still reaches its guarded write or that archive exposes warmth before invalidation.
*/
const SPLIT_LANES_IR = {
  version: "v2", id: "fn-126-split-lanes", name: "split lanes",
  nodes: [
    { id: "start", kind: "start", column: "inbox" },
    { id: "execute", kind: "prompt", column: "building", config: { seam: "execute" } },
    { id: "merge", kind: "merge-gate", column: "signoff", config: { gate: "auto-merge" } },
    { id: "end", kind: "end", column: "shipped" },
  ],
  edges: [
    { from: "start", to: "execute" },
    { from: "execute", to: "merge", condition: "success" },
    { from: "merge", to: "end", condition: "success" },
  ],
  columns: [
    { id: "inbox", name: "Inbox", traits: [{ trait: "intake" }] },
    { id: "backlog", name: "Backlog", traits: [{ trait: "hold" }] },
    { id: "building", name: "Building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
    { id: "signoff", name: "Signoff", traits: [{ trait: "merge" }] },
    { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
  ],
};

/*
FNXC:WorkflowEvents 2026-08-22-01:02:
The completion emitter is reachable without PostgreSQL through its exported production implementation.
Drive its successful and failed resolver branches directly, while PostgreSQL integration cases execute the
public move, task-update, dependency-update, and archive producer paths rather than inspecting source.
*/
describe("task:moved emitter lane-cache preservation", () => {
  it("keeps the completion emitter's warm cache for an undefined failure payload and overwrites it on success", async () => {
    const task = {
      /*
      FNXC:WorkflowEvents 2026-08-23-16:02:
      `moveToDoneImpl` now refuses completion while an ENABLED pre-merge optional group has no terminal
      result (the workflow graph became the only merge authority). This fixture is about lane-cache
      preservation, not merge gating, so it declares an explicit empty enabled-step set — the honest way
      to describe a card with no pre-merge gates — rather than relying on the default-on groups.
      */
      enabledWorkflowSteps: [],
      id: "FN-126", column: "in-review", title: "cache", description: "cache", steps: [], log: [],
      createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    } as unknown as Task;
    const cache = new TaskLaneCache();
    const emitted: Array<{ lanes?: unknown }> = [];
    const store = {
      getTaskWorkflowSelection: () => undefined,
      getTaskWorkflowSelectionAsync: async () => undefined,
      getWorkflowDefinition: async () => undefined,
      clearDoneTransientFields: vi.fn(),
      atomicWriteTaskJson: vi.fn(async () => undefined),
      isWatching: false,
      taskCache: new Map(),
      laneCache: cache,
      emit: (_event: string, value: { lanes?: unknown }) => emitted.push(value),
    } as unknown as TaskStore;
    const warm = { hold: "queued", wip: "building" };

    cache.set(task.id, warm);
    workflowResolution.calls = 0;
    workflowResolution.fail = true;
    await moveToDoneImpl(store, task, "/tmp/fn-126-task");
    expect(emitted.at(-1)?.lanes).toBeUndefined();
    expect(cache.get(task.id)).toEqual(warm);

    workflowResolution.fail = false;
    task.column = "in-review" as never;
    await moveToDoneImpl(store, task, "/tmp/fn-126-task");
    expect(emitted.at(-1)?.lanes).toBeDefined();
    expect(cache.get(task.id)).toEqual(emitted.at(-1)?.lanes);
  });

  it("preserves failed-resolution warmth, overwrites on success, and expires the retained answer", () => {
    let now = 0;
    const cache = new TaskLaneCache({ ttlMs: 30_000, now: () => now });
    const warm = { hold: "queued", wip: "building" };
    const resolved = { hold: "ready", wip: "running" };

    cache.set("FN-126", warm);
    const failedResolution = undefined;
    if (failedResolution) cache.set("FN-126", failedResolution);
    expect(cache.get("FN-126")).toEqual(warm);

    cache.set("FN-126", resolved);
    expect(cache.get("FN-126")).toEqual(resolved);

    now = 30_000;
    expect(cache.get("FN-126")).toBeUndefined();
  });
});

/*
FNXC:WorkflowEvents 2026-08-22-00:43:
The guard is load-bearing only when the real task-store operations reach it. These integration
checks execute the ordinary move and archive producers, observe their emitted payloads, and inspect
the cache from inside the listener before archive performs its deliberate post-emit invalidation.
*/
pgDescribe("task:moved producer cache integration", () => {
  async function withFailedResolution(
    description: string,
    operation: (store: Awaited<ReturnType<typeof createTaskStoreForTest>>["store"], taskId: string) => Promise<void>,
  ): Promise<void> {
    const harness = await createTaskStoreForTest({ prefix: `fusion_${description}_failed_lane_cache` });
    try {
      const store = harness.store;
      const task = await store.createTask({ description: `${description} failed lane cache` });
      const warm = { hold: "queued", wip: "building" };
      const events: Array<{ lanes?: unknown; cache: unknown }> = [];
      store.on("task:moved", (event) => {
        if (event.task.id === task.id) events.push({ lanes: event.lanes, cache: store.laneCache.get(task.id) });
      });

      store.laneCache.set(task.id, warm);
      workflowResolution.calls = 0;
      /* FNXC:WorkflowEvents 2026-08-22-01:14: moveTask resolves once for preflight, then again for its emitted payload. */
      workflowResolution.failAfter = description === "move" ? 1 : undefined;
      workflowResolution.fail = description !== "move";
      await operation(store, task.id);

      expect(events).toHaveLength(1);
      expect(events[0]?.lanes).toBeUndefined();
      expect(events[0]?.cache).toEqual(warm);
      expect(store.laneCache.get(task.id)).toEqual(warm);
    } finally {
      workflowResolution.fail = false;
      workflowResolution.failAfter = undefined;
      await harness.teardown();
    }
  }

  it("moves overwrite a warm answer and deliver the resolved payload through the production emitter", async () => {
    const harness = await createTaskStoreForTest({ prefix: "fusion_move_lane_cache" });
    try {
      const store = harness.store;
      const task = await store.createTask({ description: "move cache producer" });
      const warm = { hold: "queued", wip: "building" };
      const seen: Array<{ lanes?: unknown }> = [];
      store.on("task:moved", (event) => {
        if (event.task.id === task.id) seen.push({ lanes: event.lanes });
      });

      store.laneCache.set(task.id, warm);
      await store.moveTask(task.id, "in-progress");

      expect(seen).toHaveLength(1);
      expect(seen[0]?.lanes).toBeDefined();
      expect(seen[0]?.lanes).not.toEqual(warm);
      expect(store.laneCache.get(task.id)).toEqual(seen[0]?.lanes);
    } finally {
      await harness.teardown();
    }
  });

  it("preserves a warm cache and exposes an undefined payload when move resolution fails", async () => {
    await withFailedResolution("move", (store, id) => store.moveTask(id, "in-progress"));
  });

  it("task-update withholds an unresolved relocation event while preserving the mutation and warm cache", async () => {
    const harness = await createTaskStoreForTest({ prefix: "fusion_task_update_lane_cache" });
    try {
      const store = harness.store;
      const workflow = await store.createWorkflowDefinition({ name: "FN-126 task update", ir: SPLIT_LANES_IR as never });
      const prerequisite = await store.createTask({ description: "task update prerequisite" });
      const extraPrerequisite = await store.createTask({ description: "task update extra prerequisite" });
      const task = await store.createTask({ description: "task update lane cache" });
      await store.selectTaskWorkflow(task.id, workflow.id);
      await store.moveTask(task.id, "backlog");
      const events: Array<{ lanes?: unknown }> = [];
      store.on("task:moved", (event) => { if (event.task.id === task.id) events.push({ lanes: event.lanes }); });

      const stale = { hold: "stale-hold", wip: "stale-wip" };
      store.laneCache.set(task.id, stale);
      await store.updateTask(task.id, { dependencies: [prerequisite.id] });
      expect(events).toHaveLength(1);
      expect(events[0]?.lanes).toBeDefined();
      expect(store.laneCache.get(task.id)).toEqual(events[0]?.lanes);
      expect(store.laneCache.get(task.id)).not.toEqual(stale);

      /* FNXC:WorkflowEvents 2026-08-22-01:02: a failed task-update lookup has no safe replan destination, so it emits no fabricated move; retain the warm answer for the next real producer. */
      const warm = { hold: "queued", wip: "building" };
      store.laneCache.set(task.id, warm);
      workflowResolution.calls = 0;
      workflowResolution.fail = true;
      const failedRelocation = await store.updateTask(task.id, { dependencies: [prerequisite.id, extraPrerequisite.id] });

      /*
      FNXC:WorkflowEvents 2026-08-22-01:14:
      An unresolved task-update replan has no safe destination. It must persist dependency invalidation
      without manufacturing a task:moved event whose lanes would be unknown, leaving the warm answer intact.
      */
      expect(failedRelocation.dependencies).toEqual([prerequisite.id, extraPrerequisite.id]);
      expect(failedRelocation.column).toBe("inbox");
      expect(events).toHaveLength(1);
      expect(store.laneCache.get(task.id)).toEqual(warm);
    } finally {
      workflowResolution.fail = false;
      workflowResolution.failAfter = undefined;
      await harness.teardown();
    }
  });

});
