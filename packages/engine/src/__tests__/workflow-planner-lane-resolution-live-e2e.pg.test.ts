/*
FNXC:WorkflowLifecycleColumns 2026-07-30-15:45 (E2E evidence — U11 planner-lane guards):

Closes the unit-level-only caveat on the planner-lane conversion (#2610). That PR
turned two guards from literals into resolved vocabulary and wired four production
callers, and its central claim was an ASYMMETRY argued from reading the code:

  the mission-feature guard wants BOTH planner lanes (intake + hold), while the
  spec-staleness guard wants the DEDICATED planner lane only, because on a merged
  lineage the planner distinction is carried by STATUS rather than by the column.

I got that wrong on the first attempt and a pre-existing unit test caught it. This
file proves the resolvers behave correctly against a REAL PostgreSQL store and REAL
stored workflow definitions, over both board shapes, so the asymmetry is not
resting on a mock that happens to agree with me.

DIFFERENTIAL. Both workflows come from the ONE shared builder and differ only in
their column ids (`DEFAULT_VOCAB` vs `RENAMED_VOCAB`) and in whether the planner
lane is SPLIT out of the hold column. Any behavioural difference is therefore
attributable to vocabulary or shape and nothing else.

FIXTURE MECHANISM, updated on rebase: the shared builder now emits a SEPARATE intake
column by default and merges only when asked (`mergedIntakeAndHold`) or when the
vocabulary's `intake` equals its `hold`. An earlier version of this suite carried its
own `separateIntake` option for the split shape; that is redundant now and was dropped
rather than kept as a second way to say the same thing.

NAMED `planner-lane-RESOLUTION` to stay distinguishable from PR #2611's
`workflow-planning-lane-live-e2e.pg.test.ts`, which is a different subject: that
one drives the real hold-release SWEEP, this one drives the resolvers the lane
guards consume. Complementary, not overlapping — the near-identical names would
have invited someone to delete one as a duplicate.

LANE. `.pg.test.ts`, skipped via `pgDescribe` when no PostgreSQL is reachable, so
the merge gate is unaffected. Throwaway per-file database; never port 4040.
*/
import { beforeAll, beforeEach, afterEach, afterAll, expect, it } from "vitest";
import "@fusion/core"; // registers the built-in column traits
import type { TaskStore } from "@fusion/core";

import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../../core/src/__test-utils__/pg-test-harness.js";

import {
  resolveDedicatedPlannerColumnsForTask,
  resolvePlannerLanesForTask,
} from "../planner-lane-resolution.js";
import { DEFAULT_VOCAB, RENAMED_VOCAB, lifecycleIr, type Vocabulary } from "./_workflow-vocabulary-fixture.js";

pgDescribe("U11 planner-lane resolution against a live store", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_u11_lanes",
  });

  beforeAll(h.beforeAll);
  afterAll(h.afterAll);
  beforeEach(async () => { await h.beforeEach(); });
  afterEach(async () => { await h.afterEach(); });

  /** Persist a real workflow definition and a task bound to it.
   *
   *  Follows `workflow-lifecycle-live-e2e.pg.test.ts`: `createWorkflowDefinition`
   *  allocates its OWN `WF-###` and ignores any id passed in, so the task must be
   *  bound to the id the STORE returned. Binding to the requested id instead
   *  silently resolves to the default builtin IR — a renamed-workflow fixture that
   *  passes while testing nothing.
   *
   *  (`insertWorkflowDefinitionSync` is not usable here: it is the SQLite path and
   *  throws in backend mode. That is the whole point of running this against a real
   *  PG store rather than a mock.) */
  async function taskOn(
    store: TaskStore,
    v: Vocabulary,
    key: string,
    shape: { mergedIntakeAndHold?: boolean } = {},
  ): Promise<string> {
    const ir = lifecycleIr(v, `custom:${key}`, shape);
    const created = await store.createWorkflowDefinition({
      name: `Lanes ${key}`,
      kind: "workflow",
      ir,
    } as never);
    const workflowId = (created as { id: string }).id;

    const task = await store.createTask({ description: `lane probe ${key}` });
    await store.writeTaskWorkflowSelection(task.id, workflowId, []);
    store.taskCache.delete(task.id);
    return task.id;
  }

  it("SPLIT board: both lanes for the pair guard, the intake lane alone for the dedicated guard", async () => {
    const store = h.store();
    const taskId = await taskOn(store, RENAMED_VOCAB, "wf-split-renamed", {});

    expect(await resolvePlannerLanesForTask(store, taskId)).toEqual([
      RENAMED_VOCAB.intake,
      RENAMED_VOCAB.hold,
    ]);
    expect(await resolveDedicatedPlannerColumnsForTask(store, taskId)).toEqual([
      RENAMED_VOCAB.intake,
    ]);
  });

  it("MERGED board: one lane for the pair guard, and NOTHING for the dedicated guard", async () => {
    /*
    The asymmetry, and the half I originally got wrong. An empty result here is the
    correct ANSWER, not a failed resolution: with planning and hold sharing a column
    the planner distinction is carried by status, and treating the merged column as
    a dedicated planner lane stops a parked card with preserved progress from
    skipping staleness.
    */
    const store = h.store();
    const merged = await taskOn(store, RENAMED_VOCAB, "wf-merged-renamed", { mergedIntakeAndHold: true });

    expect(await resolvePlannerLanesForTask(store, merged)).toEqual([RENAMED_VOCAB.hold]);
    expect(await resolveDedicatedPlannerColumnsForTask(store, merged)).toEqual([]);

    /*
    A THIRD shape used to be asserted here — a hold column with NO intake trait,
    where the resolver reports `undefined` ("no intake to name") rather than `[]`
    ("intake exists and IS the hold column"). The callers treat those differently:
    `undefined` keeps their legacy default, `[]` positively asserts no dedicated
    planner lane.

    DROPPED on rebase, not because the distinction stopped mattering but because the
    shared fixture can no longer produce that shape. Main's fixture correction makes
    an intake trait unconditional — separate when the vocabulary splits, on the hold
    column when it merges — precisely so `intake === undefined` is unreachable, since
    a vacuous `expect(intake).not.toBe(hold)` passed against a resolver that never
    resolved intake at all.

    The distinction is still pinned, at the unit level, in
    `planner-lane-resolution.test.ts`. Reconstructing an intake-less IR by hand here
    just to keep the assertion would rebuild the exact shape that correction removed.
    */
  });

  it("resolves by ROLE, not by id: the default vocabulary gives the same SHAPE of answer", async () => {
    /*
    The differential. Same builder, same shape, only the ids differ — so a guard
    still keyed on a literal would answer differently here than above, and this is
    where that shows up.
    */
    const store = h.store();
    const split = await taskOn(store, DEFAULT_VOCAB, "wf-split-default", {});
    const merged = await taskOn(store, DEFAULT_VOCAB, "wf-merged-default", { mergedIntakeAndHold: true });

    expect(await resolvePlannerLanesForTask(store, split)).toEqual([
      DEFAULT_VOCAB.intake,
      DEFAULT_VOCAB.hold,
    ]);
    expect(await resolveDedicatedPlannerColumnsForTask(store, split)).toEqual([DEFAULT_VOCAB.intake]);

    expect(await resolvePlannerLanesForTask(store, merged)).toEqual([DEFAULT_VOCAB.hold]);
    expect(await resolveDedicatedPlannerColumnsForTask(store, merged)).toEqual([]);
  });
});
