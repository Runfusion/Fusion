/*
FNXC:PlanningLaneLiveE2E 2026-07-30-04:20 (U7 E2E evidence — workflow-owned lifecycle):

WHY THIS FILE EXISTS. The planning lane is the one lifecycle lane with NO E2E coverage.
The existing live-E2E files cover the lifecycle spine, agent count, agent link, lease
rebound, the merge family and the rebound family — none of them exercises a planning
decision. Every U7 fix so far closes with the same caveat the other units already
removed for their lanes: "all evidence is unit-level".

That caveat is load-bearing here more than anywhere, because the planning fixes are
guards that REFUSE things. A guard is exactly what unit tests are worst at proving:
nine times on this program a planning test passed without exercising its subject — a
fake that ignored its predicate, a store stub that returned a non-promise into
`.catch`, a fixture that silently resolved to the default IR, a control that passed
when it should have failed.

WHAT IS REAL HERE:
  - a REAL PostgreSQL TaskStore (per-file throwaway database, never the operator's),
  - the REAL `runHoldReleaseSweep` — every guard, the trait resolution, the
    reservation ordering, and the in-transaction `moveTaskIf` predicate,
  - REAL persisted rows: every claim is read back from PostgreSQL with the store's
    task cache defeated, so a passing assertion can only have come from the row.

Nothing about the AI is involved, because none of these decisions involve it: they are
release gates and column resolution. There is no seam to substitute.

WHAT IT PROVES, per fix, each of which shipped with unit-level evidence only:
  1. #2491 — an approval-held card is NOT released into WIP by the real sweep. This
     was a genuine bypass: the manual plan-approval gate could be skipped end to end.
  2. #2491 — the in-transaction predicate holds when the park lands MID-SWEEP, after
     the snapshot the sweep read. Unit-testable only with a hand-built fake that
     honours the predicate; here the real store enforces it.
  3. The same two, on a RENAMED vocabulary, so no assertion can pass by matching a
     legacy id.

ASSERTION RULE, inherited from the sibling files: observed persisted state, never "a
function was called".

LANE. `.pg.test.ts`, skipped via `pgDescribe` when no PostgreSQL is reachable, so the
merge gate is unaffected. Throwaway per-file database; never port 4040; no temp-root
walk.
*/
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import "@fusion/core"; // registers the built-in column traits into the shared registry
import type { Task, WorkflowIr } from "@fusion/core";
import { AWAITING_APPROVAL_PAUSE_REASON } from "@fusion/core";

import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../../core/src/__test-utils__/pg-test-harness.js";

import { runHoldReleaseSweep } from "../hold-release.js";
import { DEFAULT_VOCAB, RENAMED_VOCAB, lifecycleIr, type Vocabulary } from "./_workflow-vocabulary-fixture.js";
import { seedPlannedSpec } from "./_planned-spec-fixture.js";

pgDescribe("live planning-lane E2E: real hold-release sweep + real PostgreSQL store", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_planning_lane_live_e2e",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  /** Persist a real workflow definition; the STORE assigns the id, so bind to that.
   *  Binding to the id we passed in silently resolves to the default builtin IR —
   *  which is how a renamed fixture passes while testing nothing. */
  async function seedWorkflow(v: Vocabulary, key: string): Promise<string> {
    const ir: WorkflowIr = lifecycleIr(v, `custom:${key}`);
    const created = await h.store().createWorkflowDefinition({
      name: `Planning ${key}`,
      kind: "workflow",
      ir,
    } as never);
    return (created as { id: string }).id;
  }

  /** A real task resting in the workflow's HOLD column, bound to that workflow. */
  async function seedHeldTask(taskId: string, v: Vocabulary, workflowId: string, fields: Partial<Task> = {}): Promise<void> {
    const store = h.store();
    await store.createTaskWithReservedId(
      { description: `planning e2e ${taskId}`, column: v.hold } as never,
      { taskId, applyDefaultWorkflowSteps: false } as never,
    );
    await store.writeTaskWorkflowSelection(taskId, workflowId, []);
    /*
    FNXC:WorkflowLifecycleColumns 2026-07-30-12:05 (release-leg fixture):
    Needs a spec FN-7648 accepts as PLANNED, or even this file's own control case ("releases an
    ordinary held card on a default board") goes red. Rationale and self-check live in
    `_planned-spec-fixture.ts`.
    */
    seedPlannedSpec(store as never as { getTasksDir(): string }, taskId);
    if (Object.keys(fields).length > 0) await store.updateTask(taskId, fields as never);
    store.taskCache.delete(taskId);
  }

  /** The persisted column, read from PostgreSQL with the task cache defeated. */
  async function persistedColumn(taskId: string): Promise<string> {
    const store = h.store();
    store.taskCache.delete(taskId);
    return (await store.getTask(taskId)).column as string;
  }

  const sweep = () => runHoldReleaseSweep(h.store(), { now: () => Date.now() });

  for (const [label, v] of [["default", DEFAULT_VOCAB], ["renamed", RENAMED_VOCAB]] as const) {
    it(`releases an ordinary held card on a ${label} board (the control)`, async () => {
      // Without this, "not released" below would be unfalsifiable — a sweep that
      // never releases anything would pass every approval assertion.
      const wf = await seedWorkflow(v, `${label}-control`);
      await seedHeldTask("FN-OK", v, wf);

      const result = await sweep();

      expect(result.released).toContain("FN-OK");
      expect(await persistedColumn("FN-OK")).toBe(v.wip);
    });

    it(`does NOT release a card blocked on manual plan approval on a ${label} board`, async () => {
      /*
      The bypass #2491 fixed, proven against the real sweep. `status:
      "awaiting-approval"` is the shape the plan-approval gate actually writes — no
      pause flag — which is why the pre-existing `paused` skip did not catch it.
      */
      const wf = await seedWorkflow(v, `${label}-approval`);
      await seedHeldTask("FN-APPROVAL", v, wf, { status: "awaiting-approval" } as Partial<Task>);

      const result = await sweep();

      expect(result.released).not.toContain("FN-APPROVAL");
      // The card is still where the operator's pending decision left it.
      expect(await persistedColumn("FN-APPROVAL")).toBe(v.hold);
    });

    it(`does NOT release a paused-for-approval card on a ${label} board`, async () => {
      // The predicate's other hold shape. Asserted because a status-only fix would
      // leave this half unexercised.
      const wf = await seedWorkflow(v, `${label}-approval-paused`);
      await seedHeldTask("FN-PAUSED", v, wf, {
        paused: true,
        pausedReason: AWAITING_APPROVAL_PAUSE_REASON,
      } as Partial<Task>);

      const result = await sweep();

      expect(result.released).not.toContain("FN-PAUSED");
      expect(await persistedColumn("FN-PAUSED")).toBe(v.hold);
    });
  }

  it("holds a card parked for approval MID-SWEEP, after the snapshot was read", async () => {
    /*
    The in-transaction half of #2491, which no unit test can prove without a fake that
    honours `moveTaskIf`'s predicate — and the fake that shipped first did not, which
    is exactly what greptile caught. Here the REAL store enforces it.

    The sweep reads its task list once at the top of the pass. Parking the card after
    that read but before the move leaves the pre-check satisfied and the predicate as
    the only thing standing between the card and WIP.
    */
    const wf = await seedWorkflow(DEFAULT_VOCAB, "midsweep");
    await seedHeldTask("FN-RACE", DEFAULT_VOCAB, wf);
    const store = h.store();

    let parked = false;
    const result = await runHoldReleaseSweep(store, {
      now: () => Date.now(),
      // `reserveSlot` runs AFTER the snapshot and BEFORE the move — the exact window.
      reserveSlot: async () => {
        if (!parked) {
          parked = true;
          await store.updateTask("FN-RACE", { status: "awaiting-approval" } as never);
          store.taskCache.delete("FN-RACE");
        }
        return { release: () => {} };
      },
    });

    expect(parked).toBe(true);
    expect(result.released).not.toContain("FN-RACE");
    expect(await persistedColumn("FN-RACE")).toBe(DEFAULT_VOCAB.hold);
  });
});
