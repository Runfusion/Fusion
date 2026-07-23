import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import type { WorkflowStepResult } from "../types.js";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../__test-utils__/pg-test-harness.js";
import { queryRunAuditEvents } from "../task-store/async/async-audit.js";

/*
 * FNXC:ReviewLaneBypass 2026-07-09-00:00:
 * Store-level coverage for FN-7720's bypassFailedPreMergeReviewStep primitive:
 * eligibility gating (in-review, not paused, has a failed pre-merge step,
 * mandatory reason), the bypass rewrite (status → skipped + audit metadata,
 * no fabricated verdict), the run-audit/log breadcrumb, and the
 * autoMerge:false human-review contract (blocker cleared, task NOT
 * auto-moved to done).
 *
 * FNXC:PostgresCutover 2026-07-10: ported from upstream's sqlite version to
 * the shared PG harness (the sqlite TaskStore runtime is removed on this
 * branch); assertions are unchanged.
 */

pgDescribe("TaskStore.bypassFailedPreMergeReviewStep", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_bypass_review",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  function failedStep(overrides: Partial<WorkflowStepResult> = {}): WorkflowStepResult {
    return {
      workflowStepId: "code-review",
      workflowStepName: "Code Review",
      phase: "pre-merge",
      status: "failed",
      output: "(no feedback captured)",
      verdict: undefined,
      completedAt: "2026-07-09T00:00:00.000Z",
      ...overrides,
    };
  }

  function store() {
    return h.store();
  }

  async function seedInReviewTask(id: string, options: { workflowStepResults?: WorkflowStepResult[]; paused?: boolean } = {}) {
    await store().createTaskWithReservedId(
      { description: `Task ${id}`, column: "in-review" },
      { taskId: id, applyDefaultWorkflowSteps: false },
    );
    await store().updateTask(id, {
      workflowStepResults: options.workflowStepResults ?? null,
      paused: options.paused,
    });
    return store().getTask(id);
  }

  it("rewrites the failed step to skipped with bypass audit metadata and no fabricated verdict", async () => {
    await seedInReviewTask("FN-BYP-001", { workflowStepResults: [failedStep()] });

    const updated = await store().bypassFailedPreMergeReviewStep("FN-BYP-001", {
      reason: "Runfusion/Fusion#1946 no-verdict dispatch defect",
      actor: "operator-1",
    });

    const result = updated.workflowStepResults?.[0];
    expect(result?.status).toBe("skipped");
    expect(result?.verdict).toBeUndefined();
    expect(result?.bypassedBy).toBe("operator-1");
    expect(result?.bypassReason).toBe("Runfusion/Fusion#1946 no-verdict dispatch defect");
    expect(result?.bypassedFromStatus).toBe("failed");
    expect(typeof result?.bypassedAt).toBe("string");

    // Audit trail: task log entry recorded.
    const logged = updated.log?.some((entry) => entry.action.includes("Review lane bypassed"));
    expect(logged).toBe(true);
  });

  it("records a run-audit event for the bypass", async () => {
    await seedInReviewTask("FN-BYP-002", { workflowStepResults: [failedStep()] });
    await store().bypassFailedPreMergeReviewStep("FN-BYP-002", { reason: "infra failure", actor: "operator-2" });

    // FNXC:PostgresCutover 2026-07-10: getRunAuditEvents is the sync/sqlite
    // reader and intentionally returns [] in backend mode; the authoritative
    // PG read is the async queryRunAuditEvents helper.
    const events = await queryRunAuditEvents(h.layer().db, { taskId: "FN-BYP-002" });
    const bypassEvent = events.find((event) => event.mutationType === "task:bypass-review");
    expect(bypassEvent).toBeDefined();
    expect(bypassEvent?.agentId).toBe("operator-2");
  });

  it("rejects when the task is not in-review", async () => {
    await store().createTaskWithReservedId(
      { description: "todo task", column: "todo" },
      { taskId: "FN-BYP-003", applyDefaultWorkflowSteps: false },
    );
    await expect(
      store().bypassFailedPreMergeReviewStep("FN-BYP-003", { reason: "x", actor: "operator" }),
    ).rejects.toThrow(/must be in 'in-review'/);
  });

  it("rejects when the task is paused", async () => {
    await seedInReviewTask("FN-BYP-004", { workflowStepResults: [failedStep()], paused: true });
    await expect(
      store().bypassFailedPreMergeReviewStep("FN-BYP-004", { reason: "x", actor: "operator" }),
    ).rejects.toThrow(/paused/);
  });

  it("rejects when there is no failed pre-merge step", async () => {
    await seedInReviewTask("FN-BYP-005", { workflowStepResults: [failedStep({ status: "passed" })] });
    await expect(
      store().bypassFailedPreMergeReviewStep("FN-BYP-005", { reason: "x", actor: "operator" }),
    ).rejects.toThrow(/no failed pre-merge review step/);
  });

  it("rejects a blank reason", async () => {
    await seedInReviewTask("FN-BYP-006", { workflowStepResults: [failedStep()] });
    await expect(
      store().bypassFailedPreMergeReviewStep("FN-BYP-006", { reason: "   ", actor: "operator" }),
    ).rejects.toThrow(/non-empty reason/);
  });

  it("clears the merge blocker but does not force-move an autoMerge:false task to done", async () => {
    await seedInReviewTask("FN-BYP-007", { workflowStepResults: [failedStep()] });
    await store().updateTask("FN-BYP-007", { autoMerge: false });

    await store().bypassFailedPreMergeReviewStep("FN-BYP-007", { reason: "infra failure", actor: "operator" });

    const task = await store().getTask("FN-BYP-007");
    expect(task.column).toBe("in-review");

    // Blocker cleared: a manual move to done is now allowed by the merge gate,
    // but the bypass itself must not have performed that move.
    const moved = await store().moveTask("FN-BYP-007", "done");
    expect(moved.column).toBe("done");
  });

  it("does not re-select a bypassed step for self-healing recovery (status no longer 'failed')", async () => {
    await seedInReviewTask("FN-BYP-008", { workflowStepResults: [failedStep()] });
    const updated = await store().bypassFailedPreMergeReviewStep("FN-BYP-008", { reason: "infra failure", actor: "operator" });

    const latestFailedPreMergeStep = (task: { workflowStepResults?: WorkflowStepResult[] }) =>
      (task.workflowStepResults ?? []).filter((r) => (r.phase || "pre-merge") === "pre-merge" && r.status === "failed")[0];

    expect(latestFailedPreMergeStep(updated)).toBeUndefined();
  });
});
