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
import { buildTaskActionMenuModel } from "../TaskContextMenu";
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
    // FNXC:TaskActivity 2026-08-01-17:53: glow now requires the authoritative `planning`
    // status (the slot-holding signal); the client-only fresh-log window is removed so lane
    // counts can never exceed the live-agent population.
    const verdicts = LINEAGES.map((lineage) =>
      isTaskAgentActive(
        mkTask({ id: "FN-2", column: lineage.columnId, status: "planning" } as never),
        { columnFlags: PRE_IMPLEMENTATION_TRAITS as never },
      ),
    );

    expect(new Set(verdicts).size).toBe(1);
    // Non-vacuous: a live planning card on a pre-implementation lane IS active.
    expect(verdicts[0]).toBe(true);
  });

  it("a stale planner card is inactive on all three lineages, so the invariance is not just `always true`", () => {
    /*
    Without this, the case above would pass for a predicate hardwired to `true`. Both
    verdicts must be unanimous AND opposite each other for the invariance to mean anything.
    */
    // A status-null waiting card (even with recent planner logs) holds no slot: inactive.
    const stale = new Date(Date.now() - 5_000).toISOString();
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
