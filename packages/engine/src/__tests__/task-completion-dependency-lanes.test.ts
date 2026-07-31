/*
FNXC:WorkflowResolvedColumns 2026-07-31-02:00 (#2780 review — greptile):

A DEPENDENCY THAT FINISHED IN ITS OWN RENAMED LANE MUST NOT BLOCK COMPLETION.

`getTaskCompletionBlocker` takes an optional `satisfactionColumnsByTaskId` so dependency satisfaction
is judged from each dependency's OWN workflow. The production wrapper omitted it, so every real call
fell through to the legacy default (`done`/`in-review`/`archived`) and a finished dependency on a
renamed board read as unresolved — the depending task could never complete.

THIS IS THE TEST SHAPE THAT WOULD HAVE CAUGHT IT, AND THE ONE THE ORIGINAL LACKED. A test that calls
`getTaskCompletionBlocker` directly and injects the map by hand proves the pure function and says
nothing about production, because production is exactly the caller that omitted it. So this drives
the WRAPPER — `getTaskCompletionBlockerForStore` — and lets it do its own resolution. When a fix moves
data from producer to consumer, the test has to sit on the producer.

Both dependency edges are covered because `task-merge.ts` judges them through the same helper but
reaches it by two paths: the `dependencies` array and the single `blockedBy` marker. Filling only one
would leave the other on the literal.
*/
import { describe, expect, it, vi } from "vitest";
import "@fusion/core"; // registers the built-in column traits so flags resolve
import { getTaskCompletionBlockerForStore } from "../task-completion.js";
import type { Task } from "@fusion/core";

/** The dependency's own board: `shipped` carries `complete`; it declares no `done` at all. */
const DEP_IR = {
  version: "v2",
  id: "wf-dep",
  name: "dep",
  nodes: [],
  edges: [],
  columns: [
    { id: "building", name: "Building", traits: [{ trait: "wip" }] },
    { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
  ],
};

function taskLike(id: string, column: string, extra: Partial<Task> = {}): Task {
  return {
    id,
    lineageId: id,
    title: id,
    description: "",
    column,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
    ...extra,
  } as unknown as Task;
}

function storeWith(tasks: Task[]) {
  const selection = { workflowId: "wf-dep", stepIds: [] as string[] };
  return {
    getTask: vi.fn(async (id: string) => {
      const found = tasks.find((t) => t.id === id);
      if (!found) throw new Error(`no task ${id}`);
      return found;
    }),
    getTaskWorkflowSelection: () => selection,
    getTaskWorkflowSelectionAsync: async () => selection,
    getWorkflowDefinition: async () => ({ id: "wf-dep", ir: DEP_IR }),
  } as never;
}

describe("getTaskCompletionBlockerForStore resolves dependency lanes from each dependency's workflow", () => {
  it("does not block on a DEPENDENCY sitting in its own renamed complete lane", async () => {
    const dependency = taskLike("FN-DEP", "shipped");
    const task = taskLike("FN-1", "building", { dependencies: ["FN-DEP"] } as Partial<Task>);

    const blocker = await getTaskCompletionBlockerForStore(storeWith([task, dependency]), task);

    /*
    With the option unset this returned "task has unresolved dependencies: FN-DEP", because `shipped`
    is not one of the legacy three — a card permanently unable to complete behind work that is done.
    */
    expect(blocker).toBeUndefined();
  });

  it("does not block on a BLOCKED-BY marker pointing at a card in its renamed complete lane", async () => {
    /*
    The second edge. `blockedBy` reaches the same satisfaction helper by a different path, so a fix
    that populated only the `dependencies` array would leave this one on the literal.
    */
    const blocker = taskLike("FN-BLOCKER", "shipped");
    const task = taskLike("FN-2", "building", { blockedBy: "FN-BLOCKER" } as Partial<Task>);

    expect(await getTaskCompletionBlockerForStore(storeWith([task, blocker]), task)).toBeUndefined();
  });

  it("STILL blocks on a dependency that is genuinely unfinished on the same renamed board", async () => {
    /*
    The paired negative. Without it, "never blocks" also passes — and a completion gate that never
    fires is a worse defect than one that fires too often.
    */
    const dependency = taskLike("FN-DEP", "building");
    const task = taskLike("FN-3", "building", { dependencies: ["FN-DEP"] } as Partial<Task>);

    expect(await getTaskCompletionBlockerForStore(storeWith([task, dependency]), task)).toContain("FN-DEP");
  });

  it("falls back to the legacy lanes when the store cannot resolve workflows at all", async () => {
    /*
    Several callers pass a partial store with only `getTask`. Those keep the legacy behaviour rather
    than being forced to change, so a `done` dependency must still satisfy the gate there.
    */
    const dependency = taskLike("FN-DEP", "done");
    const task = taskLike("FN-4", "building", { dependencies: ["FN-DEP"] } as Partial<Task>);
    const partialStore = {
      getTask: vi.fn(async (id: string) => [task, dependency].find((t) => t.id === id)),
    } as never;

    expect(await getTaskCompletionBlockerForStore(partialStore, task)).toBeUndefined();
  });
});
