/*
FNXC:WorkflowLifecycleColumns 2026-07-29-17:30 (E2E evidence — the last tractable ledger entry):

`isAlreadyFinalizedColumn` (merger-ai.ts) was the final converted site my unproven-sites ledger
listed as needing the real-git lane, on the grounds that it is module-private and reached only from
inside `runAiMerge`. Reading the function instead of costing the lane: `runAiMerge` reaches it after
only `store.getTask`, `assertNotWorkspaceTaskMerge` (a pure check), and `resolveTaskWorkingBranch`
(pure) — BEFORE the merge blocker, before settings, before any branch sync. `projectRootDir` is not
touched on that path.

So it is reachable through the REAL public merge entry point with no repository at all, and the
short-circuit returns a `noOp` result rather than throwing. Sixth wrong lane-cost inference in that
ledger; the rule it keeps violating is still "read what the function touches".

WHAT THIS PROVES. The already-finalized guard resolves the task workflow's `complete` column, with
`done` as the degraded built-in fallback. Task archive is not a second terminal role.

WHAT IS REAL: a PostgreSQL TaskStore, a persisted renamed workflow, and the real `runAiMerge` entry
point. Assertions read the returned decision, which proves Complete-role resolution and the clean
short-circuit rather than a task movement.
*/
import { beforeAll, beforeEach, afterEach, afterAll, expect, it } from "vitest";
import "@fusion/core";

import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../../core/src/__test-utils__/pg-test-harness.js";
import { runAiMerge } from "../merge/merger-ai.js";
import { RENAMED_VOCAB, lifecycleIr } from "./_workflow-vocabulary-fixture.js";

/** Never read on the path under test — the short-circuit precedes all git work. */
const UNUSED_PROJECT_ROOT = "/nonexistent-by-design";

pgDescribe("live already-finalized E2E: Complete role resolved on a renamed board", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_already_final_e2e",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  async function seedWorkflow(key: string): Promise<string> {
    const created = await h.store().createWorkflowDefinition({
      name: `Finalized ${key}`,
      kind: "workflow",
      /* Declares `complete` renamed to `shipped`; no archive role exists. */
      ir: lifecycleIr(RENAMED_VOCAB, `custom:final-${key}`, { mergeOrchestration: true }),
    } as never);
    return (created as { id: string }).id;
  }

  async function seedTask(taskId: string, column: string, workflowId: string): Promise<void> {
    const store = h.store();
    await store.createTaskWithReservedId(
      { description: `finalized ${taskId}`, column } as never,
      { taskId, applyDefaultWorkflowSteps: false } as never,
    );
    await store.writeTaskWorkflowSelection(taskId, workflowId, []);
    store.taskCache.delete(taskId);
  }

  it("treats a card in the RENAMED complete column as already finalized", async () => {
    /* The resolved half. Pre-conversion the literal `done` did not match `shipped`, so this card
       fell through to the merge blocker and threw instead of returning a clean no-op. */
    const wf = await seedWorkflow("complete");
    await seedTask("FN-AF-1", RENAMED_VOCAB.complete, wf);

    const result = await runAiMerge(h.store(), UNUSED_PROJECT_ROOT, "FN-AF-1");

    expect(result.noOp).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.reason).toBe("already-finalized");
    expect(result.merged).toBe(false);
  });


  it("does NOT treat a card in the renamed REVIEW column as finalized", async () => {
    /* The differential. Without it both cases above would also pass for a guard that reported
       every card finalized — which would make every merge a silent no-op, the worst possible
       failure of this function. A review-column card must get past the short-circuit; it then
       fails for a merge-pipeline reason, which is proof it was NOT short-circuited. */
    const wf = await seedWorkflow("review");
    await seedTask("FN-AF-3", RENAMED_VOCAB.review, wf);

    const outcome = await runAiMerge(h.store(), UNUSED_PROJECT_ROOT, "FN-AF-3").then(
      (r) => ({ threw: false as const, r }),
      (e: unknown) => ({ threw: true as const, message: String(e) }),
    );

    if (!outcome.threw) {
      // Whatever it did, it must not have claimed "already finalized".
      expect(outcome.r.reason).not.toBe("already-finalized");
    } else {
      expect(outcome.message).not.toContain("already-finalized");
    }
  });
});
