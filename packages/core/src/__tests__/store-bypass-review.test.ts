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

  async function seedInReviewTask(id: string, options: { workflowStepResults?: WorkflowStepResult[]; paused?: boolean; workflowId?: string } = {}) {
    await store().createTaskWithReservedId(
      { description: `Task ${id}`, column: "in-review", workflowId: options.workflowId },
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

  /*
  FNXC:ReviewBypass 2026-07-29-09:30 (U9):
  The case above asserts `verdict` is undefined against a fixture whose verdict is
  ALREADY undefined, so the assertion is vacuous: deleting `delete bypassed.verdict`
  from store.ts leaves it green. Measured by mutation — NEW-failures=0 across
  store-bypass-review, task-merge-bypass, task-merge and legacy-adoption.

  The invariant only has teeth when the failed step CARRIES a verdict. That is the
  real risk: a reviewer said REVISE, an operator bypasses, and the verdict rides
  forward onto a `skipped` step — so every downstream reader sees a reviewer verdict
  attached to a step no reviewer passed. FN-7720 requires the bypass to clear it and
  preserve the original only in the audit field.
  */
  it("clears a real verdict off the bypassed step and keeps it only as audit history", async () => {
    await seedInReviewTask("FN-BYP-VERDICT", {
      workflowStepResults: [failedStep({ verdict: "REVISE", output: "reviewer asked for changes" })],
    });

    const updated = await store().bypassFailedPreMergeReviewStep("FN-BYP-VERDICT", {
      reason: "operator override after reviewer outage",
      actor: "operator-2",
    });

    const result = updated.workflowStepResults?.[0];
    expect(result?.status).toBe("skipped");
    // The bypass must NOT carry the reviewer's verdict onto the skipped step.
    expect(result?.verdict).toBeUndefined();
    // ...but it must not lose it either: the audit field preserves what was bypassed.
    expect(result?.bypassedFromVerdict).toBe("REVISE");
    expect(result?.bypassedFromStatus).toBe("failed");
    expect(result?.bypassedBy).toBe("operator-2");
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

  it("records a skipped result for an enabled gate that never produced a result", async () => {
    await seedInReviewTask("FN-BYP-ABSENT", { workflowStepResults: [], workflowId: "builtin:coding" });

    const updated = await store().bypassFailedPreMergeReviewStep("FN-BYP-ABSENT", {
      reason: "operator bypass for a resultless required gate",
      actor: "operator-absent",
    });

    const result = updated.workflowStepResults?.find((entry) => entry.workflowStepId === "plan-review");
    expect(result).toMatchObject({
      status: "skipped",
      bypassedFromStatus: "absent",
      bypassedBy: "operator-absent",
    });
    expect(result?.verdict).toBeUndefined();
  });

  /*
  FNXC:ReviewLaneBypass 2026-09-06-00:47:
  An archived failure remains an audit carrier. FN-9266 preserves its archive provenance and permits
  only the audited operator waiver to satisfy the merge gate.
  */
  it("bypasses a required gate archived by another gate's remediation", async () => {
    const archived = failedStep({
      workflowStepId: "plan-review",
      workflowStepName: "Plan Review",
      status: "skipped",
      reviewKind: "plan",
      remediationArchivedAt: "2026-09-04T19:28:37.579Z",
      remediationArchivedFromStatus: "failed",
    });
    const approvedCodeReview = failedStep({ status: "passed", verdict: "APPROVE", reviewKind: "code" });
    await seedInReviewTask("FN-BYP-ARCHIVED", { workflowStepResults: [archived, approvedCodeReview], workflowId: "builtin:coding" });

    const updated = await store().bypassFailedPreMergeReviewStep("FN-BYP-ARCHIVED", {
      reason: "gate archived as collateral of a code-review remediation",
      actor: "operator-archived",
    });

    const result = updated.workflowStepResults?.find((entry) => entry.workflowStepId === "plan-review");
    expect(result).toMatchObject({
      status: "skipped",
      bypassedBy: "operator-archived",
      bypassedFromStatus: "failed",
    });
    expect(result?.verdict).toBeUndefined();
    expect(result?.remediationArchivedAt).toBe("2026-09-04T19:28:37.579Z");
    expect(result?.remediationArchivedFromStatus).toBe("failed");
  });

  it("rejects when there is no failed or enabled resultless pre-merge step", async () => {
    await seedInReviewTask("FN-BYP-005", { workflowStepResults: [failedStep({ status: "passed" })] });
    await store().updateTask("FN-BYP-005", { enabledWorkflowSteps: [] });
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
  /*
  FNXC:WorkflowLifecycleColumns 2026-07-30-01:10 (PR #2709 review — greptile):
  THE REJECTION MUST NAME THE COLUMN THE CHECK USED. The guard was converted to the resolved review
  lane while the message still said `in-review`, so on a custom board an operator was refused and
  then told to move the card to a column their board does not have — through both the CLI and the
  dashboard, with nothing in the error to reveal the real target.

  That is worse than an unconverted guard. An inert guard fails visibly; this one refuses CORRECTLY
  and then misdirects, so the operator's next three attempts are all wrong for a reason the product
  told them.
  */
  it("accepts a humanReview-ONLY lane, which the singular `.review` excluded", async () => {
    /*
    FNXC:WorkflowLifecycleColumns 2026-07-30-16:05 (PR #2718 review — greptile):
    `.review` is the single `mergeOrchestration` column, so a board hosting review on a `humanReview`-
    only lane failed this guard — `TaskContextMenu` offered "Bypass failed review" (it asks by ROLE)
    and the store refused it. The operator's only escape from a stranded failed pre-merge step returned
    a conflict.

    The BROAD set is right here because this guard refuses or permits and moves nothing; #2750
    documents why a caller that admits and then MOVES wants the narrow lane instead.
    */
    const definition = await store().createWorkflowDefinition({
      name: "human-review-bypass",
      ir: {
        version: "v2",
        name: "human-review-bypass",
        columns: [
          { id: "backlog", name: "Backlog", traits: [{ trait: "intake" }, { trait: "hold" }] },
          { id: "building", name: "Building", traits: [{ trait: "wip" }] },
          { id: "signoff", name: "Sign-off", traits: [{ trait: "human-review" }] },
          { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
        ],
        nodes: [{ id: "start", kind: "start", column: "backlog" }, { id: "end", kind: "end", column: "shipped" }],
        edges: [{ from: "start", to: "end" }],
      },
    } as never);

    await store().createTaskWithReservedId(
      { description: "human-review bypass", column: "signoff", workflowId: definition.id } as never,
      { taskId: "FN-HRB", applyDefaultWorkflowSteps: false },
    );
    await store().updateTask("FN-HRB", { workflowStepResults: [failedStep()] });

    /* Passes the lane guard; any later refusal is a different gate, which is the point. */
    await expect(
      store().bypassFailedPreMergeReviewStep("FN-HRB", { reason: "operator override" } as never),
    ).resolves.toBeDefined();
  });

  it("names the board's OWN review column when refusing a card that is elsewhere", async () => {
    const definition = await store().createWorkflowDefinition({
      name: "renamed-review",
      ir: {
        version: "v2",
        name: "renamed-review",
        columns: [
          { id: "backlog", name: "Backlog", traits: [{ trait: "intake" }, { trait: "hold" }] },
          { id: "building", name: "Building", traits: [{ trait: "wip" }] },
          { id: "validating", name: "Validating", traits: [{ trait: "merge" }] },
          { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
        ],
        nodes: [{ id: "start", kind: "start", column: "backlog" }, { id: "end", kind: "end", column: "shipped" }],
        edges: [{ from: "start", to: "end" }],
      },
    } as never);

    await store().createTaskWithReservedId(
      { description: "renamed board card", column: "building", workflowId: definition.id } as never,
      { taskId: "FN-RENAMED", applyDefaultWorkflowSteps: false },
    );

    await expect(
      store().bypassFailedPreMergeReviewStep("FN-RENAMED", { reason: "operator override" } as never),
    ).rejects.toThrow(/must be in 'validating'/);
  });
});
