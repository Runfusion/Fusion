import { describe, expect, it } from "vitest";
import type { Task } from "@fusion/core";
import type { WorkflowStepResult } from "../../../../core/src/types/workflow/workflow-steps";
import { isTaskBlockedOnApproval } from "../../../../core/src/merge/task-merge";
import { isPlanReviewSatisfied } from "../../../../core/src/planner/plan-approval";
import { isWorkflowOptionalGroupEnabled } from "../../../../core/src/workflows/workflow-optional-steps";
import { isPlanReviewGateUnsatisfied, isTaskBlockedOnApprovalHold } from "../reviewBudgetApproval";

/*
FNXC:TaskCardPromote 2026-08-11-09:09:
FN-8950 deliberately duplicates core's browser-unsafe plan-approval rule. This pinning test is
the anti-drift mechanism: defaultOn=true encodes the built-in plan-review group's declaration,
and the approval mirror must agree with core without a column argument. It is excluded from the
gate-only failing-before demonstration because these dashboard helpers did not exist before it.
*/
const planResult = (overrides: Partial<WorkflowStepResult> = {}): WorkflowStepResult => ({
  workflowStepId: "plan-review",
  workflowStepName: "Plan Review",
  status: "pending",
  ...overrides,
});

const gateTask = (workflowStepResults?: WorkflowStepResult[], enabledWorkflowSteps?: string[] | null) => ({
  enabledWorkflowSteps,
  workflowStepResults,
}) as Pick<Task, "enabledWorkflowSteps" | "workflowStepResults">;

describe("FN-8950 plan-review gate contract", () => {
  it.each([
    ["passed", planResult({ status: "passed" })],
    ["superseded passed", planResult({ status: "passed", supersededAt: "2026-08-11T00:00:00.000Z" })],
    ["audited skipped", planResult({ status: "skipped", bypassedFromStatus: "failed", bypassedFromVerdict: "REVISE", bypassedBy: "operator", bypassedAt: "2026-08-11T00:00:00.000Z", bypassReason: "review dispatch failed" })],
    ["skipped missing source status", planResult({ status: "skipped", bypassedFromVerdict: "REVISE", bypassedBy: "operator", bypassedAt: "2026-08-11T00:00:00.000Z", bypassReason: "review dispatch failed" })],
    ["skipped missing verdict", planResult({ status: "skipped", bypassedFromStatus: "failed", bypassedBy: "operator", bypassedAt: "2026-08-11T00:00:00.000Z", bypassReason: "review dispatch failed" })],
    ["skipped missing actor", planResult({ status: "skipped", bypassedFromStatus: "failed", bypassedFromVerdict: "REVISE", bypassedAt: "2026-08-11T00:00:00.000Z", bypassReason: "review dispatch failed" })],
    ["skipped missing time", planResult({ status: "skipped", bypassedFromStatus: "failed", bypassedFromVerdict: "REVISE", bypassedBy: "operator", bypassReason: "review dispatch failed" })],
    ["skipped missing reason", planResult({ status: "skipped", bypassedFromStatus: "failed", bypassedFromVerdict: "REVISE", bypassedBy: "operator", bypassedAt: "2026-08-11T00:00:00.000Z" })],
    ["failed", planResult({ status: "failed" })],
    ["advisory failure", planResult({ status: "advisory_failure" })],
    ["pending", planResult()],
    ["running pending", planResult({ startedAt: "2026-08-11T00:00:00.000Z" })],
    ["other step", planResult({ workflowStepId: "code-review", status: "passed" })],
  ])("matches core satisfaction for %s", (_name, result) => {
    expect(isPlanReviewGateUnsatisfied(gateTask([result], ["plan-review"]))).toBe(!isPlanReviewSatisfied(result));
  });

  it.each([
    [undefined, true],
    [null, true],
    [[], false],
    [["code-review"], false],
    [["plan-review"], true],
    [["plan-review", "code-review"], true],
  ] as const)("matches core enablement for %j", (enabledWorkflowSteps, applicable) => {
    expect(isWorkflowOptionalGroupEnabled(enabledWorkflowSteps ?? undefined, "plan-review", true)).toBe(applicable);
    expect(isPlanReviewGateUnsatisfied(gateTask(undefined, enabledWorkflowSteps))).toBe(applicable);
  });

  it("treats an absent enabled-steps array as the default-on unsatisfied gate", () => {
    expect(isPlanReviewGateUnsatisfied(gateTask())).toBe(true);
    expect(isPlanReviewGateUnsatisfied(gateTask([], []))).toBe(false);
    expect(isPlanReviewGateUnsatisfied(gateTask([], ["code-review"]))).toBe(false);
  });
});

describe("FN-8950 approval-hold contract", () => {
  it.each([
    ["status without reason", { status: "awaiting-approval" }],
    ["status with reason", { status: "awaiting-approval", paused: false, pausedReason: undefined }],
    ["approval pause with null status", { status: null, paused: true, pausedReason: "awaiting-approval" }],
    ["unrelated pause", { status: null, paused: true, pausedReason: "other" }],
    ["neither shape", { status: null, paused: false, pausedReason: undefined }],
  ])("matches core for %s", (_name, task) => {
    const approvalTask = task as Pick<Task, "paused" | "pausedReason" | "status">;
    expect(isTaskBlockedOnApprovalHold(approvalTask)).toBe(isTaskBlockedOnApproval(approvalTask));
  });
});
