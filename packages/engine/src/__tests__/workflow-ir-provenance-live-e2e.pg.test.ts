/*
FNXC:WorkflowLifecycleColumns 2026-08-01-03:20 (provenance: what it may vouch for):

`resolveWorkflowIrForTaskWithProvenance` exists so a caller can TRUST `source: "selection"`. Its own
note says why: "a signal that lies is one nobody can build the census conversions on." Two ways it
could lie, and only one of them was reachable — which is worth writing down, because the first
version of this file asserted the reverse.

REACHABLE, and the defect this suite exists for: an id that LOOKS built-in but is not registered — a
workflow removed between releases, a typo'd selection — took a branch that substituted the default
coding IR WITHOUT branding it as a fallback. Provenance then vouched for it as `"selection"`, handing
a caller the default board's graph under the selected workflow's name.

NOT REACHABLE, though I claimed it was: an id cross-check also ran after the marker check and reported
`"default"` whenever the resolved IR's `id` differed from the requested workflow id. It does misfire —
`createWorkflowDefinition` stores an IR verbatim while minting `WF-NNN` separately, so any IR carrying
an author's id mismatches:

    store workflow id = WF-001   stored ir.id = custom:prov
    PROVENANCE source = default  resolved ir.id = custom:prov      <- the CORRECT IR, called a guess

— but NEITHER `WorkflowIrV1` NOR `WorkflowIrV2` DECLARES AN `id` FIELD. An editor-authored workflow
carries none, `resolvedId` is undefined, and the check passed it as `"selection"`. The mismatch above
comes from this suite's own fixture, which adds an id. So the check was unreliable and redundant, and
removing it is correctness — not the live fix for `triage.ts`'s intake recovery that I first wrote
here. Corrected rather than quietly softened, because an overstated finding is how a narrow cleanup
gets backported as a critical fix.

The remaining cases pin the fallback directions so the deletion cannot silently widen trust.

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

  it("a workflow whose IR carries its own id is reported as SELECTION", async () => {
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

  it("a selection naming an UNREGISTERED BUILTIN id is still reported as default", async () => {
    /*
    FNXC:WorkflowLifecycleColumns 2026-08-01-01:30 (PR #2815 review — greptile P1, and it caught a
    real hole in this change):
    THE FOURTH DEGRADATION PATH. An id that looks builtin but is not registered — a workflow removed
    between releases, a typo'd selection — takes a different branch from the missing-definition case
    below, and that branch substituted the default coding IR WITHOUT branding it. So deleting the id
    cross-check would have turned an unmarked fallback into a reported `source: "selection"`: the
    lying signal this API exists to prevent, through the one door I had not checked.

    The repair brands that substitution at its source. This case is what proves it, and it is the
    reason the deletion is now genuinely safe rather than argued to be.
    */
    const store = h.store();
    const task = await store.createTask({ description: "unregistered builtin" });
    await store.writeTaskWorkflowSelection(task.id, "builtin:no-such-workflow" as never, []);
    store.taskCache.delete(task.id);

    const resolved = await resolveWorkflowIrForTaskWithProvenance(store, task.id);

    expect(resolved.source).toBe("default");
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
