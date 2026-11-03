/**
 * FNXC:ApprovalHoldMoveClear 2026-09-25-11:12 (RUFU-297 defect B):
 * PG regression for `reconcile-orphaned-non-convergence-holds`: a `code-review-non-convergence`
 * approval hold left behind by a PRE-RUFU-297 build (hold present, step results already destroyed)
 * is cleared IN PLACE. The hold is legitimate only while its evidence — a `failed`/
 * `advisory_failure` result on a required pre-merge gate — exists; while that survives, the
 * human-decision contract must not be swept away. Skips follow the FN-8356 rule set (user pauses,
 * live sessions) and the reason-code gate never reaches another owner's hold.
 *
 * FNXC:ApprovalHoldMoveClear 2026-10-07-16:12 (RUFU-314 finding 1):
 * The same pair invariant covers `plan-review-replan-cap`, so this file pins BOTH halves of the
 * widened candidate set: a cap hold whose plan-review evidence is gone clears in place (with its own
 * `reasonCode` on the audit row and in the card's log line), while a cap hold whose plan-review
 * `advisory_failure`/`REVISE` row still exists stays held. It also pins that widening is an
 * allowlist and not a negation: every other approval reason — the `human-plan-approval` decision
 * pause and the `merge-blocked-by-policy` merge-policy hold — is still untouched, and that a cap
 * parked outside the review lane (where `parkPlanReviewReplanCapExhausted` actually fires) is
 * repaired in place with its lane unchanged, since the sweep never moves a card.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../../core/src/__test-utils__/pg-test-harness.js";
import { SelfHealingManager } from "../self-healing.js";

const pgTest = pgDescribe;

const HOLD_EVENT = "task:reconcile-orphaned-non-convergence-hold";

const failedCodeReviewRow = {
  workflowStepId: "code-review",
  workflowStepName: "Code Review",
  phase: "pre-merge" as const,
  status: "failed" as const,
  verdict: "REVISE" as const,
  startedAt: "2026-01-01T00:00:00.000Z",
};

/*
FNXC:ApprovalHoldMoveClear 2026-10-07-16:12 (RUFU-314 finding 1):
A genuine Plan Review non-convergence is an `advisory_failure` carrying verdict REVISE — that is the
row `requestPreMergeOptionalStepFix` counts against the replan cap before
`parkPlanReviewReplanCapExhausted` parks the card. It is the cap hold's evidence, exactly the way the
failed Code Review row is the ladder hold's.
*/
const revisePlanReviewRow = {
  workflowStepId: "plan-review",
  workflowStepName: "Plan Review",
  phase: "pre-merge" as const,
  status: "advisory_failure" as const,
  verdict: "REVISE" as const,
  startedAt: "2026-01-01T00:00:00.000Z",
};

pgTest("self-healing reconcileOrphanedNonConvergenceHolds (PostgreSQL, RUFU-297)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_orphan_nc_hold",
    projectId: "rufu297-sweep",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  /** Seed an in-review card on the exact drifted pair: non-convergence hold + step-list state. */
  async function seedDrifted(
    id: string,
    shape: {
      stepResults?: Array<Record<string, unknown>> | null;
      reason?: string;
      pausedShape?: boolean;
      userPaused?: boolean;
      column?: string;
      enabledSteps?: string[];
    } = {},
  ) {
    const store = h.store();
    await store.createTaskWithReservedId(
      { description: id, column: shape.column ?? "in-review" },
      { taskId: id, applyDefaultWorkflowSteps: false },
    );
    await store.updateTask(id, {
      status: shape.pausedShape ? (undefined as never) : ("awaiting-approval" as never),
      awaitingApprovalReason: (shape.reason ?? "code-review-non-convergence") as never,
      enabledWorkflowSteps: shape.enabledSteps ?? ["code-review"],
      workflowStepResults: (shape.stepResults ?? null) as never,
    });
    if (shape.pausedShape) {
      await h.adminSql()`UPDATE project.tasks SET paused = 1, paused_reason = 'awaiting-approval', paused_started_at = '2026-01-01T00:00:00.000Z' WHERE id = ${id}`;
      store.taskCache.delete(id);
    }
    if (shape.userPaused) {
      await h.adminSql()`UPDATE project.tasks SET user_paused = 1 WHERE id = ${id}`;
      store.taskCache.delete(id);
    }
  }

  async function auditRows(taskId: string): Promise<Array<Record<string, unknown>>> {
    /*
    FNXC:RunAuditSink 2026-09-30 (RUFU-453):
    A best-effort audit emit is now accepted before it is durable, so "the sweep finished" no longer means
    "its row is in the table". Flushing here is the drain's own bounded hand-off: the assertion below is
    about what the sweep recorded, and this line is what makes that question answerable at all.
    */
    await h.store().flushRunAuditSink();
    const rows = await h.adminSql()`SELECT metadata FROM project.run_audit_events WHERE task_id = ${taskId} AND mutation_type = ${HOLD_EVENT}`;
    return rows.map((r: { metadata: unknown }) =>
      (typeof r.metadata === "string" ? JSON.parse(r.metadata) : r.metadata) as Record<string, unknown>);
  }

  it("clears a drifted hold whose step results are null, in place, with audit + log", async () => {
    const store = h.store();
    await seedDrifted("rufu297-b1", { stepResults: null });

    const manager = new SelfHealingManager(store, { rootDir: h.rootDir() });
    const cleared = await manager.reconcileOrphanedNonConvergenceHolds();
    expect(cleared).toBe(1);

    const repaired = await store.getTask("rufu297-b1");
    // In-place clear: hold gone, lane untouched (no lifecycle move).
    expect(repaired?.status ?? undefined).toBeUndefined();
    expect(repaired?.awaitingApprovalReason ?? undefined).toBeUndefined();
    expect(repaired?.column).toBe("in-review");
    expect((repaired?.log ?? []).some((entry) => /drifted code-review-non-convergence/i.test(entry.action))).toBe(true);

    const rows = await auditRows("rufu297-b1");
    expect(rows.length).toBe(1);
    const meta = rows[0];
    /*
    FNXC:RunAudit 2026-10-07-16:22 (RUFU-314 finding 2): this assertion used to tolerate the
    `createRunAuditor` envelope — it asserted `meta.phase` equalled the sweep's phase and deleted
    `phase`/`taskLineageId` before checking the key set. The sweep now emits through
    `emitBoundedRunAudit` directly (FN-9175 names that seam, and the core half of this pair already
    used it), so the stored jsonb carries EXACTLY the documented contract: five keys, no envelope.
    Tightening it here is deliberate, not a make-it-pass edit — this assertion IS the pair invariant's
    metadata contract, and a key the docs do not declare must now fail loudly.
    */
    expect(Object.keys(meta).sort()).toEqual(
      ["column", "outcome", "priorStatus", "reasonCode", "taskId"],
    );
    expect(meta.taskId).toBe("rufu297-b1");
    expect(meta.column).toBe("in-review");
    expect(meta.priorStatus).toBe("awaiting-approval");
    expect(meta.reasonCode).toBe("code-review-non-convergence");
    expect(meta.outcome).toBe("cleared");
  });

  it("clears the drifted hold when only unrelated (non-required) results survived the wipe", async () => {
    const store = h.store();
    await seedDrifted("rufu297-b2", {
      stepResults: [{
        workflowStepId: "browser-verification",
        workflowStepName: "Browser Verification",
        phase: "pre-merge",
        status: "failed",
        startedAt: "2026-01-01T00:00:00.000Z",
      }],
    });

    const manager = new SelfHealingManager(store, { rootDir: h.rootDir() });
    expect(await manager.reconcileOrphanedNonConvergenceHolds()).toBe(1);
    const repaired = await store.getTask("rufu297-b2");
    expect(repaired?.awaitingApprovalReason ?? undefined).toBeUndefined();
  });

  it("leaves the hold alone while the failed pre-merge evidence survives", async () => {
    const store = h.store();
    await seedDrifted("rufu297-b3", { stepResults: [failedCodeReviewRow] });

    const manager = new SelfHealingManager(store, { rootDir: h.rootDir() });
    expect(await manager.reconcileOrphanedNonConvergenceHolds()).toBe(0);
    const kept = await store.getTask("rufu297-b3");
    expect(kept?.status).toBe("awaiting-approval");
    expect(kept?.awaitingApprovalReason).toBe("code-review-non-convergence");
    expect((await auditRows("rufu297-b3")).length).toBe(0);
  });

  it("never reaches through an operator user-pause", async () => {
    const store = h.store();
    await seedDrifted("rufu297-b4", { stepResults: null, userPaused: true });

    const manager = new SelfHealingManager(store, { rootDir: h.rootDir() });
    expect(await manager.reconcileOrphanedNonConvergenceHolds()).toBe(0);
    const kept = await store.getTask("rufu297-b4");
    expect(kept?.status).toBe("awaiting-approval");
  });

  it("never clears another owner's hold (human-plan-approval decision pause)", async () => {
    const store = h.store();
    await seedDrifted("rufu297-b5", { stepResults: null, reason: "human-plan-approval" });

    const manager = new SelfHealingManager(store, { rootDir: h.rootDir() });
    expect(await manager.reconcileOrphanedNonConvergenceHolds()).toBe(0);
    const kept = await store.getTask("rufu297-b5");
    expect(kept?.status).toBe("awaiting-approval");
    expect(kept?.awaitingApprovalReason).toBe("human-plan-approval");
  });

  it("clears the gated-session pause shape with pause accounting", async () => {
    const store = h.store();
    await seedDrifted("rufu297-b6", { stepResults: null, pausedShape: true });

    const manager = new SelfHealingManager(store, { rootDir: h.rootDir() });
    expect(await manager.reconcileOrphanedNonConvergenceHolds()).toBe(1);
    const repaired = await store.getTask("rufu297-b6");
    expect(repaired?.paused ?? false).toBe(false);
    expect(repaired?.pausedReason ?? undefined).toBeUndefined();
    expect(repaired?.awaitingApprovalReason ?? undefined).toBeUndefined();
    expect(typeof repaired?.cumulativePausedMs).toBe("number");
  });

  it("clears a drifted plan-review-replan-cap hold whose plan-review evidence is gone", async () => {
    const store = h.store();
    await seedDrifted("rufu314-c1", {
      reason: "plan-review-replan-cap",
      enabledSteps: ["plan-review"],
      stepResults: null,
    });

    const manager = new SelfHealingManager(store, { rootDir: h.rootDir() });
    expect(await manager.reconcileOrphanedNonConvergenceHolds()).toBe(1);

    const repaired = await store.getTask("rufu314-c1");
    expect(repaired?.status ?? undefined).toBeUndefined();
    expect(repaired?.awaitingApprovalReason ?? undefined).toBeUndefined();
    expect(repaired?.column).toBe("in-review");
    // The card's own log line must name WHICH hold was released, not a fixed code-review sentence.
    expect((repaired?.log ?? []).some((entry) => /drifted plan-review-replan-cap/i.test(entry.action))).toBe(true);

    const rows = await auditRows("rufu314-c1");
    expect(rows.length).toBe(1);
    expect(rows[0].reasonCode).toBe("plan-review-replan-cap");
    expect(rows[0].outcome).toBe("cleared");
    expect(rows[0].priorStatus).toBe("awaiting-approval");
  });

  it("clears a cap hold parked outside the review lane in place, with its lane unchanged", async () => {
    const store = h.store();
    // `parkPlanReviewReplanCapExhausted` fires from the executor/planning lane, not from review.
    await seedDrifted("rufu314-c2", {
      reason: "plan-review-replan-cap",
      enabledSteps: ["plan-review"],
      stepResults: null,
      column: "in-progress",
    });

    const manager = new SelfHealingManager(store, { rootDir: h.rootDir() });
    expect(await manager.reconcileOrphanedNonConvergenceHolds()).toBe(1);
    const repaired = await store.getTask("rufu314-c2");
    expect(repaired?.column).toBe("in-progress");
    expect(repaired?.awaitingApprovalReason ?? undefined).toBeUndefined();
  });

  it("leaves a legitimate cap hold whose plan-review REVISE evidence survives", async () => {
    const store = h.store();
    await seedDrifted("rufu314-c3", {
      reason: "plan-review-replan-cap",
      enabledSteps: ["plan-review"],
      stepResults: [revisePlanReviewRow],
    });

    const manager = new SelfHealingManager(store, { rootDir: h.rootDir() });
    expect(await manager.reconcileOrphanedNonConvergenceHolds()).toBe(0);
    const kept = await store.getTask("rufu314-c3");
    expect(kept?.status).toBe("awaiting-approval");
    expect(kept?.awaitingApprovalReason).toBe("plan-review-replan-cap");
    expect((await auditRows("rufu314-c3")).length).toBe(0);
  });

  it("never clears a merge-policy hold (widening is an allowlist, not a negation)", async () => {
    const store = h.store();
    await seedDrifted("rufu314-c4", {
      reason: "merge-blocked-by-policy",
      enabledSteps: ["code-review"],
      stepResults: null,
    });

    const manager = new SelfHealingManager(store, { rootDir: h.rootDir() });
    expect(await manager.reconcileOrphanedNonConvergenceHolds()).toBe(0);
    const kept = await store.getTask("rufu314-c4");
    expect(kept?.status).toBe("awaiting-approval");
    expect(kept?.awaitingApprovalReason).toBe("merge-blocked-by-policy");
  });

  it("never reaches through an operator user-pause on a cap hold either", async () => {
    const store = h.store();
    await seedDrifted("rufu314-c5", {
      reason: "plan-review-replan-cap",
      enabledSteps: ["plan-review"],
      stepResults: null,
      userPaused: true,
    });

    const manager = new SelfHealingManager(store, { rootDir: h.rootDir() });
    expect(await manager.reconcileOrphanedNonConvergenceHolds()).toBe(0);
    const kept = await store.getTask("rufu314-c5");
    expect(kept?.awaitingApprovalReason).toBe("plan-review-replan-cap");
  });

  it("skips a card with a live session (FN-8492 canonical liveness triple)", async () => {
    const store = h.store();
    await seedDrifted("rufu297-b7", { stepResults: null });

    const manager = new SelfHealingManager(store, {
      rootDir: h.rootDir(),
      isTaskActive: (id: string) => id === "rufu297-b7",
    });
    expect(await manager.reconcileOrphanedNonConvergenceHolds()).toBe(0);
    const kept = await store.getTask("rufu297-b7");
    expect(kept?.status).toBe("awaiting-approval");
  });
});
