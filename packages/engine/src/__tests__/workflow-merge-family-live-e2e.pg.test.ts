/*
FNXC:WorkflowMergeFinalization 2026-07-28-11:40 (E2E — closing merge-family ledger entries):

WHAT THIS CLOSES. The unproven-sites ledger in workflow-lifecycle-live-e2e says the
merge/rebound family "needs a REAL git worktree, branch, and squash … an engine-slow
real-git lane, not another table row". That is true of the MERGER, but it turned out
to be too broad: `finalizeProvenAutoMergeTask` is the step that actually moves a
proven-merged card to the workflow's COMPLETE column, it takes a real `TaskStore`,
and it needs no git at all — the merge proof is a field on the row. So three ledger
entries are reachable today without building that lane:

    auto-merge-finalization.ts  resolveCompleteColumn        -> the card's destination
    auto-merge-finalization.ts  resolveMergeOrchestrationColumn -> the pre-complete lane
    auto-merge-finalization.ts  columnHasFlag(ir, col, "complete") -> the already-done classifier

WHY IT MATTERS MORE THAN ITS SIZE. This is the last move a card makes. If
`resolveCompleteColumn` silently returned the literal `done` for a workflow whose
complete column is `shipped`, a proven-merged card would be moved to a column its
own workflow does not declare — or refused and left stranded in review with the work
already landed. That is the most expensive failure shape in the lifecycle, and until
now nothing had run it against a renamed workflow.

SUBSTITUTION BOUNDARY. Only the merge PROOF is seeded (`mergeConfirmed`), which is
what a real merger would have written. Everything downstream — column resolution,
the move, its guards, persistence — is real, and every assertion reads the persisted
row back through `getTask`.
*/
import { beforeAll, beforeEach, afterEach, afterAll, describe, expect, it } from "vitest";
import "@fusion/core"; // registers the built-in column traits
import type { MergeResult, TaskStore } from "@fusion/core";

import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../../core/src/__test-utils__/pg-test-harness.js";
import { finalizeProvenAutoMergeTask } from "../auto-merge-finalization.js";
import { DEFAULT_VOCAB, RENAMED_VOCAB, lifecycleIr, type Vocabulary } from "./_workflow-vocabulary-fixture.js";

pgDescribe("live merge finalization E2E: real store, renamed complete column", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_merge_family_e2e",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  /** Persist the workflow and return the id the STORE assigned — it allocates its
   *  own `WF-###` and ignores the one in the input, and binding to the id we passed
   *  in would silently resolve to the DEFAULT builtin IR instead. */
  async function seedWorkflow(v: Vocabulary, key: string): Promise<string> {
    const created = await h.store().createWorkflowDefinition({
      name: `Merge family ${key}`,
      kind: "workflow",
      // `mergeOrchestration` opt-in: the review column carries the `merge` trait,
      // which is the flag `resolveMergeOrchestrationColumn` keys on.
      ir: lifecycleIr(v, `custom:${key}`, { mergeOrchestration: true }),
    } as never);
    return (created as { id: string }).id;
  }

  /** A card resting in the workflow's merge-orchestration column, carrying durable
   *  merge proof — exactly the state a real merger leaves behind. */
  async function seedProvenMergedTask(taskId: string, v: Vocabulary, workflowId: string): Promise<void> {
    const store = h.store();
    await store.createTaskWithReservedId(
      { description: `merged ${taskId}`, column: v.hold } as never,
      { taskId, applyDefaultWorkflowSteps: false } as never,
    );
    await store.writeTaskWorkflowSelection(taskId, workflowId, []);
    // Walk the card into the review lane through the REAL transition policy rather
    // than writing the column directly, so the row is one a real run could produce.
    await store.moveTask(taskId, v.wip, { moveSource: "user" } as never);
    await store.moveTask(taskId, v.review, { moveSource: "user", allowDirectInReviewMove: true } as never);
    /* Steps must be COMPLETE. `getTaskHardMergeBlocker` refuses a card with incomplete
       steps ("task has incomplete steps"), and a genuinely merged card has none
       outstanding. Set explicitly rather than assumed empty: task creation parses
       steps out of the bootstrap PROMPT even with `applyDefaultWorkflowSteps: false`,
       so a freshly created card arrives carrying three pending ones. Discovered by
       this suite blocking on BOTH vocabularies — the signature of a broken fixture
       rather than a broken guard. */
    await store.updateTask(taskId, {
      steps: [{ name: "implementation", status: "done" }],
      mergeDetails: { mergeConfirmed: true },
    } as never);
    store.taskCache.delete(taskId);
  }

  async function persistedColumn(taskId: string): Promise<string> {
    const store = h.store();
    store.taskCache.delete(taskId);
    return (await store.getTask(taskId)).column as string;
  }

  const proof = { mergeConfirmed: true } as unknown as MergeResult;

  async function finalize(taskId: string) {
    return finalizeProvenAutoMergeTask({
      store: h.store() as TaskStore,
      taskId,
      result: proof,
      source: "direct-ai-merge",
    } as never);
  }

  describe.each([
    { label: "RENAMED vocabulary", vocab: RENAMED_VOCAB, key: "renamed" },
    { label: "DEFAULT vocabulary (regression floor)", vocab: DEFAULT_VOCAB, key: "default" },
  ])("$label", ({ vocab, key }) => {
    it("moves a proven-merged card into the workflow's COMPLETE column", async () => {
      const taskId = `FN-MF-${key}-1`;
      const workflowId = await seedWorkflow(vocab, `${key}-1`);
      await seedProvenMergedTask(taskId, vocab, workflowId);

      expect(await persistedColumn(taskId)).toBe(vocab.review);

      const outcome = await finalize(taskId);

      expect({ outcome: outcome.outcome, reason: outcome.reason }).toEqual({ outcome: "done", reason: undefined });
      // Observed state, not the return value: the row actually landed in the
      // workflow's own complete column.
      expect(await persistedColumn(taskId)).toBe(vocab.complete);
      expect(outcome.previousColumn).toBe(vocab.review);
    });

    it("classifies a card ALREADY in the complete column as already-done, not a second move", async () => {
      /* This is `columnHasFlag(ir, col, "complete")`. Keyed on the literal `done`, a
         renamed board's finished card reads as unfinished and finalization tries to
         move it again — the idempotency this classifier provides is what stops a
         retry from re-finalizing. */
      const taskId = `FN-MF-${key}-2`;
      const workflowId = await seedWorkflow(vocab, `${key}-2`);
      await seedProvenMergedTask(taskId, vocab, workflowId);
      await finalize(taskId);
      expect(await persistedColumn(taskId)).toBe(vocab.complete);

      const second = await finalize(taskId);

      expect(second.outcome).toBe("already-done");
      expect(await persistedColumn(taskId)).toBe(vocab.complete);
    });
  });

  it("does NOT record a column-mismatch REPAIR when the card was resting in the merge lane", async () => {
    /*
    This is `resolveMergeOrchestrationColumn`, and it is observable only here.
    `shouldRecoveryRehome = latest.column !== mergeColumn` decides whether
    finalization treats this as a normal completion or as REPAIRING a stranded card:
    the repair branch writes a `task:auto-merge-finalize-column-mismatch-reconciled`
    audit row and a log entry saying the column mismatch was fixed.

    Keyed on the literal `in-review`, a renamed board's card resting in `checking`
    compares unequal, so EVERY ordinary finalization would be recorded as a repair
    of a mismatch that never existed — a healthy board would read as one constantly
    self-healing, and the audit trail that operators use to spot real strandings
    would be full of false positives. The card still reaches `shipped` either way,
    which is exactly why the other cases in this file cannot see it.
    */
    const workflowId = await seedWorkflow(RENAMED_VOCAB, "renamed-lane");
    await seedProvenMergedTask("FN-MF-LANE", RENAMED_VOCAB, workflowId);

    const outcome = await finalize("FN-MF-LANE");

    expect(outcome.outcome).toBe("done");
    expect(await persistedColumn("FN-MF-LANE")).toBe(RENAMED_VOCAB.complete);

    const audit = await h.store().getRunAuditEventsAsync({ taskId: "FN-MF-LANE" });
    const repairs = audit.filter((e) => e.mutationType === "task:auto-merge-finalize-column-mismatch-reconciled");
    expect(repairs).toEqual([]);
  });

  it("never lands a renamed board's card in a legacy column id", async () => {
    /* The differential. Both vocabularies run the identical code path above; this
       asserts the renamed run touched none of the legacy ids, which is the single
       claim the vocabulary conversion rests on. */
    const workflowId = await seedWorkflow(RENAMED_VOCAB, "renamed-diff");
    await seedProvenMergedTask("FN-MF-DIFF", RENAMED_VOCAB, workflowId);

    const outcome = await finalize("FN-MF-DIFF");

    const legacy = new Set(Object.values(DEFAULT_VOCAB));
    expect(outcome.outcome).toBe("done");
    expect(legacy.has(await persistedColumn("FN-MF-DIFF"))).toBe(false);
    expect(legacy.has(outcome.previousColumn as string)).toBe(false);
  });

  it("refuses to finalize a card with NO merge proof, on a renamed board", async () => {
    /* The negative half. "Resolve the complete column per workflow" must not become
       "move anything in the review lane to done" — the proof gate is what keeps an
       unmerged card out of the terminal column. */
    const store = h.store();
    const workflowId = await seedWorkflow(RENAMED_VOCAB, "renamed-noproof");
    await store.createTaskWithReservedId(
      { description: "unproven", column: RENAMED_VOCAB.hold } as never,
      { taskId: "FN-MF-NOPROOF", applyDefaultWorkflowSteps: false } as never,
    );
    await store.writeTaskWorkflowSelection("FN-MF-NOPROOF", workflowId, []);
    await store.moveTask("FN-MF-NOPROOF", RENAMED_VOCAB.wip, { moveSource: "user" } as never);
    await store.moveTask("FN-MF-NOPROOF", RENAMED_VOCAB.review, {
      moveSource: "user",
      allowDirectInReviewMove: true,
    } as never);
    store.taskCache.delete("FN-MF-NOPROOF");

    const outcome = await finalizeProvenAutoMergeTask({
      store: store as TaskStore,
      taskId: "FN-MF-NOPROOF",
      source: "direct-ai-merge",
    } as never);

    expect(outcome.outcome).toBe("blocked");
    expect(outcome.reason).toBe("missing-merge-confirmation");
    expect(await persistedColumn("FN-MF-NOPROOF")).toBe(RENAMED_VOCAB.review);
  });
});
