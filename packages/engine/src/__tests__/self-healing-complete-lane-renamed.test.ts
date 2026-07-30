/*
FNXC:WorkflowLifecycleColumns 2026-07-30-21:25 (PR #2684 review — the coverage half):

RATCHET FOR THE COMPLETE-LANE FILTER, WHICH WAS INERT AND HAD NO TEST THAT COULD SAY SO.

`filterByCompleteRole` used to resolve through the SYNC reader. That reader cannot see a task's
selection — `getTaskWorkflowSelectionImpl` returns `undefined` unconditionally ("sync selection reader
is incomplete-PG") — so `resolveTaskWorkflowIrSync` fell back to the DEFAULT workflow IR and the filter
answered the default board's complete lane for every task, on every board. It read as converted and
behaved exactly like the literal it replaced. The fix (this PR) routes it through
`resolveWorkflowIrForTask` with the caller's cache, the only resolver that reads the selection.

WHY THE EXISTING TESTS COULD NOT CATCH IT. Every other sweep test in this file's neighbourhood runs on
the DEFAULT board, where the sync fallback and the correct answer are the same string. That coincidence
is what let an inert filter look covered. This fixture names its complete lane `shipped`, where the two
answers differ, so the sync form fails it and the async form passes.

The negative case is here for the same reason: without it, "keep everything" also passes.
*/
import { describe, expect, it, vi } from "vitest";
import { SelfHealingManager } from "../self-healing.js";
import type { Task, WorkflowIr } from "@fusion/core";

/** Standard roles under non-default names, so a default-board answer cannot accidentally match. */
const RENAMED_IR = {
  version: "v2",
  id: "wf-renamed",
  name: "renamed",
  nodes: [],
  edges: [],
  columns: [
    { id: "queued", name: "Queued", traits: [{ trait: "hold", config: { release: "capacity" } }] },
    { id: "building", name: "Building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
    { id: "signoff", name: "Signoff", traits: [{ trait: "merge" }] },
    { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
    { id: "attic", name: "Attic", traits: [{ trait: "archived" }] },
  ],
} as unknown as WorkflowIr;

function taskIn(id: string, column: string): Task {
  return {
    id,
    lineageId: id,
    title: "card",
    description: "",
    column,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
  } as unknown as Task;
}

function managerFor(tasks: Task[]) {
  const selection = { workflowId: "wf-renamed", stepIds: [] as string[] };
  const store = {
    getTaskWorkflowSelection: () => selection,
    getTaskWorkflowSelectionAsync: async () => selection,
    getWorkflowDefinition: async () => ({ id: "wf-renamed", ir: RENAMED_IR }),
    /*
    Stubbed to do what production does: answer without ever seeing the task's selection. Leaving it
    working would let the mock succeed where production cannot, and the test would then pass against
    the very implementation it exists to reject.
    */
    resolveTaskWorkflowIrSync: () => {
      throw new Error("sync selection reader is incomplete-PG");
    },
    listTasks: vi.fn().mockResolvedValue(tasks),
    getTask: vi.fn(async (id: string) => tasks.find((t) => t.id === id)),
    getSettings: vi.fn().mockResolvedValue({ autoMerge: true }),
    updateTask: vi.fn().mockResolvedValue(undefined),
    logEntry: vi.fn().mockResolvedValue(undefined),
    recordRunAuditEvent: vi.fn().mockResolvedValue(undefined),
  };
  const manager = new SelfHealingManager(store as never, { rootDir: "/tmp/complete-lane-test" } as never);
  const filterByCompleteRole = (manager as unknown as {
    filterByCompleteRole: (tasks: Task[], cache: Map<string, unknown>) => Promise<Task[]>;
  }).filterByCompleteRole.bind(manager);
  return { store, manager, filterByCompleteRole };
}

describe("filterByCompleteRole resolves the complete lane from the task's OWN workflow", () => {
  it("keeps a card in the RENAMED complete lane", async () => {
    const shipped = taskIn("FN-SHIPPED", "shipped");
    const building = taskIn("FN-BUILDING", "building");
    const { filterByCompleteRole } = managerFor([shipped, building]);

    const kept = await filterByCompleteRole([shipped, building], new Map());

    /*
    With the sync reader this matched nothing, so every sweep behind this filter silently processed an
    empty list — a failure that reads as "no work to do" rather than as an error.
    */
    expect(kept.map((t) => t.id)).toEqual(["FN-SHIPPED"]);
  });

  it("excludes a card in the DEFAULT complete lane this board does not declare", async () => {
    const legacyDone = taskIn("FN-LEGACY", "done");
    const { filterByCompleteRole } = managerFor([legacyDone]);

    expect(await filterByCompleteRole([legacyDone], new Map())).toEqual([]);
  });
});
