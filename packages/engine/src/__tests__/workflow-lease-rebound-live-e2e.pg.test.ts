/*
FNXC:WorkflowLifecycleColumns 2026-07-29-09:20 (E2E — closing the mesh-lease ledger entry):

`mesh-lease-manager.ts` — where a RECOVERED LEASE rebounds to. Its conversion note
records a defect worth reproducing precisely:

    "They were previously two independent `=== "todo"` comparisons that could
     disagree, which is how the audit came to claim a card landed in `todo` when
     the workflow has no such column."

So there are two distinct things to prove, and only one of them is where the card
ends up:

  1. the card actually rebounds to the RENAMED workflow's own rebound column;
  2. the AUDIT reports the column the card actually reached.

(2) is the one that rotted silently. An audit trail that names a column the board
does not have is worse than no audit: it is the thing an operator reads to work out
where a recovered card went, and it was confidently wrong.

DELIBERATELY NOT ASSERTED AS RENAMED: `decisionPath` keeps its legacy
`lease-recovered-to-todo` wording. The code says why — it is a stable discriminator
existing queries and dashboards match on, and renaming it would break them to
describe the same decision. The column actually used travels in `newColumn`. This
suite pins that split so a future "cleanup" cannot quietly rename the discriminator.

No git anywhere in this path; MeshLeaseManager takes a TaskStore.
*/
import { beforeAll, beforeEach, afterEach, afterAll, describe, expect, it } from "vitest";
import "@fusion/core"; // registers the built-in column traits

import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../../core/src/__test-utils__/pg-test-harness.js";
import { MeshLeaseManager } from "../mesh-lease-manager.js";
import { DEFAULT_VOCAB, RENAMED_VOCAB, lifecycleIr, type Vocabulary } from "./_workflow-vocabulary-fixture.js";

pgDescribe("live lease-rebound E2E: where a recovered lease lands, and what the audit says", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_lease_rebound_e2e",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  async function seedWorkflow(v: Vocabulary, key: string): Promise<string> {
    const created = await h.store().createWorkflowDefinition({
      name: `Lease ${key}`,
      kind: "workflow",
      ir: lifecycleIr(v, `custom:${key}`),
    } as never);
    return (created as { id: string }).id;
  }

  /** A card holding a STALE lease: checked out by an owner whose lease was last
   *  renewed long ago and which has no agent row to heartbeat. Written through the
   *  admin client because these are lease-bookkeeping fields the store stamps on its
   *  own terms — and the seed is asserted below, so a silently-dropped write cannot
   *  make the recovery look declined. */
  async function seedStaleLease(taskId: string, v: Vocabulary, workflowId: string): Promise<void> {
    const store = h.store();
    await store.createTaskWithReservedId(
      { description: `lease ${taskId}`, column: v.hold } as never,
      { taskId, applyDefaultWorkflowSteps: false } as never,
    );
    await store.writeTaskWorkflowSelection(taskId, workflowId, []);
    await store.moveTask(taskId, v.wip, { moveSource: "user" } as never);

    const longAgo = new Date(Date.now() - 60 * 60_000).toISOString();
    await h.adminSql()`
      UPDATE project.tasks
      SET checked_out_by = 'agent-gone', checkout_lease_renewed_at = ${longAgo}, checkout_node_id = 'node-gone'
      WHERE id = ${taskId}
    `;
    store.taskCache.delete(taskId);

    const seeded = await store.getTask(taskId);
    expect(seeded.checkedOutBy).toBe("agent-gone");
    expect(seeded.column).toBe(v.wip);
  }

  async function persistedColumn(taskId: string): Promise<string> {
    const store = h.store();
    store.taskCache.delete(taskId);
    return (await store.getTask(taskId)).column as string;
  }

  describe.each([
    { label: "RENAMED vocabulary", vocab: RENAMED_VOCAB, key: "renamed" },
    { label: "DEFAULT vocabulary (regression floor)", vocab: DEFAULT_VOCAB, key: "default" },
  ])("$label", ({ vocab, key }) => {
    it("rebounds a recovered lease to the workflow's own rebound column", async () => {
      const taskId = `FN-LR-${key}-1`;
      const workflowId = await seedWorkflow(vocab, `${key}-1`);
      await seedStaleLease(taskId, vocab, workflowId);

      const manager = new MeshLeaseManager({ taskStore: h.store() });
      const recovered = await manager.recoverAbandonedLease(taskId, "e2e-stale-lease");

      expect(recovered).toBe(true);
      expect(await persistedColumn(taskId)).toBe(vocab.hold);
      // The lease itself is released, not merely the column changed.
      h.store().taskCache.delete(taskId);
      expect((await h.store().getTask(taskId)).checkedOutBy ?? null).toBeNull();
    });

    it("reports the column the card ACTUALLY reached in the unreachable-owner audit", async () => {
      /* The defect the conversion note describes. Two independent `=== "todo"`
         comparisons could disagree, so the audit named a column the card never
         reached — and on a renamed board, one the workflow does not even declare. */
      const taskId = `FN-LR-${key}-2`;
      const workflowId = await seedWorkflow(vocab, `${key}-2`);
      await seedStaleLease(taskId, vocab, workflowId);

      const manager = new MeshLeaseManager({
        taskStore: h.store(),
        // Forces the unreachable-owner branch, which is the one that emits this audit.
        nodeHealthMonitor: { getNodeHealth: () => "offline" } as never,
      });
      await manager.recoverAbandonedLease(taskId, "e2e-owner-offline");

      const audit = await h.store().getRunAuditEventsAsync({ taskId });
      const recovery = audit.find((e) => String(e.mutationType).includes("unreachable"));
      expect(recovery, `no unreachable-owner audit; saw ${JSON.stringify(audit.map((e) => e.mutationType))}`).toBeDefined();
      const metadata = (typeof recovery?.metadata === "string" ? JSON.parse(recovery.metadata) : recovery?.metadata) as
        | Record<string, unknown>
        | undefined;

      expect(metadata?.newColumn).toBe(vocab.hold);
      expect(metadata?.newColumn).toBe(await persistedColumn(taskId));
    });
  });

  it("keeps the legacy `decisionPath` discriminator even on a renamed board", async () => {
    /* Pinned deliberately. `decisionPath` is a stable audit discriminator that existing
       queries and dashboards match on; the code keeps the legacy wording on purpose and
       carries the real column in `newColumn`. Asserting it here stops a future
       vocabulary "cleanup" from renaming a field that is not a column at all. */
    const taskId = "FN-LR-PATH";
    const workflowId = await seedWorkflow(RENAMED_VOCAB, "path");
    await seedStaleLease(taskId, RENAMED_VOCAB, workflowId);

    const manager = new MeshLeaseManager({
      taskStore: h.store(),
      nodeHealthMonitor: { getNodeHealth: () => "offline" } as never,
    });
    await manager.recoverAbandonedLease(taskId, "e2e-decision-path");

    const audit = await h.store().getRunAuditEventsAsync({ taskId });
    const recovery = audit.find((e) => String(e.mutationType).includes("unreachable"));
    const metadata = (typeof recovery?.metadata === "string" ? JSON.parse(recovery.metadata) : recovery?.metadata) as
      | Record<string, unknown>
      | undefined;

    // The card moved wip -> backlog, so this is the "not in place" discriminator...
    expect(metadata?.decisionPath).toBe("lease-recovered-to-todo");
    // ...while the column it actually reached is the renamed one.
    expect(metadata?.newColumn).toBe(RENAMED_VOCAB.hold);
  });

  it("does NOT recover a lease that is still fresh", async () => {
    /* The negative half: "rebound anything with a checkout" would tear live work off
       its owner. A lease renewed just now is not recoverable at all. */
    const taskId = "FN-LR-FRESH";
    const workflowId = await seedWorkflow(RENAMED_VOCAB, "fresh");
    const store = h.store();
    await store.createTaskWithReservedId(
      { description: "fresh lease", column: RENAMED_VOCAB.hold } as never,
      { taskId, applyDefaultWorkflowSteps: false } as never,
    );
    await store.writeTaskWorkflowSelection(taskId, workflowId, []);
    await store.moveTask(taskId, RENAMED_VOCAB.wip, { moveSource: "user" } as never);
    await h.adminSql()`
      UPDATE project.tasks
      SET checked_out_by = 'agent-live', checkout_lease_renewed_at = ${new Date().toISOString()}
      WHERE id = ${taskId}
    `;
    store.taskCache.delete(taskId);
    /*
    GUARD THE SEED (PR #2539 review). Without this the case passes for the wrong reason:
    a no-op UPDATE leaves the card with no `checkedOutBy`, `isLeaseRecoverable` returns
    `no_lease`, recovery declines, and the assertion below is satisfied — while proving
    nothing about lease FRESHNESS, which is the only thing this case exists to check.
    The sibling `seedStaleLease` already asserts its seed; this inline one did not, which
    is the same one-of-two omission this suite's own findings keep turning up.
    */
    const seeded = await store.getTask(taskId);
    expect(seeded.checkedOutBy).toBe("agent-live");

    const manager = new MeshLeaseManager({ taskStore: store });
    /* Assert the REASON, not merely the refusal: `no_lease` and a fresh lease both
       return false, and only one of them is this test's subject. */
    const verdict = await manager.isLeaseRecoverable(seeded);
    expect(verdict.reason).not.toBe("no_lease");
    expect(verdict.recoverable).toBe(false);

    const recovered = await manager.recoverAbandonedLease(taskId, "e2e-fresh");

    expect(recovered).toBe(false);
    expect(await persistedColumn(taskId)).toBe(RENAMED_VOCAB.wip);
  });
});
