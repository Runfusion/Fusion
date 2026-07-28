import { beforeAll, beforeEach, afterEach, afterAll, it, expect } from "vitest";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../__test-utils__/pg-test-harness.js";

/*
FNXC:WorkflowReviewGates 2026-07-26-16:40:
`task:handoff-invariant-violation` guards the requirement "a card only arrives in `in-review`
through a recognised authority". When it was written, `TaskStore.handoffToReview(...)` was the ONLY
such authority. After the U1 IR-driven lifecycle cutover the workflow GRAPH also owns column
transitions, and moving the pre-merge review gates (`code-review`, `browser-verification`) into the
`in-review` column made the graph cross that boundary on EVERY gate entry — so a fully-provenanced,
legitimate transition emitted a violation audit each time (observed on FN-8596 at 15:19:22).

Invariant asserted here (not just the FN-8596 repro): entry into `in-review` audits a violation for
exactly the movers that lack a recognised authority. Surface enumeration —
 - graph-owned crossing (`workflowMoveSource: "workflow-graph"`, the executor column-boundary shape):
   NO violation, from both `in-progress` (the gate entry) and `todo`-side WIP;
 - graph-owned crossing that re-enters `in-review` after a remediation bounce: still NO violation
   (the FN-8596 report was a repeat crossing, not a first one);
 - operator drag (`moveSource: "user"`, no provenance): violation STILL emitted;
 - engine/self-healing style move (`moveSource: "engine"`, no graph provenance): violation STILL
   emitted — this is the class the invariant was written for and must not be silenced;
 - a foreign `workflowMoveSource` value: violation STILL emitted (only the graph's own literal is
   recognised);
 - explicit `allowDirectInReviewMove: true` opt-out: unchanged, no violation;
 - `handoffToReview(...)`: unchanged — no violation, and it still records `task:handoff`.
*/

const VIOLATION = "task:handoff-invariant-violation";

pgDescribe("in-review entry audit (handoff invariant)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_ir_entry_audit",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  const violationsFor = async (taskId: string): Promise<unknown[]> => {
    const store = h.store();
    return store.getRunAuditEventsAsync({ taskId, mutationType: VIOLATION });
  };

  /** Create a task and park it in `in-progress`, the column the graph's review gates enter from. */
  const seedInProgress = async (description: string): Promise<string> => {
    const store = h.store();
    const task = await store.createTask({ description });
    await store.moveTask(task.id, "todo", { moveSource: "user" });
    await store.moveTask(task.id, "in-progress", { moveSource: "user" });
    return task.id;
  };

  it("does not audit a violation for a graph-owned crossing into in-review", async () => {
    const store = h.store();
    const id = await seedInProgress("graph-owned review-gate entry");

    // Exact option shape emitted by executor.buildColumnBoundaryHooks / onNodeEntry.
    const moved = await store.moveTask(id, "in-review", {
      moveSource: "engine",
      workflowMoveSource: "workflow-graph",
      bypassGuards: true,
      preserveProgress: true,
      workflowMoveMetadata: { fromColumn: "in-progress", nodeId: "browser-verification" },
    });

    expect(moved.column).toBe("in-review");
    expect(await violationsFor(id)).toHaveLength(0);
  });

  it("does not audit a violation when the graph re-enters in-review after a remediation bounce", async () => {
    const store = h.store();
    const id = await seedInProgress("graph re-entry after remediation");

    await store.moveTask(id, "in-review", {
      moveSource: "engine",
      workflowMoveSource: "workflow-graph",
      bypassGuards: true,
      preserveProgress: true,
    });
    // Remediation node re-enters in-progress, then the gate is crossed a second time.
    await store.moveTask(id, "in-progress", {
      moveSource: "engine",
      workflowMoveSource: "workflow-graph",
      bypassGuards: true,
      preserveProgress: true,
    });
    const reentered = await store.moveTask(id, "in-review", {
      moveSource: "engine",
      workflowMoveSource: "workflow-graph",
      bypassGuards: true,
      preserveProgress: true,
    });

    expect(reentered.column).toBe("in-review");
    expect(await violationsFor(id)).toHaveLength(0);
  });

  it("still audits a violation for an operator drag straight into in-review", async () => {
    const store = h.store();
    const id = await seedInProgress("operator drag into review");

    const moved = await store.moveTask(id, "in-review", { moveSource: "user" });

    expect(moved.column).toBe("in-review");
    const violations = await violationsFor(id);
    expect(violations).toHaveLength(1);
    expect((violations[0] as { metadata?: { fromColumn?: string } }).metadata?.fromColumn).toBe("in-progress");
  });

  it("still audits a violation for an engine move with no graph provenance", async () => {
    const store = h.store();
    const id = await seedInProgress("engine move with no provenance");

    await store.moveTask(id, "in-review", { moveSource: "engine", bypassGuards: true });

    expect(await violationsFor(id)).toHaveLength(1);
  });

  it("still audits a violation for a foreign workflowMoveSource", async () => {
    const store = h.store();
    const id = await seedInProgress("foreign workflow move source");

    await store.moveTask(id, "in-review", {
      moveSource: "engine",
      workflowMoveSource: "self-healing-advanced-triage",
      bypassGuards: true,
    });

    expect(await violationsFor(id)).toHaveLength(1);
  });

  it("keeps the explicit allowDirectInReviewMove opt-out silent", async () => {
    const store = h.store();
    const id = await seedInProgress("explicit direct-move opt-out");

    await store.moveTask(id, "in-review", { moveSource: "user", allowDirectInReviewMove: true });

    expect(await violationsFor(id)).toHaveLength(0);
  });

  it("leaves handoffToReview unaffected: no violation, and task:handoff is still recorded", async () => {
    const store = h.store();
    const id = await seedInProgress("handoff to review");

    const handed = await store.handoffToReview(id, {
      ownerAgentId: null,
      evidence: { reason: "fn_task_done", runId: "run-1", agentId: "agent-1" },
    });

    expect(handed.column).toBe("in-review");
    expect(await violationsFor(id)).toHaveLength(0);
    expect(await store.getRunAuditEventsAsync({ taskId: id, mutationType: "task:handoff" })).toHaveLength(1);
  });
});
