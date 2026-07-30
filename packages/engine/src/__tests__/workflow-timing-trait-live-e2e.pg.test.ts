/*
FNXC:WorkflowResolvedColumns 2026-08-01-09:10 (E2E evidence — the `timing` role, and it is CORRECT):

Coverage for the last lifecycle role with none, and the result is a clean bill of health — recorded
because a working conversion with no test is one refactor away from a silent regression, and because
this program should be able to say which seams are RIGHT, not only which are broken.

`cumulativeActiveMs` accrues while a card sits in the WIP lane. Both halves of the segment boundary
resolve that lane by ROLE:

    const isWip = (column) =>
      inRole(column, ctx.lifecycleColumnSets?.wip, ctx.lifecycleColumns?.wip, "in-progress");

Note the literal at the end. It is the same optional-parameter shape that this series found broken at
four other seams — `shouldHoldActiveFileScopeLease` (#2795), `evaluateParkedAgentTaskLink` (#2798),
`resolvePlanningContinuationCandidate` (#2799), `hasAutoHealableVerificationBufferFailure` (#2802) —
where a caller did not supply the resolved answer and the literal silently took over. Here the move
path DOES supply it, so the seam works. Measured on a live store rather than assumed:

    default: after exit cumulativeActiveMs=84
    renamed: after exit cumulativeActiveMs=75      <- accrues on `building`, not just `in-progress`

WHAT THIS GUARDS. If the move path ever stops populating the resolved columns, the literal takes over
and a renamed board's cards accrue ZERO active time — silently, because zero is a legitimate value for
a card that has not run. The operator sees no error, just wrong numbers on every custom board. This
suite turns that into a red test; blinding the resolved answer is exactly the mutation it was
verified against.

THE SEGMENT IS CLOSED ON EXIT, not sampled on entry — `cumulativeActiveMs` is 0 while the card is
still in WIP and only accrues when it leaves. Both are asserted, because a test that only checked the
final number would pass against an implementation that accrued at the wrong boundary.

LANE. `.pg.test.ts`, skipped via `pgDescribe` when no PostgreSQL is reachable, so the merge gate is
unaffected. Throwaway per-file database; never port 4040.
*/
import { beforeAll, beforeEach, afterEach, afterAll, expect, it } from "vitest";
import "@fusion/core"; // registers the built-in column traits
import type { Task, TaskStore } from "@fusion/core";

import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../../core/src/__test-utils__/pg-test-harness.js";

import { DEFAULT_VOCAB, RENAMED_VOCAB, lifecycleIr, type Vocabulary } from "./_workflow-vocabulary-fixture.js";

/** Long enough that a closed segment is unambiguously non-zero, short enough to stay cheap. Not a
 *  flake knob: the assertion is `> 0`, and the alternative outcome is exactly 0. */
const DWELL_MS = 60;

pgDescribe("WIP timing accrues on the board's own implementation lane", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_timing_trait",
  });

  beforeAll(h.beforeAll);
  afterAll(h.afterAll);
  beforeEach(async () => { await h.beforeEach(); });
  afterEach(async () => { await h.afterEach(); });

  /** Move a real card through its board's WIP lane and out, sampling the row at both boundaries. */
  async function dwellInWip(
    store: TaskStore,
    v: Vocabulary,
    key: string,
  ): Promise<{ inWip: Task | null; afterExit: Task | null }> {
    const created = await store.createWorkflowDefinition({
      name: `Timing ${key}`,
      kind: "workflow",
      ir: lifecycleIr(v, `custom:${key}`),
    } as never);
    const task = await store.createTask({ description: `timing probe ${key}` });
    await store.writeTaskWorkflowSelection(task.id, (created as { id: string }).id, []);
    store.taskCache.delete(task.id);

    await store.moveTask(task.id, v.wip as never, { recoveryRehome: true } as never);
    store.taskCache.delete(task.id);
    const inWip = await store.getTask(task.id);

    await new Promise((resolve) => setTimeout(resolve, DWELL_MS));
    await store.moveTask(task.id, v.review as never, { recoveryRehome: true } as never);
    store.taskCache.delete(task.id);
    return { inWip, afterExit: await store.getTask(task.id) };
  }

  it("CONTROL — the DEFAULT board accrues active time across a WIP visit", async () => {
    const store = h.store();
    const { inWip, afterExit } = await dwellInWip(store, DEFAULT_VOCAB, "wf-default-timing");

    expect(inWip?.firstExecutionAt).toBeTruthy();      // stamped on ENTRY
    expect(inWip?.cumulativeActiveMs).toBe(0);         // segment still open
    expect(afterExit?.cumulativeActiveMs).toBeGreaterThan(0); // closed on EXIT
  });

  it("a RENAMED board accrues on ITS implementation lane, not on `in-progress`", async () => {
    /*
    The differential. This board has no `in-progress` column at all, so if the literal fallback were
    reached — because the move path stopped supplying the resolved answer — neither boundary would
    match and the card would accrue exactly zero, indistinguishable from a card that never ran.
    */
    const store = h.store();
    const { inWip, afterExit } = await dwellInWip(store, RENAMED_VOCAB, "wf-renamed-timing");

    expect(inWip?.firstExecutionAt).toBeTruthy();
    expect(inWip?.cumulativeActiveMs).toBe(0);
    expect(afterExit?.cumulativeActiveMs).toBeGreaterThan(0);
  });
});
