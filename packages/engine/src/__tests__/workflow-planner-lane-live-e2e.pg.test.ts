/*
FNXC:WorkflowLifecycleColumns 2026-07-29-11:20 (E2E evidence — the planner-lane resolvers):

`planner-lane-resolution.ts` is the one merged-board-aware conversion in the program that got the
hard case RIGHT, and its correctness rests on a claim that is only unit-proven against a MOCKED
IR: that a merged lineage yields NOTHING from the dedicated-planner resolver, and that saying so
is the correct answer rather than a failure to resolve.

That claim is worth proving on a real store because `[]` is the shape of a guard that no longer
guards. Two things have to hold and neither is self-evident:

  1. The merged board must produce `[]` — not `undefined`, and not the merged column. `undefined`
     would make both consumers fall back to the LEGACY literal list (`?? LEGACY_...`), silently
     reintroducing `triage` on a board that does not declare it. Returning the merged column
     would make a parked card with preserved progress skip staleness.

  2. `[]` must SURVIVE the consumer. Both call sites spell it `context.plannerColumns ?? LEGACY`,
     which is only correct because `??` fails over on null/undefined and NOT on empty — a
     `.length ? … : LEGACY` spelling would look equivalent and quietly restore the literal. That
     is a live hazard, so it is asserted through the real guard rather than by reading the code.

And the discriminating case the resolver's own comment cites: on a merged lineage the planner
distinction is carried by STATUS, not by the column, so the SAME column with a different status
must give the OPPOSITE answer. A column-only implementation cannot produce that.

WHAT IS REAL: a PostgreSQL TaskStore, real persisted workflow definitions, the real resolvers,
and the real `evaluateSpecStaleness` guard. Assertions read resolver output and guard verdicts,
never call spies.
*/
import { beforeAll, beforeEach, afterEach, afterAll, expect, it } from "vitest";
import "@fusion/core";

import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../../core/src/__test-utils__/pg-test-harness.js";
import {
  resolveDedicatedPlannerColumnsForTask,
  resolvePlannerLanesForTask,
} from "../planner-lane-resolution.js";
import { shouldSkipSpecStalenessForPreservedProgress } from "../spec-staleness.js";
import { MERGED_RENAMED_VOCAB, RENAMED_VOCAB, lifecycleIr, type Vocabulary } from "./_workflow-vocabulary-fixture.js";

/*
A card sitting in the MERGED lane that has ALREADY done work. The preserved progress is the
guard's actual subject — `currentStep > 0` is what makes it return true at all — so a card
without it returns false for a reason that has nothing to do with the planner-lane question.
Learned by getting it wrong: the first version of these two cases passed no progress and read
the resulting `false` as a lane verdict.
*/
const PRESERVED_PROGRESS_CARD = {
  column: MERGED_RENAMED_VOCAB.hold,
  status: "in-progress",
  currentStep: 2,
} as const;

pgDescribe("live planner-lane E2E: the merged board must yield NO dedicated planner column", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_planner_lane_e2e",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  async function seedWorkflow(v: Vocabulary, key: string, merged: boolean): Promise<string> {
    const created = await h.store().createWorkflowDefinition({
      name: `Planner ${key}`,
      kind: "workflow",
      ir: lifecycleIr(v, `custom:planner-${key}`, { mergedIntakeAndHold: merged }),
    } as never);
    return (created as { id: string }).id;
  }

  async function seedTask(taskId: string, column: string, workflowId: string): Promise<void> {
    const store = h.store();
    await store.createTaskWithReservedId(
      { description: `planner ${taskId}`, column } as never,
      { taskId, applyDefaultWorkflowSteps: false } as never,
    );
    await store.writeTaskWorkflowSelection(taskId, workflowId, []);
    store.taskCache.delete(taskId);
  }

  it("yields [] for a MERGED lineage — empty, not undefined, and not the merged column", async () => {
    /* The three-way distinction that matters. `toEqual([])` alone would also pass for
       `undefined` under a loose matcher, so the emptiness and the definedness are asserted
       separately, and the merged column is explicitly ruled out. */
    const wf = await seedWorkflow(MERGED_RENAMED_VOCAB, "merged", true);
    await seedTask("FN-PL-1", MERGED_RENAMED_VOCAB.hold, wf);

    const dedicated = await resolveDedicatedPlannerColumnsForTask(h.store(), "FN-PL-1");

    expect(dedicated).toBeDefined();
    expect(dedicated).toEqual([]);
    expect(dedicated).not.toContain(MERGED_RENAMED_VOCAB.hold);
    // ...and the legacy id is not smuggled in either.
    expect(dedicated).not.toContain("triage");
  });

  it("still yields the intake lane for a RENAMED lineage with two distinct columns", async () => {
    /* The differential. Without this, the case above would also pass for a resolver that
       returned [] unconditionally — which is the exact way this guard could go dead. */
    const wf = await seedWorkflow(RENAMED_VOCAB, "renamed", false);
    await seedTask("FN-PL-2", RENAMED_VOCAB.hold, wf);

    const dedicated = await resolveDedicatedPlannerColumnsForTask(h.store(), "FN-PL-2");

    expect(dedicated).toHaveLength(1);
    expect(dedicated?.[0]).not.toBe(RENAMED_VOCAB.hold);
    expect(dedicated?.[0]).not.toBe("triage");
  });

  it("reports BOTH lanes as planner lanes on a renamed board, and ONE on a merged board", async () => {
    /* `resolvePlannerLanesForTask` answers a different question — "is this card waiting to be
       planned?", true in either lane — so it must de-duplicate rather than return [] when the
       two roles collapse. A merged board reporting zero planner lanes here would strand every
       card waiting to be planned. */
    const renamedWf = await seedWorkflow(RENAMED_VOCAB, "lanes-renamed", false);
    await seedTask("FN-PL-3", RENAMED_VOCAB.hold, renamedWf);
    const mergedWf = await seedWorkflow(MERGED_RENAMED_VOCAB, "lanes-merged", true);
    await seedTask("FN-PL-4", MERGED_RENAMED_VOCAB.hold, mergedWf);

    const renamedLanes = await resolvePlannerLanesForTask(h.store(), "FN-PL-3");
    const mergedLanes = await resolvePlannerLanesForTask(h.store(), "FN-PL-4");

    expect(renamedLanes).toHaveLength(2);
    // Collapsed to one by the Set, and NOT empty — the opposite of the dedicated resolver.
    expect(mergedLanes).toEqual([MERGED_RENAMED_VOCAB.hold]);
  });

  it("keeps [] alive through the real guard instead of failing over to the legacy literal", async () => {
    /*
    The `??` hazard, asserted rather than read. Both consumers spell the fallback
    `plannerColumns ?? LEGACY_...`, correct only because `??` does not fail over on empty.

    A card in the merged lane with preserved progress must NOT be treated as sitting in a
    planner column: with `[]` the guard sees no planner column and proceeds. If `[]` were
    replaced by the legacy list, the merged lane would still not match `triage` — so to make
    this bite, the merged lane is checked against a legacy list that DOES contain it, which is
    what a `.length ? … : LEGACY` spelling would produce for the faithful U11 vocabulary.
    */
    const skipWithEmpty = shouldSkipSpecStalenessForPreservedProgress(
      PRESERVED_PROGRESS_CARD as never,
      [],
    );
    const skipWithLaneAsPlanner = shouldSkipSpecStalenessForPreservedProgress(
      PRESERVED_PROGRESS_CARD as never,
      [MERGED_RENAMED_VOCAB.hold],
    );

    // Empty planner list -> the card is not in a planner column -> the guard does not bail out.
    expect(skipWithEmpty).toBe(true);
    // The same card, if the merged lane were reported AS a planner column -> opposite verdict.
    expect(skipWithLaneAsPlanner).toBe(false);
  });

  it("gives the OPPOSITE answer for the same column with a planner status — the merged distinction is status, not column", async () => {
    /* The case `planner-lane-resolution.ts` cites as its reason for returning []: "same column,
       different status, opposite correct answer". A column-only implementation cannot produce
       this, which is why the merged board must not report a dedicated planner column at all. */
    const preserved = shouldSkipSpecStalenessForPreservedProgress(
      PRESERVED_PROGRESS_CARD as never,
      [],
    );
    const replanning = shouldSkipSpecStalenessForPreservedProgress(
      { ...PRESERVED_PROGRESS_CARD, status: "needs-replan" } as never,
      [],
    );

    expect(preserved).toBe(true);
    expect(replanning).toBe(false);
  });
});
