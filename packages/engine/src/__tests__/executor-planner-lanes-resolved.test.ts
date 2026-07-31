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
import { BUILTIN_CODING_WORKFLOW_IR } from "@fusion/core";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import { createMockStore } from "./executor-test-helpers.js";
import type { WorkflowIr } from "@fusion/core";

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

/**
 * @param syncResolvesIr Feed the SYNC reader the test's IR instead of the default lineage.
 *
 * Default is `false`, which mirrors production: the sync reader answers with the DEFAULT workflow for
 * every task, whatever the card is bound to. Pass `true` ONLY for cases exercising a classifier that
 * is still synchronous — there the sync reader is genuinely the input path, so feeding it the IR
 * tests the classifier's logic rather than the (separately tracked) fact that the reader does not
 * resolve. Those classifiers live in the synchronous `task:moved` listener; converting them needs a
 * restructure of that handler's else-if chain, and their production inertness is held by the
 * `resolveTaskWorkflowIrSync` call-site allow-list.
 */
function harness(ir: WorkflowIr | undefined, column: string, syncResolvesIr = false) {
  const store = createMockStore();
  let task: Record<string, unknown> = completedTaskIn(column);
  const moves: Array<[string, string]> = [];

  /*
  FNXC:WorkflowLifecycleColumns 2026-07-30-23:10 (the sync seam could not see production):
  THE AUTHORITATIVE READERS, not just the sync one.

  This harness injected ONLY `resolveTaskWorkflowIrSync`, so every case here proved the promotion
  LOGIC while being structurally blind to whether production resolves anything at all. It does not:
  that reader's selection lookup returns `undefined` unconditionally in PostgreSQL mode, so the real
  call site resolved the DEFAULT workflow for every card and the recovery never fired on a renamed
  board — with this suite green.

  Feeding the async readers makes the suite exercise the path the call site now takes. The sync
  reader stays wired so a revert to it is visible as a failure here rather than as silence.
  */
  /*
  The sync reader returns the DEFAULT lineage, which is what it ACTUALLY does in production for every
  task regardless of binding. Handing it the test's `ir` — as this harness used to — is the part that
  made the suite unable to tell a resolved answer from an unresolved one: it fed the broken reader the
  right answer. With this, reverting the call site to the sync resolver fails these cases.
  */
  (store as unknown as { resolveTaskWorkflowIrSync: (id: string) => WorkflowIr })
    .resolveTaskWorkflowIrSync = () => (syncResolvesIr ? (ir as WorkflowIr) : (BUILTIN_CODING_WORKFLOW_IR as unknown as WorkflowIr));
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
    const h = harness(RENAMED_SPLIT_IR, "backlog", true);

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

describe("planner-column classification for the planning-evacuation branch", () => {
  it("recognises both renamed planner lanes and nothing else", () => {
    const h = harness(RENAMED_SPLIT_IR, "backlog", true);
    const isPlanner = (column: string) =>
      (h.executor as unknown as { isPlannerColumnFor: (id: string, c: string) => boolean })
        .isPlannerColumnFor("FN-STRANDED", column);

    expect(isPlanner("backlog")).toBe(true);
    expect(isPlanner("queued")).toBe(true);
    expect(isPlanner("building")).toBe(false);
    expect(isPlanner("checking")).toBe(false);
    // The default lineage's names are NOT planner lanes on this board — the point of the
    // conversion is that the answer follows the workflow, in both directions.
    expect(isPlanner("todo")).toBe(false);
    expect(isPlanner("triage")).toBe(false);
  });

  it("falls back to the legacy pair when the workflow cannot be resolved", () => {
    const h = harness(undefined, "todo");
    const isPlanner = (column: string) =>
      (h.executor as unknown as { isPlannerColumnFor: (id: string, c: string) => boolean })
        .isPlannerColumnFor("FN-STRANDED", column);

    expect(isPlanner("todo")).toBe(true);
    expect(isPlanner("triage")).toBe(true);
    expect(isPlanner("in-progress")).toBe(false);
  });
});

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

describe("a forward move off a renamed planner lane is not an evacuation", () => {
  const isBackward = (h: ReturnType<typeof harness>, from: string, to: string) =>
    (h.executor as unknown as { isBackwardMoveOutOfPlanning: (id: string, f: string, t: string) => boolean })
      .isBackwardMoveOutOfPlanning("FN-STRANDED", from, to);

  it("does NOT evacuate a card advancing into the renamed wip/review/complete lanes", () => {
    // Pre-fix each of these returned true, so the executor aborted live planning work and
    // deleted the pre-execution worktree of a card that was merely advancing.
    const h = harness(RENAMED_SPLIT_IR, "backlog", true);

    expect(isBackward(h, "backlog", "building")).toBe(false);
    expect(isBackward(h, "queued", "checking")).toBe(false);
    expect(isBackward(h, "queued", "shipped")).toBe(false);
  });

  it("DOES evacuate a card withdrawn to a non-lifecycle column", () => {
    // The paired positive: the branch must still fire for the case it was written for
    // (the reported symptom was todo -> Ideas).
    const h = harness(RENAMED_SPLIT_IR, "backlog", true);

    expect(isBackward(h, "backlog", "ideas")).toBe(true);
  });

  it("keeps the legacy answer when the workflow has no column vocabulary", () => {
    const h = harness(undefined, "todo");

    expect(isBackward(h, "todo", "in-progress")).toBe(false);
    expect(isBackward(h, "todo", "in-review")).toBe(false);
    expect(isBackward(h, "todo", "done")).toBe(false);
    expect(isBackward(h, "todo", "ideas")).toBe(true);
  });

  it("never fires for a card that was not in a planner lane", () => {
    const h = harness(RENAMED_SPLIT_IR, "building", true);

    expect(isBackward(h, "building", "ideas")).toBe(false);
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
