/*
FNXC:WorkflowLifecycleColumns 2026-07-30-09:55 (Phase C convergence — executor.ts):

TWO EXECUTOR DECISIONS THAT NAMED THE DEFAULT LINEAGE'S COLUMNS, and what each one
silently stopped doing on a renamed board:

  1. STRANDED-COMPLETED RECOVERY (`recoverCompletedTask`). `promotedFromPlannerColumn` was
     `originColumn === "todo" || === "triage"`. On a renamed board it was false, so
     finished work resting in the planning lane was not promoted — the code fell through to
     `handoffTaskToReview` straight from the planning column, and role adjacency has no
     planning -> review edge, so the handoff was rejected and the card stayed stranded with
     its work complete. This is the recovery of LAST RESORT; a literal here means the last
     resort does not exist off the default lineage.

  2. PLANNING EVACUATION (the `task:moved` branch). `from === "todo" || === "triage"`
     decided whether a card had been pulled BACKWARD out of a lane where pre-execution graph
     work runs. On a renamed board a withdrawn card kept its reviewer streaming and its
     pre-execution worktree on disk.

THE PROMOTION TARGET IS CONVERTED TOO, deliberately. Resolving the planner lane and then
moving to a literal `in-progress` is the half-conversion this program has already been
burned by twice: the guard starts admitting cards on a renamed board and the move then
sends them to a column that board does not declare — strictly worse than refusing, because
the refusal was at least visible.
*/
import { describe, expect, it, vi } from "vitest";
import { BUILTIN_CODING_WORKFLOW_IR, toTaskMoveLanes } from "@fusion/core";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import { createMockStore } from "./executor-test-helpers.js";
import type { WorkflowIr, TaskMoveLanes } from "@fusion/core";

/** Standard traits, non-default names, intake and hold SEPARATE (pre-U11 shape renamed). */
const RENAMED_SPLIT_IR = {
  version: "v2", id: "wf-renamed", name: "renamed", nodes: [], edges: [],
  columns: [
    { id: "backlog", name: "Backlog", traits: [{ trait: "intake" }] },
    { id: "queued", name: "Queued", traits: [{ trait: "hold", config: { release: "capacity" } }] },
    { id: "building", name: "Building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
    { id: "checking", name: "Checking", traits: [{ trait: "merge" }] },
    { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
  ],
} as unknown as WorkflowIr;

/** The post-U11 MERGED shape, renamed: one column carries intake AND hold. */
const RENAMED_MERGED_IR = {
  version: "v2", id: "wf-merged", name: "merged", nodes: [], edges: [],
  columns: [
    {
      id: "planning",
      name: "Planning",
      traits: [{ trait: "intake" }, { trait: "hold", config: { release: "capacity" } }],
    },
    { id: "building", name: "Building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
    { id: "checking", name: "Checking", traits: [{ trait: "merge" }] },
    { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
  ],
} as unknown as WorkflowIr;

function completedTaskIn(column: string) {
  return {
    id: "FN-STRANDED",
    title: "completed but stranded",
    description: "",
    column,
    worktree: "/repo/.worktrees/stranded",
    branch: "fusion/fn-stranded",
    steps: [{ name: "Implement", status: "done" as const }],
    currentStep: 0,
    dependencies: [],
    log: [],
    executionMode: "normal",
    /*
    FIXTURE NOTE: the promotion seam is only REACHED when recovery has nothing left to gate.
    With unsatisfied pre-merge gates, `recoverCompletedTask` re-enters the workflow graph and
    returns before ever classifying the origin column — so a fixture without these passed rows
    silently tests the graph re-entry branch instead, and every assertion below reads as "no
    moves happened" for a reason that has nothing to do with column vocabulary.
    */
    enabledWorkflowSteps: ["plan-review", "code-review"],
    workflowStepResults: [
      { workflowStepId: "plan-review", phase: "pre-merge", status: "passed" },
      { workflowStepId: "code-review", phase: "pre-merge", status: "passed" },
    ],
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
  };
}

function harness(ir: WorkflowIr | undefined, column: string) {
  const store = createMockStore();
  let task: Record<string, unknown> = completedTaskIn(column);
  const moves: Array<[string, string]> = [];

  /*
  FNXC:WorkflowResolvedColumns 2026-08-01-02:07 REDUNDANT:
  Deleting the complete sync-resolver assignment and running
  `pnpm --filter @fusion/engine exec vitest run src/__tests__/executor-planner-lanes-resolved.test.ts --silent=passed-only --reporter=dot`
  passed 12/12. The harness's async selection and definition readers supply the production path;
  its direct classifier cases already pass explicit move lanes, so no sync fixture is required.
  */
  const workflowId = (ir as { id?: string } | undefined)?.id ?? "builtin:coding";
  store.getTaskWorkflowSelectionAsync = vi.fn(async () => (ir ? { workflowId, stepIds: [] } : undefined));
  store.getWorkflowDefinition = vi.fn(async () => (ir ? { ir } : undefined));
  store.getTask.mockImplementation(async () => ({ ...task }));
  store.updateTask.mockImplementation(async (_id: string, updates: Record<string, unknown>) => {
    task = { ...task, ...updates };
    return task;
  });
  store.moveTask.mockImplementation(async (id: string, to: string) => {
    moves.push([id, to]);
    task = { ...task, column: to };
    return { ...task };
  });
  store.recordRunAuditEvent = vi.fn().mockResolvedValue(undefined);

  const executor = new TaskExecutor(store as never, "/repo");
  /*
  The review handoff is the boundary AFTER the decision under test — it opens sessions and
  talks to git. Stubbing it keeps the assertion on the promotion moves; without the stub the
  test would fail for reasons unrelated to which column the promotion targeted.
  */
  const handoff = vi
    .spyOn(executor as unknown as { handoffTaskToReview: (...a: unknown[]) => Promise<void> }, "handoffTaskToReview")
    .mockResolvedValue(undefined);

  return { store, executor, moves, handoff, task: () => task };
}

describe("stranded-completed recovery promotes through the task's OWN planner lanes", () => {
  it("re-homes intake -> hold -> wip on a renamed board that separates the two roles", async () => {
    const h = harness(RENAMED_SPLIT_IR, "backlog");

    const recovered = await h.executor.recoverCompletedTask(completedTaskIn("backlog") as never);

    expect(recovered).toBe(true);
    // Pre-fix: `backlog` matched neither literal, so NO promotion happened and the handoff
    // was attempted from the planning column, which role adjacency rejects.
    expect(h.moves).toEqual([["FN-STRANDED", "queued"], ["FN-STRANDED", "building"]]);
    expect(h.handoff).toHaveBeenCalled();
  });

  it("takes the single hop when the card is already in the renamed hold lane", async () => {
    const h = harness(RENAMED_SPLIT_IR, "queued");

    await h.executor.recoverCompletedTask(completedTaskIn("queued") as never);

    expect(h.moves).toEqual([["FN-STRANDED", "building"]]);
  });

  it("collapses to a single hop on a MERGED planning column (the post-U11 shape)", async () => {
    // hold === intake here, so the re-home would be a no-op move; it must not be emitted.
    const h = harness(RENAMED_MERGED_IR, "planning");

    await h.executor.recoverCompletedTask(completedTaskIn("planning") as never);

    expect(h.moves).toEqual([["FN-STRANDED", "building"]]);
  });

  it("does NOT promote a card that is not in a planner lane at all", async () => {
    // The paired negative: "always promote" must not pass for "resolve the lanes". A card in
    // the review lane is already past planning and owns its own handoff.
    const h = harness(RENAMED_SPLIT_IR, "checking");

    await h.executor.recoverCompletedTask(completedTaskIn("checking") as never);

    expect(h.moves).toEqual([]);
    expect(h.handoff).toHaveBeenCalled();
  });

  it("still promotes on the default lineage (the conversion is not a rename)", async () => {
    const h = harness(undefined, "todo");

    await h.executor.recoverCompletedTask(completedTaskIn("todo") as never);

    expect(h.moves).toEqual([["FN-STRANDED", "in-progress"]]);
  });
});

/*
FNXC:WorkflowResolvedColumns 2026-07-31-23:59:
The `planner-column classification` describe that stood here is DELETED with its subject.

`isPlannerColumnFor` was a private method with no production caller — `tsc` reported it unused, and
these two tests were the only things reaching it, through an `as unknown as { … }` cast that is
exactly what let it look alive. A test whose subject cannot be reached from any code path pins
nothing; keeping it would have meant maintaining assertions about a method the executor never calls.

Its planning-evacuation doc comment described the branch below, which calls
`isBackwardMoveOutOfPlanning` and never called this.
*/

/*
FNXC:WorkflowLifecycleColumns 2026-07-30-17:05 (PR #2628 review — greptile P1 x2):

Both findings are over-reaches in my own first version, and the first one made the branch WORSE
than the bug it replaced. Recording that plainly because it is the third time this program has
produced the same shape: role-aware gate, name-matched destinations.

  1. FORWARD MOVES TRIGGERED EVACUATION. The evacuation branch's source check became role-aware
     while its destination exclusions stayed literal, so on a renamed board an ordinary forward
     move (planning -> building) passed the source test and matched no exclusion. The evacuation
     fired on a card that was simply advancing: live planning work aborted, valid pre-execution
     worktree deleted. Before the conversion the source check failed and nothing happened — so a
     half-conversion turned a missed rescue into active damage.

  2. A MISSING WIP ROLE INVENTED A COLUMN. `resolvePlannerLanes` substituted the legacy
     `in-progress` when a workflow declared no WIP role, so the promotion targeted a column that
     board does not declare. `moveTask` rejects it, recovery reports failure — and since the
     intake -> hold re-home runs FIRST, the card could be left half-moved. Now `wip`/`review`/
     `complete` are OPTIONAL when the workflow speaks columns, and the caller refuses BEFORE any
     move.
*/
/** Planning lanes but NO wip role — a legal shape with nowhere to promote completed work to. */
const NO_WIP_IR = {
  version: "v2", id: "wf-no-wip", name: "no-wip", nodes: [], edges: [],
  columns: [
    { id: "backlog", name: "Backlog", traits: [{ trait: "intake" }] },
    { id: "queued", name: "Queued", traits: [{ trait: "hold", config: { release: "capacity" } }] },
    { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
  ],
} as unknown as WorkflowIr;

/*
FNXC:WorkflowResolvedColumns 2026-07-31-23:59 (LANES NOW COME FROM THE EMITTER):
`isBackwardMoveOutOfPlanning` no longer resolves its own lanes — it receives the `TaskMoveLanes` the
`task:moved` emitter already resolved asynchronously. So the harness's IR is converted here with
`toTaskMoveLanes`, which is the SAME function `moves.ts` calls to build the payload.

That makes these tests stronger than they were, not merely adapted. Previously they reached the
predicate through the store-backed SYNC resolver, which in production returns the DEFAULT board for
every task — so the renamed-lane assertions passed in the harness while the real code path could
never see a renamed lane. Driving the actual payload shape removes that gap between what the test
exercises and what runs.

`undefined` lanes model the emitter failing to resolve, which is when the legacy ids answer.
*/
describe("a forward move off a renamed planner lane is not an evacuation", () => {
  const isBackward = (h: ReturnType<typeof harness>, from: string, to: string, ir?: WorkflowIr) =>
    (h.executor as unknown as { isBackwardMoveOutOfPlanning: (id: string, f: string, t: string, l: TaskMoveLanes | undefined) => boolean })
      .isBackwardMoveOutOfPlanning("FN-STRANDED", from, to, ir ? toTaskMoveLanes(ir) : undefined);

  it("does NOT evacuate a card advancing into the renamed wip/review/complete lanes", () => {
    // Pre-fix each of these returned true, so the executor aborted live planning work and
    // deleted the pre-execution worktree of a card that was merely advancing.
    const h = harness(RENAMED_SPLIT_IR, "backlog");

    expect(isBackward(h, "backlog", "building", RENAMED_SPLIT_IR)).toBe(false);
    expect(isBackward(h, "queued", "checking", RENAMED_SPLIT_IR)).toBe(false);
    expect(isBackward(h, "queued", "shipped", RENAMED_SPLIT_IR)).toBe(false);
  });

  it("DOES evacuate a card withdrawn to a non-lifecycle column", () => {
    // The paired positive: the branch must still fire for the case it was written for
    // (the reported symptom was todo -> Ideas).
    const h = harness(RENAMED_SPLIT_IR, "backlog");

    expect(isBackward(h, "backlog", "ideas", RENAMED_SPLIT_IR)).toBe(true);
  });

  it("keeps the legacy answer when the workflow has no column vocabulary", () => {
    const h = harness(undefined, "todo");

    expect(isBackward(h, "todo", "in-progress")).toBe(false);
    expect(isBackward(h, "todo", "in-review")).toBe(false);
    expect(isBackward(h, "todo", "done")).toBe(false);
    expect(isBackward(h, "todo", "ideas")).toBe(true);
  });

  it("never fires for a card that was not in a planner lane", () => {
    const h = harness(RENAMED_SPLIT_IR, "building");

    expect(isBackward(h, "building", "ideas", RENAMED_SPLIT_IR)).toBe(false);
  });
});

describe("a workflow with no WIP lane is refused, not promoted to an invented column", () => {
  it("withholds recovery without issuing ANY move", async () => {
    // Pre-fix: the intake -> hold re-home was issued first, then the promotion targeted the
    // undeclared `in-progress` and was rejected — leaving the card half-moved.
    const h = harness(NO_WIP_IR, "backlog");

    const recovered = await h.executor.recoverCompletedTask(completedTaskIn("backlog") as never);

    expect(recovered).toBe(false);
    expect(h.moves).toEqual([]);
    expect(h.handoff).not.toHaveBeenCalled();
  });

  it("says so in the task log rather than skipping the card silently", async () => {
    // Nothing else owns this state, so a silent withhold is indistinguishable from the
    // stranding this recovery exists to fix.
    const h = harness(NO_WIP_IR, "queued");

    await h.executor.recoverCompletedTask(completedTaskIn("queued") as never);

    const messages = (h.store.logEntry as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((call) => String(call[1] ?? ""));
    expect(messages.some((m) => m.includes("no WIP column"))).toBe(true);
  });

  it("still promotes when the workflow DOES declare a wip lane", async () => {
    // The paired negative: "refuse when a role is missing" must not become "refuse always".
    const h = harness(RENAMED_SPLIT_IR, "queued");

    await h.executor.recoverCompletedTask(completedTaskIn("queued") as never);

    expect(h.moves).toEqual([["FN-STRANDED", "building"]]);
  });
});
