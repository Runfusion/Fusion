/*
FNXC:ReplanTargetLifecycleColumns 2026-07-29-09:30 (U7 / R3, R7, R12 — workflow-owned lifecycle):

THE INVARIANT: a Plan Review REVISE bounce lands the card in a column the task's
OWN workflow declares, and NEVER in one it does not.

`resolveReplanTargetColumn` asked `workflowHasColumn(ir, "triage")`, then
`"todo"`, and fell back to `"triage"` — twice by literal id, once by fiat. On a
workflow that renames both, all three answers are wrong in the same way: the card
is moved into a column the workflow does not declare.

That is the R7 violation this program exists to remove ("a stored task row pointing
at a column no workflow declares"), reached not by drift but by DESIGN — the final
`return "triage"` fired for any workflow that declares neither legacy id, so
`reconcileUndeclaredTaskColumns` had to clean up after a move the engine made on
purpose.

The plan's U5 states the intended behavior directly: "a replan rebound lands in the
workflow's planning column; a workflow declaring neither legacy column is SKIPPED
WITH A LOG rather than moved arbitrarily". This is that.

THE LEGACY IDS STAY PREFERRED FIRST, so both built-ins keep their exact current
target; only a workflow declaring NEITHER reaches the resolved answer. For those the
fallback prefers HOLD over intake — see the ordering test below for why the obvious
"intake first" rule is wrong, and which existing test caught it.

WHY THIS FILE IS IN U7 rather than U5, which nominally owns `replan-target.ts`:
U5's B2 slice converted 12 sites and left this one. It is the planning lane's
rebound seam — the thing that decides where a rejected plan goes to be re-planned —
so it sits inside U7's ownership question even though the file is listed elsewhere.
Flagging rather than assuming: if U5 has this in flight, this is the conflict.
*/
import { describe, expect, it, vi } from "vitest";
import type { Task, TaskStore, WorkflowIr } from "@fusion/core";

import { hasAdvancedPastPlanning, isTaskStillInPlanningStage, resolveReplanTargetColumn } from "../replan-target.js";

const WF = "custom:replan-vocab";

/**
 * A workflow shape parameterised on its column ids. Traits are identical in every
 * variant, so any behavioral difference is attributable to a surviving literal.
 * `omit` drops a role entirely, which is how the "declares neither" case is built.
 */
function ir(names: { intake?: string; hold?: string; wip?: string }): WorkflowIr {
  const columns: Array<Record<string, unknown>> = [];
  if (names.intake) columns.push({ id: names.intake, name: "Intake", traits: [{ trait: "intake" }] });
  if (names.hold) {
    columns.push({
      id: names.hold,
      name: "Hold",
      traits: [{ trait: "hold", config: { release: "capacity" } }],
    });
  }
  columns.push({
    id: names.wip ?? "in-progress",
    name: "Wip",
    traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }],
  });
  columns.push({ id: "done", name: "Done", traits: [{ trait: "complete" }] });
  return { version: "v2", id: WF, name: WF, columns, nodes: [], edges: [] } as unknown as WorkflowIr;
}

function storeWith(workflowIr: WorkflowIr | null): TaskStore {
  const selection = { workflowId: WF, stepIds: [] };
  return {
    getTaskWorkflowSelection: vi.fn(() => selection),
    getTaskWorkflowSelectionAsync: vi.fn(async () => selection),
    getWorkflowDefinition: vi.fn(async () => {
      if (!workflowIr) throw new Error("workflow could not be resolved");
      return { ir: workflowIr };
    }),
  } as unknown as TaskStore;
}

describe("the replan rebound targets a column the workflow actually declares", () => {
  it("targets the intake column under the DEFAULT vocabulary (no-regression half)", async () => {
    const target = await resolveReplanTargetColumn(
      storeWith(ir({ intake: "triage", hold: "todo" })),
      "FN-1",
    );

    expect(target).toBe("triage");
  });

  it("targets a declared column under a RENAMED vocabulary, never the legacy literal", async () => {
    // Pre-conversion this returned the literal "triage" — a column this workflow
    // does not declare — so the card was moved somewhere nothing renders it.
    const target = await resolveReplanTargetColumn(
      storeWith(ir({ intake: "backlog", hold: "drafting" })),
      "FN-1",
    );

    expect(target).toBe("drafting");
    expect(target).not.toBe("triage");
  });

  it("falls back to the HOLD column when the workflow has no intake (plan-in-place)", async () => {
    // Coding (Ideas) and any workflow whose planning happens in the capacity lane.
    // Order matters: intake first, hold only when there is no intake.
    const target = await resolveReplanTargetColumn(
      storeWith(ir({ hold: "drafting" })),
      "FN-1",
    );

    expect(target).toBe("drafting");
  });

  it("prefers HOLD over intake when a renamed workflow declares both", async () => {
    /*
    MEASURED, and the existing suite corrected me. I first wrote "intake, else
    hold" on the reasoning that a REVISE sends the card back to be re-specified and
    specification starts at intake. That broke Coding (Ideas): its intake is `ideas`,
    which is MANUAL CAPTURE WITH NO AI (plan R10), so a rejected plan sent there
    stops being replanned at all and becomes an idea awaiting a human.

    The old code got Ideas right by ACCIDENT — it never recognised `ideas` as intake
    and fell through to `todo`. A trait rule that "corrected" that would have shipped
    a regression dressed as a cleanup, and only the existing Coding (Ideas) tests
    stood between me and doing it.

    So the fallback prefers HOLD: it is the planning lane, it has a releaser, and an
    intake column may be a manual-capture lane with nothing that auto-plans in it.
    */
    const target = await resolveReplanTargetColumn(
      storeWith(ir({ intake: "backlog", hold: "drafting" })),
      "FN-1",
    );

    expect(target).toBe("drafting");
  });

  it("returns UNDEFINED for a workflow that declares neither role, instead of inventing a column", async () => {
    // The R7 case. Previously answered "triage" by fiat — moving the card into a
    // column no workflow declares, which is the exact state
    // `reconcileUndeclaredTaskColumns` exists to clean up after.
    const target = await resolveReplanTargetColumn(
      storeWith(ir({ wip: "building" })),
      "FN-1",
    );

    expect(target).toBeUndefined();
  });

  it("falls back to the DEFAULT workflow's intake when the selection cannot be read", async () => {
    /*
    MEASURED, and it corrected me mid-slice. I first asserted `undefined` here, on
    the assumption that an unreadable workflow reaches this function's `catch`. It
    does not: `resolveWorkflowIrForTask` is TOTAL — every failure path returns
    `defaultCodingWorkflowIr()` rather than throwing. So the `catch` in
    `resolveReplanTargetColumn` is unreachable belt-and-braces, and asserting
    `undefined` would have been a test for a state that cannot occur — the exact
    guard-that-cannot-fire shape this program keeps finding.

    The real behavior is worth pinning precisely BECAUSE it is surprising: an
    unreadable selection silently becomes the default coding workflow, so the card
    replans to `triage` — correct for the overwhelmingly common case, and quietly
    wrong for a renamed workflow whose selection failed to load. That is a property
    of the resolver, not of this seam, so it is documented here rather than
    "fixed" here.
    */
    const target = await resolveReplanTargetColumn(storeWith(null), "FN-1");

    expect(target).toBe("triage");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The planner-lane predicate
// ─────────────────────────────────────────────────────────────────────────────

/*
FNXC:PlannerLanePredicate 2026-07-29-11:20 (U7 / R3):
`hasAdvancedPastPlanning` decides whether a card has left the planning stage, and
it asked `task.column === "triage"` literally. On a renamed workflow that branch
never matched, so a card resting in its OWN intake column fell through to the
"steps parsed => advanced" tail and was reported ADVANCED while sitting exactly
where planning puts it.

That answer is load-bearing: `isTaskStillInPlanningStage` is the predicate handed to
`moveTaskIf` and `deleteTaskIf` under the task lock, so a false "advanced" REFUSES
the planning handoff. A renamed-workflow card whose previous pass parsed steps could
never be released — finalize would report the guard refusal every time.

The lane is a PARAMETER rather than a lookup because these predicates run under the
task lock, where nothing may await. It defaults to the legacy pair, so every caller
that has no roles behaves exactly as before.
*/
describe("the planner-lane predicate resolves the intake column", () => {
  const card = (column: string, over: Partial<Task> = {}): Parameters<typeof hasAdvancedPastPlanning>[0] => ({
    column,
    worktree: undefined,
    steps: [{ id: "s0", title: "Implement", status: "pending" }],
    status: null,
    ...over,
  } as unknown as Parameters<typeof hasAdvancedPastPlanning>[0]);

  it("reports NOT advanced for a card in the default intake column (no-regression half)", () => {
    expect(hasAdvancedPastPlanning(card("triage"))).toBe(false);
  });

  it("reports NOT advanced for a card in a RENAMED intake column, when told the lane", () => {
    // Pre-conversion this returned true — the card was reported as having advanced
    // past planning while resting exactly where planning puts it, which made the
    // under-the-lock guard refuse its own planning handoff.
    expect(hasAdvancedPastPlanning(card("backlog"), { intake: "backlog" })).toBe(false);
  });

  it("still reports ADVANCED for a renamed card that genuinely left the lane", () => {
    // The other side, so "never advanced" cannot pass for "correctly in the lane".
    expect(hasAdvancedPastPlanning(card("in-progress"), { intake: "backlog" })).toBe(true);
  });

  it("keeps the legacy answer when no lane is supplied (strictly additive)", () => {
    // A caller with no resolved roles gets byte-identical behavior: `triage` is the
    // lane, and a renamed intake column reads as advanced exactly as it did before.
    expect(hasAdvancedPastPlanning(card("backlog"))).toBe(true);
    expect(hasAdvancedPastPlanning(card("triage"))).toBe(false);
  });

  it("isTaskStillInPlanningStage is the inverse, and threads the lane through", () => {
    expect(isTaskStillInPlanningStage(card("backlog"), { intake: "backlog" })).toBe(true);
    expect(isTaskStillInPlanningStage(card("backlog"))).toBe(false);
  });
});
