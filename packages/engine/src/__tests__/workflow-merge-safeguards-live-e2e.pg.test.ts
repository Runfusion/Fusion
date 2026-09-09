/*
FNXC:MergeSafeguards 2026-07-29-20:40 (U9 E2E evidence — the safeguards, not the happy path):

WHAT THIS CLOSES. U9's safeguard baseline
(docs/plans/workflow-owned-merge-stack/u9-safeguard-baseline.md) verified all six merge
safeguards by MUTATION at unit level. The sibling merge-family E2E covers exactly one of
them end-to-end — "refuses to finalize a card with NO merge proof" (safeguard 5). The
other five had no live-engine evidence, which is the same caveat the lifecycle suite
exists to remove: a unit test proves the guard is consulted, not that a real store, real
transition policy and real column resolution actually refuse the move.

This file drives the LAST move a card makes — `finalizeProvenAutoMergeTask`, the step that
rehomes a proven-merged card into its workflow's complete column — against a real
PostgreSQL TaskStore, and asserts on the PERSISTED column read back after clearing the
task cache. Never on "a function was called".

SUBSTITUTION BOUNDARY. Only the merge PROOF is seeded (`mergeDetails.mergeConfirmed`),
which is what a real merger would have written; there is no git and none is needed, the
proof is a field on the row. Column resolution, the blocker evaluation, the move and its
guards, and persistence are all real.

WHAT THE PAUSE CASES PIN, and why they are written as they are. Proven-merge finalization
is deliberately a RECOVERY path: `mergeConfirmed` means the branch ALREADY LANDED, so the
code evaluates hard blockers with `paused: false` (auto-merge-finalization.ts:243) on the
grounds that leaving the card in review would misrepresent reality. That is a considered
exception to "never mutate a paused card", not an oversight — so these cases assert the
OBSERVED behavior rather than the safeguard's general form, and say so. If a future change
makes finalization refuse a paused card, these fail and the decision gets re-made
deliberately instead of drifting.

LANE. `.pg.test.ts`, `pgDescribe`-skipped without PostgreSQL, so the merge gate is
unaffected. Shared throwaway per-file database; never port 4040; no temp-root walk.
*/
import { beforeAll, beforeEach, afterEach, afterAll, expect, it } from "vitest";
import "@fusion/core"; // registers the built-in column traits
import type { MergeResult } from "@fusion/core";

import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../../core/src/__test-utils__/pg-test-harness.js";
import { finalizeProvenAutoMergeTask } from "../merge/auto-merge-finalization.js";
import { DEFAULT_VOCAB, RENAMED_VOCAB, MERGED_VOCAB, MERGED_RENAMED_VOCAB, lifecycleIr, type Vocabulary } from "./_workflow-vocabulary-fixture.js";

pgDescribe("live merge safeguards E2E: real store, real refusals", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_merge_safeguards_e2e",
    projectId: "project-workflow-merge-safeguards-e2e",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  /** The store allocates its own `WF-###` and ignores the id in the input; binding to
   *  the one we passed would silently resolve to the DEFAULT builtin IR instead. */
  async function seedWorkflow(v: Vocabulary, key: string, merged = false): Promise<string> {
    const created = await h.store().createWorkflowDefinition({
      name: `Merge safeguards ${key}`,
      kind: "workflow",
      ir: lifecycleIr(v, `custom:${key}`, { mergeOrchestration: true, mergedIntakeAndHold: merged }),
    } as never);
    return (created as { id: string }).id;
  }

  /** A card resting in the merge-orchestration column with durable merge proof —
   *  the state a real merger leaves behind. Walked through the REAL transition
   *  policy rather than written directly, so the row is one a real run could produce. */
  async function seedProvenMergedTask(
    taskId: string,
    v: Vocabulary,
    workflowId: string,
    patch: Record<string, unknown> = {},
  ): Promise<void> {
    const store = h.store();
    await store.createTaskWithReservedId(
      { description: `merged ${taskId}`, column: v.hold } as never,
      { taskId, applyDefaultWorkflowSteps: false } as never,
    );
    await store.writeTaskWorkflowSelection(taskId, workflowId, []);
    await store.moveTask(taskId, v.wip, { moveSource: "user" } as never);
    await store.moveTask(taskId, v.review, { moveSource: "user", allowDirectInReviewMove: true } as never);
    // Steps must be COMPLETE or getTaskHardMergeBlocker refuses on "incomplete steps";
    // creation parses three pending steps out of the bootstrap PROMPT even with
    // applyDefaultWorkflowSteps:false, so set them explicitly rather than assume empty.
    await store.updateTask(taskId, {
      steps: [{ name: "implementation", status: "done" }],
      mergeDetails: { mergeConfirmed: true },
      ...patch,
    } as never);
    store.taskCache.delete(taskId);
  }

  async function persistedColumn(taskId: string): Promise<string> {
    const store = h.store();
    store.taskCache.delete(taskId);
    return (await store.getTask(taskId)).column as string;
  }

  const finalize = (taskId: string) =>
    finalizeProvenAutoMergeTask({
      store: h.store(),
      taskId,
      mergeResult: { merged: true } as unknown as MergeResult,
    } as never);

  /* ── Safeguard 5 — merge proof, on BOTH vocabularies ──────────────────────────
     The sibling suite covers the renamed board; this adds the default one, so a
     regression that only affects legacy ids cannot hide behind the rename. */
  it("refuses to finalize a card with no merge proof and leaves it in the review lane", async () => {
    const wf = await seedWorkflow(DEFAULT_VOCAB, "noproof");
    await seedProvenMergedTask("FN-SG-NOPROOF", DEFAULT_VOCAB, wf, { mergeDetails: null });

    const result = await finalize("FN-SG-NOPROOF");

    // The REASON matters, not just the refusal. finalizeProvenAutoMergeTask has three
    // layered refusal gates (durable-proof, hard-blocker, workflow-proof); asserting a
    // bare "blocked" passes when ANY of them fires, so it cannot detect one being
    // removed. Measured: removing the durable-proof gate left the bare assertion green.
    expect({ outcome: result.outcome, reason: (result as { reason?: string }).reason })
      .toEqual({ outcome: "blocked", reason: "missing-merge-confirmation" });
    // The card must still be where it was: a refused finalize may not half-move it.
    expect(await persistedColumn("FN-SG-NOPROOF")).toBe(DEFAULT_VOCAB.review);
  });

  /* ── Safeguard 3 — dependency gating does NOT reach this seam ─────────────────
     MEASURED, and it contradicted my first draft of this test, which asserted a
     refusal. A proven-merged card with a live `blockedBy` finalizes to the complete
     column anyway.

     That is coherent rather than a hole: dependency gating lives in
     `getTaskCompletionBlocker` (verified by mutation in core's task-merge.test.ts,
     NEW-failures=5), which gates whether work may be CALLED complete. This seam runs
     after `mergeConfirmed` — the branch has already landed, so refusing the rehome
     would strand a merged card in review and misreport the repository, without
     un-merging anything.

     Pinned so the distinction is explicit: dependency gating protects the decision to
     finish, not the bookkeeping that follows a landed merge. If this ever starts
     refusing, that is a behavior change worth noticing. */
  it("still finalizes a proven-merged card whose dependency is unresolved, by design", async () => {
    const wf = await seedWorkflow(DEFAULT_VOCAB, "deps");
    await seedProvenMergedTask("FN-SG-BLOCKER", DEFAULT_VOCAB, wf);
    await seedProvenMergedTask("FN-SG-DEPENDENT", DEFAULT_VOCAB, wf, {
      blockedBy: "FN-SG-BLOCKER is not finished",
    });

    const result = await finalize("FN-SG-DEPENDENT");

    expect(result.outcome).toBe("done");
    expect(await persistedColumn("FN-SG-DEPENDENT")).toBe(DEFAULT_VOCAB.complete);
  });

  /* ── Safeguard 6 — at-most-once, through a real store ─────────────────────────
     The second finalize of the same card must classify as already-done rather than
     performing a second move. Distinguished by the persisted column being the
     complete column both times AND the second outcome not being a fresh move. */
  it("finalizes once and classifies the repeat as already-done", async () => {
    const wf = await seedWorkflow(DEFAULT_VOCAB, "once");
    await seedProvenMergedTask("FN-SG-ONCE", DEFAULT_VOCAB, wf);

    const first = await finalize("FN-SG-ONCE");
    expect(first.outcome).not.toBe("blocked");
    expect(await persistedColumn("FN-SG-ONCE")).toBe(DEFAULT_VOCAB.complete);

    const second = await finalize("FN-SG-ONCE");
    expect(second.outcome).toBe("already-done");
    // Still exactly where the first finalize left it.
    expect(await persistedColumn("FN-SG-ONCE")).toBe(DEFAULT_VOCAB.complete);
  });

  /* ── Safeguard 1 — pause: MEASURED, and it mutates a user-paused card ─────────
     Both cases below were written as open questions and answered by running them.
     The answer for BOTH `paused` and `userPaused` is: the card is moved to the
     complete column.

     For `paused` that is the documented design — auto-merge-finalization.ts:243
     evaluates hard blockers with `paused: false` precisely because `mergeConfirmed`
     means the branch already landed, and leaving a merged card in review misreports
     the repository.

     For `userPaused` it is worth a second look, and I am flagging rather than
     changing it. The pause invariant re-ratified in #2486 is "never MUTATE lifecycle
     state of a user-paused card"; this seam does. The mitigating argument is the same
     one — the merge is already durable, so the mutation is bookkeeping that reflects
     reality rather than new work, and refusing it would leave an operator's paused
     card permanently misfiled in review.

     Either reading may be right. What is not acceptable is that it was UNTESTED and
     therefore unnoticed: these assertions make the behavior explicit, so tightening
     it becomes a decision instead of a discovery. Resolving it belongs to whoever
     owns the pause contract. */
  it("moves a PAUSED proven-merged card to complete (documented recovery exception)", async () => {
    const wf = await seedWorkflow(DEFAULT_VOCAB, "paused");
    await seedProvenMergedTask("FN-SG-PAUSED", DEFAULT_VOCAB, wf, { paused: true });

    const result = await finalize("FN-SG-PAUSED");

    expect(result.outcome).toBe("done");
    expect(await persistedColumn("FN-SG-PAUSED")).toBe(DEFAULT_VOCAB.complete);
  });

  it("ALSO moves a USER-paused proven-merged card to complete — flagged, see comment", async () => {
    const wf = await seedWorkflow(DEFAULT_VOCAB, "userpaused");
    await seedProvenMergedTask("FN-SG-USERPAUSED", DEFAULT_VOCAB, wf);
    /*
    FNXC:MergeSafeguards 2026-07-29-21:40 (#2615 review — greptile P1 was CORRECT):
    `userPaused` must be set through `store.pauseTask(..., { userPaused: true })`, the
    supported writer. Passing it in an `updateTask` patch does NOT persist — measured:
    the row read back as `{ userPaused: undefined, paused: true }`, so the original
    version of this case was a silent duplicate of the plain-pause case above and would
    have stayed green even if user-paused cards were genuinely refused.

    I had "verified" the field was writable by finding it in a column list at
    task-mutation-ops.ts:48 — which is a SELECT projection, i.e. what is READ, not what
    may be written. Reading the list was not evidence; running it was.
    */
    await h.store().pauseTask("FN-SG-USERPAUSED", true, undefined, { userPaused: true });

    /*
    FNXC:MergeSafeguards 2026-07-29-21:30 (#2615 review — greptile P1):
    PROVE THE FIXTURE TOOK. The review flagged that if `updateTask` dropped
    `userPaused` as an unsupported field, this case would silently degrade into a
    duplicate of the plain-pause case above and stay green even if genuinely
    user-paused cards were refused. `userPaused` IS in updateTask's allowed-field set
    (task-mutation-ops.ts:48), but "I read the allow-list" is not evidence — a fixture
    that cannot prove its own precondition is exactly the failure mode this suite
    exists to remove, so assert the persisted row before acting on it.
    */
    // PROVE THE FIXTURE TOOK before acting on it: a case that cannot establish its own
    // precondition proves nothing about the guard it names.
    h.store().taskCache.delete("FN-SG-USERPAUSED");
    const seeded = await h.store().getTask("FN-SG-USERPAUSED");
    expect({ userPaused: seeded.userPaused, paused: seeded.paused }).toEqual({ userPaused: true, paused: true });

    const result = await finalize("FN-SG-USERPAUSED");

    // If the pause contract is tightened to exclude user pauses, this flips to
    // "blocked" + review, and that is the intended way for this test to fail.
    expect(result.outcome).toBe("done");
    expect(await persistedColumn("FN-SG-USERPAUSED")).toBe(DEFAULT_VOCAB.complete);
  });

  /* ── The rename differential ──────────────────────────────────────────────────
     Same refusal on a board whose ids overlap the legacy enum nowhere: a guard keyed
     on a literal goes silent here, so the refusal proves trait resolution. */
  it("refuses a proofless card on a RENAMED board and never names a legacy column", async () => {
    const wf = await seedWorkflow(RENAMED_VOCAB, "renamed-noproof");
    await seedProvenMergedTask("FN-SG-RENAMED", RENAMED_VOCAB, wf, { mergeDetails: null });

    const result = await finalize("FN-SG-RENAMED");

    expect({ outcome: result.outcome, reason: (result as { reason?: string }).reason })
      .toEqual({ outcome: "blocked", reason: "missing-merge-confirmation" });
    const column = await persistedColumn("FN-SG-RENAMED");
    expect(column).toBe(RENAMED_VOCAB.review);
    expect(["todo", "in-progress", "in-review", "done"]).not.toContain(column);
  });
  /* ── The MERGED board — U11's actual shape ────────────────────────────────────
     Every case above drives a board where intake and hold are SEPARATE columns. The
     operator's real default workflow no longer looks like that: U11 merged them into
     one Planning column (id `todo`, no `triage` at all). A guard that keys on "the
     column that is only a hold" passes on the default AND renamed vocabularies and
     goes wrong only here, which is precisely why this needed its own family rather
     than another row in an existing one.

     Two variants on purpose: MERGED_VOCAB keeps the legacy ids (so a failure is
     attributable to the ROLE merge alone), MERGED_RENAMED_VOCAB moves both variables
     at once (the shape a custom workflow author actually produces). */
  it("finalizes a proven-merged card on a MERGED intake+hold board", async () => {
    const wf = await seedWorkflow(MERGED_VOCAB, "merged", true);
    await seedProvenMergedTask("FN-SG-MERGED", MERGED_VOCAB, wf);

    const result = await finalize("FN-SG-MERGED");

    expect(result.outcome).toBe("done");
    expect(await persistedColumn("FN-SG-MERGED")).toBe(MERGED_VOCAB.complete);
  });

  it("refuses a proofless card on a MERGED board, with the same reason", async () => {
    const wf = await seedWorkflow(MERGED_VOCAB, "merged-noproof", true);
    await seedProvenMergedTask("FN-SG-MERGED-NOPROOF", MERGED_VOCAB, wf, { mergeDetails: null });

    const result = await finalize("FN-SG-MERGED-NOPROOF");

    expect({ outcome: result.outcome, reason: (result as { reason?: string }).reason })
      .toEqual({ outcome: "blocked", reason: "missing-merge-confirmation" });
    expect(await persistedColumn("FN-SG-MERGED-NOPROOF")).toBe(MERGED_VOCAB.review);
  });

  it("finalizes on a board that is BOTH merged and renamed, landing no legacy id", async () => {
    const wf = await seedWorkflow(MERGED_RENAMED_VOCAB, "merged-renamed", true);
    await seedProvenMergedTask("FN-SG-MR", MERGED_RENAMED_VOCAB, wf);

    const result = await finalize("FN-SG-MR");

    expect(result.outcome).toBe("done");
    const column = await persistedColumn("FN-SG-MR");
    expect(column).toBe(MERGED_RENAMED_VOCAB.complete);
    expect(["todo", "triage", "in-progress", "in-review", "done"]).not.toContain(column);
  });

  it("at-most-once holds on a merged+renamed board too", async () => {
    const wf = await seedWorkflow(MERGED_RENAMED_VOCAB, "merged-once", true);
    await seedProvenMergedTask("FN-SG-MR-ONCE", MERGED_RENAMED_VOCAB, wf);

    expect((await finalize("FN-SG-MR-ONCE")).outcome).toBe("done");
    expect((await finalize("FN-SG-MR-ONCE")).outcome).toBe("already-done");
    expect(await persistedColumn("FN-SG-MR-ONCE")).toBe(MERGED_RENAMED_VOCAB.complete);
  });

});
