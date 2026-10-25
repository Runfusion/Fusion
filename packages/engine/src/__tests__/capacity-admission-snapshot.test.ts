/*
FNXC:CapacityAdmissionSnapshot 2026-10-25-20:41 (RUFU-627 Step 3):
The scheduler shares one pass-scoped IR/selection cache pair across its capacity dimensions (RUFU-698),
but the triage throttle evaluation, the merge claim snapshot, and the in-process runtime claim snapshot
each called `persistedTopLevelAgentTaskIdsFromStore(store, tasks, undefined, …)`. With `undefined`
caches, `enrichedTopLevelAgentTasksFromStore` allocated a fresh IR cache per call and resolved every
row's workflow identity one card at a time — one selection SELECT per card per evaluation, four such
evaluations per engine loop, on the same board the ~27 MiB/min heap growth was measured on.

These tests pin the mechanism, not a number: ONE prefilled batch per evaluation, per-task reads only
on the two documented fallbacks, the SAME holder ids as the uncached path (no behavior change to what
counts as running), and a per-evaluation lifetime so a selection write between evaluations is seen.
*/
import { describe, expect, it, vi } from "vitest";
import type { Task, TaskStore, WorkflowIr } from "@fusion/core";

import { persistedTopLevelAgentTaskIdsFromStore } from "../concurrency/concurrency.js";
import { openCapacityAdmissionPass } from "../concurrency/capacity-admission-snapshot.js";

const ir = {
  version: "v2",
  id: "custom:wf-a",
  nodes: [],
  edges: [],
  columns: [
    { id: "todo", label: "Todo", traits: [{ trait: "hold", config: { release: "capacity" } }] },
    { id: "in-progress", label: "In Progress", traits: [{ trait: "wip", config: { limit: 1 } }] },
    { id: "done", label: "Done", traits: [{ trait: "complete" }] },
  ],
} as unknown as WorkflowIr;

function task(id: string, column = "in-progress"): Task {
  return {
    id, title: id, description: "", column, status: null, dependencies: [], steps: [], currentStep: 0, log: [],
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", columnMovedAt: "2026-01-01T00:00:00.000Z",
    prompt: "# Planned\n\n## Mission\nImplement the approved work.\n",
  } as Task;
}

interface FakeStoreHandle {
  store: TaskStore;
  selections: Map<string, { workflowId: string; stepIds: string[] }>;
  batch: ReturnType<typeof vi.fn>;
  singles: ReturnType<typeof vi.fn>;
  definitions: ReturnType<typeof vi.fn>;
}

function fakeStore(
  tasks: Task[],
  options: { batchFails?: boolean; batchAvailable?: boolean } = {},
): FakeStoreHandle {
  const selections = new Map(tasks.map((item) => [
    item.id,
    { workflowId: item.id.endsWith("B") ? "custom:wf-b" : "custom:wf-a", stepIds: [] },
  ]));
  const batch = vi.fn(async (ids: string[]) => {
    if (options.batchFails) throw new Error("temporary batch read failure");
    return new Map(ids.flatMap((id) => {
      const selection = selections.get(id);
      return selection ? [[id, selection] as const] : [];
    }));
  });
  const store = {
    getWorkflowSettingsProjectId: () => "project-a",
    getRootDir: () => "/test/project-a",
    on: vi.fn(),
    listTasks: vi.fn(async () => tasks),
    getTaskWorkflowSelectionsAsync: batch,
    getTaskWorkflowSelectionAsync: vi.fn(async (id: string) => selections.get(id)),
    getTaskWorkflowSelection: vi.fn((id: string) => selections.get(id)),
    getWorkflowDefinition: vi.fn(async () => ({ ir })),
  } as unknown as TaskStore;
  if (options.batchAvailable === false) delete (store as Partial<TaskStore>).getTaskWorkflowSelectionsAsync;
  return {
    store,
    selections,
    batch,
    singles: store.getTaskWorkflowSelectionAsync as ReturnType<typeof vi.fn>,
    definitions: store.getWorkflowDefinition as ReturnType<typeof vi.fn>,
  };
}

const board = () => [task("CAP-1"), task("CAP-2"), task("CAP-3A"), task("CAP-4B"), task("CAP-5B"), task("CAP-6")];

describe("capacity admission snapshot", () => {
  it("returns the holder ids the uncached path returns", async () => {
    const tasks = board();
    const { store } = fakeStore(tasks);
    const baseline = await persistedTopLevelAgentTaskIdsFromStore(store, tasks);
    const pass = await openCapacityAdmissionPass(store, tasks);
    const { agentTaskIds } = await pass.runningAgentTaskIds(tasks);
    expect(agentTaskIds).toEqual(baseline);
  });

  it("prefills identity with one batch read and never touches the per-task reader", async () => {
    const tasks = board();
    const handle = fakeStore(tasks);
    const pass = await openCapacityAdmissionPass(handle.store, tasks);
    expect(handle.batch).toHaveBeenCalledTimes(1);
    expect(handle.singles).not.toHaveBeenCalled();

    await pass.runningAgentTaskIds(tasks);
    /*
    Both capacity dimensions of one evaluation share this object, so a second derivation over the same
    rows must add no identity work at all — that is the reuse the engine lanes were missing.
    */
    await pass.runningAgentTaskIds(tasks, { rootDir: () => "/test/project-a", settings: {} });
    expect(handle.batch).toHaveBeenCalledTimes(1);
    expect(handle.singles).not.toHaveBeenCalled();
    expect(handle.definitions.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it("observes a selection write committed between two evaluations", async () => {
    const tasks = board();
    const handle = fakeStore(tasks);
    const first = await openCapacityAdmissionPass(handle.store, tasks);
    await first.runningAgentTaskIds(tasks);
    expect(first.caches.selectionCache.get("CAP-1")?.workflowId).toBe("custom:wf-a");

    handle.selections.set("CAP-1", { workflowId: "custom:wf-b", stepIds: [] });

    const second = await openCapacityAdmissionPass(handle.store, tasks);
    await second.runningAgentTaskIds(tasks);
    expect(handle.batch).toHaveBeenCalledTimes(2);
    expect(second.caches.selectionCache.get("CAP-1")?.workflowId).toBe("custom:wf-b");
    /* The first pass keeps its own stale view — it must not be rebuilt or shared across evaluations. */
    expect(first.caches.selectionCache.get("CAP-1")?.workflowId).toBe("custom:wf-a");
  });

  it("falls back to per-task identity reads when the batch read fails", async () => {
    const tasks = board();
    const handle = fakeStore(tasks, { batchFails: true });
    const baseline = await persistedTopLevelAgentTaskIdsFromStore(handle.store, tasks);
    handle.batch.mockClear();
    handle.singles.mockClear();
    const pass = await openCapacityAdmissionPass(handle.store, tasks);
    expect(handle.batch).toHaveBeenCalledTimes(1);
    // One per-task read per distinct id, not one whole-pass default to the built-in workflow.
    expect(handle.singles).toHaveBeenCalledTimes(tasks.length);
    const { agentTaskIds } = await pass.runningAgentTaskIds(tasks);
    expect(agentTaskIds).toEqual(baseline);
    // The pass cache absorbs the fan-out: the fallback reads happened at open, not once per row.
    expect(handle.singles).toHaveBeenCalledTimes(tasks.length);
  });

  it("uses per-task reads when the store exposes no batch reader", async () => {
    const tasks = board();
    const handle = fakeStore(tasks, { batchAvailable: false });
    const baseline = await persistedTopLevelAgentTaskIdsFromStore(handle.store, tasks);
    handle.singles.mockClear();
    const pass = await openCapacityAdmissionPass(handle.store, tasks);
    expect(handle.singles).toHaveBeenCalledTimes(tasks.length);
    const { agentTaskIds } = await pass.runningAgentTaskIds(tasks);
    expect(agentTaskIds).toEqual(baseline);
    expect(handle.singles).toHaveBeenCalledTimes(tasks.length);
  });
});
