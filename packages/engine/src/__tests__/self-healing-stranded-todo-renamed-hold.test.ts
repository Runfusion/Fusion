/*
FNXC:WorkflowLifecycleColumns 2026-07-28-06:10 (Phase B / slice B3.1 — U4):

`recoverStrandedCompletedTodoTasks` promotes a card whose steps are all
done/skipped but which is still sitting in the HOLD column — work that finished
and never handed off to review. It decides "is this card in the hold column?"
TWICE, and both were literal:

  1. the QUERY — `listTasks({ column: "todo", slim: true })`
  2. the per-task GUARD — `task.column !== "todo"`

Both must convert together. Converting only the guard leaves a correct predicate
the sweep never reaches, because the query already returned an empty list;
converting only the query leaves the guard rejecting every row it just fetched.
Either half alone is a green diff with zero behavior change — the exact shape
that made B1's stale-paused-todo fix cosmetic.

TEST-HARNESS WARNING, load-bearing. The pre-existing `self-healing.test.ts` store
mock returns its fixture from `listTasks` REGARDLESS of arguments. A renamed-hold
test written on that harness passes while the query stays hardcoded, because the
mock hands the sweep rows the real store never would. The mock below therefore
HONORS `options.column`, and one test asserts the query is no longer scoped to
the literal. Do not "simplify" this mock.
*/
import { describe, expect, it, vi } from "vitest";
import type { Task, TaskStore, WorkflowIr } from "@fusion/core";

import { SelfHealingManager } from "../self-healing.js";

const WF = "custom:wf";

/** A card whose steps are all done — stranded, awaiting promotion to review. */
function strandedTask(over: Partial<Task> = {}): Task {
  return {
    id: "FN-1",
    title: "t",
    description: "",
    column: "todo",
    paused: false,
    dependencies: [],
    steps: [{ name: "s1", status: "done" }],
    currentStep: 1,
    log: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    columnMovedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  } as unknown as Task;
}

function ir(holdId: string): WorkflowIr {
  return {
    version: "v2",
    id: WF,
    nodes: [],
    edges: [],
    columns: [
      { id: holdId, label: "Hold", traits: [{ trait: "hold", config: { release: "capacity" } }] },
      { id: "building", label: "Building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      { id: "reviewing", label: "Reviewing", traits: [{ trait: "mergeOrchestration" }] },
      { id: "shipped", label: "Shipped", traits: [{ trait: "complete" }] },
    ],
  } as unknown as WorkflowIr;
}

function harness(tasks: Task[], workflowIr: WorkflowIr | undefined) {
  const recovered: string[] = [];
  const selection = { workflowId: WF, stepIds: [] };
  const listTasks = vi.fn(async (opts?: { column?: string }) =>
    /* HONORS the column filter — see the file header. */
    opts?.column ? tasks.filter((t) => t.column === opts.column) : tasks,
  );
  const store = {
    listTasks,
    getTask: vi.fn(async (id: string) => tasks.find((t) => t.id === id) ?? null),
    getSettings: vi.fn(async () => ({})),
    logEntry: vi.fn(async () => undefined),
    recordRunAuditEvent: vi.fn(async () => undefined),
    getTaskWorkflowSelection: vi.fn(() => selection),
    getTaskWorkflowSelectionAsync: vi.fn(async () => selection),
    getWorkflowDefinition: vi.fn(async () => (workflowIr ? { ir: workflowIr } : null)),
  } as unknown as TaskStore;

  const manager = new SelfHealingManager(store, {
    rootDir: "/tmp/test-project",
    recoverCompletedTask: async (task: Task) => {
      recovered.push(task.id);
      return true;
    },
  } as never);

  return { manager, store, listTasks, recovered };
}

describe("recoverStrandedCompletedTodoTasks under a renamed hold column", () => {
  it("recovers a stranded completed card resting in a RENAMED hold column", async () => {
    /* The whole point: this card finished its work and is stuck. Under the
       literal query+guard the sweep does not see it at all, so it sits in
       `drafting` forever with no error and no failing test. */
    const task = strandedTask({ id: "FN-R", column: "drafting" });
    const h = harness([task], ir("drafting"));

    const count = await h.manager.recoverStrandedCompletedTodoTasks();

    expect(count).toBe(1);
    expect(h.recovered).toEqual(["FN-R"]);
  });

  it("does not scope its query to the literal todo column", async () => {
    /* Pins the QUERY half directly. A correct guard behind a `column: "todo"`
       query is a guard that never runs — the conversion would be cosmetic. */
    const task = strandedTask({ id: "FN-R", column: "drafting" });
    const h = harness([task], ir("drafting"));

    await h.manager.recoverStrandedCompletedTodoTasks();

    const columnArgs = h.listTasks.mock.calls.map(
      (call) => (call[0] as { column?: string } | undefined)?.column,
    );
    expect(columnArgs).not.toContain("todo");
  });

  it("does NOT recover a completed card resting in a NON-hold column", async () => {
    /*
    The negative half the phase brief requires. Dropping the column filter
    without a per-task hold check would promote finished cards out of the WIP and
    review columns too — a louder bug than the silent one it replaces, and one
    that would launder work past review.
    */
    const wip = strandedTask({ id: "FN-W", column: "building" });
    const review = strandedTask({ id: "FN-V", column: "reviewing" });
    const h = harness([wip, review], ir("drafting"));

    const count = await h.manager.recoverStrandedCompletedTodoTasks();

    expect(count).toBe(0);
    expect(h.recovered).toEqual([]);
  });

  it("still recovers a builtin todo card (regression floor)", async () => {
    const task = strandedTask({ id: "FN-D", column: "todo" });
    const h = harness([task], ir("todo"));

    expect(await h.manager.recoverStrandedCompletedTodoTasks()).toBe(1);
    expect(h.recovered).toEqual(["FN-D"]);
  });

  it("falls back to the legacy todo column when the workflow cannot be resolved", async () => {
    /* Conservative: an unresolvable workflow must behave exactly as it did
       before this conversion rather than guessing. */
    const task = strandedTask({ id: "FN-U", column: "todo" });
    const h = harness([task], undefined);

    expect(await h.manager.recoverStrandedCompletedTodoTasks()).toBe(1);
  });

  it("handles a board mixing a renamed and a builtin workflow", async () => {
    /* Per-task resolution, not one board-wide vocabulary: each card's hold
       column comes from ITS OWN workflow, and a card in the OTHER workflow's
       hold column must not be promoted. */
    const renamed = strandedTask({ id: "FN-R", column: "drafting" });
    const legacy = strandedTask({ id: "FN-D", column: "todo" });
    // FN-R belongs to the renamed workflow; FN-D to the builtin one.
    const irByWorkflow: Record<string, WorkflowIr> = {
      "wf-renamed": ir("drafting"),
      "wf-legacy": ir("todo"),
    };
    const byTask: Record<string, string> = { "FN-R": "wf-renamed", "FN-D": "wf-legacy" };
    const tasks = [renamed, legacy];
    const recovered: string[] = [];
    const store = {
      listTasks: vi.fn(async (opts?: { column?: string }) =>
        opts?.column ? tasks.filter((t) => t.column === opts.column) : tasks,
      ),
      getTask: vi.fn(async (id: string) => tasks.find((t) => t.id === id) ?? null),
      getSettings: vi.fn(async () => ({})),
      logEntry: vi.fn(async () => undefined),
      recordRunAuditEvent: vi.fn(async () => undefined),
      getTaskWorkflowSelection: vi.fn((id: string) => ({ workflowId: byTask[id], stepIds: [] })),
      getTaskWorkflowSelectionAsync: vi.fn(async (id: string) => ({ workflowId: byTask[id], stepIds: [] })),
      getWorkflowDefinition: vi.fn(async (id: string) => (irByWorkflow[id] ? { ir: irByWorkflow[id] } : null)),
    } as unknown as TaskStore;
    const manager = new SelfHealingManager(store, {
      rootDir: "/tmp/test-project",
      recoverCompletedTask: async (task: Task) => {
        recovered.push(task.id);
        return true;
      },
    } as never);

    const count = await manager.recoverStrandedCompletedTodoTasks();

    expect(count).toBe(2);
    expect(recovered.sort()).toEqual(["FN-D", "FN-R"]);
  });

  it("leaves the existing non-column guards intact under a renamed workflow", async () => {
    /*
    The conversion must not widen the sweep. These three rejections
    (paused / incomplete steps / errored) are the ones most likely to be lost
    when a filter is rewritten, and each independently protects against
    promoting work that is not actually finished.
    */
    const paused = strandedTask({ id: "FN-P", column: "drafting", paused: true });
    const incomplete = strandedTask({
      id: "FN-I",
      column: "drafting",
      steps: [{ name: "s1", status: "pending" }],
    } as Partial<Task>);
    const errored = strandedTask({ id: "FN-E", column: "drafting", error: "boom" } as Partial<Task>);
    const h = harness([paused, incomplete, errored], ir("drafting"));

    expect(await h.manager.recoverStrandedCompletedTodoTasks()).toBe(0);
    expect(h.recovered).toEqual([]);
  });
});
