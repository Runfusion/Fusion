/*
FNXC:WorkflowScheduling 2026-08-09-06:29:
Issue #3364 found that a small PostgreSQL board saturated the three-connection
pool through repeated selection reads. These tests hold the sweep to one batch
selection read and preserve the legacy per-task behavior when that batch fails.
*/
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskStore, WorkflowIr } from "@fusion/core";

import { resetHoldReleaseInstrumentation, runHoldReleaseSweep } from "../execution/hold-release.js";
import { schedulerLog } from "../logger.js";
import { Scheduler } from "../scheduler.js";

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

function task(id: string, column = "todo"): Task {
  return {
    id, title: id, description: "", column, status: null, dependencies: [], steps: [], currentStep: 0, log: [],
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", columnMovedAt: "2026-01-01T00:00:00.000Z",
  } as Task;
}

function storeWith(tasks: Task[], options: { batchFails?: boolean; batchAvailable?: boolean; projectId?: string } = {}): TaskStore {
  const selections = new Map(tasks.map((item) => [item.id, {
    workflowId: item.id.endsWith("B") ? "custom:wf-b" : "custom:wf-a", stepIds: [],
  }]));
  const getTaskWorkflowSelectionsAsync = vi.fn(async (ids: string[]) => {
    if (options.batchFails) throw new Error("temporary batch read failure");
    return new Map(ids.flatMap((id) => {
      const selection = selections.get(id);
      return selection ? [[id, selection] as const] : [];
    }));
  });
  const store = {
    getWorkflowSettingsProjectId: () => options.projectId ?? "project-a",
    getRootDir: () => `/test/${options.projectId ?? "project-a"}`,
    on: vi.fn(),
    getSettings: vi.fn(async () => ({})),
    listTasks: vi.fn(async () => tasks),
    getTaskWorkflowSelectionsAsync,
    getTaskWorkflowSelectionAsync: vi.fn(async (id: string) => selections.get(id)),
    getTaskWorkflowSelection: vi.fn((id: string) => selections.get(id)),
    getWorkflowDefinition: vi.fn(async () => ({ ir })),
    getCompletionHandoffAcceptedMarker: vi.fn(async () => null),
    recordRunAuditEvent: vi.fn(async () => undefined),
    moveTaskIf: vi.fn(async (id: string, column: string) => {
      const item = tasks.find((candidate) => candidate.id === id)!;
      item.column = column;
      return { task: item, moved: true };
    }),
  } as unknown as TaskStore;
  if (options.batchAvailable === false) delete (store as Partial<TaskStore>).getTaskWorkflowSelectionsAsync;
  return store;
}

describe("hold-release bounded database work", () => {
  beforeEach(() => resetHoldReleaseInstrumentation());

  it("reports the successful list hydration batch in the slow-sweep warning", async () => {
    const tasks = [task("H-1")];
    const store = storeWith(tasks);
    const warn = vi.spyOn(schedulerLog, "warn").mockImplementation(() => {});
    (store.listTasks as ReturnType<typeof vi.fn>).mockImplementation(async (options?: { selectionCache?: Map<string, unknown>; selectionReadTally?: { batched: number; singles: number } }) => {
      options?.selectionCache?.set("H-1", { workflowId: "custom:wf-a", stepIds: [] });
      if (options?.selectionReadTally) Object.assign(options.selectionReadTally, { batched: 1, singles: 0 });
      return tasks;
    });

    let clockCalls = 0;
    await runHoldReleaseSweep(store, { now: () => 1_000_000 + (clockCalls++ > 0 ? 3_000 : 0) });

    expect(store.listTasks).toHaveBeenCalledWith(expect.objectContaining({ includeArchived: false, selectionCache: expect.any(Map), selectionReadTally: { batched: 1, singles: 0 } }));
    expect(store.getTaskWorkflowSelectionsAsync).not.toHaveBeenCalled();
    expect(warn.mock.calls.map(([line]) => String(line))).toContainEqual(expect.stringContaining("batchSelections=1, selections=0"));
  });

  it("reports degraded per-row list hydration reads without claiming a batch in the slow-sweep warning", async () => {
    const tasks = [task("H-1"), task("H-2"), task("H-3")];
    const store = storeWith(tasks);
    const warn = vi.spyOn(schedulerLog, "warn").mockImplementation(() => {});
    (store.listTasks as ReturnType<typeof vi.fn>).mockImplementation(async (options?: { selectionCache?: Map<string, unknown>; selectionReadTally?: { batched: number; singles: number } }) => {
      for (const candidate of tasks) options?.selectionCache?.set(candidate.id, { workflowId: "custom:wf-a", stepIds: [] });
      if (options?.selectionReadTally) Object.assign(options.selectionReadTally, { batched: 0, singles: tasks.length });
      return tasks;
    });

    let clockCalls = 0;
    await runHoldReleaseSweep(store, { now: () => 1_000_000 + (clockCalls++ > 0 ? 3_000 : 0) });

    expect(store.getTaskWorkflowSelectionsAsync).not.toHaveBeenCalled();
    expect(warn.mock.calls.map(([line]) => String(line))).toContainEqual(expect.stringContaining("batchSelections=0, selections=3"));
  });

  it("shares one selection cache across the production scheduler pass and release reservation", async () => {
    const held = task("H-1");
    const store = storeWith([held]);
    const scheduler = new Scheduler(store);

    await (scheduler as unknown as { runHoldReleaseSweepPass(tasks: Task[], settings: Record<string, unknown>): Promise<void> })
      .runHoldReleaseSweepPass([held], {});

    expect(store.getTaskWorkflowSelectionsAsync).toHaveBeenCalledOnce();
    expect(store.getTaskWorkflowSelectionAsync).not.toHaveBeenCalled();
    scheduler.stop();
  });

  it.each([13, 26])("uses one selection batch regardless of board size (%i cards)", async (count) => {
    const tasks = Array.from({ length: count }, (_, index) => task(`H-${index}-${index % 2 === 0 ? "A" : "B"}`));
    const store = storeWith(tasks);

    await runHoldReleaseSweep(store, { now: () => 1_000_000 });

    expect(store.getTaskWorkflowSelectionsAsync).toHaveBeenCalledTimes(1);
    expect(store.getTaskWorkflowSelectionsAsync).toHaveBeenCalledWith(tasks.map((item) => item.id));
    expect(store.getTaskWorkflowSelectionAsync).not.toHaveBeenCalled();
    expect(store.getWorkflowDefinition).toHaveBeenCalledTimes(2);
  });

  it.each([13, 26])("keeps selection reads constant as dependency edges grow (%i cards)", async (count) => {
    const dependencyIr = {
      version: "v2", id: "custom:dependency", nodes: [], edges: [],
      columns: [
        { id: "waiting", label: "Waiting", traits: [{ trait: "hold", config: { release: "dependency" } }] },
        { id: "done", label: "Done", traits: [{ trait: "complete" }] },
      ],
    } as unknown as WorkflowIr;
    const dependency = task("DEP", "done");
    const waiting = Array.from({ length: count - 1 }, (_, index) => {
      const candidate = task(`WAIT-${index}`, "waiting");
      candidate.dependencies = [dependency.id];
      return candidate;
    });
    const store = storeWith([...waiting, dependency]);
    (store.getWorkflowDefinition as ReturnType<typeof vi.fn>).mockResolvedValue({ ir: dependencyIr });

    await runHoldReleaseSweep(store, { now: () => 1_000_000 });

    expect(store.getTaskWorkflowSelectionsAsync).toHaveBeenCalledOnce();
    expect(store.getTaskWorkflowSelectionAsync).not.toHaveBeenCalled();
    expect(store.getCompletionHandoffAcceptedMarker).toHaveBeenCalledOnce();
  });

  it("uses a supplied selection cache without re-reading covered task ids", async () => {
    const tasks = [task("H-1"), task("H-2"), task("H-3")];
    const store = storeWith(tasks);
    const selectionCache = new Map(tasks.slice(0, 2).map((item) => [item.id, {
      workflowId: "custom:wf-a", stepIds: [],
    }]));

    await runHoldReleaseSweep(store, { now: () => 1_000_000, selectionCache });

    expect(store.getTaskWorkflowSelectionsAsync).toHaveBeenCalledTimes(1);
    expect(store.getTaskWorkflowSelectionsAsync).toHaveBeenCalledWith(["H-3"]);
    expect(store.getTaskWorkflowSelectionAsync).not.toHaveBeenCalled();
  });

  it("issues no selection query when a supplied cache covers every task", async () => {
    const tasks = [task("H-1"), task("H-2")];
    const store = storeWith(tasks);
    const selectionCache = new Map(tasks.map((item) => [item.id, {
      workflowId: "custom:wf-a", stepIds: [],
    }]));

    await runHoldReleaseSweep(store, { now: () => 1_000_000, selectionCache });

    expect(store.getTaskWorkflowSelectionsAsync).not.toHaveBeenCalled();
    expect(store.getTaskWorkflowSelectionAsync).not.toHaveBeenCalled();
  });

  it("keeps legacy per-task selection reads when the batch capability is absent", async () => {
    const held = task("H-A");
    const otherWorkflowOccupant = task("O-B", "in-progress");
    const store = storeWith([held, otherWorkflowOccupant], { batchAvailable: false });

    const result = await runHoldReleaseSweep(store, { now: () => 1_000_000 });

    expect(store.getTaskWorkflowSelectionAsync).toHaveBeenCalledTimes(2);
    expect(result.released).toEqual(["H-A"]);
    expect(result.held).toEqual([]);
  });

  it("falls back to per-task selections after a failed batch without changing capacity pools", async () => {
    const held = task("H-A");
    const otherWorkflowOccupant = task("O-B", "in-progress");
    const store = storeWith([held, otherWorkflowOccupant], { batchFails: true });

    const result = await runHoldReleaseSweep(store, { now: () => 1_000_000 });

    expect(store.getTaskWorkflowSelectionsAsync).toHaveBeenCalledTimes(1);
    expect(store.getTaskWorkflowSelectionAsync).toHaveBeenCalledTimes(2);
    expect(result.released).toEqual(["H-A"]);
    expect(result.held).toEqual([]);
  });

  it("memoizes rejected handoff markers across dependents", async () => {
    const dependency = task("DEP", "done");
    const waiting = [task("WAIT-1", "waiting"), task("WAIT-2", "waiting")];
    for (const item of waiting) item.dependencies = [dependency.id];
    const dependencyHoldIr = {
      version: "v2", id: "custom:dependency", nodes: [], edges: [],
      columns: [
        { id: "waiting", label: "Waiting", traits: [{ trait: "hold", config: { release: "dependency" } }] },
        { id: "done", label: "Done", traits: [{ trait: "complete" }] },
      ],
    } as unknown as WorkflowIr;
    const store = storeWith([...waiting, dependency]);
    (store.getWorkflowDefinition as ReturnType<typeof vi.fn>).mockResolvedValue({ ir: dependencyHoldIr });

    await runHoldReleaseSweep(store, { now: () => 1_000_000 });

    expect(store.getCompletionHandoffAcceptedMarker).toHaveBeenCalledTimes(1);
    expect(store.getCompletionHandoffAcceptedMarker).toHaveBeenCalledWith("DEP");
  });

  it("does not issue listTasks after getSettings exhausts the deadline", async () => {
    let now = 0;
    const store = storeWith([task("H-1")]);
    (store.getSettings as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      now = 11;
      return {};
    });

    const result = await runHoldReleaseSweep(store, { now: () => now, budgetMs: 10 });

    expect(store.listTasks).not.toHaveBeenCalled();
    expect(result).toMatchObject({ released: [], held: [], budgetTruncated: true, unevaluatedCount: 0 });
  });

  it("stops at a preamble deadline without inventing held cards", async () => {
    let now = 0;
    const tasks = [task("H-1"), task("H-2")];
    const store = storeWith(tasks);
    (store.listTasks as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      now = 11;
      return tasks;
    });

    const result = await runHoldReleaseSweep(store, { now: () => now, budgetMs: 10 });

    expect(store.getTaskWorkflowSelectionsAsync).not.toHaveBeenCalled();
    expect(result).toMatchObject({ released: [], held: [], budgetTruncated: true, unevaluatedCount: 2 });
  });

  it("stops evaluating cards after the first post-deadline check", async () => {
    let now = 0;
    const tasks = [task("H-1"), task("H-2"), task("H-3")];
    const manualWorkflow = {
      ...ir,
      columns: [{ id: "todo", label: "Todo", traits: [{ trait: "hold", config: { release: "manual" } }] }],
    } as WorkflowIr;
    const store = storeWith(tasks);
    (store.getWorkflowDefinition as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      now = 11;
      return { ir: manualWorkflow };
    });

    const result = await runHoldReleaseSweep(store, { now: () => now, budgetMs: 10 });

    expect(store.getWorkflowDefinition).toHaveBeenCalledTimes(1);
    expect(result.held).toEqual([{ taskId: "H-1", reason: "manual-only" }]);
    expect(result).toMatchObject({ budgetTruncated: true, unevaluatedCount: 2 });
    expect(result.held.map((entry) => entry.taskId)).not.toContain("H-2");
  });

  it("classifies a deadline-truncated dependency as budget exhaustion", async () => {
    let now = 0;
    const dependencyWorkflow = {
      version: "v2",
      id: "custom:dependency",
      nodes: [],
      edges: [],
      columns: [
        { id: "waiting", label: "Waiting", traits: [{ trait: "hold", config: { release: "dependency" } }] },
        { id: "done", label: "Done", traits: [{ trait: "complete" }] },
      ],
    } as unknown as WorkflowIr;
    const waiting = task("WAIT", "waiting");
    waiting.dependencies = ["DEP-1", "DEP-2"];
    const dependencies = [waiting, task("DEP-1", "done"), task("DEP-2", "done")];
    const store = storeWith(dependencies);
    (store.getWorkflowDefinition as ReturnType<typeof vi.fn>).mockResolvedValue({ ir: dependencyWorkflow });
    (store.getCompletionHandoffAcceptedMarker as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      now = 11;
      return null;
    });

    const result = await runHoldReleaseSweep(store, { now: () => now, budgetMs: 10 });

    expect(result.released).toEqual([]);
    expect(result.held).toEqual([{ taskId: "WAIT", reason: "sweep-budget-exhausted" }]);
    expect(store.getCompletionHandoffAcceptedMarker).toHaveBeenCalledTimes(1);
  });

  it("keeps ordinary unsatisfied dependencies distinct from deadline truncation", async () => {
    const dependencyWorkflow = {
      version: "v2", id: "custom:dependency", nodes: [], edges: [],
      columns: [
        { id: "waiting", label: "Waiting", traits: [{ trait: "hold", config: { release: "dependency" } }] },
        { id: "todo", label: "Todo", traits: [] },
        { id: "done", label: "Done", traits: [{ trait: "complete" }] },
      ],
    } as unknown as WorkflowIr;
    const waiting = task("WAIT", "waiting");
    waiting.dependencies = ["DEP"];
    const store = storeWith([waiting, task("DEP", "todo")]);
    (store.getWorkflowDefinition as ReturnType<typeof vi.fn>).mockResolvedValue({ ir: dependencyWorkflow });

    const result = await runHoldReleaseSweep(store, { now: () => 1_000_000 });

    expect(result.held).toEqual([{ taskId: "WAIT", reason: "deps-unsatisfied" }]);
    expect(result.budgetTruncated).toBeUndefined();
  });

  it("does not emit a dependency parity audit for an edge not evaluated after expiry", async () => {
    let now = 0;
    const dependencyWorkflow = {
      version: "v2", id: "custom:dependency", nodes: [], edges: [],
      columns: [
        { id: "waiting", label: "Waiting", traits: [{ trait: "hold", config: { release: "dependency" } }] },
        { id: "done", label: "Done", traits: [{ trait: "complete" }] },
      ],
    } as unknown as WorkflowIr;
    const waiting = task("WAIT", "waiting");
    waiting.dependencies = ["DEP-1", "DEP-2"];
    const store = storeWith([waiting, task("DEP-1", "done"), task("DEP-2", "done")]);
    (store.getWorkflowDefinition as ReturnType<typeof vi.fn>).mockResolvedValue({ ir: dependencyWorkflow });
    (store.getCompletionHandoffAcceptedMarker as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      now = 11;
      return null;
    });

    const result = await runHoldReleaseSweep(store, { now: () => now, budgetMs: 10 });

    expect(result.held).toEqual([{ taskId: "WAIT", reason: "sweep-budget-exhausted" }]);
    expect(store.recordRunAuditEvent).not.toHaveBeenCalled();
  });

  it("clears a failed sweep's project guard before the next invocation", async () => {
    const store = storeWith([task("H-1")]);
    (store.getSettings as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("transient settings failure"));

    await expect(runHoldReleaseSweep(store, { now: () => 1_000_000 })).rejects.toThrow("transient settings failure");
    const result = await runHoldReleaseSweep(store, { now: () => 1_000_000 });

    expect(result.skippedConcurrent).toBeUndefined();
    expect(store.getSettings).toHaveBeenCalledTimes(2);
  });

  it("preserves the held clock for an unreached card", async () => {
    const log = vi.spyOn(schedulerLog, "log").mockImplementation(() => {});
    let now = 0;
    let stage = 0;
    const capacityIr = {
      ...ir,
      columns: [
        { id: "block", label: "Block", traits: [{ trait: "hold", config: { release: "manual" } }] },
        { id: "todo", label: "Todo", traits: [{ trait: "hold", config: { release: "capacity" } }] },
        { id: "in-progress", label: "In Progress", traits: [{ trait: "wip", config: { limit: 1 } }] },
      ],
    } as WorkflowIr;
    const target = task("TARGET");
    const occupant = task("OCCUPANT", "in-progress");
    const store = storeWith([task("BLOCK", "block"), target, occupant]);
    (store.getWorkflowDefinition as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      if (stage === 1) now = 11;
      return { ir: capacityIr };
    });

    await runHoldReleaseSweep(store, { now: () => now });
    stage = 1;
    now = 0;
    await runHoldReleaseSweep(store, { now: () => now, budgetMs: 10 });
    stage = 2;
    now = 100;
    occupant.column = "done";
    await runHoldReleaseSweep(store, { now: () => now });

    expect(log.mock.calls.map((call) => String(call[0])).find((line) => line.includes("Hold release for TARGET"))).toContain("100ms");
  });

  it("preserves a dependency hold clock across budget exhaustion", async () => {
    const log = vi.spyOn(schedulerLog, "log").mockImplementation(() => {});
    let now = 0;
    let expireDuringDependencyCheck = false;
    const dependencyWorkflow = {
      version: "v2", id: "custom:dependency", nodes: [], edges: [],
      columns: [
        { id: "waiting", label: "Waiting", traits: [{ trait: "hold", config: { release: "dependency" } }] },
        { id: "todo", label: "Todo", traits: [] },
        { id: "done", label: "Done", traits: [{ trait: "complete" }] },
      ],
    } as unknown as WorkflowIr;
    const waiting = task("WAIT", "waiting");
    const firstDependency = task("DEP-1", "todo");
    const secondDependency = task("DEP-2", "todo");
    waiting.dependencies = [firstDependency.id, secondDependency.id];
    const store = storeWith([waiting, firstDependency, secondDependency]);
    (store.getWorkflowDefinition as ReturnType<typeof vi.fn>).mockResolvedValue({ ir: dependencyWorkflow });
    (store.getCompletionHandoffAcceptedMarker as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      if (expireDuringDependencyCheck) now = 11;
      return null;
    });

    // Establish the ordinary dependency-held timestamp before a later pass is cut short.
    await runHoldReleaseSweep(store, { now: () => now });
    firstDependency.column = "done";
    secondDependency.column = "done";
    expireDuringDependencyCheck = true;

    /*
    FNXC:WorkflowScheduling 2026-08-09-11:20:
    A dependency timeout has partial evidence, so it reports sweep-budget-exhausted directly
    instead of trackHeld. This regression proves that classification cannot replace the prior
    deps-unsatisfied timestamp and reset the eventual release duration.
    */
    const truncated = await runHoldReleaseSweep(store, { now: () => now, budgetMs: 10 });
    expect(truncated.held).toEqual([{ taskId: "WAIT", reason: "sweep-budget-exhausted" }]);

    expireDuringDependencyCheck = false;
    now = 100;
    const released = await runHoldReleaseSweep(store, { now: () => now });

    expect(released.released).toEqual(["WAIT"]);
    expect(log.mock.calls.map((call) => String(call[0])).find((line) => line.includes("Hold release for WAIT"))).toContain("100ms");
  });

  it("preserves the resolver sync fallback through the counting facade", async () => {
    const held = task("H-1");
    const store = storeWith([held], { batchAvailable: false });
    delete (store as Partial<TaskStore>).getTaskWorkflowSelectionAsync;

    await runHoldReleaseSweep(store, { now: () => 1_000_000 });

    expect(store.getTaskWorkflowSelection).toHaveBeenCalled();
  });

  it("allows overlapping sweeps for different projects and releases the guard after completion", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = storeWith([task("H-1")], { projectId: "project-a" });
    const second = storeWith([task("H-2")], { projectId: "project-b" });
    (first.getSettings as ReturnType<typeof vi.fn>).mockImplementation(async () => firstGate);

    const firstPass = runHoldReleaseSweep(first, { now: () => 1_000_000 });
    await Promise.resolve();
    const secondResult = await runHoldReleaseSweep(second, { now: () => 1_000_000 });
    releaseFirst();
    await firstPass;
    const sequentialResult = await runHoldReleaseSweep(first, { now: () => 1_000_000 });

    expect(secondResult.skippedConcurrent).toBeUndefined();
    expect(second.getSettings).toHaveBeenCalledTimes(1);
    expect(sequentialResult.skippedConcurrent).toBeUndefined();
    expect(first.getSettings).toHaveBeenCalledTimes(2);
  });

  it("does not serialize identity-less stores that belong to different synthetic partitions", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = storeWith([task("H-1")]);
    const second = storeWith([task("H-2")]);
    delete (first as Partial<TaskStore>).getWorkflowSettingsProjectId;
    delete (second as Partial<TaskStore>).getWorkflowSettingsProjectId;
    (first.getSettings as ReturnType<typeof vi.fn>).mockImplementation(async () => firstGate);

    const firstPass = runHoldReleaseSweep(first, { now: () => 1_000_000 });
    await Promise.resolve();
    const secondResult = await runHoldReleaseSweep(second, { now: () => 1_000_000 });
    releaseFirst();
    await firstPass;

    expect(secondResult.skippedConcurrent).toBeUndefined();
    expect(second.getSettings).toHaveBeenCalledOnce();
  });

  it.each(["project-a", ""])("skips an overlapping sweep in the same project partition (%s)", async (projectId) => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = storeWith([task("H-1")], { projectId });
    const second = storeWith([task("H-2")], { projectId });
    (first.getSettings as ReturnType<typeof vi.fn>).mockImplementation(async () => firstGate);

    const firstPass = runHoldReleaseSweep(first, { now: () => 1_000_000 });
    await Promise.resolve();
    const skipped = await runHoldReleaseSweep(second, { now: () => 1_000_000 });
    releaseFirst();
    await firstPass;

    expect(skipped).toEqual({ released: [], held: [], skippedConcurrent: true });
    expect(second.getSettings).not.toHaveBeenCalled();
  });
});
