/*
FNXC:WorkflowLifecycleColumns 2026-07-29-11:30 (E2E — the already-finalized short circuit):

`runAiMerge` is THE merge path (chokepoint U0), and the first thing it does after
reading the task — explicitly "BEFORE any git work" — is ask whether the card is
already in a terminal column of its OWN workflow. Its conversion note names the bug:

    "Under a renamed workflow the literal `done`/`archived` pair stopped matching,
     and the already-finalized card fell through to `getTaskMergeBlocker` — which
     threw 'task is in shipped, must be in in-review' for a task whose real state
     was 'already done, nothing to do'."

So the failure is not a silent one for once — it THROWS, on a card that needed
nothing done. That makes the observable difference unusually crisp: correct behaviour
returns a clean no-op; the broken behaviour raises an error naming a column the
operator never asked about.

FOURTH TIME THE "NEEDS REAL GIT" INFERENCE WAS WRONG. The ledger had this behind the
real-git lane because it lives in the merge family. The short circuit returns before
any git work, so a real store and a real persisted workflow are the whole harness.

THE PER-ROLE FALLBACK IS THE SUBTLE HALF (PR #2471 review, P1). The terminal pair is
resolved per ROLE, not per set: a workflow that declares `complete` but no `archived`
must keep the legacy `archived` id for the half it did not declare. The shared
vocabulary fixture is exactly that shape — it declares a complete column and no
archived one — so both directions are exercised here rather than assumed.
*/
import { beforeAll, beforeEach, afterEach, afterAll, describe, expect, it } from "vitest";
import "@fusion/core"; // registers the built-in column traits

import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../../core/src/__test-utils__/pg-test-harness.js";
import { runAiMerge } from "../merger-ai.js";
import { DEFAULT_VOCAB, RENAMED_VOCAB, lifecycleIr, type Vocabulary } from "./_workflow-vocabulary-fixture.js";

pgDescribe("live already-finalized E2E: the merge chokepoint's terminal short circuit", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_already_finalized_e2e",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  /** Seed a card and park it directly in `column`. Written through the admin client
   *  because `archived` is not a lane the transition policy will walk a card into, and
   *  the point here is the state a finished card is already in. The seed is asserted. */
  async function seedAt(taskId: string, v: Vocabulary, key: string, column: string): Promise<void> {
    const store = h.store();
    const created = await store.createWorkflowDefinition({
      name: `Already finalized ${key}`,
      kind: "workflow",
      ir: lifecycleIr(v, `custom:${key}`),
    } as never);
    await store.createTaskWithReservedId(
      { description: `finalized ${taskId}`, column: v.hold } as never,
      { taskId, applyDefaultWorkflowSteps: false } as never,
    );
    await store.writeTaskWorkflowSelection(taskId, (created as { id: string }).id, []);
    await h.adminSql()`UPDATE project.tasks SET "column" = ${column} WHERE id = ${taskId}`;
    store.taskCache.delete(taskId);
    const seeded = await store.getTask(taskId);
    expect(seeded.column).toBe(column);
    expect((await store.getTaskWorkflowSelectionAsync(taskId))?.workflowId).toBe((created as { id: string }).id);
  }

  /** Run the real chokepoint. `projectRootDir` is the harness temp dir and is never
   *  touched: the short circuit returns before any git work, which is the whole reason
   *  this suite does not need a repository. */
  async function merge(taskId: string) {
    return runAiMerge(h.store(), h.rootDir(), taskId);
  }

  describe.each([
    { label: "RENAMED vocabulary", vocab: RENAMED_VOCAB, key: "renamed" },
    { label: "DEFAULT vocabulary (regression floor)", vocab: DEFAULT_VOCAB, key: "default" },
  ])("$label", ({ vocab, key }) => {
    it("short-circuits a card already in the workflow's COMPLETE column", async () => {
      const taskId = `FN-AF-${key}-1`;
      await seedAt(taskId, vocab, `${key}-1`, vocab.complete);

      const result = await merge(taskId);

      expect(result.noOp).toBe(true);
      expect(result.reason).toBe("already-finalized");
      expect(result.ok).toBe(true);
    });

    it("short-circuits a card in `archived` even though the workflow never declares it", async () => {
      /* The per-role fallback. This fixture declares a complete column and NO archived
         one, so `lifecycle.archived` is undefined and the guard must keep the legacy
         `archived` id for that half alone. A per-SET fallback — replacing the whole
         pair as soon as any role resolves — collapses to one element and silently
         drops this short circuit, which is the P1 the review caught. */
      const taskId = `FN-AF-${key}-2`;
      await seedAt(taskId, vocab, `${key}-2`, "archived");

      const result = await merge(taskId);

      expect(result.noOp).toBe(true);
      expect(result.reason).toBe("already-finalized");
    });
  });

  it("does NOT short-circuit a card still in the review lane", async () => {
    /* The negative half. "Treat anything that looks terminal as done" would make the
       chokepoint silently skip real merges. A review-lane card must get past this
       guard — it then fails for its own reasons (no branch/worktree here), which is a
       DIFFERENT outcome from the clean no-op and is what this asserts. */
    const taskId = "FN-AF-REVIEW";
    await seedAt(taskId, RENAMED_VOCAB, "review", RENAMED_VOCAB.review);

    const outcome = await merge(taskId).then(
      (r) => ({ kind: "resolved" as const, reason: r.reason }),
      (e: unknown) => ({ kind: "threw" as const, reason: e instanceof Error ? e.message : String(e) }),
    );

    expect(outcome.reason).not.toBe("already-finalized");
  });

  it("throws NOTHING for a finalized renamed card — the regression this guard exists for", async () => {
    /* Stated as its own case because the pre-conversion symptom was an ERROR, not a
       wrong column: "task is in 'shipped', must be in 'in-review'". Asserting the
       absence of that throw is the clearest statement of what was fixed. */
    const taskId = "FN-AF-NOTHROW";
    await seedAt(taskId, RENAMED_VOCAB, "nothrow", RENAMED_VOCAB.complete);

    await expect(merge(taskId)).resolves.toMatchObject({ noOp: true, reason: "already-finalized" });
  });
});
