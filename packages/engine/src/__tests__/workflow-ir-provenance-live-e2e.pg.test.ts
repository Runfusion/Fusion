/*
FNXC:WorkflowLifecycleColumns 2026-07-31-23:45 (the provenance signal lied about custom workflows):

`resolveWorkflowIrForTaskWithProvenance` exists so a caller can TRUST `source: "selection"`. Its own
note says as much: "a signal that lies is one nobody can build the census conversions on."

It lied for a whole class of workflows. After the marker check it also compared the returned IR's `id`
against the requested workflow id and reported `"default"` when they differed — but
`createWorkflowDefinition` stores an authored IR VERBATIM, so `ir.id` keeps whatever the author wrote
while the store allocates its own `WF-NNN`. Measured before the fix:

    store workflow id = WF-001   stored ir.id = custom:prov
    PROVENANCE source = default  resolved ir.id = custom:prov      <- the CORRECT IR, called a guess

THE CONSEQUENCE IS LIVE, not theoretical. `triage.ts`'s post-U11 intake recovery reads
`source === "selection" ? workflowHasColumn(ir, "triage") : true` and fails closed on `"default"`.
Its comment reasons that declining "costs a deferred recovery that the next sweep retries" — which
holds only if the provenance can ever become `"selection"`. For these workflows it never could, so a
card stranded in `triage` was declined on every sweep forever, not deferred.

WHY DELETING THE CHECK IS SAFE RATHER THAN A LOOSENING. All three ways `resolveWorkflowIrById`
degrades — missing definition, malformed definition, throwing lookup — return an IR branded by
`markFellBack`, and the marker check runs first. The id comparison caught nothing the marker misses,
which the last two cases below pin from the other direction so the deletion cannot silently widen
trust.

The `markFellBack` note already stated the principle the id check violated: "there is no rule over
the returned value that separates them, because the two shapes are genuinely identical. So the
function that KNOWS marks it."

LANE. `.pg.test.ts`, skipped via `pgDescribe` when no PostgreSQL is reachable. Throwaway per-file
database; never port 4040.
*/
import { beforeAll, beforeEach, afterEach, afterAll, expect, it } from "vitest";
import "@fusion/core"; // registers the built-in column traits
import { resolveWorkflowIrForTaskWithProvenance, type TaskStore } from "@fusion/core";

import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../../core/src/__test-utils__/pg-test-harness.js";

import { RENAMED_VOCAB, lifecycleIr } from "./_workflow-vocabulary-fixture.js";

pgDescribe("workflow IR provenance against a live store", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_ir_provenance",
  });

  beforeAll(h.beforeAll);
  afterAll(h.afterAll);
  beforeEach(async () => { await h.beforeEach(); });
  afterEach(async () => { await h.afterEach(); });

  it("REGRESSION — a custom workflow whose IR carries its own id is reported as SELECTION", async () => {
    /*
    The defect, and the shape every authored workflow has: the store allocates `WF-NNN` while the
    stored IR keeps the author's own id. Asserting the id mismatch explicitly, because if
    `createWorkflowDefinition` ever starts rewriting `ir.id` this case would pass for a reason that
    has nothing to do with the fix.
    */
    const store = h.store();
    const created = await store.createWorkflowDefinition({
      name: "Authored board",
      kind: "workflow",
      ir: lifecycleIr(RENAMED_VOCAB, "custom:authored"),
    } as never);
    const workflowId = (created as { id: string }).id;

    const task = await store.createTask({ description: "authored board card" });
    await store.writeTaskWorkflowSelection(task.id, workflowId, []);
    store.taskCache.delete(task.id);

    const resolved = await resolveWorkflowIrForTaskWithProvenance(store, task.id);

    expect((resolved.ir as { id?: string }).id).toBe("custom:authored");
    expect((resolved.ir as { id?: string }).id).not.toBe(workflowId); // the mismatch that misfired
    expect(resolved.source).toBe("selection");
    expect(resolved.workflowId).toBe(workflowId);
  });

  it("the resolved IR really is the task's own board, not the default", async () => {
    /* Provenance is only worth anything if the IR it vouches for is the right one. Without this, a
       resolver that returned the default while reporting "selection" would pass the case above. */
    const store = h.store();
    const created = await store.createWorkflowDefinition({
      name: "Authored board 2",
      kind: "workflow",
      ir: lifecycleIr(RENAMED_VOCAB, "custom:authored-2"),
    } as never);
    const task = await store.createTask({ description: "second card" });
    await store.writeTaskWorkflowSelection(task.id, (created as { id: string }).id, []);
    store.taskCache.delete(task.id);

    const resolved = await resolveWorkflowIrForTaskWithProvenance(store, task.id);
    const columnIds = (resolved.ir as { columns?: { id: string }[] }).columns?.map((c) => c.id) ?? [];

    expect(columnIds).toContain(RENAMED_VOCAB.hold);
    expect(columnIds).not.toContain("in-progress"); // a default-board id this board does not have
  });

  it("a task with NO selection is still reported as default", async () => {
    /* The other direction. Deleting the id check must not turn every answer into "selection". */
    const store = h.store();
    const task = await store.createTask({ description: "no selection" });

    const resolved = await resolveWorkflowIrForTaskWithProvenance(store, task.id);

    expect(resolved.source).toBe("default");
    expect(resolved.workflowId).toBeUndefined();
  });

  it("a selection naming a MISSING definition is still reported as default", async () => {
    /*
    The case the deleted id check was believed to be carrying. It is caught by the `markFellBack`
    brand instead — asserted here so the deletion is proven not to widen trust, rather than argued.
    */
    const store = h.store();
    const task = await store.createTask({ description: "dangling selection" });
    await store.writeTaskWorkflowSelection(task.id, "WF-999-does-not-exist" as never, []);
    store.taskCache.delete(task.id);

    const resolved = await resolveWorkflowIrForTaskWithProvenance(store, task.id);

    expect(resolved.source).toBe("default");
  });
});
