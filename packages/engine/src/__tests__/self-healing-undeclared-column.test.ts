/*
FNXC:WorkflowColumns 2026-07-29-00:00 (U12 — R7):
Coverage for `reconcileUndeclaredTaskColumns`, the sweep that re-homes a card resting in
a column its workflow no longer declares.

WHY IT NEEDED ITS OWN TEST. The sweep is the shipped answer to R7 and the reason several
other U12 deletions were safe — I cited it when deleting the superseded
`runWorkflowColumnsIntegrityPass` and again when arguing that a torn workflow switch
leaves recoverable state. Yet its only coverage was incidental, inside two live
PostgreSQL e2e suites that exercise it in passing. A repair everything else leans on was
itself unpinned, which is the same shape as the rest of this unit: a guarantee everyone
cites and nobody checks.

The plan names three scenarios for U12, and they are the three ways this sweep can be
wrong: it must repair the stranded card, it must LEAVE ALONE the two states where a
repair would be a guess, and re-running it must not move the card twice. The
leave-alone cases matter more than the repair — a sweep that over-fires rewrites an
operator's board.

These run against a store double rather than PostgreSQL: the sweep's decisions are pure
functions of the task list and the resolved IR, and a double makes the "did NOT move"
assertions exact rather than inferred from absence of change.

MECHANISM COVERAGE, measured rather than claimed. Deleting the user-pause guard fails 2
cases; deleting the already-declared short-circuit fails 2 cases. The
unresolvable-workflow case was REWRITTEN after PR #2543 review: chasing per-task isolation
proved the sweep's unresolvable-workflow guard is UNREACHABLE (the IR resolver never
rejects), so the case now asserts what actually happens — resolution falls back to the
default workflow and the card is re-homed on a guess — plus the isolation property the
review asked for. See the note at that case.
*/
import { describe, expect, it, vi } from "vitest";
import type { Task, WorkflowIr } from "@fusion/core";
import { SelfHealingManager } from "../self-healing.js";

/** A workflow declaring `intake` + `hold` + `done`, with NO `todo` column. A card stored
 *  in `todo` is therefore undeclared — the U11 Todo→Planning merge shape. */
const WORKFLOW_WITHOUT_TODO: WorkflowIr = {
  version: "v2",
  name: "no-todo",
  columns: [
    { id: "triage", name: "Planning", traits: [{ trait: "intake" }, { trait: "hold", config: { release: "capacity" } }] },
    { id: "in-progress", name: "In progress", traits: [{ trait: "wip" }] },
    { id: "done", name: "Done", traits: [{ trait: "complete" }] },
  ],
  nodes: [
    { id: "start", kind: "start", column: "triage" },
    { id: "end", kind: "end", column: "done" },
  ],
  edges: [{ from: "start", to: "end" }],
} as unknown as WorkflowIr;

function task(overrides: Partial<Task> & Pick<Task, "id" | "column">): Task {
  return {
    title: overrides.id,
    description: "",
    priority: "normal",
    status: undefined,
    steps: [],
    dependencies: [],
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    log: [],
    ...overrides,
  } as unknown as Task;
}

/** Minimal store surface the sweep touches. `resolveWorkflowIrForTask` reads the
 *  selection then the definition, so both are stubbed. */
/*
FNXC:WorkflowColumns 2026-07-29-00:00 (PR #2543 review — CodeRabbit, second pass):
`unresolvableWorkflowFor` must make the IR RESOLVER throw, not the selection read.
`resolveWorkflowIrForTask` wraps the selection lookup in its own try/catch and returns the
DEFAULT coding IR on failure — so a throwing `getTaskWorkflowSelectionAsync` never reaches
the sweep's guard at all. My first fixture did exactly that, which is why nothing could
make the case fail: the card was being skipped by the already-declared check (the default
IR declares `todo`), not by the unresolvable path. The test was named for a branch it
never entered.

Routing the failure through the DEFINITION lookup makes the exception propagate to the
sweep, which is the state the guard exists for.
*/
function makeStore(tasks: Task[], options?: { unresolvableWorkflowFor?: string }) {
  const moveTask = vi.fn(async (id: string, column: string, _options?: Record<string, unknown>) => {
    const found = tasks.find((candidate) => candidate.id === id);
    if (found) (found as { column: string }).column = column;
    return found as Task;
  });
  const recordRunAuditEvent = vi.fn(async () => undefined);
  return {
    moveTask,
    recordRunAuditEvent,
    listTasks: vi.fn(async (opts?: { offset?: number }) => ((opts?.offset ?? 0) === 0 ? tasks : [])),
    getTaskWorkflowSelectionAsync: vi.fn(async (id: string) => ({
      workflowId: options?.unresolvableWorkflowFor === id ? "wf-broken" : "wf-no-todo",
    })),
    getTaskWorkflowSelection: vi.fn(() => ({ workflowId: "wf-no-todo" })),
    getWorkflowDefinition: vi.fn(async (id: string) => {
      if (id === "wf-broken") throw new Error("workflow definition unreadable");
      return { id: "wf-no-todo", name: "no-todo", ir: WORKFLOW_WITHOUT_TODO };
    }),
    listWorkflowDefinitions: vi.fn(async () => []),
    getSettings: vi.fn(async () => ({})),
  };
}

function manager(store: ReturnType<typeof makeStore>) {
  return new SelfHealingManager(store as never, { rootDir: "/tmp/u12-undeclared" } as never);
}

describe("reconcileUndeclaredTaskColumns (U12 — R7)", () => {
  it("re-homes a card stranded in a column its workflow no longer declares", async () => {
    const stranded = task({ id: "FN-1", column: "todo" });
    const store = makeStore([stranded]);

    const rehomed = await manager(store).reconcileUndeclaredTaskColumns();

    expect(rehomed).toBe(1);
    expect(store.moveTask).toHaveBeenCalledTimes(1);
    const [movedId, movedColumn, movedOptions] = store.moveTask.mock.calls[0]!;
    expect(movedId).toBe("FN-1");
    // The workflow's own rebound target, not a hardcoded legacy id.
    expect(movedColumn).toBe("triage");
    /*
    `recoveryRehome` is load-bearing, not incidental: the card's SOURCE column is
    undeclared too, so adjacency resolves to [] and every target is rejected without it.
    Its absence once made this sweep a repair that never repaired anything.
    */
    expect(movedOptions).toMatchObject({ recoveryRehome: true, bypassGuards: true, preserveProgress: true });
  });

  it("leaves a USER-PAUSED card alone", async () => {
    const paused = task({ id: "FN-2", column: "todo", userPaused: true });
    const store = makeStore([paused]);

    expect(await manager(store).reconcileUndeclaredTaskColumns()).toBe(0);
    // An operator pause is a deliberate hold; moving the card would override a human.
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(paused.column).toBe("todo");
  });

  /*
  FNXC:WorkflowColumns 2026-07-29-00:00 (PR #2543 review — CodeRabbit, and a real finding):
  THE SWEEP'S "UNRESOLVABLE WORKFLOW" GUARD CANNOT FIRE. Chasing the review's request to
  prove per-task isolation, I could not make the case fail under any mutation — including
  simulating a whole-sweep abort. The reason is upstream: `resolveWorkflowIrById` catches
  EVERY failure and returns `defaultCodingWorkflowIr()`, and `resolveWorkflowIrForTask`
  does the same for a failed selection read. So `resolveWorkflowIrForTask` never rejects,
  the sweep's `try/catch` around it is unreachable, and its comment — "do not guess a
  column" — describes protection that does not exist.

  What ACTUALLY happens to a card whose workflow cannot be read: it is judged against the
  DEFAULT workflow. If its column is not one the default declares, the sweep re-homes it
  to the default's rebound target — i.e. it guesses, using a workflow that is not the
  card's own. That is the exact outcome the guard was written to prevent.

  This test now asserts the real behaviour rather than the intended behaviour, because a
  test asserting the intent would pass for the wrong reason and hide the gap. The fix
  belongs upstream (the resolver needs to signal failure, or the sweep needs to detect
  "I was handed the default IR but this task selects something else") and is a behaviour
  change, not test work — flagged in the PR body rather than smuggled in here.

  The per-task isolation the review asked for IS pinned: two stranded cards, one with an
  unreadable workflow, and the sweep must still process both rather than dying on the
  first.
  */
  it("resolves an unreadable workflow to the DEFAULT and keeps processing other cards", async () => {
    const unreadable = task({ id: "FN-3", column: "custom-lane" as Task["column"] });
    const neighbour = task({ id: "FN-3b", column: "todo" });
    const store = makeStore([unreadable, neighbour], { unresolvableWorkflowFor: "FN-3" });

    const rehomed = await manager(store).reconcileUndeclaredTaskColumns();

    /*
    Both cards move: the neighbour correctly (its own workflow lacks `todo`), and FN-3 on a
    GUESS against the default workflow. A failure here of `2 -> 0` would mean the resolver
    exception aborted the whole sweep, which is the isolation property under test.
    */
    expect(rehomed).toBe(2);
    expect(store.moveTask.mock.calls.map((call) => call[0]).sort()).toEqual(["FN-3", "FN-3b"]);
    expect(neighbour.column).toBe("triage");
  });

  it("is idempotent: a second run does not move the card again", async () => {
    const stranded = task({ id: "FN-4", column: "todo" });
    const store = makeStore([stranded]);
    const sweep = manager(store);

    expect(await sweep.reconcileUndeclaredTaskColumns()).toBe(1);
    // The double mutates the task's column, so the second pass sees the repaired state.
    expect(await sweep.reconcileUndeclaredTaskColumns()).toBe(0);
    expect(store.moveTask).toHaveBeenCalledTimes(1);
  });

  it("does not touch a card already resting in a DECLARED column", async () => {
    const healthy = task({ id: "FN-5", column: "in-progress" });
    const store = makeStore([healthy]);

    expect(await manager(store).reconcileUndeclaredTaskColumns()).toBe(0);
    expect(store.moveTask).not.toHaveBeenCalled();
  });

  it("repairs one stranded card without disturbing its healthy neighbours", async () => {
    // The over-fire check: a sweep that rewrites an operator's board is worse than one
    // that under-repairs, so the healthy cards must be provably untouched.
    const stranded = task({ id: "FN-6", column: "todo" });
    const healthy = task({ id: "FN-7", column: "in-progress" });
    const paused = task({ id: "FN-8", column: "todo", userPaused: true });
    const store = makeStore([stranded, healthy, paused]);

    expect(await manager(store).reconcileUndeclaredTaskColumns()).toBe(1);
    expect(store.moveTask).toHaveBeenCalledTimes(1);
    expect(store.moveTask.mock.calls[0]![0]).toBe("FN-6");
    expect(healthy.column).toBe("in-progress");
    expect(paused.column).toBe("todo");
  });
});
