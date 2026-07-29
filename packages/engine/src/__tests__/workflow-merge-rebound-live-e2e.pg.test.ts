/*
FNXC:WorkflowLifecycleColumns 2026-07-29-10:40 (E2E — the LIVE merge-rebound resolver):

`merger-ai.ts` is the live merge path (`runAiMerge` / `landWorkspaceTask` are what
project-engine imports). `resolveFinalizeReboundColumn` decides where a card goes
when finalization has to put it back — the failure branch of a merge, reached four
times in `runAiMerge` and once in `landWorkspaceTask`.

WHY THIS IS HERE AND NOT BEHIND THE REAL-GIT LANE. The ledger listed the whole merge
family as needing a real worktree, branch and squash. Re-checked with the lens that
already freed auto-merge-finalization and both self-healing rebounds:
`resolveFinalizeReboundColumn` is EXPORTED and takes `(store, taskId)`. It touches no
git at all. Its callers need git; it does not — and it is the part that carries the
column vocabulary.

OBSERVABILITY, labelled honestly: this resolver RETURNS a column, it does not move a
card, so this is returned-decision evidence rather than persisted-row evidence. It
proves the renamed board's rebound column is resolved correctly through a real store
and a real persisted workflow; it does NOT prove a card lands there, because reaching
that requires the merge failure branch and therefore the lane. Recorded that way in
the ledger rather than counted as a full close.
*/
import { beforeAll, beforeEach, afterEach, afterAll, describe, expect, it } from "vitest";
import "@fusion/core"; // registers the built-in column traits

import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../../core/src/__test-utils__/pg-test-harness.js";
import { resolveFinalizeReboundColumn } from "../merger-ai.js";
import { DEFAULT_VOCAB, RENAMED_VOCAB, lifecycleIr, type Vocabulary } from "./_workflow-vocabulary-fixture.js";

pgDescribe("live merge-rebound E2E: where the LIVE merge path puts a card back", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_merge_rebound_e2e",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  async function seedBoundTask(taskId: string, v: Vocabulary, key: string): Promise<void> {
    const store = h.store();
    const created = await store.createWorkflowDefinition({
      name: `Merge rebound ${key}`,
      kind: "workflow",
      ir: lifecycleIr(v, `custom:${key}`),
    } as never);
    await store.createTaskWithReservedId(
      { description: `merge rebound ${taskId}`, column: v.review } as never,
      { taskId, applyDefaultWorkflowSteps: false } as never,
    );
    await store.writeTaskWorkflowSelection(taskId, (created as { id: string }).id, []);
    store.taskCache.delete(taskId);
    // Prove the binding took: an unbound task resolves to the DEFAULT builtin IR and
    // this suite would then pass for a reason unrelated to the renamed workflow.
    const selection = await store.getTaskWorkflowSelectionAsync(taskId);
    expect(selection?.workflowId).toBe((created as { id: string }).id);
  }

  describe.each([
    { label: "RENAMED vocabulary", vocab: RENAMED_VOCAB, key: "renamed" },
    { label: "DEFAULT vocabulary (regression floor)", vocab: DEFAULT_VOCAB, key: "default" },
  ])("$label", ({ vocab, key }) => {
    it("resolves the finalize-rebound column from the card's own workflow", async () => {
      const taskId = `FN-MR-${key}-1`;
      await seedBoundTask(taskId, vocab, `${key}-1`);

      expect(await resolveFinalizeReboundColumn(h.store(), taskId)).toBe(vocab.hold);
    });
  });

  it("falls back to the legacy column for a task with no resolvable workflow", async () => {
    /* The fail-soft half, and it must stay: a merge finalization must never be
       abandoned because a workflow lookup failed. An unknown task id is the cleanest
       way to force the catch without corrupting a row. */
    expect(await resolveFinalizeReboundColumn(h.store(), "FN-DOES-NOT-EXIST")).toBe("todo");
  });

  it("resolves a RENAMED board to a column that board actually declares", async () => {
    /* The differential stated as the invariant that matters: whatever this returns
       must be a column the workflow declares, or the card is rebounded into a lane the
       board does not draw — the strand this program keeps finding. */
    const taskId = "FN-MR-DIFF";
    await seedBoundTask(taskId, RENAMED_VOCAB, "diff");

    const resolved = await resolveFinalizeReboundColumn(h.store(), taskId);

    const declared = new Set(Object.values(RENAMED_VOCAB));
    expect(declared.has(resolved)).toBe(true);
    expect(new Set(Object.values(DEFAULT_VOCAB)).has(resolved)).toBe(false);
  });
});
