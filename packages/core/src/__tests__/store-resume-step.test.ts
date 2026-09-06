import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import type { WorkflowStepResult } from "../types.js";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../__test-utils__/pg-test-harness.js";
import { queryRunAuditEvents } from "../task-store/async/async-audit.js";
import { archiveTerminalWorkflowStepFailures } from "../workflows/workflow-step-results.js";

/*
 * FNXC:StepResume 2026-07-24-13:00:
 * Store-level coverage for the resumeWorkflowStep primitive: eligibility gating
 * (in-review or in-progress, step is pending, mandatory reason + stepId), the
 * resume rewrite (status -> failed + audit metadata), the run-audit event/log
 * breadcrumb, and rejection of non-pending steps.
 */

pgDescribe("TaskStore.resumeWorkflowStep", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_resume_step",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  function pendingStep(overrides: Partial<WorkflowStepResult> = {}): WorkflowStepResult {
    return {
      workflowStepId: "code-review",
      workflowStepName: "Code Review",
      phase: "pre-merge",
      source: "optional-group",
      status: "pending",
      startedAt: "2026-07-17T16:10:10.052Z",
      ...overrides,
    };
  }

  function store() {
    return h.store();
  }

  async function seedInReviewTask(
    id: string,
    options: {
      workflowStepResults?: WorkflowStepResult[];
      paused?: boolean;
      column?: string;
    } = {},
  ) {
    const column = options.column ?? "in-review";
    await store().createTaskWithReservedId(
      { description: `Task ${id}`, column },
      { taskId: id, applyDefaultWorkflowSteps: false },
    );
    await store().updateTask(id, {
      workflowStepResults: options.workflowStepResults ?? null,
      paused: options.paused,
    });
    return store().getTask(id);
  }

  it("transitions a pending step to failed with audit metadata", async () => {
    await seedInReviewTask("FN-RES-001", { workflowStepResults: [pendingStep()] });

    const updated = await store().resumeWorkflowStep("FN-RES-001", {
      stepId: "code-review",
      reason: "Runfusion/Fusion#1946 no-verdict dispatch defect",
      actor: "operator-1",
    });

    const result = updated.workflowStepResults?.[0];
    expect(result?.status).toBe("failed");
    expect(result?.completedAt).toBeDefined();
    expect(result?.resumedBy).toBe("operator-1");
    expect(result?.resumeReason).toBe("Runfusion/Fusion#1946 no-verdict dispatch defect");
    expect(result?.resumedFromStatus).toBe("pending");
    expect(typeof result?.resumedAt).toBe("string");

    // Audit trail: task log entry recorded.
    const logged = updated.log?.some((entry) => entry.action.includes("Workflow step resumed"));
    expect(logged).toBe(true);
  });

  it("records a run-audit event for the resume", async () => {
    await seedInReviewTask("FN-RES-002", { workflowStepResults: [pendingStep()] });
    await store().resumeWorkflowStep("FN-RES-002", {
      stepId: "code-review",
      reason: "infra failure",
      actor: "operator-2",
    });

    const events = await queryRunAuditEvents(h.layer().db, { taskId: "FN-RES-002" });
    const resumeEvent = events.find((event) => event.mutationType === "task:resume-step");
    expect(resumeEvent).toBeDefined();
    expect(resumeEvent?.agentId).toBe("operator-2");
  });

  it("rejects when the step is not pending", async () => {
    await seedInReviewTask("FN-RES-003", {
      workflowStepResults: [pendingStep({ status: "passed" })],
    });
    await expect(
      store().resumeWorkflowStep("FN-RES-003", {
        stepId: "code-review",
        reason: "x",
        actor: "operator",
      }),
    ).rejects.toThrow(/only pending steps can be resumed/);
  });

  it("points an archived failure carrier at bypass without rewriting its history", async () => {
    const archived = archiveTerminalWorkflowStepFailures([
      pendingStep({ status: "failed", completedAt: "2026-09-02T00:00:00.000Z" }),
    ], "2026-09-03T00:00:00.000Z")![0]!;
    await seedInReviewTask("FN-RES-003A", { workflowStepResults: [archived] });

    await expect(store().resumeWorkflowStep("FN-RES-003A", {
      stepId: "code-review", reason: "x", actor: "operator",
    })).rejects.toThrow(/archived remediation carrier.*fn_task_bypass_review/);
    expect((await store().getTask("FN-RES-003A")).workflowStepResults?.[0]).toMatchObject({
      status: "skipped", remediationArchivedAt: "2026-09-03T00:00:00.000Z", remediationArchivedFromStatus: "failed",
    });
  });

  it("rejects when the step is not found as a pending pre-merge step", async () => {
    await seedInReviewTask("FN-RES-004", { workflowStepResults: [] });
    await expect(
      store().resumeWorkflowStep("FN-RES-004", {
        stepId: "non-existent-step",
        reason: "x",
        actor: "operator",
      }),
    ).rejects.toThrow(/not found as a pending pre-merge step/);
  });

  it("rejects resuming a post-merge step (pre-merge boundary, FNXC:StepResume)", async () => {
    await seedInReviewTask("FN-RES-004B", {
      workflowStepResults: [pendingStep({ workflowStepId: "post-deploy", workflowStepName: "Post Deploy", phase: "post-merge" })],
    });
    await expect(
      store().resumeWorkflowStep("FN-RES-004B", {
        stepId: "post-deploy",
        reason: "x",
        actor: "operator",
      }),
    ).rejects.toThrow(/not found as a pending pre-merge step/);
  });

  it("rejects a blank reason", async () => {
    await seedInReviewTask("FN-RES-005", { workflowStepResults: [pendingStep()] });
    await expect(
      store().resumeWorkflowStep("FN-RES-005", {
        stepId: "code-review",
        reason: "   ",
        actor: "operator",
      }),
    ).rejects.toThrow(/non-empty reason/);
  });

  it("rejects a blank stepId", async () => {
    await seedInReviewTask("FN-RES-006", { workflowStepResults: [pendingStep()] });
    await expect(
      store().resumeWorkflowStep("FN-RES-006", {
        stepId: "",
        reason: "x",
        actor: "operator",
      }),
    ).rejects.toThrow(/non-empty stepId/);
  });

  it("rejects when the task is not in-review or in-progress", async () => {
    await seedInReviewTask("FN-RES-007", {
      workflowStepResults: [pendingStep()],
      column: "todo",
    });
    await expect(
      store().resumeWorkflowStep("FN-RES-007", {
        stepId: "code-review",
        reason: "x",
        actor: "operator",
      }),
    ).rejects.toThrow(/task is in 'todo', must be in .* or a WIP/);
  });

  it("works on tasks in in-progress column", async () => {
    await seedInReviewTask("FN-RES-008", {
      workflowStepResults: [pendingStep()],
      column: "in-progress",
    });

    const updated = await store().resumeWorkflowStep("FN-RES-008", {
      stepId: "code-review",
      reason: "stuck pending step in execution",
      actor: "operator-3",
    });

    const result = updated.workflowStepResults?.[0];
    expect(result?.status).toBe("failed");
    expect(result?.resumedBy).toBe("operator-3");
    expect(result?.resumedFromStatus).toBe("pending");
  });

  it("preserves existing pending step properties after resume", async () => {
    await seedInReviewTask("FN-RES-009", {
      workflowStepResults: [
        pendingStep({ source: "optional-group", startedAt: "2026-07-17T16:10:10.052Z" }),
      ],
    });

    const updated = await store().resumeWorkflowStep("FN-RES-009", {
      stepId: "code-review",
      reason: "dispatch callback never received",
      actor: "operator",
    });

    const result = updated.workflowStepResults?.[0];
    expect(result?.workflowStepId).toBe("code-review");
    expect(result?.workflowStepName).toBe("Code Review");
    expect(result?.phase).toBe("pre-merge");
    expect(result?.source).toBe("optional-group");
    expect(result?.startedAt).toBe("2026-07-17T16:10:10.052Z");
    expect(result?.status).toBe("failed");
    expect(result?.resumedFromStatus).toBe("pending");
  });

  it("clears lease ownership on the resumed step result (FNXC:StepResume lease cleanup)", async () => {
    await seedInReviewTask("FN-RES-010", {
      workflowStepResults: [
        pendingStep({ leaseOwner: "agent-reviewer-1", leaseNodeId: "review-1" }),
      ],
    });

    const updated = await store().resumeWorkflowStep("FN-RES-010", {
      stepId: "code-review",
      reason: "lease owner never completed the verdict callback",
      actor: "operator",
    });

    const result = updated.workflowStepResults?.[0];
    expect(result?.status).toBe("failed");
    // A terminal 'failed' result must not carry the stale dispatch lease forward.
    expect(result?.leaseOwner).toBeUndefined();
    expect(result?.leaseNodeId).toBeUndefined();
  });
});