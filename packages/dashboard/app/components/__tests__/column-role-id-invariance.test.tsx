/*
FNXC:WorkflowResolvedColumns 2026-07-29-00:00 (U12 — R8, completion criterion 3):
EVIDENCE that the converted dashboard surfaces behave on a RENAMED board and on the
MERGED board — stated as an invariance property rather than a pile of per-site cases.

THE CLAIM THE CONVERSION MAKES. After resolving roles from traits, a surface's behaviour
is a function of the column's TRAITS, not of its id. So the test is: hold the traits
fixed, change only the id, and every decision must be identical. That is one assertion
covering every site at once, and it fails for any site that still consults an id — which
per-site cases cannot promise, because a per-site case only proves the site it names.

WHY THIS IS NOT A RESTATEMENT OF THE HELPER TESTS. `columnRoles.test.ts` proves the
helpers answer correctly. It cannot prove the CONSUMERS ask them: a component that kept an
inline id comparison passes every helper test. These cases drive the real consumers —
`buildTaskActionMenuModel` and `isTaskAgentActive`, the predicates behind the actions menu,
the pulsing badge, the row border and the column header's executing count — and compare
their outputs across three lineages that differ only in naming.

THE THREE LINEAGES.
  MERGED   — post-#2515 default: one pre-implementation column, id `todo`, "Planning".
  LEGACY   — the pre-merge shape, id `triage`, same traits.
  RENAMED  — a custom board: `backlog` / `building` / `shipped`, same traits.
An id-sensitive site behaves differently on at least one of the three; a trait-driven one
cannot tell them apart.

REVERT CHECK, measured. Restoring `task.column !== "triage"` in `shouldShowActionsMenu`
fails the actions-menu invariance case (MERGED and RENAMED start showing a menu that
LEGACY suppresses). Restoring the intake-id comparison in `taskActivity`'s planner-lane
check fails the agent-active case the same way. Both were run.
*/
import { describe, expect, it, vi } from "vitest";
import type { Task } from "@fusion/core";
import { buildTaskActionMenuModel, getTaskReviewAction } from "../TaskContextMenu";
import { isTaskAgentActive } from "../../utils/taskActivity";

const t = ((_key: string, fallback?: string) => fallback ?? _key) as never;
const columnLabel = ((column: string) => column) as never;

/**
 * The same PRE-IMPLEMENTATION column expressed three ways. Traits are byte-identical;
 * only `id` differs, which is the whole point.
 */
const PRE_IMPLEMENTATION_TRAITS = { intake: true, hold: true } as const;
const LINEAGES = [
  { label: "MERGED (post-#2515 default)", columnId: "todo" },
  { label: "LEGACY (pre-merge)", columnId: "triage" },
  { label: "RENAMED (custom board)", columnId: "backlog" },
] as const;

/** A mid-flight column, likewise expressed under three names. */
const WIP_TRAITS = { countsTowardWip: true } as const;
const WIP_LINEAGES = [
  { label: "MERGED", columnId: "in-progress" },
  { label: "RENAMED", columnId: "building" },
] as const;

function mkTask(overrides: Partial<Task> & { id: string; column: string }): Task {
  return {
    title: overrides.id,
    description: "Task",
    dependencies: [],
    steps: [],
    currentStep: 0,
    status: undefined,
    paused: false,
    log: [],
    createdAt: "2026-07-27T00:00:00.000Z",
    updatedAt: "2026-07-27T00:00:00.000Z",
    ...overrides,
  } as unknown as Task;
}

/** Every decision the actions menu exposes, as a comparable shape. */
function menuDecisions(columnId: string, flags: Record<string, boolean>, task: Partial<Task> = {}) {
  const model = buildTaskActionMenuModel({
    task: mkTask({ id: "FN-1", column: columnId, ...task }),
    t,
    columnLabel,
    currentColumnFlags: flags as never,
    onPlan: vi.fn(),
  } as never);
  return {
    shouldShowActionsMenu: model.shouldShowActionsMenu,
    actionIds: model.actions.map((action: { id: string }) => action.id),
  };
}

describe("column-role decisions are invariant under column RENAMING (U12 evidence)", () => {
  it("the actions menu decides identically on merged, legacy and renamed lineages", () => {
    const decisions = LINEAGES.map((lineage) => ({
      label: lineage.label,
      ...menuDecisions(lineage.columnId, PRE_IMPLEMENTATION_TRAITS as never),
    }));

    /*
    Compared against the FIRST lineage rather than a hardcoded expectation: the property
    under test is agreement, and hardcoding would quietly bake in whichever shape happened
    to be current. If a site consults an id, the entries diverge and the diff names it.
    */
    const [first, ...rest] = decisions;
    for (const other of rest) {
      expect({ ...other, label: first!.label }).toEqual(first);
    }

    // And the shape is not vacuous: a pre-implementation card really does offer Plan.
    expect(first!.actionIds).toContain("plan");
  });

  it("a mid-flight card decides identically whether its column is `in-progress` or `building`", () => {
    const decisions = WIP_LINEAGES.map((lineage) => ({
      label: WIP_LINEAGES[0]!.label,
      ...menuDecisions(lineage.columnId, WIP_TRAITS as never),
    }));
    expect(decisions[1]).toEqual(decisions[0]);
    // The inversion guard, stated positively: executing cards are never planning targets.
    expect(decisions[0]!.actionIds).not.toContain("plan");
  });

  it("planner activity reads as agent-active identically across all three lineages", () => {
    /*
    `isTaskAgentActive` drives three separate surfaces from one predicate, so an id-sensitive
    fallback here reports planning work as idle board-wide — the failure that motivated the
    `taskActivity` conversion, and one that throws nothing.
    */
    const recent = new Date(Date.now() - 5_000).toISOString();
    const verdicts = LINEAGES.map((lineage) =>
      isTaskAgentActive(
        mkTask({ id: "FN-2", column: lineage.columnId, recentAgentActivityAt: recent } as never),
        { columnFlags: PRE_IMPLEMENTATION_TRAITS as never },
      ),
    );

    expect(new Set(verdicts).size).toBe(1);
    // Non-vacuous: fresh planner activity on a pre-implementation card IS active.
    expect(verdicts[0]).toBe(true);
  });

  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-21:55 (fleet phase — the TERMINAL/REVIEW roles, and the
  direction the cases above cannot reach):

  The renaming property is the wrong instrument for the three predicates converted here
  (`isReviewColumn`, `isDoneOrReview`, `isMutableLiveColumn`). They ORed the legacy id with the traits
  UNCONDITIONALLY, so renaming `in-review` to `validating` never broke them — the trait arm answered.
  A pure rename case passes before AND after, which is a test that proves nothing.

  The delta is the OTHER direction: a column that still CARRIES a lifecycle name while its traits say
  something else. That is not a hypothetical board — it is what a project gets by repurposing a default
  column instead of deleting it, and by the pre-load window where a card's stored id outlives the
  workflow that declared it. So the property here is the converse of the one above: hold the id at a
  lifecycle name, and the decision must follow the TRAITS.

  REVERT CHECK, measured (both run, both fail on revert):
    - Restoring `column === "in-review" || ...` in `isReviewColumn` and `column === "done" || ...` in
      `isDoneOrReview` fails "traits decide, not the lifecycle-sounding name": the `in-review`-named
      mid-flight card gains `refine`, which its `building`-named twin does not have, and the two
      lineages stop agreeing.
    - Restoring `task.column === "in-review"` on the bypass guard fails "the review bypass survives a
      renamed review lane": the action disappears for `validating`.
  */
  const REVIEW_TRAITS = { mergeBlocker: true } as const;

  /*
  Every optional handler wired, deliberately. `menuDecisions` above supplies only `onPlan`, so the
  actions gated behind a handler — `refine` among them — cannot appear in its output at all. My first
  draft of these cases reused it and passed with the conversion REVERTED, because the branch under test
  was unreachable rather than correct. Anything a host can wire has to be wired for the absence of an
  action to carry information.
  */
  function fullMenuDecisions(columnId: string, flags: Record<string, boolean>, task: Partial<Task> = {}) {
    const model = buildTaskActionMenuModel({
      task: mkTask({ id: "FN-1", column: columnId, ...task }),
      t,
      columnLabel,
      currentColumnFlags: flags as never,
      onPlan: vi.fn(),
      onOpenRefine: vi.fn(),
      onRespecify: vi.fn(),
      onReset: vi.fn(),
      onTogglePause: vi.fn(),
      onBypassReview: vi.fn(),
    } as never);
    return {
      shouldShowActionsMenu: model.shouldShowActionsMenu,
      actionIds: model.actions.map((action: { id: string }) => action.id),
    };
  }

  it("traits decide, not the lifecycle-sounding name: an `in-review`-NAMED mid-flight card matches its renamed twin", () => {
    const namedLikeReview = fullMenuDecisions("in-review", WIP_TRAITS as never);
    const plainlyNamed = fullMenuDecisions("building", WIP_TRAITS as never);

    expect(namedLikeReview).toEqual(plainlyNamed);
    /*
    Non-vacuous in the direction that matters: Refine belongs to done/review lanes, so a card whose
    traits say it is mid-flight must not offer it however its column is spelled. Before the conversion
    the name alone was enough.
    */
    expect(namedLikeReview.actionIds).not.toContain("refine");
  });

  it("traits decide for the terminal role too: a `done`-NAMED mid-flight card is still mutable live work", () => {
    const namedLikeDone = fullMenuDecisions("done", WIP_TRAITS as never);
    expect(namedLikeDone).toEqual(fullMenuDecisions("building", WIP_TRAITS as never));
    expect(namedLikeDone.actionIds).not.toContain("refine");
  });

  it("a mid-flight card named `in-review` is not offered MERGE — the id alone used to open the merge lane", () => {
    /*
    The sharpest consequence of the unconditional id OR, and a separate surface from the menu:
    `getTaskReviewAction` returns undefined for anything that is not a review lane, so before the
    conversion a repurposed column still NAMED `in-review` produced a live "Merge & Close" on a card
    whose traits say it is mid-implementation.
    */
    expect(
      getTaskReviewAction(mkTask({ id: "FN-6", column: "in-review" }), {
        t,
        currentColumnFlags: WIP_TRAITS as never,
        onMerge: vi.fn(),
      } as never),
    ).toBeUndefined();

    // Non-vacuous: the same card in a real review lane DOES get the action, under either spelling.
    for (const columnId of ["in-review", "validating"]) {
      expect(
        getTaskReviewAction(mkTask({ id: "FN-7", column: columnId }), {
          t,
          currentColumnFlags: REVIEW_TRAITS as never,
          onMerge: vi.fn(),
        } as never),
      ).toBeDefined();
    }
  });

  it("the review bypass survives a renamed review lane (the affordance the id comparison hid)", () => {
    const stranded = {
      workflowStepResults: [{ phase: "pre-merge", status: "failed" }],
    } as unknown as Partial<Task>;

    for (const columnId of ["in-review", "validating"]) {
      const model = buildTaskActionMenuModel({
        task: mkTask({ id: "FN-4", column: columnId, ...stranded }),
        t,
        columnLabel,
        currentColumnFlags: REVIEW_TRAITS as never,
        onBypassReview: vi.fn(),
      } as never);
      expect(model.actions.map((action: { id: string }) => action.id)).toContain("bypass-review");
    }
  });

  it("and the bypass still requires a genuinely stranded card, so widening the lane test did not widen the action", () => {
    const model = buildTaskActionMenuModel({
      task: mkTask({ id: "FN-5", column: "validating" }),
      t,
      columnLabel,
      currentColumnFlags: REVIEW_TRAITS as never,
      onBypassReview: vi.fn(),
    } as never);
    expect(model.actions.map((action: { id: string }) => action.id)).not.toContain("bypass-review");
  });

  it("a stale planner card is inactive on all three lineages, so the invariance is not just `always true`", () => {
    /*
    Without this, the case above would pass for a predicate hardwired to `true`. Both
    verdicts must be unanimous AND opposite each other for the invariance to mean anything.
    */
    const stale = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const verdicts = LINEAGES.map((lineage) =>
      isTaskAgentActive(
        mkTask({ id: "FN-3", column: lineage.columnId, recentAgentActivityAt: stale } as never),
        { columnFlags: PRE_IMPLEMENTATION_TRAITS as never },
      ),
    );

    expect(new Set(verdicts).size).toBe(1);
    expect(verdicts[0]).toBe(false);
  });
});
