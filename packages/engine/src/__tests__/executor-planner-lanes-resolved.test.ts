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

function harness(ir: WorkflowIr | undefined, column: string) {
  const store = createMockStore();
  let task: Record<string, unknown> = completedTaskIn(column);
  const moves: Array<[string, string]> = [];

  (store as unknown as { resolveTaskWorkflowIrSync: (id: string) => WorkflowIr | undefined })
    .resolveTaskWorkflowIrSync = () => ir;
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

describe("planner-column classification for the planning-evacuation branch", () => {
  it("recognises both renamed planner lanes and nothing else", () => {
    const h = harness(RENAMED_SPLIT_IR, "backlog");
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
