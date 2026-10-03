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
import {
  BUILTIN_CODING_WORKFLOW_IR,
  resolveAllowedColumns,
  resolveLifecycleColumns,
  toTaskMoveLanes,
  workflowHasColumn,
} from "@fusion/core";
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

/**
 * The same renamed board after an operator re-wires its WIP lane id. Used to prove the landing
 * check answers against the workflow IN FORCE, not against the decision snapshot's lanes.
 */
const RENAMED_SPLIT_REWIRED_IR = {
  version: "v2", id: "wf-renamed-rewired", name: "renamed-rewired", nodes: [], edges: [],
  columns: [
    { id: "backlog", name: "Backlog", traits: [{ trait: "intake" }] },
    { id: "queued", name: "Queued", traits: [{ trait: "hold", config: { release: "capacity" } }] },
    { id: "delivering", name: "Delivering", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
    { id: "checking", name: "Checking", traits: [{ trait: "merge" }] },
    { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
  ],
} as unknown as WorkflowIr;

/**
 * The same renamed board with BOTH the hold and the WIP lane re-wired. Used to tell a card
 * sitting in a DECLARED hold lane (a legitimate requeue) apart from one sitting in a column the
 * board no longer declares at all (an orphan) — the only difference a re-home may act on.
 */
const RENAMED_SPLIT_REWIRED_HOLD_IR = {
  version: "v2", id: "wf-renamed-rewired-hold", name: "renamed-rewired-hold", nodes: [], edges: [],
  columns: [
    { id: "backlog", name: "Backlog", traits: [{ trait: "intake" }] },
    { id: "staged", name: "Staged", traits: [{ trait: "hold", config: { release: "capacity" } }] },
    { id: "delivering", name: "Delivering", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
    { id: "checking", name: "Checking", traits: [{ trait: "merge" }] },
    { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
  ],
} as unknown as WorkflowIr;

/** A v1 IR: no column vocabulary, which is what makes the lane resolver answer the LEGACY lanes. */
const COLUMNLESS_IR = { version: "v1", nodes: [], edges: [] } as unknown as WorkflowIr;

/**
 * The same renamed board plus a DECLARED lane carrying NO lifecycle trait (`parked`), the shape that
 * makes hop 1's missing fence observable against the real store:
 *
 *  - `moveTaskInternal` skips adjacency for a `recoveryRehome` move, so the store does not refuse an
 *    engine move out of `parked` into the hold lane (`evaluateTransitionInvariants` answers ALLOWED:
 *    a trait-less column has no lifecycle role, so no direction rule applies).
 *  - `parked` is nevertheless DECLARED, so leaving the card there is a correct outcome and not a
 *    stranding — and unlike a second hold lane it still admits a handoff to review, so the next sweep
 *    can advance it. Both halves of the regression are therefore observable.
 */
const RENAMED_SPLIT_PARKED_IR = {
  version: "v2", id: "wf-renamed-parked", name: "renamed-parked", nodes: [], edges: [],
  columns: [
    { id: "backlog", name: "Backlog", traits: [{ trait: "intake" }] },
    { id: "queued", name: "Queued", traits: [{ trait: "hold", config: { release: "capacity" } }] },
    { id: "building", name: "Building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
    { id: "parked", name: "Parked", traits: [] },
    { id: "checking", name: "Checking", traits: [{ trait: "merge" }] },
    { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
  ],
} as unknown as WorkflowIr;

/*
FNXC:WorkflowLifecycleColumns 2026-10-02-14:20:
The three cases below are the seam the recovery itself has to survive: a workflow that stops
answering (the lane resolver falls back to the legacy ids), a board edit that lands WHILE the
landing lanes are being resolved, and a requeue that arrives at the same moment as a board edit.
Each one is modelled from the REAL authority — the workflow is resolved on every read and a
handoff out of a column the board in force does not declare is rejected exactly as
`moveTaskInternal` rejects it — because a handoff stubbed to resolve is what makes a stranded
card look recovered.
*/

/** Board identity by workflow id, so a selection change really re-points the definition read. */
const BOARDS_BY_ID: Record<string, WorkflowIr> = {
  "wf-renamed": RENAMED_SPLIT_IR,
  "wf-renamed-rewired": RENAMED_SPLIT_REWIRED_IR,
  "wf-renamed-rewired-hold": RENAMED_SPLIT_REWIRED_HOLD_IR,
};

describe("a promotion is only re-homed from a column the board in force does not declare", () => {
  const loggedMessages = (h: ReturnType<typeof harness>) =>
    (h.store.logEntry as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((call) => String(call[1] ?? ""));

  /**
   * The real handoff path, not a stub that resolves: resolve the workflow in force and reject
   * exactly as `moveTaskInternal` does when the source column has no adjacency to review.
   */
  const modelHandoffAuthority = (h: ReturnType<typeof harness>, boardInForce: () => WorkflowIr) => {
    h.handoff.mockImplementation((async (task: { id: string; column?: string }) => {
      const ir = boardInForce() as Parameters<typeof resolveAllowedColumns>[0];
      const review = resolveLifecycleColumns(ir)?.review ?? "in-review";
      if (!workflowHasColumn(ir, review)) throw new Error(`Unknown column for this workflow: '${review}'`);
      const allowed = resolveAllowedColumns(ir, String(task.column));
      if (!allowed.includes(review)) {
        throw new Error(
          `Invalid transition: '${task.column}' → '${review}'. Valid targets: ${allowed.join(", ") || "none"}`,
        );
      }
      await h.store.moveTask(task.id, review);
    }) as (...args: unknown[]) => Promise<void>);
  };

  /*
  FNXC:WorkflowLifecycleColumns 2026-10-02-14:20 (lane resolution stopped answering):
  `resolvePlannerLanesForTaskAsync` answers the LEGACY ids whenever the workflow carries no
  column vocabulary, and those answers DISAGREE with the board's real lanes. The re-home branch
  compared lane answers and treated that disagreement as a board edit, so it moved completed work
  toward `in-progress` — a column this board does not declare — after the card had landed
  correctly. The fallback names no board, so it can never prove a source is undeclared.
  */
  it("does not re-home toward legacy lanes when lane resolution falls back after the hops", async () => {
    const h = harness(RENAMED_SPLIT_IR, "backlog");
    // Stage-keyed: the pre-hop resolutions run with `h.moves` empty and answer the real board;
    // the LANDING resolution is the one that stops answering.
    h.store.getWorkflowDefinition = vi.fn(async () => ({ ir: h.moves.length > 0 ? COLUMNLESS_IR : RENAMED_SPLIT_IR }));

    const recovered = await h.executor.recoverCompletedTask(completedTaskIn("backlog") as never);

    expect(recovered).toBe(false);
    // The card landed correctly in the board's own WIP lane; the only extra hop would be the
    // legacy `in-progress` this board does not declare.
    expect(h.moves).toEqual([["FN-STRANDED", "queued"], ["FN-STRANDED", "building"]]);
    expect((h.task() as { column?: string }).column).toBe("building");
    // A lane answer with no board behind it is a fallback, not a board edit, so it is reported
    // as a withhold rather than acted on.
    expect(h.handoff).not.toHaveBeenCalled();
    expect(loggedMessages(h).some((m) => m.includes("did not land in 'in-progress'"))).toBe(true);
  });

  /*
  FNXC:WorkflowLifecycleColumns 2026-10-02-14:20 (the re-home inside the refused landing is not
  enough): the landing lanes are read ONCE, so a selection change that lands inside that read is
  invisible to it — the read answers with the board that was in force when it started, the row it
  validates then belongs to a board that no longer exists, and the real handoff rejects it. The
  card is left in a column the board in force does not declare, and every later sweep skips the
  promotion branch entirely (`promotedFromPlannerColumn` is false for it) and hands off from that
  same dead source. So the repair has to happen on the LATER attempt, not only inside the refusal.
  */
  it("recovers on a later sweep when the board changed while the landing lanes were resolving", async () => {
    const h = harness(RENAMED_SPLIT_IR, "backlog");
    let rewired = false;
    const boardInForce = () => (rewired ? RENAMED_SPLIT_REWIRED_IR : RENAMED_SPLIT_IR);
    h.store.getWorkflowDefinition = vi.fn(async (id: string) => ({ ir: BOARDS_BY_ID[id] ?? RENAMED_SPLIT_IR }));
    // The selection flips WHILE the landing lanes resolve: that read answers the old board, and
    // the handoff that follows — which resolves the workflow itself — sees the new one.
    h.store.getTaskWorkflowSelectionAsync = vi.fn(async () => {
      const id = rewired ? "wf-renamed-rewired" : "wf-renamed";
      if (h.moves.length > 0) rewired = true;
      return { workflowId: id, stepIds: [] };
    });
    modelHandoffAuthority(h, boardInForce);

    // Sweep 1: the hops land in the old board's WIP lane, the landing check passes against the
    // board the read started on, and the real handoff rejects the now-obsolete source.
    const first = await h.executor.recoverCompletedTask(completedTaskIn("backlog") as never);
    expect(first).toBe(false);
    expect((h.task() as { column?: string }).column).toBe("building");
    expect(workflowHasColumn(boardInForce() as never, "building")).toBe(false);

    // Sweep 2: the edit has settled, so the card is in a column this board does not declare and
    // the promotion branch no longer runs for it. Pre-fix this sweep hands off from the dead
    // source and is rejected identically, forever.
    const second = await h.executor.recoverCompletedTask(h.task() as never);
    expect(second).toBe(false);
    // The orphan is repaired under the board in force, not left where the rejected handoff put it.
    expect(workflowHasColumn(boardInForce() as never, String((h.task() as { column?: string }).column))).toBe(true);

    // Sweep 3: the card is in a lane this board declares, so recovery hands it off for real.
    const third = await h.executor.recoverCompletedTask(h.task() as never);
    expect(third).toBe(true);
    expect((h.task() as { column?: string }).column).toBe("checking");
  });

  /*
  FNXC:WorkflowLifecycleColumns 2026-10-02-14:20 (requeue and board change are not exclusive):
  the re-home branch asked only whether the lanes disagreed and whether the card was somewhere
  other than the new WIP lane. A pause/resume abort re-queues the row into a DECLARED hold lane
  at the same moment the board is re-wired, and that re-home answers both questions — so it
  dragged a legitimately re-queued card straight into WIP, discarding the queue placement. A
  requeue is not a board edit: the source is a lane this board declares, so the re-home must not
  touch it, and the ordinary promotion must still run from it on the next sweep.
  */
  it("preserves a requeue that lands in a declared hold lane while the board is re-wired", async () => {
    const h = harness(RENAMED_SPLIT_IR, "backlog");
    let rewired = false;
    const boardInForce = () => (rewired ? RENAMED_SPLIT_REWIRED_HOLD_IR : RENAMED_SPLIT_IR);
    h.store.getWorkflowDefinition = vi.fn(async (id: string) => ({ ir: BOARDS_BY_ID[id] ?? RENAMED_SPLIT_IR }));
    h.store.getTaskWorkflowSelectionAsync = vi.fn(async () => {
      // The board edit lands INSIDE the landing-lane read, so the landing answer disagrees with
      // the pre-hop answer — the disagreement the re-home branch keys on.
      if (h.moves.length > 0 && !rewired) {
        rewired = true;
        // A pause/resume abort re-queues the row into the NEW board's hold lane in the same window.
        h.store._setRow("FN-STRANDED", { column: "staged" });
      }
      return { workflowId: rewired ? "wf-renamed-rewired-hold" : "wf-renamed", stepIds: [] };
    });
    modelHandoffAuthority(h, boardInForce);

    const first = await h.executor.recoverCompletedTask(completedTaskIn("backlog") as never);

    expect(first).toBe(false);
    // `staged` is a lane the board in force DECLARES, so the requeue stands: the re-home must not
    // answer "the lanes disagree" by dragging the card out of hold and into the new WIP lane.
    expect(h.moves).toEqual([["FN-STRANDED", "queued"], ["FN-STRANDED", "building"]]);
    expect((await h.store.getTask("FN-STRANDED") as { column?: string }).column).toBe("staged");

    // The next sweep runs the ordinary promotion from that hold lane — the requeue converges
    // instead of being skipped, which is what "preserve" has to mean.
    const second = await h.executor.recoverCompletedTask(h.task() as never);
    expect(second).toBe(true);
    expect((h.task() as { column?: string }).column).toBe("checking");
  });

  /*
  FNXC:WorkflowLifecycleColumns 2026-10-02-14:20 (the paired negative): "re-home from a column the
  board does not declare" must not become "re-home from any non-WIP column". A card in the review
  lane is a DECLARED column, owns its own handoff, and is never a promotion candidate — so no
  repair may be issued toward a WIP lane for it. Asserted on the MOVES, since a repair that did
  not move anything would be indistinguishable from the correct outcome.
  */
  it("issues no re-home for a card in a declared review lane", async () => {
    const h = harness(RENAMED_SPLIT_IR, "checking");
    const recovered = await h.executor.recoverCompletedTask(completedTaskIn("checking") as never);

    // The review lane is declared by the board in force, so it is not an orphan and nothing moves
    // the card; the handoff it owns is the only call this sweep makes.
    expect(h.moves).toEqual([]);
    expect((h.task() as { column?: string }).column).toBe("checking");
    expect(h.handoff).toHaveBeenCalledTimes(1);
    expect(recovered).toBe(true);
  });
});

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

  return {
    store,
    executor,
    moves,
    handoff,
    task: () => task,
    setLiveColumn: (column: string) => { task = { ...task, column }; },
  };
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

  /*
  FNXC:WorkflowLifecycleColumns 2026-08-25-10:15 (stale-snapshot race, GDPR-052):
  The caller's task snapshot said in-progress, but a pause/resume abort had benignly
  re-queued the live row to todo BEFORE recovery ran. Deciding promotion from the stale
  snapshot skipped the todo -> wip hop and handed off straight from todo — rejected as
  "Invalid transition: 'todo' → 'in-review'", stranding the completed card.
  The promotion decision must read the AUTHORITATIVE row (store.getTask), not the snapshot.
  */
  it("re-homes through wip when the LIVE column is a planner lane even if the caller's snapshot is stale", async () => {
    const h = harness(BUILTIN_CODING_WORKFLOW_IR as unknown as WorkflowIr, "todo");
    // Simulate the stale caller snapshot: recovery is invoked with a task object that
    // still says in-progress while the live store row says todo.
    const staleSnapshot = { ...completedTaskIn("in-progress"), id: "FN-STRANDED" };

    await h.executor.recoverCompletedTask(staleSnapshot as never);

    expect(h.moves).toEqual([["FN-STRANDED", "in-progress"]]);
    expect(h.handoff).toHaveBeenCalledTimes(1);
    // Handoff receives the PROMOTED task (post-move column), not the stale snapshot.
    const handed = h.handoff.mock.calls[0]?.[0] as { column?: string } | undefined;
    expect(handed?.column).toBe("in-progress");
    expect(h.handoff.mock.invocationCallOrder[0]).toBeGreaterThan(
      Math.max(...h.store.moveTask.mock.invocationCallOrder),
    );
  });


  it("walks intake -> hold -> wip when the live row sits in the distinct intake lane", async () => {
    // Live backlog (intake), stale snapshot said building. The two-hop re-home must fire:
    // backlog -> queued (hold) -> building (wip) before the handoff.
    const h = harness(RENAMED_SPLIT_IR, "backlog");
    const staleSnapshot = { ...completedTaskIn("building"), id: "FN-STRANDED" };

    await h.executor.recoverCompletedTask(staleSnapshot as never);

    expect(h.moves).toEqual([["FN-STRANDED", "queued"], ["FN-STRANDED", "building"]]);
    expect(h.handoff).toHaveBeenCalledTimes(1);
    const handed = h.handoff.mock.calls[0]?.[0] as { column?: string } | undefined;
    expect(handed?.column).toBe("building");
  });

  /*
  FNXC:TaskRecovery 2026-08-25-19:45 (CodeRabbit review of PR #3524):
  The stale-snapshot test above covers "live backlog, caller thought building" — the snapshot
  lied. The PAIRED case — caller and live row AGREE that the card is in the distinct intake
  lane — is the one the branch is actually named for. A card that was always in `backlog`
  and is still in `backlog` when recovery runs must take the same two-hop re-home:
  backlog -> queued (hold) -> building (wip). Without this test the intake classification
  is only ever reached through a stale-snapshot race, which is the opposite of the day-to-day
  flow the renamed-board fix was written for.
  */
  it("walks intake -> hold -> wip when both the snapshot and the live row sit in the distinct intake lane", async () => {
    const h = harness(RENAMED_SPLIT_IR, "backlog");
    // Snapshot and live row agree: both say backlog. No race, no stale read.
    const inSyncSnapshot = { ...completedTaskIn("backlog"), id: "FN-STRANDED" };

    const recovered = await h.executor.recoverCompletedTask(inSyncSnapshot as never);

    expect(recovered).toBe(true);
    expect(h.moves).toEqual([["FN-STRANDED", "queued"], ["FN-STRANDED", "building"]]);
    expect(h.handoff).toHaveBeenCalledTimes(1);
    const handed = h.handoff.mock.calls[0]?.[0] as { column?: string } | undefined;
    expect(handed?.column).toBe("building");
  });

  /*
  The regression for THIS PR's own mechanism: the promotion decision must read the store
  AFTER every awaited step (here, after async lane resolution). Mutating the live row
  mid-await proves the final read happens late; against a decision seeded from an earlier
  snapshot, originColumn would still say in-progress and NO move would fire.
  */
  it("uses the live column when it changes during async lane resolution", async () => {
    const h = harness(BUILTIN_CODING_WORKFLOW_IR as unknown as WorkflowIr, "in-progress");
    let mutated = false;
    h.store.getTaskWorkflowSelectionAsync = vi.fn(async () => {
      if (!mutated) {
        mutated = true;
        h.setLiveColumn("todo");
      }
      return { workflowId: "builtin:coding", stepIds: [] };
    });

    await h.executor.recoverCompletedTask(completedTaskIn("in-progress") as never);

    expect(mutated).toBe(true);
    // The final read happened AFTER the mid-await mutation, so originColumn was the live
    // "todo" (a hold lane) — the todo -> wip promotion hop fired and the card ended in wip.
    expect(h.moves).toEqual([["FN-STRANDED", "in-progress"]]);
    const live = h.task() as { column?: string } | undefined;
    expect(live?.column).toBe("in-progress");
  });

  /*
  FNXC:WorkflowLifecycleColumns 2026-09-26-12:05 (column-only mutation during the SECOND lane read):
  The paired case the async-mutation test above does NOT reach. That test mutates during
  selection read #1, which lands BEFORE the authoritative `getTask` — so the row read already
  sees the new column and the test passes on any ordering. The mutation that reproduces the
  ORIGINAL stranding is a pure column change with the lanes held constant, timed to land during
  the SECOND lane resolution: `originColumn` is then read from a row that has since been
  re-queued, `samePlannerLanes` still returns true (the lanes never changed), and the
  todo -> wip hop is skipped — `handoffTaskToReview` is handed the stale pre-move column and
  the completed card strands exactly as it did on GDPR-052.

  The lanes sandwich proves the two lane ANSWERS agree. It says nothing about the row, which is
  a third, independent read: nothing awaits between `getTask` and the moves it feeds ONLY if
  the row read is the LAST of the three. A lane-only guard cannot stand in for a column guard.
  */
  it("re-reads the row after the second lane resolution, so a column-only requeue during it still promotes", async () => {
    const h = harness(BUILTIN_CODING_WORKFLOW_IR as unknown as WorkflowIr, "in-progress");
    let selectionReads = 0;
    h.store.getTaskWorkflowSelectionAsync = vi.fn(async () => {
      selectionReads += 1;
      // Second resolution only: the lanes are identical on both sides (same workflow, same
      // definition), so the sandwich cannot see this. The row is re-queued underneath it.
      if (selectionReads === 2) h.setLiveColumn("todo");
      return { workflowId: "builtin:coding", stepIds: [] };
    });

    const recovered = await h.executor.recoverCompletedTask(completedTaskIn("in-progress") as never);

    expect(selectionReads).toBeGreaterThanOrEqual(2);
    // The live row was re-queued to `todo` (a hold lane) while the lanes stayed constant, so
    // the promotion must fire: the re-home hop targets wip, and the handoff gets the LANDED row.
    expect(recovered).toBe(true);
    expect(h.moves).toEqual([["FN-STRANDED", "in-progress"]]);
    expect((h.handoff.mock.calls[0]?.[0] as { column?: string } | undefined)?.column).toBe("in-progress");
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

/*
FNXC:WorkflowLifecycleColumns 2026-09-19-07:22 (greptile P1, PR #3524):

THE TWO-READ SPLIT. `resolvePlannerLanesForTaskAsync` reads the task's workflow SELECTION and
`deps.store.getTask` reads the task ROW — two independent reads. Deciding the promotion from both
pairs a lane answer from one board with a column from another, and because the intake -> hold
re-home is issued FIRST, rejecting the later hop leaves the completed card parked one lane off
where it started while recovery reports a bare failure.

Each case below fails on that shape, and the assertions are on the OUTCOME (where the card ended
up, whether the handoff ran), not on which store call was made.
*/
describe("the promotion decision uses one coherent snapshot and reports what it could not do", () => {
  const loggedMessages = (h: ReturnType<typeof harness>) =>
    (h.store.logEntry as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((call) => String(call[1] ?? ""));

  it("withholds recovery when the workflow changes across the promotion snapshot's two reads", async () => {
    const h = harness(RENAMED_SPLIT_IR, "backlog");
    /*
    The lane answer is resolved on both sides of the row read in production, so alternating the
    resolved workflow between those two resolutions is exactly a selection change landing inside
    the window. Pre-fix there was only ONE lane resolution, taken before the row read, so the
    decision proceeded on the old board's lanes against the live row.
    */
    let resolutionPass = 0;
    h.store.getWorkflowDefinition = vi.fn(async () => {
      resolutionPass += 1;
      return { ir: resolutionPass === 1 ? RENAMED_SPLIT_IR : RENAMED_MERGED_IR };
    });

    const recovered = await h.executor.recoverCompletedTask(completedTaskIn("backlog") as never);

    expect(recovered).toBe(false);
    // No hop may be issued toward a board the card is no longer on, and the handoff must not run
    // from a lane the current workflow may not even declare.
    expect(h.moves).toEqual([]);
    expect(h.handoff).not.toHaveBeenCalled();
    expect(loggedMessages(h).some((m) => m.includes("changed while the promotion snapshot was being read"))).toBe(true);
  });

  it("reports the lane a rejected later hop left the card in, instead of a bare failure", async () => {
    const h = harness(RENAMED_SPLIT_IR, "backlog");
    // The intake -> hold hop succeeds, then the promotion into wip is rejected. The card IS
    // half-re-homed; what must change is that recovery says so, by lane, and does not hand off.
    // The throw propagates through the shared write-through store, so the recorded lane is the
    // intermediate one — which is exactly the state on disk.
    h.store.moveTask.mockImplementation(async (id: string, to: string) => {
      if (to === "building") throw new Error("role adjacency rejects queued -> building");
      h.moves.push([id, to]);
      return { ...(h.task() as object), column: to };
    });

    const recovered = await h.executor.recoverCompletedTask(completedTaskIn("backlog") as never);

    expect(recovered).toBe(false);
    expect(h.moves).toEqual([["FN-STRANDED", "queued"]]);
    expect((await h.store.getTask("FN-STRANDED") as { column?: string }).column).toBe("queued");
    expect(h.handoff).not.toHaveBeenCalled();
    const reported = loggedMessages(h).find((m) => m.includes("did not land in 'building'"));
    expect(reported).toBeDefined();
    expect(reported).toContain("is in 'queued'");
    expect(reported).toContain("role adjacency rejects queued -> building");
  });

  /*
  FNXC:WorkflowLifecycleColumns 2026-09-19-07:22:
  A "the move resolved but the row did not move" case is deliberately NOT written here. The shared
  `createMockStore` pairs a write-through `moveTask` with a write-through `getTask`
  (`makeWriteThroughMoveTask` / `makeWriteThroughGetTask` in `executor-test-helpers.ts`), so a
  resolved move IS the row's new column at that seam by construction — every attempt to install a
  resolving-but-inert move still ends up patched to the requested lane. The branch that check
  protects is exercised by the rejected-hop case above, which reaches it through the one path the
  seam can express: the hop throws, the last RECORDED lane is the intermediate one, and the landing
  read disagrees with the intended wip lane.
  */
  /*
  FNXC:WorkflowLifecycleColumns 2026-09-19-07:22:
  The landing check must answer against the workflow IN FORCE. Comparing the landed lane to the
  DECISION's `plannerLanes.wip` validated a move toward a lane the card's workflow had stopped
  calling WIP — the check agreed with the stale answer it existed to catch. Here the operator
  re-wires the board's WIP lane id while the card is being promoted, so the hops run on the old
  lanes and the verification runs on the new one.
  */
  it("withholds the handoff when the workflow's WIP lane changes before the card lands", async () => {
    const h = harness(RENAMED_SPLIT_IR, "backlog");
    let rewired = false;
    h.store.getWorkflowDefinition = vi.fn(async () => ({
      ir: rewired ? RENAMED_SPLIT_REWIRED_IR : RENAMED_SPLIT_IR,
    }));
    h.store.moveTask.mockImplementation(async (id: string, to: string) => {
      h.moves.push([id, to]);
      // The re-wire lands as the card is promoted: the hops still use the old board's lanes.
      if (to === "building") rewired = true;
      return { ...(h.task() as object), column: to };
    });

    const recovered = await h.executor.recoverCompletedTask(completedTaskIn("backlog") as never);

    // The hops were issued toward the old board (they are the only targets it declared), and
    // because the board changed across them the card is re-homed to the lane the board NOW calls
    // WIP — a declared lane, so the next sweep can hand off from it instead of rejecting forever.
    expect(h.moves).toEqual([
      ["FN-STRANDED", "queued"],
      ["FN-STRANDED", "building"],
      ["FN-STRANDED", "delivering"],
    ]);
    // This sweep still withholds: the hops landed in a lane the decision did not target.
    expect(recovered).toBe(false);
    expect(h.handoff).not.toHaveBeenCalled();
    const reported = loggedMessages(h).find((m) => m.includes("did not land in 'delivering'"));
    expect(reported).toBeDefined();
    // The card is re-homed to 'delivering' below, so the withhold names where it actually IS; it
    // used to name 'building', the column it had already left, with no hop failure to say so.
    expect(reported).toContain("is in 'delivering'");
  });

  /*
  FNXC:WorkflowLifecycleColumns 2026-10-02-00:12: the landing verdict must compare a row read AFTER
  the lane resolution, so a re-queue inside that await withholds the handoff. The re-queue goes in
  through `_setRow` — the only write that reaches the read log `getTask` merges over — keyed on
  STAGE (`h.moves` non-empty), and the store state is asserted first so the case cannot go vacuous.
  */
  it("reads the landing row AFTER the landing lane resolution, so a requeue inside that await withholds the handoff", async () => {
    const h = harness(BUILTIN_CODING_WORKFLOW_IR as unknown as WorkflowIr, "todo");
    h.store.getTaskWorkflowSelectionAsync = vi.fn(async () => {
      // Stage-keyed: every lane resolution before the hops runs with `h.moves` empty.
      if (h.moves.length > 0) h.store._setRow("FN-STRANDED", { column: "todo" });
      return { workflowId: "builtin:coding", stepIds: [] };
    });

    const recovered = await h.executor.recoverCompletedTask(completedTaskIn("todo") as never);

    // The card really was re-queued during the landing resolution, and the store really says so —
    // asserted first, so a mutation that never reached the read log cannot make this test vacuous.
    expect(h.moves).toEqual([["FN-STRANDED", "in-progress"]]);
    expect((await h.store.getTask("FN-STRANDED") as { column?: string }).column).toBe("todo");
    // Pre-fix: `landed` was captured before the re-queue, so the comparison passed, recovery
    // returned true, and the handoff ran on a row the store had already moved out from under.
    expect(recovered).toBe(false);
    expect(h.handoff).not.toHaveBeenCalled();
    const reported = loggedMessages(h).find((m) => m.includes("did not land in 'in-progress'"));
    expect(reported).toBeDefined();
    expect(reported).toContain("is in 'todo'");
  });

  /*
  FNXC:WorkflowLifecycleColumns 2026-10-02-13:05 (liveness, not one withheld handoff):

  THE REACHABLE SEAM IS AN OPERATOR BOARD EDIT, AND IT DOES NOT MIGRATE THE CARD.
  `updateWorkflowDefinitionImpl` only re-homes columns it REMOVES while occupied
  (`computeRemovedOccupiedColumns`, workflow-reconciliation.ts:220). Renaming the WIP lane while
  the card is still in INTAKE is a legal save — `building` holds nobody at that moment — so the
  edit commits and the card is left behind in a column the new board no longer declares. That is
  the same shape a `writeTaskWorkflowSelection` flip produces, and that writer
  (`workflow-definitions.ts:682`) never touches the column at all.

  THE HANDOFF IS MODELLED FROM THE REAL AUTHORITY, not stubbed to succeed. `handoffTaskToReview`
  stubbed as an unconditional resolve is what made `recovered=true` look like production: it is
  not. The real `handoffToReviewImpl` resolves the workflow itself and `moveTaskInternal`
  (moves.ts:643/658) validates against it — for an UNDECLARED source column `resolveAllowedColumns`
  has no adjacency and falls to the rebound escape hatch, so the move is rejected. This harness
  therefore runs the real `resolveAllowedColumns` and throws on rejection.

  THE POINT IS THE LATER SWEEP. One withheld handoff is not a fix: the completed card is now in a
  column the board in force does not declare, `promotedFromPlannerColumn` is false for it forever,
  and every later sweep hands off from that same dead source and is rejected identically. Two
  structurally identical lane answers cannot both be true across a board edit, and once the edit has
  settled the second resolution AGREES with the first — so a double-read guard does not even fire
  on the sweep that matters. Recovery has to put the card back in a lane the board declares.
  */
  it("recovers a completed card stranded in a lane the board edit no longer declares", async () => {
    const h = harness(RENAMED_SPLIT_IR, "backlog");
    let rewired = false;
    const boardInForce = () => (rewired ? RENAMED_SPLIT_REWIRED_IR : RENAMED_SPLIT_IR);
    h.store.getWorkflowDefinition = vi.fn(async () => ({ ir: boardInForce() }));
    // The harness's own write-through `moveTask`, so the card really moves (and the landing read
    // sees the new column) instead of a throwaway stub that leaves it in intake.
    const moveThrough = h.store.moveTask.getMockImplementation()!;
    h.store.moveTask.mockImplementation(async (id: string, to: string, ...rest: unknown[]) => {
      h.moves.push([id, to]);
      // The board edit lands while the card is in INTAKE: `building` is unoccupied, so the
      // operator's save is legal and migrates nobody. The hops still target the old board.
      if (to === "queued") rewired = true;
      return moveThrough(id, to, ...rest) as never;
    });
    // The real handoff path: validate the transition against the workflow IN FORCE, and reject
    // exactly as `moveTaskInternal` does. An undeclared source column has no adjacency.
    h.handoff.mockImplementation(async (task: { id: string; column?: string }) => {
      const ir = boardInForce() as Parameters<typeof resolveAllowedColumns>[0];
      const review = resolveLifecycleColumns(ir)?.review ?? "in-review";
      if (!workflowHasColumn(ir, review)) throw new Error(`Unknown column for this workflow: '${review}'`);
      const allowed = resolveAllowedColumns(ir, String(task.column));
      if (!allowed.includes(review)) {
        throw new Error(
          `Invalid transition: '${task.column}' → '${review}'. Valid targets: ${allowed.join(", ") || "none"}`,
        );
      }
      await h.store.moveTask(task.id, review);
    });

    // Sweep 1: the hops run on the pre-edit board, so the card lands in a column the board now
    // in force does not declare. Assert the INVARIANT, not the lane: whatever recovery does with
    // it, the card must not be left in a column this board does not declare. Pre-fix it stayed in
    // 'building' and the assertion failed here — that is the stranding, stated as a property.
    const first = await h.executor.recoverCompletedTask(completedTaskIn("backlog") as never);
    expect(first).toBe(false);
    const afterFirst = String((h.task() as { column?: string }).column);
    expect(workflowHasColumn(boardInForce() as never, afterFirst)).toBe(true);

    // Sweep 2: the edit has settled, so BOTH lane resolutions now agree and a double-read guard
    // has nothing to catch. This is the sweep the card was stranded on before the fix.
    const second = await h.executor.recoverCompletedTask(h.task() as never);
    expect(second).toBe(true);

    // The card reached the review lane of the board now in force, so the workflow selection stayed
    // stable across the recovery instead of flapping, and the handoff ran from a DECLARED source.
    expect((h.task() as { column?: string }).column).toBe("checking");
    expect(h.handoff).toHaveBeenCalledTimes(1);
  });

  it("handoffs the LANDED row, not the pre-hop snapshot", async () => {
    // The paired positive: verifying the landing must not stop a promotion that did land.
    const h = harness(RENAMED_SPLIT_IR, "backlog");

    const recovered = await h.executor.recoverCompletedTask(completedTaskIn("backlog") as never);

    expect(recovered).toBe(true);
    expect(h.moves).toEqual([["FN-STRANDED", "queued"], ["FN-STRANDED", "building"]]);
    expect(h.handoff).toHaveBeenCalledTimes(1);
    expect((h.handoff.mock.calls[0]?.[0] as { column?: string } | undefined)?.column).toBe("building");
  });
});

/**
 * LEGACY target ids, the only unknown-column exception `recoveryRehome` buys (moves.ts).
 */
const LEGACY_COLUMNS = new Set(["backlog", "todo", "triage", "in-progress", "done", "archived"]);

/*
FNXC:WorkflowLifecycleColumns 2026-10-02-15:08 (the requeue that lands inside the re-home helper's OWN await):

The 14:20 case puts the requeue inside the LANDING-lane resolution, so `landed` already reads `staged`
and the helper is asked about the right column. This one lands one await LATER — inside
`resolveOrphanedColumnRehome`, after it captured `building` as its source. The helper then asks the
board in force whether a column the row no longer occupies is declared, and the
`moveTask(..., { recoveryRehome: true })` it returns on that answer skips adjacency (moves.ts:659)
toward a DECLARED target, so `staged -> delivering` is accepted: a third promotion that discards the
requeue a pause/resume abort had just made.

The requeue goes in through `_setRow` — the only write that reaches the read log `getTask` merges
over, so the production read really observes it — and it is aimed at the SECOND selection read after
the hops: the first is the landing-lane resolution (where the 14:20 requeue lands) and the second is
the re-home helper's own workflow resolution, so the window under test is the helper's await alone.

MODELLED FROM THE REAL AUTHORITY, because an unconditional move stub is what makes this look safe:
the recoveryRehome hop runs the moves.ts rules (unknown target unless legacy, adjacency otherwise)
and the handoff runs the real `resolveAllowedColumns` rejection. The other moves stay with the
harness, whose write-through `moveTask` the promotion branch already exercises.
*/
describe("a requeue that lands inside the re-home helper's own await is not a promotion", () => {
  it("withholds the third hop and still promotes the requeued card on the next sweep", async () => {
    const h = harness(RENAMED_SPLIT_IR, "backlog");
    let rewired = false;
    let requeued = false;
    let selectionReadsAfterHops = 0;
    const boardInForce = () => (rewired ? RENAMED_SPLIT_REWIRED_HOLD_IR : RENAMED_SPLIT_IR);
    h.store.getWorkflowDefinition = vi.fn(async (id: string) => ({ ir: BOARDS_BY_ID[id] ?? RENAMED_SPLIT_IR }));

    const hops: string[] = [];
    const moveThrough = h.store.moveTask.getMockImplementation()!;
    h.store.moveTask.mockImplementation(async (id: string, to: string, options?: { recoveryRehome?: boolean }) => {
      hops.push(to);
      if (options?.recoveryRehome === true) {
        const ir = boardInForce();
        const current = String((await h.store.getTask("FN-STRANDED") as { column?: string } | undefined)?.column);
        if (!workflowHasColumn(ir, to) && !LEGACY_COLUMNS.has(to)) {
          throw new Error(`Invalid transition: '${current}' -> '${to}'. Unknown column for this workflow.`);
        }
      }
      // The board edit lands while the card is promoted, so the hops target the old lanes.
      if (to === "building") rewired = true;
      return moveThrough(id, to, options as never) as never;
    });
    h.store.getTaskWorkflowSelectionAsync = vi.fn(async () => {
      if (hops.length >= 2) selectionReadsAfterHops += 1;
      // A pause/resume abort re-queues the row into the board in force's DECLARED hold lane DURING
      // the helper's own workflow resolution — after its source column was captured.
      if (selectionReadsAfterHops === 2 && !requeued) {
        requeued = true;
        h.store._setRow("FN-STRANDED", { column: "staged" });
      }
      return { workflowId: rewired ? "wf-renamed-rewired-hold" : "wf-renamed", stepIds: [] };
    });
    h.handoff.mockImplementation((async (task: { id: string; column?: string }) => {
      const ir = boardInForce() as Parameters<typeof resolveAllowedColumns>[0];
      const review = resolveLifecycleColumns(ir)?.review ?? "in-review";
      if (!workflowHasColumn(ir, review)) throw new Error(`Unknown column for this workflow: '${review}'`);
      const allowed = resolveAllowedColumns(ir, String(task.column));
      if (!allowed.includes(review)) {
        throw new Error(`Invalid transition: '${task.column}' -> '${review}'. Valid targets: ${allowed.join(", ") || "none"}`);
      }
      await h.store.moveTask(task.id, review);
    }) as (...args: unknown[]) => Promise<void>);

    // Sweep 1: the hops land on the pre-edit board, the landing check fails, and the requeue
    // arrives while the helper is still resolving the board in force.
    const first = await h.executor.recoverCompletedTask(completedTaskIn("backlog") as never);
    const live = async () => await h.store.getTask("FN-STRANDED") as { column?: string };

    // Preconditions, asserted first so the case cannot go vacuous: the requeue really reached the
    // row, and the column it landed in is one the board in force DECLARES.
    expect(requeued).toBe(true);
    expect(workflowHasColumn(boardInForce() as never, "staged")).toBe(true);
    expect((await live()).column).toBe("staged");
    // The verdict: no third hop in this attempt, and the requeued row is handed off nothing.
    expect(hops).toEqual(["queued", "building"]);
    expect(first).toBe(false);
    expect(h.handoff).not.toHaveBeenCalled();

    // Sweep 2: the withhold is not the fix — the requeued card is completed work in a declared
    // hold lane, so the ordinary promotion runs from it and reaches review.
    const second = await h.executor.recoverCompletedTask((await live()) as never);
    expect(second).toBe(true);
    expect((await live()).column).toBe("checking");
  });
});

/*
FNXC:WorkflowLifecycleColumns 2026-10-02-16:40 (the window the re-read could not close):

THE 15:08 CASE PUTS THE REQUEUE INSIDE THE RE-HOME HELPER'S OWN AWAIT, which the helper's
re-read answers. This one lands one step later: after that re-read reported the column the card
was in, and before the store is asked to move it. `moveTask` carries no predicate, so the
answer was consumed as a licence and the requeue was discarded; `moveTaskIf` re-reads the row
under the task lock and runs the SAME captured column as a predicate, so the move happens or
does not on what the row says NOW.

THE MUTATION IS ARMED AT THE MOVE API BOUNDARY, keyed on `recoveryRehome`, so it lands under
BOTH store APIs: with the old `moveTask` the card is dragged out of the lane the requeue put it
in (RED), with `moveTaskIf` the predicate sees the new column and withholds (GREEN). Arming it
on the API call rather than on the helper's read is what makes the case prove the WINDOW
rather than the re-read the 15:08 case already covers.

This is an IN-PROCESS fence: the predicate and the move are one locked read-then-write inside
one engine. A writer in another process or straight to the database can still land between the
store's own preflight and its transaction, so nothing here is a cross-process CAS. What it
does prove is that this seam no longer moves a card on a value it read before the move.

Caller 2's non-promotion re-home asks the same question, so it takes the same fence — and its
fall-through to the handoff is only honest for a card whose column is DECLARED. Every other
answer (the row moved, the workflow could not be loaded, the board declares no WIP, the row
could not be read back) is a withhold: handing off from a column the board does not declare is
what strands completed work in the first place. The declared case is kept as a paired positive
so a blanket "any reason withholds" cannot pass by freezing ordinary WIP cards.
*/
describe("the re-home move is fenced on the row, not on the value read before it", () => {
  const loggedMessages = (h: ReturnType<typeof harness>) =>
    (h.store.logEntry as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((call) => String(call[1] ?? ""));

  /** The real handoff path: reject a move out of a column the board in force cannot leave. */
  const modelHandoffAuthority = (h: ReturnType<typeof harness>, boardInForce: () => WorkflowIr) => {
    h.handoff.mockImplementation((async (task: { id: string; column?: string }) => {
      const ir = boardInForce() as Parameters<typeof resolveAllowedColumns>[0];
      const review = resolveLifecycleColumns(ir)?.review ?? "in-review";
      if (!workflowHasColumn(ir, review)) throw new Error(`Unknown column for this workflow: '${review}'`);
      const allowed = resolveAllowedColumns(ir, String(task.column));
      if (!allowed.includes(review)) {
        throw new Error(
          `Invalid transition: '${task.column}' → '${review}'. Valid targets: ${allowed.join(", ") || "none"}`,
        );
      }
      await h.store.moveTask(task.id, review);
    }) as (...args: unknown[]) => Promise<void>);
  };

  /**
   * An external requeue that lands at the instant the re-home move is requested. Both store
   * APIs go through their own instrumented wrapper, so the case is honest about which API it
   * is exercising instead of stubbing a predicate that always answers true.
   */
  const requeueAtRehome = (h: ReturnType<typeof harness>, rehomeTarget: string, to: string) => {
    let fired = false;
    const fire = () => {
      if (fired) return;
      fired = true;
      // `_setRow` is the authoritative test-side write: patches win over the executor's earlier
      // writes, so the production read really observes the requeue.
      h.store._setRow("FN-STRANDED", { column: to });
    };
    const moveThrough = h.store.moveTask.getMockImplementation()!;
    // Named by TARGET, not by option: caller 1's intake -> hold hop carries `recoveryRehome` too, so
    // arming on the flag alone would fire on the promotion instead of on the re-home under test.
    h.store.moveTask.mockImplementation(async (id: string, target: string, options?: { recoveryRehome?: boolean }) => {
      if (options?.recoveryRehome === true && target === rehomeTarget) fire();
      return moveThrough(id, target, options as never) as never;
    });
    const conditionalThrough = h.store.moveTaskIf.getMockImplementation()!;
    h.store.moveTaskIf.mockImplementation(async (
      id: string,
      target: string,
      predicate: (live: { column?: string }) => boolean | Promise<boolean>,
      options?: { recoveryRehome?: boolean },
    ) => {
      if (options?.recoveryRehome === true && target === rehomeTarget) fire();
      return conditionalThrough(id, target, predicate, options) as never;
    });
    return () => fired;
  };

  it("caller 1 withholds the re-home when the card is re-queued between the re-read and the move", async () => {
    const h = harness(RENAMED_SPLIT_IR, "backlog");
    let rewired = false;
    const boardInForce = () => (rewired ? RENAMED_SPLIT_REWIRED_HOLD_IR : RENAMED_SPLIT_IR);
    h.store.getWorkflowDefinition = vi.fn(async (id: string) => ({ ir: BOARDS_BY_ID[id] ?? RENAMED_SPLIT_IR }));

    // The board is re-wired while the card is promoted, so the landing check refuses the WIP the
    // hops targeted and the refused-landing re-home is the one under test.
    const hops: string[] = [];
    const moveThrough = h.store.moveTask.getMockImplementation()!;
    h.store.moveTask.mockImplementation(async (id: string, to: string, options?: { recoveryRehome?: boolean }) => {
      hops.push(to);
      if (to === "building") rewired = true;
      return moveThrough(id, to, options as never) as never;
    });
    h.store.getTaskWorkflowSelectionAsync = vi.fn(async () => ({
      workflowId: rewired ? "wf-renamed-rewired-hold" : "wf-renamed",
      stepIds: [],
    }));
    modelHandoffAuthority(h, boardInForce);
    const requeued = requeueAtRehome(h, "delivering", "staged");

    const first = await h.executor.recoverCompletedTask(completedTaskIn("backlog") as never);
    const live = await h.store.getTask("FN-STRANDED") as { column?: string };

    // Preconditions: the requeue really landed, and where it landed is a DECLARED hold lane of
    // the board in force — so withholding it is the correct outcome, not a stranded card.
    expect(requeued()).toBe(true);
    expect(workflowHasColumn(boardInForce() as never, "staged")).toBe(true);
    expect(hops).toEqual(["queued", "building"]);
    expect(first).toBe(false);
    // No third promotion, and the requeued card is not handed off from a column it left.
    expect(live.column).toBe("staged");
    expect(h.handoff).not.toHaveBeenCalled();
    expect(loggedMessages(h).some((message) => message.includes("did not land in"))).toBe(true);

    // The withhold is not the fix: the card is completed work in a declared hold lane, so the
    // ordinary promotion runs from it on the next sweep and reaches review.
    const second = await h.executor.recoverCompletedTask(live as never);
    expect(second).toBe(true);
    expect(((await h.store.getTask("FN-STRANDED")) as { column?: string }).column).toBe("checking");
  });

  it("caller 2 withholds the non-promotion re-home when the card is re-queued in that window", async () => {
    const h = harness(RENAMED_SPLIT_IR, "staged");
    modelHandoffAuthority(h, () => RENAMED_SPLIT_IR);
    const requeued = requeueAtRehome(h, "building", "queued");

    const first = await h.executor.recoverCompletedTask(completedTaskIn("staged") as never);
    const live = await h.store.getTask("FN-STRANDED") as { column?: string };

    expect(requeued()).toBe(true);
    expect(workflowHasColumn(RENAMED_SPLIT_IR as never, "queued")).toBe(true);
    expect(first).toBe(false);
    expect(live.column).toBe("queued");
    expect(h.handoff).not.toHaveBeenCalled();

    // Next sweep: the requeued card is in the declared hold lane, so it promotes and is handed
    // off. Convergent without the re-home having touched it.
    const second = await h.executor.recoverCompletedTask(live as never);
    expect(second).toBe(true);
    expect(((await h.store.getTask("FN-STRANDED")) as { column?: string }).column).toBe("checking");
  });

  it("caller 2 withholds when the row cannot be read back, instead of re-homing a column it cannot verify", async () => {
    const h = harness(RENAMED_SPLIT_IR, "staged");
    modelHandoffAuthority(h, () => RENAMED_SPLIT_IR);
    /*
    The store fails EXACTLY the helper's post-resolution re-read, and arms off that seam rather than
    off a read index: the two lane resolutions read the workflow while the stranded row has only been
    read by recovery's completeness and origin reads, and the helper's resolution is the first one
    after the origin read. So the failure is armed by that resolution, not by a counted position,
    which keeps the case honest about WHICH read failed. The withhold message below can only come
    from that read failing, so the case cannot go vacuous on an earlier one.
    */
    const modelRead = h.store.getTask.getMockImplementation()!;
    const modelSelection = h.store.getTaskWorkflowSelectionAsync.getMockImplementation()!;
    let strandedReads = 0;
    let selectionReads = 0;
    let strandedAtSecondLaneResolution = 0;
    let unreadable = false;
    let failed = false;
    h.store.getTaskWorkflowSelectionAsync.mockImplementation(async (...args: unknown[]) => {
      selectionReads += 1;
      if (selectionReads === 2) strandedAtSecondLaneResolution = strandedReads;
      // One-shot for the whole case: the liveness sweep below has to read normally.
      if (!failed && selectionReads > 2 && strandedReads > strandedAtSecondLaneResolution) unreadable = true;
      return modelSelection(...(args as []));
    });
    h.store.getTask.mockImplementation(async (id?: string) => {
      const row = await modelRead(id) as { column?: string };
      if (String(row?.column) === "staged") {
        strandedReads += 1;
        if (unreadable) {
          unreadable = false;
          failed = true;
          throw new Error("store read failed");
        }
      }
      return row;
    });

    const first = await h.executor.recoverCompletedTask(completedTaskIn("staged") as never);
    const live = await h.store.getTask("FN-STRANDED") as { column?: string };

    // Precondition: the failed read really happened, and the row is readable again afterwards —
    // so this is the helper's read failing, not recovery bailing out early.
    expect(strandedReads).toBeGreaterThanOrEqual(4);
    expect(workflowHasColumn(RENAMED_SPLIT_IR as never, "staged")).toBe(false);
    expect(first).toBe(false);
    expect(live.column).toBe("staged");
    expect(h.handoff).not.toHaveBeenCalled();
    expect(loggedMessages(h).some((message) => message.includes("could not be read back"))).toBe(true);

    // Liveness: with the store answering again, the re-home happens and the sweep after it hands off.
    const rehomed = await h.executor.recoverCompletedTask(live as never);
    expect(rehomed).toBe(false);
    expect(((await h.store.getTask("FN-STRANDED")) as { column?: string }).column).toBe("building");
    const handedOff = await h.executor.recoverCompletedTask(
      (await h.store.getTask("FN-STRANDED")) as never,
    );
    expect(handedOff).toBe(true);
    expect(((await h.store.getTask("FN-STRANDED")) as { column?: string }).column).toBe("checking");
  });

  it("still hands off a card whose column is declared — only a withhold-worthy answer withholds", async () => {
    const h = harness(RENAMED_SPLIT_IR, "building");
    modelHandoffAuthority(h, () => RENAMED_SPLIT_IR);
    const requeued = requeueAtRehome(h, "building", "queued");

    const recovered = await h.executor.recoverCompletedTask(completedTaskIn("building") as never);

    expect(recovered).toBe(true);
    // Nothing armed fired: a declared column is the ordinary promotion's input, so the re-home
    // question is asked and answered without moving anything.
    expect(requeued()).toBe(false);
    expect(h.handoff).toHaveBeenCalledTimes(1);
    expect(((await h.store.getTask("FN-STRANDED")) as { column?: string }).column).toBe("checking");
  });
});

/*
FNXC:WorkflowLifecycleColumns 2026-10-02-19:40 (a recovery re-home is not a dispatch):
BOTH re-home callers land the card in the WIP lane ON PURPOSE, so their move says `to = wip` and
the executor's own `task:moved` listener reads that as a fresh dispatch and starts an agent. The
promotion branch already holds the recovery claim when it re-homes, so its move is suppressed.
The non-promotion re-home did not, and a sweep therefore STARTED AN AGENT on a card whose work is
already complete — a real execution, not a test artifact. The claim is taken for the duration of
the move and released on every exit, so the re-home stops reading as a dispatch and the recovery
is not left stuck behind its own ownership.
*/
describe("a recovery re-home into the WIP lane is not a dispatch of completed work", () => {
  /** One macrotask turn, so the listener's own async dispatch body has run. No waiting on state. */
  const flushDispatch = () => new Promise<void>((resolve) => { setImmediate(resolve); });

  /*
  The real store publishes `task:moved` from the move itself; the shared store fake stays silent
  on that event, so a re-home in this file never reaches the dispatch listener at all. Emitting
  the real payload is what makes the assertion about dispatch observable — the lanes ride it
  because the listener reads the WIP lane from the payload, exactly as production does.
  */
  const emitRealMove = (h: ReturnType<typeof harness>, wip: string, onMove?: (to: string) => void) => {
    const moveThrough = h.store.moveTask.getMockImplementation()!;
    h.store.moveTask.mockImplementation(async (id: string, to: string, options?: unknown) => {
      const from = String((h.task() as { column?: string }).column);
      const moved = await moveThrough(id, to, options as never) as { column?: string };
      onMove?.(to);
      h.store._trigger("task:moved", {
        task: moved, from, to, source: "engine",
        lanes: { intake: "backlog", hold: "staged", wip, review: "checking", complete: "shipped", archived: "archived" },
      });
      return moved as never;
    });
  };

  it("does not start an agent when the non-promotion re-home lands completed work in WIP", async () => {
    // The board in force declares `delivering` as WIP; the card is sitting in `building`, a
    // column that board no longer declares, so recovery is neither promoting nor handing off:
    // the non-promotion re-home puts it back into WIP for a later sweep.
    const h = harness(RENAMED_SPLIT_REWIRED_HOLD_IR, "building");
    emitRealMove(h, "delivering");
    const dispatched = vi
      .spyOn(h.executor as unknown as { execute: (task: unknown) => Promise<void> }, "execute")
      .mockResolvedValue(undefined);
    h.handoff.mockImplementation(async (task: { id: string }) => { await h.store.moveTask(task.id, "checking"); });

    const first = await h.executor.recoverCompletedTask(completedTaskIn("building") as never);
    await flushDispatch();

    // The re-home really happened, and it happened SILENTLY: completed work resting in WIP is
    // not a fresh run. Pre-fix the listener dispatched `execute()` on this very move.
    expect((h.task() as { column?: string }).column).toBe("delivering");
    expect(first).toBe(false);
    expect(dispatched).not.toHaveBeenCalled();

    // Liveness: the claim is released as the call returns, so the next sweep still hands the
    // card off instead of the recovery sitting stuck behind its own ownership entry.
    const second = await h.executor.recoverCompletedTask(h.task() as never);
    await flushDispatch();
    expect(second).toBe(true);
    expect((h.task() as { column?: string }).column).toBe("checking");
    expect(dispatched).not.toHaveBeenCalled();
  });

  it("does not start an agent when the promotion branch re-homes a mismatched landing", async () => {
    // The paired path: the landing check refuses the WIP the hops targeted because the board was
    // re-wired mid-promotion, and the refused-landing re-home puts the card into the NEW WIP.
    const h = harness(RENAMED_SPLIT_IR, "backlog");
    let rewired = false;
    const boardInForce = () => (rewired ? RENAMED_SPLIT_REWIRED_HOLD_IR : RENAMED_SPLIT_IR);
    h.store.getWorkflowDefinition = vi.fn(async (id: string) => ({ ir: BOARDS_BY_ID[id] ?? RENAMED_SPLIT_IR }));
    h.store.getTaskWorkflowSelectionAsync = vi.fn(async () => ({
      workflowId: rewired ? "wf-renamed-rewired-hold" : "wf-renamed", stepIds: [],
    }));
    emitRealMove(h, "delivering", (to) => { if (to === "queued") rewired = true; });
    const dispatched = vi
      .spyOn(h.executor as unknown as { execute: (task: unknown) => Promise<void> }, "execute")
      .mockResolvedValue(undefined);
    h.handoff.mockImplementation(async (task: { id: string }) => { await h.store.moveTask(task.id, "checking"); });

    const first = await h.executor.recoverCompletedTask(completedTaskIn("backlog") as never);
    await flushDispatch();

    expect((h.task() as { column?: string }).column).toBe("delivering");
    expect(first).toBe(false);
    expect(dispatched).not.toHaveBeenCalled();

    // And the card still converges: the next sweep promotes from the declared WIP it now sits in.
    const second = await h.executor.recoverCompletedTask(h.task() as never);
    await flushDispatch();
    expect(second).toBe(true);
    expect((h.task() as { column?: string }).column).toBe("checking");
  });
});

/*
FNXC:WorkflowLifecycleColumns 2026-10-02-21:05 (the second hop answers a question about a row it
never read): the intake -> hold re-home and the promotion into WIP are two awaits apart, and the
second one was unconditional — so a pause/resume abort that re-queued the card in between was
overwritten by it, and completed work was dragged into WIP out of the very lane the abort was
making room for. The first hop is fenced on the row it read; this closes the same window on the
hop that follows it, and reports the refusal as the withhold it is rather than as a chain that
reported success.
*/
describe("a requeue that lands between the two promotion hops is not overwritten by the second hop", () => {
  const loggedMessages = (h: ReturnType<typeof harness>) =>
    (h.store.logEntry as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((call) => String(call[1] ?? ""));

  /** The real handoff path: reject a move out of a column the board in force cannot leave. */
  const modelHandoffAuthority = (h: ReturnType<typeof harness>, boardInForce: () => WorkflowIr) => {
    h.handoff.mockImplementation((async (task: { id: string; column?: string }) => {
      const ir = boardInForce() as Parameters<typeof resolveAllowedColumns>[0];
      const review = resolveLifecycleColumns(ir)?.review ?? "in-review";
      if (!workflowHasColumn(ir, review)) throw new Error(`Unknown column for this workflow: '${review}'`);
      const allowed = resolveAllowedColumns(ir, String(task.column));
      if (!allowed.includes(review)) {
        throw new Error(
          `Invalid transition: '${task.column}' → '${review}'. Valid targets: ${allowed.join(", ") || "none"}`,
        );
      }
      await h.store.moveTask(task.id, review);
    }) as (...args: unknown[]) => Promise<void>);
  };

  it("withholds instead of promoting the card out of the column the requeue put it in", async () => {
    const h = harness(RENAMED_SPLIT_IR, "backlog");
    modelHandoffAuthority(h, () => RENAMED_SPLIT_IR);

    /*
    The requeue lands in the WINDOW between the two hops: hop 1 has already been awaited (the card
    is in the hold lane) and hop 2 is only now being requested, so an external pause/resume abort
    puts the card back in the intake lane there. `_setRow` is the authoritative test-side write —
    patches win over the executor's earlier writes, so production really observes the requeue.

    ARMED AT HOP 2'S REQUEST, THROUGH BOTH STORE APIs. Naming one of them would only prove that
    one: pre-fix hop 2 is an unconditional `moveTask` and never reaches `moveTaskIf`, so an injection
    that waits for the conditional call never fires at all and the case fails on its own
    precondition instead of on the behaviour. Hooking the move TOWARD the WIP lane makes the abort
    land in the same window under both the old API (which then overwrites it — RED) and the fenced
    one (whose predicate reads the requeued row and withholds — GREEN).
    */
    let fired = false;
    let columnAtAbort: string | undefined;
    const fire = () => {
      if (fired) return;
      fired = true;
      // Hop 1 is already persisted when the abort lands, so this is the BETWEEN-hops window and not
      // a requeue that merely preceded recovery.
      columnAtAbort = String((h.task() as { column?: string }).column);
      h.store._setRow("FN-STRANDED", { column: "backlog" });
    };
    const moveThrough = h.store.moveTask.getMockImplementation()!;
    // Named by TARGET, not by option: hop 1 targets the hold lane, so arming on hop 2's lane cannot
    // fire before hop 1 has persisted.
    h.store.moveTask.mockImplementation(async (id: string, target: string, options?: unknown) => {
      if (target === "building") fire();
      return moveThrough(id, target, options as never) as never;
    });
    const conditionalThrough = h.store.moveTaskIf.getMockImplementation()!;
    h.store.moveTaskIf.mockImplementation(async (
      id: string,
      target: string,
      predicate: (live: { column?: string }) => boolean | Promise<boolean>,
      options?: unknown,
    ) => {
      // Before the predicate reads, so the fence evaluates against the requeued row.
      if (target === "building") fire();
      return conditionalThrough(id, target, predicate, options) as never;
    });

    const first = await h.executor.recoverCompletedTask(completedTaskIn("backlog") as never);
    const live = await h.store.getTask("FN-STRANDED") as { column?: string };

    // Precondition: the requeue really landed where hop 1 put it, before hop 2 was issued.
    expect(fired).toBe(true);
    expect(columnAtAbort).toBe("queued");
    expect(workflowHasColumn(RENAMED_SPLIT_IR as never, "backlog")).toBe(true);
    // The requeue survives: hop 2 declines rather than dragging the card into WIP.
    expect(first).toBe(false);
    expect(live.column).toBe("backlog");
    expect(h.handoff).not.toHaveBeenCalled();
    // And the refusal is reported as one, naming the WIP the hops targeted.
    expect(loggedMessages(h).some((message) => message.includes("did not land in"))).toBe(true);

    // Liveness: the card is completed work in a DECLARED intake lane, so the ordinary promotion
    // runs from it on the next sweep and reaches review. Withholding is not a stranding.
    const second = await h.executor.recoverCompletedTask(live as never);
    expect(second).toBe(true);
    expect(((await h.store.getTask("FN-STRANDED")) as { column?: string }).column).toBe("checking");
  });
});

/*
FNXC:WorkflowLifecycleColumns 2026-10-02-21:05 (a withhold that re-homed says where the card went):
the withhold message is written from the row read BEFORE the re-home, so a re-home that succeeded
was reported as the card still sitting in the orphaned column, with no hop failure to explain why —
reading as "both hops success" on a chain whose promotion had just been refused. Same path, same
branches: the message names where the card actually is.
*/
describe("a withhold that re-homed reports the column the card actually reached", () => {
  const loggedMessages = (h: ReturnType<typeof harness>) =>
    (h.store.logEntry as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((call) => String(call[1] ?? ""));

  it("names the re-home destination instead of the pre-re-home column and a silent chain", async () => {
    const h = harness(RENAMED_SPLIT_IR, "backlog");
    let rewired = false;
    const boardInForce = () => (rewired ? RENAMED_SPLIT_REWIRED_HOLD_IR : RENAMED_SPLIT_IR);
    h.store.getWorkflowDefinition = vi.fn(async (id: string) => ({ ir: BOARDS_BY_ID[id] ?? RENAMED_SPLIT_IR }));
    h.store.getTaskWorkflowSelectionAsync = vi.fn(async () => ({
      workflowId: rewired ? "wf-renamed-rewired-hold" : "wf-renamed",
      stepIds: [],
    }));

    // The board is re-wired while the card is promoted, so the landing check refuses the WIP the
    // hops targeted; the refused-landing re-home then puts the card in the NEW WIP.
    const moveThrough = h.store.moveTask.getMockImplementation()!;
    h.store.moveTask.mockImplementation(async (id: string, to: string, options?: unknown) => {
      if (to === "queued") rewired = true;
      return moveThrough(id, to, options as never) as never;
    });
    h.handoff.mockImplementation(async (task: { id: string }) => { await h.store.moveTask(task.id, "checking"); });

    const first = await h.executor.recoverCompletedTask(completedTaskIn("backlog") as never);
    const live = (await h.store.getTask("FN-STRANDED")) as { column?: string };

    // Preconditions: the promotion was refused AND the re-home landed the card in the new WIP.
    expect(first).toBe(false);
    expect(live.column).toBe("delivering");
    const withhold = loggedMessages(h).find((message) => message.includes("did not land in"));
    // The log names where the card IS, not the column it was re-homed out of, and does not claim a
    // chain that reported success.
    expect(withhold).toContain("the card is in 'delivering'");
    expect(withhold).not.toContain("both hops reported success");
  });
});

/*
FNXC:WorkflowLifecycleColumns 2026-10-03 (hop 1 was the only unfenced move left in the chain):
the 21:05 fence covered hop 2 and the 16:40 fences covered both re-home callers, but the FIRST hop was
still an unconditional `moveTask`. Its own note claims "hop 2's fence exists for the same window" —
so the two hops had different fencing over the SAME class of race, and hop 1's is the earlier one:
recovery read the row in `backlog`, then a concurrent writer moved it to the declared `parked` lane
while hop 1 waited on the task lock, and hop 1 dragged it into `queued` anyway.

`recoveryRehome` is why the drag is silent: it skips adjacency in `moveTaskInternal`, so a move out
of a lane the requeue chose is ACCEPTED, and hop 2's predicate then observes `queued` — the very
column hop 1 manufactured — and promotes from it, so the landing check passes and the overwrite is
never reported. The card was re-queued to make room; recovery put it into WIP anyway.

The case is modelled on the REAL store authority: `parked` is a DECLARED lane of the board in force,
and `moveTask` with `recoveryRehome` really does accept an engine move out of it (adjacency skipped,
`evaluateTransitionInvariants` ALLOWED because a trait-less column has no lifecycle role), so this is
not a mock artifact. Asserting against the requeue's own choice is the point: the withhold below is
what makes the next sweep hand the card off from `parked` instead.
*/
describe("the intake -> hold re-home is fenced on the row, like the promotion that follows it", () => {
  const loggedMessages = (h: ReturnType<typeof harness>) =>
    (h.store.logEntry as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((call) => String(call[1] ?? ""));

  /** The real handoff path: reject a move out of a column the board in force cannot leave. */
  const modelHandoffAuthority = (h: ReturnType<typeof harness>, boardInForce: () => WorkflowIr) => {
    h.handoff.mockImplementation((async (task: { id: string; column?: string }) => {
      const ir = boardInForce() as Parameters<typeof resolveAllowedColumns>[0];
      const review = resolveLifecycleColumns(ir)?.review ?? "in-review";
      if (!workflowHasColumn(ir, review)) throw new Error(`Unknown column for this workflow: '${review}'`);
      const allowed = resolveAllowedColumns(ir, String(task.column));
      if (!allowed.includes(review)) {
        throw new Error(
          `Invalid transition: '${task.column}' → '${review}'. Valid targets: ${allowed.join(", ") || "none"}`,
        );
      }
      await h.store.moveTask(task.id, review);
    }) as (...args: unknown[]) => Promise<void>);
  };

  /**
   * The requeue lands while hop 1 is in flight. Armed through BOTH store APIs and keyed on hop 1's
   * TARGET: pre-fix hop 1 is an unconditional `moveTask` and never reaches `moveTaskIf`, so an
   * injection that waited for the conditional API would never fire and the case would fail on its own
   * precondition instead of on the behaviour.
   */
  const requeueAtHop1 = (h: ReturnType<typeof harness>, to: string) => {
    let fired = false;
    const fire = () => {
      if (fired) return;
      fired = true;
      h.store._setRow("FN-STRANDED", { column: to });
    };
    const moveThrough = h.store.moveTask.getMockImplementation()!;
    h.store.moveTask.mockImplementation(async (id: string, target: string, options?: unknown) => {
      // Before the move is applied, so the requeue is what the store reads.
      if (target === "queued") fire();
      return moveThrough(id, target, options as never) as never;
    });
    const conditionalThrough = h.store.moveTaskIf.getMockImplementation()!;
    h.store.moveTaskIf.mockImplementation(async (
      id: string,
      target: string,
      predicate: (live: { column?: string }) => boolean | Promise<boolean>,
      options?: unknown,
    ) => {
      // Before the predicate reads, so the fence evaluates against the requeued row.
      if (target === "queued") fire();
      return conditionalThrough(id, target, predicate, options) as never;
    });
    return () => fired;
  };

  it("does not drag a requeued card into the hold lane hop 1 decided about", async () => {
    const h = harness(RENAMED_SPLIT_PARKED_IR, "backlog");
    modelHandoffAuthority(h, () => RENAMED_SPLIT_PARKED_IR);
    const requeued = requeueAtHop1(h, "parked");

    const first = await h.executor.recoverCompletedTask(completedTaskIn("backlog") as never);
    const live = await h.store.getTask("FN-STRANDED") as { column?: string };

    // Precondition: the requeue really landed while hop 1 was in flight, into a lane the board in
    // force DECLARES — so leaving it alone is the correct outcome, not a stranded card.
    expect(requeued()).toBe(true);
    expect(workflowHasColumn(RENAMED_SPLIT_PARKED_IR as never, "parked")).toBe(true);
    // The requeue survives: hop 1 declines rather than overwriting it, and nothing is promoted.
    expect(first).toBe(false);
    expect(live.column).toBe("parked");
    expect(h.handoff).not.toHaveBeenCalled();
    // The refusal is reported as one, naming the hop that was declined.
    expect(loggedMessages(h).some((message) => message.includes("did not land in"))).toBe(true);

    // Liveness: the card is completed work in a DECLARED lane, so the next sweep hands it off.
    // Withholding is not a stranding — the point of the fence is preservation, not a freeze.
    const second = await h.executor.recoverCompletedTask(live as never);
    expect(second).toBe(true);
    expect(((await h.store.getTask("FN-STRANDED")) as { column?: string }).column).toBe("checking");
  });

  /*
  The fence on hop 1 is only half the answer while hop 2 still runs. A requeue that lands in the hold
  lane hop 1 was TARGETING is the case the fence cannot catch on its own: hop 1's predicate asks "is
  the row still in intake?", the requeue already moved it to hold, so the predicate is false and the
  move declines — but hop 2's predicate asks "is the row in the lane hop 1 was decided about?", which
  is now TRUE, because the requeue put it there. So the chain promoted straight out of the requeue and
  the landing check passed on the promotion.

  That is the same overwrite the fence exists to prevent, arriving from the other side: the declined
  hop is evidence the card moved, and the promotion must not be issued on a row that evidence already
  condemned. The fix stops the chain when hop 1 declines — the withhold below then names the refusal.
  */
  it("does not promote out of the hold lane when the requeue landed where hop 1 was headed", async () => {
    const h = harness(RENAMED_SPLIT_IR, "backlog");
    modelHandoffAuthority(h, () => RENAMED_SPLIT_IR);
    // The requeue targets hop 1's own destination: the card is already in `queued` when hop 1 is
    // issued, so hop 1 declines AND hop 2's predicate is satisfied.
    const requeued = requeueAtHop1(h, "queued");

    const first = await h.executor.recoverCompletedTask(completedTaskIn("backlog") as never);
    const live = await h.store.getTask("FN-STRANDED") as { column?: string };

    expect(requeued()).toBe(true);
    // Pre-fix this is `true` and the card lands in `checking`: hop 2 promoted out of the requeue.
    expect(first).toBe(false);
    expect(live.column).toBe("queued");
    expect(h.handoff).not.toHaveBeenCalled();
    // The refusal names hop 1, the hop that actually declined.
    const withhold = loggedMessages(h).find((m) => m.includes("did not land in"));
    expect(withhold).toContain("before the re-home to 'queued' could be applied");

    // Liveness: from the declared hold lane the ordinary promotion runs on the next sweep.
    const second = await h.executor.recoverCompletedTask(live as never);
    expect(second).toBe(true);
    expect(((await h.store.getTask("FN-STRANDED")) as { column?: string }).column).toBe("checking");
  });
});
