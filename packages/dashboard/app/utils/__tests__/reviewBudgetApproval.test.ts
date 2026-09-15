import { describe, expect, it } from "vitest";
import type { Task } from "@fusion/core";
import type { WorkflowStepResult } from "../../../../core/src/types/workflow/workflow-steps";
import { isTaskBlockedOnApproval } from "../../../../core/src/merge/task-merge";
import { isPlanReviewSatisfied } from "../../../../core/src/planner/plan-approval";
import {
  HUMAN_PLAN_APPROVAL_MESSAGE_MAX_LENGTH,
  hasCurrentHumanPlanApproval,
  isHumanPlanApprovalEnabled,
  resolvePlanReviewEpisodeId,
} from "../../../../core/src/planner/human-plan-approval";
import { isWorkflowOptionalGroupEnabled } from "../../../../core/src/workflows/workflow-optional-steps";
import {
  HUMAN_PLAN_APPROVAL_MESSAGE_MAX_LENGTH_CLIENT,
  hasCurrentHumanPlanApprovalClient,
  isPlanReviewGateUnsatisfied,
  isTaskBlockedOnApprovalHold,
  resolveHumanPlanApprovalBadgeState,
  resolvePlanReviewEpisodeIdClient,
} from "../reviewBudgetApproval";

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

/*
FNXC:HumanPlanApproval 2026-09-15-06:24:
FN-408 duplicates core's per-card decision rules for the same browser-bundle reason as FN-8950 above
(core's plan-approval module imports `node:crypto` at module top, and importing it from a component
breaks the dashboard build). This is the anti-drift pin: the mirror must agree with core on every
state, and the message limit the UI enforces must be the same number the server enforces.
*/
describe("FN-408 per-card human plan approval contract", () => {
  const EPISODE = "2026-09-15T06:20:00.000Z";
  const FINGERPRINT = "f".repeat(64);

  const passed = (completedAt: string | undefined, over: Partial<WorkflowStepResult> = {}): WorkflowStepResult => ({
    workflowStepId: "plan-review",
    workflowStepName: "Plan Review",
    status: "passed",
    completedAt,
    ...over,
  });

  const decision = (over: Record<string, unknown> = {}) => ({
    requestId: "r1",
    decision: "approved" as const,
    decidedBy: "dashboard-operator",
    decidedAt: EPISODE,
    planFingerprint: FINGERPRINT,
    planningEpisodeId: EPISODE,
    ...over,
  });

  const CASES: ReadonlyArray<readonly [string, Partial<Task>]> = [
    ["no option", { workflowStepResults: [passed(EPISODE)], approvedPlanFingerprint: FINGERPRINT }],
    ["armed, review pending", { humanPlanApproval: { enabled: true }, workflowStepResults: [] }],
    ["armed, review satisfied, undecided", {
      humanPlanApproval: { enabled: true },
      workflowStepResults: [passed(EPISODE)],
      approvedPlanFingerprint: FINGERPRINT,
    }],
    ["armed and approved", {
      humanPlanApproval: { enabled: true, decision: decision() },
      workflowStepResults: [passed(EPISODE)],
      approvedPlanFingerprint: FINGERPRINT,
    }],
    ["approved for a superseded episode", {
      humanPlanApproval: { enabled: true, decision: decision() },
      workflowStepResults: [
        passed(EPISODE, { supersededAt: EPISODE, supersededReason: "respecify" }),
        passed("2026-09-15T09:00:00.000Z"),
      ],
      approvedPlanFingerprint: FINGERPRINT,
    }],
    ["approved for a different plan", {
      humanPlanApproval: { enabled: true, decision: decision() },
      workflowStepResults: [passed(EPISODE)],
      approvedPlanFingerprint: "9".repeat(64),
    }],
    ["rejection record", {
      humanPlanApproval: { enabled: true, decision: decision({ decision: "rejected" }) },
      workflowStepResults: [passed(EPISODE)],
      approvedPlanFingerprint: FINGERPRINT,
    }],
  ] as const;

  it.each(CASES)("matches core for %s", (_name, overrides) => {
    const task = overrides as Task;
    expect(hasCurrentHumanPlanApprovalClient(task)).toBe(hasCurrentHumanPlanApproval(task));
    expect(resolvePlanReviewEpisodeIdClient(task)).toBe(resolvePlanReviewEpisodeId(task.workflowStepResults));
    // The badge is derived state, so it must never contradict the shared release predicate.
    const badge = resolveHumanPlanApprovalBadgeState(task);
    expect(badge === "approved").toBe(hasCurrentHumanPlanApproval(task));
    expect(badge !== null).toBe(isHumanPlanApprovalEnabled(task));
  });

  it("enforces the same message limit the server enforces", () => {
    expect(HUMAN_PLAN_APPROVAL_MESSAGE_MAX_LENGTH_CLIENT).toBe(HUMAN_PLAN_APPROVAL_MESSAGE_MAX_LENGTH);
  });
});
