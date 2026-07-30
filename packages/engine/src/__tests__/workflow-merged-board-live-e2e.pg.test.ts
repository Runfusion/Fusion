/*
FNXC:WorkflowLifecycleColumns 2026-07-30-16:30 (E2E evidence — the MERGED board):

THE BOARD THE PROGRAM ACTUALLY SHIPPED, and the one no E2E family covered.

Every suite in this directory proves the RENAMED case: a board whose column ids differ from
the legacy enum. U11 shipped something structurally different — it merged Todo into Planning,
so on the default lineage ONE column carries BOTH the intake and hold traits and the id
`triage` no longer exists.

A renamed differential cannot see that, because renamed boards still have two separate
columns. The merged shape breaks a distinct class of guard:

  - "is this card in intake but NOT in hold" is UNSATISFIABLE — one column, both traits;
  - a hold -> intake release is a SELF-MOVE, which a move guard may reject or loop on;
  - `intake && column !== "triage"` inverts from sometimes-true to ALWAYS-true, so an
    affordance gated on it appears everywhere instead of nowhere.

The first and third are silent. The second is the interesting one, because it is the shape
that produces a loop rather than a no-op.

WHAT IS REAL: a PostgreSQL TaskStore, a real persisted workflow whose hold column carries both
traits, the real capacity release sweep, and the real graph column boundary. Assertions read
the persisted row.
*/
import { beforeAll, beforeEach, afterEach, afterAll, describe, expect, it } from "vitest";
import "@fusion/core";
import { resolveLifecycleColumns, resolveWorkflowIrForTask } from "@fusion/core";

import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../../core/src/__test-utils__/pg-test-harness.js";
import { runHoldReleaseSweep } from "../hold-release.js";
import { MERGED_VOCAB, RENAMED_VOCAB, lifecycleIr } from "./_workflow-vocabulary-fixture.js";
import { seedPlannedSpec } from "./_planned-spec-fixture.js";

pgDescribe("live MERGED-board E2E: one column carrying both intake and hold", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_merged_board_e2e",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  /** A workflow whose planning lane carries BOTH intake and hold — the U11 shape. */
  async function seedMergedWorkflow(key: string): Promise<string> {
    const created = await h.store().createWorkflowDefinition({
      name: `Merged ${key}`,
      kind: "workflow",
      ir: lifecycleIr(MERGED_VOCAB, `custom:merged-${key}`, { mergedIntakeAndHold: true }),
    } as never);
    return (created as { id: string }).id;
  }

  async function seedTask(taskId: string, column: string, workflowId: string): Promise<void> {
    const store = h.store();
    await store.createTaskWithReservedId(
      { description: `merged ${taskId}`, column } as never,
      { taskId, applyDefaultWorkflowSteps: false } as never,
    );
    await store.writeTaskWorkflowSelection(taskId, workflowId, []);
    /*
    FNXC:WorkflowLifecycleColumns 2026-07-30-12:05 (release-leg fixture):
    On a MERGED board the hold lane IS the intake lane, so EVERY card seeded here is subject to
    FN-7648's planned-spec gate. Rationale, the retracted #2613 escalation, and the self-check
    live in `_planned-spec-fixture.ts`.
    */
    seedPlannedSpec(store as never as { getTasksDir(): string }, taskId);
    store.taskCache.delete(taskId);
  }

  async function persistedColumn(taskId: string): Promise<string> {
    const store = h.store();
    store.taskCache.delete(taskId);
    return (await store.getTask(taskId)).column as string;
  }

  it("resolves intake and hold to the SAME column — the premise every other assertion rests on", async () => {
    /* Asserted rather than assumed: if the fixture emitted two columns, every case below would
       silently degrade into the renamed case that other suites already cover. */
    const wf = await seedMergedWorkflow("premise");
    await seedTask("FN-MB-0", MERGED_VOCAB.hold, wf);

    const lifecycle = resolveLifecycleColumns(await resolveWorkflowIrForTask(h.store(), "FN-MB-0"));

    expect(lifecycle?.intake).toBe(MERGED_VOCAB.hold);
    expect(lifecycle?.hold).toBe(MERGED_VOCAB.hold);
    // ...and the legacy `triage` id is genuinely absent from this board.
    expect(lifecycle?.intake).not.toBe("triage");
  });

  it("releases a card out of the merged lane on capacity — the release is not a self-move", async () => {
    /* The shape that loops rather than no-ops. The scheduler releases hold -> wip; on a merged
       board the SOURCE column is also intake, so a sweep that reasons "intake cards are not
       ready" would hold forever, and one that moves hold -> intake would move a card to where
       it already is and re-fire every poll. */
    const wf = await seedMergedWorkflow("release");
    await seedTask("FN-MB-1", MERGED_VOCAB.hold, wf);

    const sweep = await runHoldReleaseSweep(h.store(), { now: () => Date.now() });

    expect(sweep.released).toContain("FN-MB-1");
    expect(await persistedColumn("FN-MB-1")).toBe(MERGED_VOCAB.wip);
    // The card LEFT the merged lane; it did not land back on itself.
    expect(await persistedColumn("FN-MB-1")).not.toBe(MERGED_VOCAB.hold);
  });

  it("does not re-release a card that already left the merged lane (no repeat firing)", async () => {
    /* The loop check. A self-move or an unsatisfiable predicate shows up as the same card being
       released on every sweep, which a single-pass test cannot see. */
    const wf = await seedMergedWorkflow("norepeat");
    await seedTask("FN-MB-2", MERGED_VOCAB.hold, wf);

    await runHoldReleaseSweep(h.store(), { now: () => Date.now() });
    const second = await runHoldReleaseSweep(h.store(), { now: () => Date.now() });

    expect(second.released).not.toContain("FN-MB-2");
    expect(await persistedColumn("FN-MB-2")).toBe(MERGED_VOCAB.wip);
  });

  it("holds a merged-lane card when capacity is exhausted, rather than looping", async () => {
    /* The negative half: the merged lane must still be a genuine hold. With the wip slot taken
       the card stays put and is reported held — not released, not moved onto itself. */
    const store = h.store();
    await store.updateSettings({ maxConcurrent: 1 } as never);
    const wf = await seedMergedWorkflow("capacity");
    await seedTask("FN-MB-3", MERGED_VOCAB.wip, wf);
    await seedTask("FN-MB-4", MERGED_VOCAB.hold, wf);

    const sweep = await runHoldReleaseSweep(store, { now: () => Date.now() });

    expect(sweep.released).not.toContain("FN-MB-4");
    expect(await persistedColumn("FN-MB-4")).toBe(MERGED_VOCAB.hold);
  });

  it("a RENAMED board with separate lanes still behaves — the two shapes are not the same test", async () => {
    /* The differential that justifies a third vocabulary: this board has intake and hold as
       DISTINCT columns, so it exercises the two-place assumption the merged cases cannot. */
    const created = await h.store().createWorkflowDefinition({
      name: "Renamed separate",
      kind: "workflow",
      ir: lifecycleIr(RENAMED_VOCAB, "custom:renamed-separate"),
    } as never);
    await seedTask("FN-MB-5", RENAMED_VOCAB.hold, (created as { id: string }).id);

    const lifecycle = resolveLifecycleColumns(await resolveWorkflowIrForTask(h.store(), "FN-MB-5"));
    /*
    FNXC:WorkflowLifecycleColumns 2026-07-29-16:00 (strengthened — this was vacuous):
    `expect(intake).not.toBe(hold)` alone passes when `intake` is `undefined`, which is exactly
    what this fixture produced before it declared a separate intake lane. So the assertion that
    was supposed to prove "two distinct lanes" would have passed against a resolver that never
    resolved intake at all.

    Asserting the id positively is what makes it bite: intake must be DEFINED, must be the lane
    the vocabulary declares, and must differ from hold. Confirmed by mutation — removing the
    intake lane from the builder now fails here, where before it stayed green.
    */
    expect(lifecycle?.hold).toBe(RENAMED_VOCAB.hold);
    expect(lifecycle?.intake).toBe(RENAMED_VOCAB.intake);
    expect(lifecycle?.intake).not.toBeUndefined();
    expect(lifecycle?.intake).not.toBe(lifecycle?.hold);

    const sweep = await runHoldReleaseSweep(h.store(), { now: () => Date.now() });
    expect(sweep.released).toContain("FN-MB-5");
    expect(await persistedColumn("FN-MB-5")).toBe(RENAMED_VOCAB.wip);
  });
});
