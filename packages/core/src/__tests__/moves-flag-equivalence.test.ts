/*
FNXC:WorkflowColumns 2026-07-31-02:00 (U12 — precondition 1 for flipping the move-path flag):
DO THE TWO COLUMN-SIDE-EFFECT IMPLEMENTATIONS AGREE?

`moves.ts` gates six behaviours on the raw compatibility flag (#2639 pins all six). Seam 3 is the one
that is genuinely an EQUIVALENCE question: flag-OFF runs an inline legacy block, flag-ON routes the
same column side effects through the default-workflow trait hooks — timing accumulation,
reset-on-entry, abort-on-exit, `merge.onEnter`. Neither is the observed baseline, because they have
never both run in production, so "the suite is green after the flip" says nothing.

WHY THIS IS BUILDABLE NOW, which I had assumed it was not. The flag reads
`settings.experimentalFeatures.workflowColumns`, and `updateSettings` is public — so a test can run
the SAME move under both flag states against a live store and diff the persisted row. No production
change, no mock of the thing under test.

WHAT IT COMPARES. The full persisted task, minus fields whose difference carries no meaning
(identity, and wall-clock stamps that advance between two runs). Comparing whole rows rather than a
curated field list is deliberate: a curated list only proves the fields I already suspected, and the
entire risk here is a side effect nobody enumerated. `moves.ts` mutates ~15 fields in that branch.

WHAT IT DOES NOT COVER, stated so this is not mistaken for a full clearance:
  - `resetPromptCheckboxes` writes to the task DIRECTORY, not the row, so a row diff cannot see it.
  - Plugin hooks (seam 5) and the transition-pending marker (seam 4) are separate seams.
  - Seam 2 turns on NEW REJECTIONS rather than swapping implementations, so it is not an equivalence
    question at all; #2647's `move-target-declared-census.test.ts` measures that exposure instead.
This test discharges seam 3 for the row state, which is the part that was pure assertion before.
*/
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { pgDescribe, createSharedPgTaskStoreTestHarness } from "../__test-utils__/pg-test-harness.js";
import type { TaskDetail } from "../types.js";
import type { TaskStore } from "../store.js";

/**
 * Fields whose difference between two runs is meaningless: identity, and stamps that advance with
 * wall clock. Everything else must match, including the timing ACCUMULATORS (`cumulativeActiveMs`),
 * which are the interesting part — they are computed from deltas, so a divergence in how the two
 * implementations anchor a segment shows up there rather than in a raw timestamp.
 */
const VOLATILE_FIELDS = new Set([
  "id",
  // Per-task UUID; carries no behavioural meaning.
  "lineageId",
  "createdAt",
  "updatedAt",
  "columnMovedAt",
  "executionStartedAt",
  "executionCompletedAt",
  "firstExecutionAt",
  "cumulativeActiveMs",
  "log",
]);

/*
Wall-clock noise is normalised RECURSIVELY rather than by a flat key list, because it is nested:
`columnDwellMs` is a column -> milliseconds map and run-audit-ish entries carry their own `observedAt`.
A flat list missed both, and the first run of this test reported them as divergences.

Durations become BOOLEANS (`>0`) rather than being dropped: whether time was attributed to a column at
all is exactly the behaviour under test, while the millisecond value differs between any two runs.
Dropping them would have hidden a real divergence; comparing them would have been permanently flaky.
*/
function normalize(value: unknown, key?: string, taskId?: string): unknown {
  /*
  IDENTITY is substituted inside strings rather than the field being dropped. `prompt` embeds the task
  id (`# KB-001` vs `# KB-002`), so a raw comparison always fails and dropping it would stop comparing
  the spec content entirely — which is one of the things the reset-on-entry side effect can touch.
  Replacing the id keeps the content under test.
  */
  if (typeof value === "string" && taskId) return value.split(taskId).join("<TASK_ID>");
  if (typeof value === "number" && key !== undefined && /Ms$/.test(key)) return value > 0;
  if (Array.isArray(value)) return value.map((entry) => normalize(entry, undefined, taskId));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (VOLATILE_FIELDS.has(k) || /At$/.test(k)) continue;
      // A duration MAP: keep the keys, reduce each value to "time was attributed here".
      out[k] = /Ms$/.test(k) && v && typeof v === "object" && !Array.isArray(v)
        ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([ck, cv]) => [ck, typeof cv === "number" ? cv > 0 : cv]))
        : normalize(v, k, taskId);
    }
    return out;
  }
  return value;
}

function comparableSnapshot(task: TaskDetail): Record<string, unknown> {
  return normalize(task, undefined, task.id) as Record<string, unknown>;
}

/** Which timing fields were SET (not their values), so anchoring behaviour is still compared. */
function timingShape(task: TaskDetail): Record<string, boolean> {
  const t = task as unknown as Record<string, unknown>;
  return {
    hasExecutionStartedAt: t.executionStartedAt != null,
    hasExecutionCompletedAt: t.executionCompletedAt != null,
    hasFirstExecutionAt: t.firstExecutionAt != null,
    accumulatedActiveTime: typeof t.cumulativeActiveMs === "number" && (t.cumulativeActiveMs as number) > 0,
  };
}

/*
FNXC:WorkflowColumns 2026-07-31-02:30 (U12 — the trap this test fell into first):
THE FLAG IS GLOBAL-ONLY, so it must be written through `updateGlobalSettings`.

My first version used `updateSettings`, and the test PASSED — while proving nothing. `moves.ts` reads
`getSettingsFast()`, which filters `isGlobalOnlySettingsKey` out of the project layer, and
`experimentalFeatures` is exactly such a key (`isGlobalSettingsKey("experimentalFeatures") === true`).
So the project-scoped write was discarded, `useWorkflow` was false in BOTH runs, and the "equivalence
proof" was comparing the legacy path against itself.

Caught by stamping the flag-ON branch of `moves.ts` and observing that the test still passed — i.e. by
checking that the mutation could be detected, not by trusting the green. Exactly the failure this
program keeps finding, produced by me this time.
*/
async function setFlag(store: TaskStore, enabled: boolean): Promise<void> {
  const current = await store.globalSettingsStore.getSettings();
  await store.updateGlobalSettings({
    ...current,
    experimentalFeatures: { ...(current.experimentalFeatures ?? {}), workflowColumns: enabled },
  } as never);

  // Prove the write took effect before relying on it — the whole point of this note.
  const effective = await store.getSettingsFast();
  if ((effective.experimentalFeatures?.workflowColumns === true) !== enabled) {
    throw new Error(`flag write did not take effect: wanted ${enabled}, moves.ts would read ${effective.experimentalFeatures?.workflowColumns === true}`);
  }
}

/**
 * Drive one task through a column journey under a fixed flag state and return what persisted.
 * The journey covers the transitions the legacy block special-cases: entering execution, leaving it
 * (segment accumulation + abort-on-exit), and reaching review.
 */
async function runJourney(store: TaskStore, flagEnabled: boolean): Promise<{ snapshot: Record<string, unknown>; timing: Record<string, boolean> }> {
  await setFlag(store, flagEnabled);
  /*
  IDENTICAL description in both runs. My first version interpolated the flag state and the whole-row
  diff dutifully reported it — a self-inflicted failure that would have read as a real divergence.
  */
  const created = await store.createTask({ description: "equivalence journey" });

  /*
  THE JOURNEY MUST GO BACKWARD TOO. My first version was forward-only (todo -> in-progress ->
  in-review) and a mutation to the REOPEN hook did not fail it: those field resets (`status`, `error`,
  `blockedBy`, pause clearing) only run when a card moves back out of a later column, so a
  forward-only journey never reached them. The test passed while covering roughly half the branch.

  Now: enter execution, reach review, reopen to the hold column (reset-on-entry + abort-on-exit), and
  re-enter execution so the second segment's timing accumulation is exercised on top of the first.
  */
  await store.moveTask(created.id, "in-progress");
  await store.moveTask(created.id, "in-review");
  await store.moveTask(created.id, "todo");
  await store.moveTask(created.id, "in-progress");

  const final = await store.getTask(created.id);
  if (!final) throw new Error("task vanished mid-journey");
  return { snapshot: comparableSnapshot(final), timing: timingShape(final) };
}

pgDescribe("move-path side effects are equivalent with the compatibility flag OFF and ON (U12 seam 3)", () => {
  const harness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_moves_flag_equiv" });
  beforeAll(harness.beforeAll);
  beforeEach(harness.beforeEach);
  afterEach(harness.afterEach);
  afterAll(harness.afterAll);

  /*
  One test rather than two, because the assertion IS the comparison: neither run has meaning alone.
  Ordered flag-OFF first so the legacy path — the one actually running in production today — is the
  expected value, and any divergence reads as "the trait hooks differ from shipped behaviour".
  */
  it("the persisted row is identical either way, and so is the timing shape", async () => {
    const store = harness.store();

    const legacy = await runJourney(store, false);
    const traitHooks = await runJourney(store, true);

    /*
    Whole-row equality. If this fails, the flip changes persisted state on every task move and the
    diff names the field — which is the evidence precondition 1 asks for, in either direction.
    */
    expect(traitHooks.snapshot).toEqual(legacy.snapshot);

    /*
    Timing is compared as a SHAPE, not by value: the two runs happen at different wall-clock instants,
    so equal millisecond counts would be coincidence and a mismatch would be noise. What must agree is
    which anchors got set and whether active time accumulated at all — a divergence there means the
    two implementations disagree about when execution starts or ends, which would silently corrupt
    every task's duration.
    */
    expect(traitHooks.timing).toEqual(legacy.timing);
  });
});
