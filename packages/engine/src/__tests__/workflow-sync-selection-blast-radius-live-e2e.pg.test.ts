/*
FNXC:WorkflowLifecycleColumns 2026-07-31-01:30 (E2E evidence — BOUNDING the inert-sync-resolution class):

Four PRs in this series (#2789 scheduler, #2791 planner lanes, #2792 custom fields, #2793 terminal
node) each proved a site broken because it resolved a task's workflow synchronously. Read together
they invite a conclusion that is FALSE and would be expensive: that every synchronous consumer of the
workflow selection is inert.

Most are not, and this file is the bound. The difference is one line of shape:

    GUARDED (correct)     store.getTaskWorkflowSelectionAsync
                            ? await store.getTaskWorkflowSelectionAsync(id)
                            : store.getTaskWorkflowSelection(id)

    UNGUARDED (inert)     store.resolveTaskWorkflowIrSync(id)

The real PostgreSQL store DOES implement the async reader, so every guarded site takes the async arm
and resolves the card's own workflow. Only the sync IR helper — which has no async arm to fall to —
is stuck with the default. Five call sites use the guarded shape (`workflow-settings-resolver.ts`,
`workflow-ir-resolver.ts`, `executor.ts`, `workflow-graph-task-runner.ts`, `workflow-task-runtime.ts`,
plus `board-workflows.ts` in the dashboard); six use the unguarded one and are the allow-list.

WHY THIS IS WORTH A FILE RATHER THAN A SENTENCE. "The ternary saves them" is an inference from
reading, and the whole point of this program is that reading is what let the class survive. The
guarded sites are the ones a fleet worker would otherwise "fix" — converting a correct site costs
review time, risks behaviour, and produces a diff that looks like progress. This makes the bound
checkable in the same lane as the defects.

It also closes the allow-listed family: of the six unguarded sites, four are now proven broken
end-to-end (the four PRs above), one is legitimately correct (`workflow-task-create-ops.ts` — creation
runs before any selection exists, so the default IR is the right answer), and one is NOT driven here
and is stated as such rather than substituted for: `lifecycle-ops.ts`'s stale-transition-pending
recovery re-runs plugin column-transition hooks against the sync IR, which needs a registered plugin
hook plus a crash-simulated marker to reach. Unproven, deliberately, and named so it is not mistaken
for covered.

OBSERVED STATE. Both readers called on one live store against one persisted workflow, and a real
resolved settings value — not a spy on which arm ran.

LANE. `.pg.test.ts`, skipped via `pgDescribe` when no PostgreSQL is reachable, so the merge gate is
unaffected. Throwaway per-file database; never port 4040.
*/
import { beforeAll, beforeEach, afterEach, afterAll, expect, it } from "vitest";
import "@fusion/core"; // registers the built-in column traits
import { resolveWorkflowIrForTask, type TaskStore } from "@fusion/core";

import { resolveEffectiveSettingsDetailed } from "../../../core/src/workflow-settings-resolver.js";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../../core/src/__test-utils__/pg-test-harness.js";

import { RENAMED_VOCAB, lifecycleIr } from "./_workflow-vocabulary-fixture.js";

/** A declared setting whose default is deliberately not the builtin's, so "9" can only come from
 *  this workflow. */
const MAX_REVISIONS = 9;

pgDescribe("the sync-selection defect class, bounded on a live store", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_sync_bound",
  });

  beforeAll(h.beforeAll);
  afterAll(h.afterAll);
  beforeEach(async () => { await h.beforeEach(); });
  afterEach(async () => { await h.afterEach(); });

  /** A task bound to a renamed workflow that also declares a settings default. */
  async function taskOnCustomWorkflow(store: TaskStore, key: string): Promise<{ taskId: string; workflowId: string }> {
    const ir = {
      ...lifecycleIr(RENAMED_VOCAB, `custom:${key}`),
      settings: [{ id: "planReviewMaxRevisions", name: "Max revisions", type: "number", default: MAX_REVISIONS }],
    };
    const created = await store.createWorkflowDefinition({
      name: `Bound ${key}`,
      kind: "workflow",
      ir,
    } as never);
    const workflowId = (created as { id: string }).id;

    const task = await store.createTask({ description: `bound probe ${key}` });
    await store.writeTaskWorkflowSelection(task.id, workflowId, []);
    store.taskCache.delete(task.id);
    return { taskId: task.id, workflowId };
  }

  it("the store implements BOTH readers, and only the sync one is blind", async () => {
    /*
    The pivot the whole class turns on, stated once at the seam. The sync reader is a cutover stub;
    the async reader is real. Everything else in this file follows from which of the two a call site
    can reach.
    */
    const store = h.store();
    const { taskId, workflowId } = await taskOnCustomWorkflow(store, "wf-readers");

    expect(typeof store.getTaskWorkflowSelectionAsync).toBe("function");
    expect(await store.getTaskWorkflowSelectionAsync(taskId)).toMatchObject({ workflowId });
    expect(store.getTaskWorkflowSelection(taskId)).toBeUndefined();
  });

  it("BOUND — a GUARDED consumer resolves the card's own workflow settings", async () => {
    /*
    `resolveEffectiveSettingsDetailed` is one of the guarded sites: it prefers the async reader and
    only falls to the sync one if the store has none. Against the real store it therefore reads THIS
    workflow's declaration, not the builtin's.

    This is the assertion that makes the bound checkable. If someone "converts" a guarded site and
    this value stops being the workflow's own, the conversion broke something that worked.
    */
    const store = h.store();
    const { taskId } = await taskOnCustomWorkflow(store, "wf-guarded");

    const effective = await resolveEffectiveSettingsDetailed(store as never, { id: taskId } as never);

    expect(effective.effective?.planReviewMaxRevisions).toBe(MAX_REVISIONS);
  });

  it("CHARACTERIZATION — the UNGUARDED sync IR helper still answers with the default board", async () => {
    /*
    The contrast, on the same store and the same task, so the difference is attributable to the call
    shape and nothing else. The async resolver names this workflow's own hold column; the sync helper
    names the builtin's.
    */
    const store = h.store();
    const { taskId } = await taskOnCustomWorkflow(store, "wf-unguarded");

    const asyncIr = await resolveWorkflowIrForTask(store, taskId);
    const syncIr = store.resolveTaskWorkflowIrSync(taskId);

    const asyncColumns = (asyncIr as { columns?: { id: string }[] }).columns?.map((c) => c.id) ?? [];
    const syncColumns = (syncIr as { columns?: { id: string }[] }).columns?.map((c) => c.id) ?? [];

    expect(asyncColumns).toContain(RENAMED_VOCAB.hold);

    /*
    FNXC:WorkflowLifecycleColumns 2026-07-31-04:20 (PR #2794 review — greptile):
    POSITIVE first. `not.toContain(RENAMED_VOCAB.hold)` alone is satisfied by an empty, malformed, or
    entirely unrelated IR — anything that merely lacks `backlog` — so it could stay green while
    establishing nothing about the stated default-board behaviour. Naming the columns the sync helper
    IS expected to return makes the claim "it answered with the DEFAULT board" rather than the much
    weaker "it did not answer with this one".

    `todo` and `in-progress` are the post-U11 default lineage's own ids, asserted here rather than
    imported so this case fails loudly if that lineage changes instead of silently widening.
    */
    expect(syncColumns).toContain("todo");
    expect(syncColumns).toContain("in-progress");
    expect(syncColumns).not.toContain(RENAMED_VOCAB.hold);
  });
});
