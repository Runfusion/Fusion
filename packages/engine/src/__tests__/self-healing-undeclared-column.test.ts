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
unloadable-workflow case asserts the guard that now EXISTS: the sweep proves the resolved
IR belongs to the task before moving its card. Before that fix the resolver never rejected
and the card was re-homed against the DEFAULT workflow — a guess. See the note at that
case.
*/
import { describe, expect, it, vi } from "vitest";
import type { Task, WorkflowIr } from "@fusion/core";
import { getBuiltinWorkflow } from "@fusion/core";
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
  FNXC:WorkflowColumns 2026-07-29-00:00 (U12 — the guard now EXISTS):
  A card whose workflow cannot be loaded is SKIPPED, and its neighbour is still repaired.

  History, because it matters for reading this file: the sweep's `catch` around IR
  resolution was dead code. `resolveWorkflowIrById` swallows every failure and returns
  `defaultCodingWorkflowIr()`, so the resolver never rejected and a card with an
  unloadable workflow was judged against the DEFAULT and re-homed to the DEFAULT's
  rebound target — the sweep guessed with someone else's workflow, the exact outcome the
  guard's comment claimed to prevent. Discovered by being unable to make a test of that
  guard fail (PR #2543); the protection is added in this change.

  Both halves are asserted deliberately: the unloadable card must NOT move (no guessing),
  and the neighbour MUST move (one bad card cannot disable the sweep for everyone else —
  the per-task isolation property, which a single-task fixture cannot distinguish from a
  whole-sweep abort).
  */
  it("skips a card whose workflow cannot be loaded, and still repairs its neighbour", async () => {
    const unloadable = task({ id: "FN-3", column: "custom-lane" as Task["column"] });
    const neighbour = task({ id: "FN-3b", column: "todo" });
    const store = makeStore([unloadable, neighbour], { unresolvableWorkflowFor: "FN-3" });

    expect(await manager(store).reconcileUndeclaredTaskColumns()).toBe(1);
    expect(store.moveTask).toHaveBeenCalledTimes(1);
    expect(store.moveTask.mock.calls[0]![0]).toBe("FN-3b");

    // No guess: the card stays exactly where it was.
    expect(unloadable.column).toBe("custom-lane");
    expect(neighbour.column).toBe("triage");
  });

  /*
  FNXC:WorkflowColumns 2026-07-29-00:00 (PR #2600 review — greptile):
  A STALE BUILT-IN id must not pass the resolvability proof. `isBuiltinWorkflowId` is a
  PREFIX check, so `builtin:removed-workflow` satisfied it — and an unknown built-in id
  resolves to the default coding IR, so the card was still re-homed against a workflow that
  is not its own. The guard reproduced the hole it was added to close.

  REVERT CHECK: restore the prefix check (`isBuiltinWorkflowId(...) => true`) and this
  fails — the card is re-homed to the default's target instead of being left alone.
  */
  it("skips a card selecting a built-in workflow that no longer exists", async () => {
    const stale = task({ id: "FN-9", column: "custom-lane" as Task["column"] });
    const store = makeStore([stale]);
    // Prefix-valid, existence-invalid.
    store.getTaskWorkflowSelectionAsync = vi.fn(async () => ({ workflowId: "builtin:removed-workflow" }));

    expect(await manager(store).reconcileUndeclaredTaskColumns()).toBe(0);
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(stale.column).toBe("custom-lane");
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

/*
FNXC:WorkflowColumns 2026-07-29-00:00 (PR #2600 review — greptile):
"PLUGIN-GATED WORKFLOWS PASS PROOF" — checked, and the guard is CORRECT as written.

The claim was that `getBuiltinWorkflow` finds a plugin-gated built-in's static definition
even when the store would reject it, so the guard returns true while the resolver falls
back to the default IR and the sweep guesses anyway.

The second half does not hold. `resolveWorkflowIrById`'s built-in branch reads
`getBuiltinWorkflow(workflowId)` and RETURNS ITS IR WITHOUT EVER CALLING THE STORE — a
store rejection is unreachable for a built-in id. So a plugin-gated selection resolves to
that workflow's OWN IR whether or not its plugin is installed, and there is no guess for
the guard to have prevented.

That is not a coincidence to leave undefended: the guard is right precisely BECAUSE it
uses the same lookup the resolver uses. If someone later routes built-in resolution
through the store, the guard and the resolver diverge and this coupling is what breaks
first. Hence a test rather than a reply.

The genuinely unresolvable built-in case — `builtin:`-prefixed but NOT in the registry,
where `getBuiltinWorkflow` returns undefined and the resolver DOES fall back to the
default — is the hole the parent commit closed, and is covered below it.
*/
describe("plugin-gated built-in selections (PR #2600 review)", () => {
  it("resolves through the static registry, so a store rejection cannot force a guess", () => {
    // Precondition: the static lookup still finds the plugin-gated built-in. If this ever
    // returns undefined the case below is vacuous, so assert it rather than assume it.
    expect(getBuiltinWorkflow("builtin:compound-engineering")).toBeDefined();
  });

  /*
  THE FIXTURE IS THE ARGUMENT. `builtin:compound-engineering` declares `triage`; the
  post-#2515 DEFAULT lineage does not (its columns are todo, in-progress, in-review, done,
  archived) — both measured, not assumed.

  So a card resting in `triage` separates the two worlds cleanly:
    - resolver uses CE's own IR   -> `triage` is DECLARED   -> left alone  (asserted here)
    - resolver fell back to default -> `triage` is UNDECLARED -> re-homed  (greptile's claim)
  This case therefore FAILS in exactly the world the review describes, which is the only
  way to answer "the guard passes proof it should not" with evidence instead of assertion.
  */
  it("leaves a plugin-gated card in a column ITS OWN workflow declares, even when the store rejects it", async () => {
    const card = task({ id: "FN-9", column: "triage" });
    const store = makeStore([card]);
    // The plugin is unavailable: every store-side definition read fails.
    store.getTaskWorkflowSelectionAsync = vi.fn(async () => ({ workflowId: "builtin:compound-engineering" }));
    store.getWorkflowDefinition = vi.fn(async () => {
      throw new Error("plugin fusion-plugin-compound-engineering is not installed");
    });

    const rehomed = await manager(store).reconcileUndeclaredTaskColumns();

    expect(rehomed).toBe(0);
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(card.column).toBe("triage");
    /*
    And the mechanism, pinned directly: the IR came from the static registry, so the
    store was never asked. This is the coupling the guard depends on — if built-in
    resolution is ever routed through the store, this assertion breaks first and names
    the reason.
    */
    expect(store.getWorkflowDefinition).not.toHaveBeenCalled();
  });
});
