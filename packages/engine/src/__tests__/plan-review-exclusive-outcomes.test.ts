/*
FNXC:PlanReviewOutputExclusivity 2026-09-06-01:01:
Each Plan Review verdict must traverse exactly one integrated route: approval reaches execution,
revision reaches plan-replan and stops, and a valid no-op reaches terminal completion. Both
`remediation-scheduled` and `pre-merge-optional-step-fix-scheduled` are successful node outcomes,
so high-level outcome assertions cannot prove exclusivity; this suite asserts visited nodes and
durable writes, including the declined-remediation path.
*/
import { BUILTIN_WORKFLOWS, isPlanReviewSatisfied } from "@fusion/core";
import type { Task, TaskDetail, WorkflowIr, WorkflowIrNode, WorkflowStepResult } from "@fusion/core";
import { describe, expect, it, vi } from "vitest";
import { evaluateUnplannedForExecution } from "../execution/hold-release.js";
import { requestPreMergeOptionalStepFix } from "../executor/request-pre-merge-optional-step-fix.js";
import { WorkflowGraphExecutor } from "../workflows/workflow-graph-executor.js";
import type { WorkflowNodeResult } from "../workflows/workflow-node-handler.js";
import {
  createPlanReviewApprovedState,
  createPlanReviewRevisedState,
  createSupersededPlanReviewApproval,
  PLAN_REVIEW_ID,
  PLAN_REVIEW_NOTES,
} from "./_plan-review-outcome-states.js";

export { createPlanReviewApprovedState, createPlanReviewRevisedState } from "./_plan-review-outcome-states.js";

const PLAN_REVIEW_STEP_ID = "plan-review-step";

interface PlanReviewWorkflowCase {
  id: string;
  ir: WorkflowIr;
  successTarget: string;
  replanTarget: string;
  noOpTarget: string;
}

const PLAN_REVIEW_WORKFLOWS: PlanReviewWorkflowCase[] = BUILTIN_WORKFLOWS.flatMap((definition) => {
  const ir = definition.ir as WorkflowIr;
  if (!ir.nodes.some((node) => node.id === PLAN_REVIEW_ID)) return [];
  const targetFor = (condition: string) => ir.edges.find((edge) => edge.from === PLAN_REVIEW_ID && edge.condition === condition)?.to;
  const successTarget = targetFor("success");
  const replanTarget = targetFor("failure");
  const noOpTarget = targetFor("outcome:close-no-op");
  if (!successTarget || !replanTarget || !noOpTarget) {
    throw new Error(`${definition.id} has an incomplete Plan Review route`);
  }
  return [{ id: definition.id, ir, successTarget, replanTarget, noOpTarget }];
});

interface GraphRunEvidence {
  result: Awaited<ReturnType<WorkflowGraphExecutor["run"]>>;
  records: WorkflowStepResult[];
  requestFix: ReturnType<typeof vi.fn>;
  completeNoOp: ReturnType<typeof vi.fn>;
  holdNoOp: ReturnType<typeof vi.fn>;
}

type ScriptedPlanReviewVerdict = "APPROVE" | "APPROVE_WITH_NOTES" | "REVISE" | "CLOSE_NO_OP" | "MISSING";

function reviewNodeResult(
  verdict: ScriptedPlanReviewVerdict,
  notes?: string,
  reviseOutcome: "success" | "failure" = "failure",
): WorkflowNodeResult {
  if (verdict === "MISSING") {
    return { outcome: "success", contextPatch: { verdictRequired: true } };
  }
  const blocking = verdict === "REVISE";
  return {
    outcome: blocking ? reviseOutcome : "success",
    value: verdict,
    contextPatch: {
      verdictRequired: true,
      notes: notes ?? (blocking ? "The plan omits regression coverage." : "The plan is ready for execution."),
      output: blocking ? "Add a focused regression test before execution." : "Plan review completed.",
      findings: blocking
        ? [{
            id: "missing-regression-test",
            title: "Regression proof is missing",
            body: "Add a focused regression test for the race.",
            severity: "high",
            resolution: "open",
          }]
        : [],
    },
  };
}

async function runPlanReview(
  workflow: PlanReviewWorkflowCase,
  verdict: ScriptedPlanReviewVerdict,
  options: {
    remediationAccepted?: boolean;
    closeNotes?: string;
    completeNoOp?: boolean;
    reviseOutcome?: "success" | "failure";
  } = {},
): Promise<GraphRunEvidence> {
  const records: WorkflowStepResult[] = [];
  const requestFix = vi.fn(async () => options.remediationAccepted ?? true);
  const completeNoOp = vi.fn(async () => options.completeNoOp ?? true);
  const holdNoOp = vi.fn(async () => undefined);
  const task = {
    ...createPlanReviewApprovedState({
      id: `FN-${workflow.id.replace(/[^a-z0-9]/gi, "-")}-${verdict}`,
      column: workflow.ir.nodes.find((node) => node.id === PLAN_REVIEW_ID)?.column ?? "todo",
      workflowStepResults: [],
    }),
  } as TaskDetail;

  const executor = new WorkflowGraphExecutor({
    handlers: {
      prompt: async (node: WorkflowIrNode) => node.id === PLAN_REVIEW_STEP_ID
        ? reviewNodeResult(verdict, options.closeNotes, options.reviseOutcome)
        : { outcome: "success" },
      gate: async () => ({ outcome: "success" }),
    },
    requestPreMergeOptionalStepFix: requestFix,
    completePlanReviewNoOp: completeNoOp,
    holdPlanReviewNoOp: holdNoOp,
    recordWorkflowStepResult: async (_taskId, result) => {
      records.push(result);
      const at = (task.workflowStepResults ?? []).findIndex((entry) => entry.workflowStepId === result.workflowStepId);
      if (at >= 0) task.workflowStepResults![at] = result;
      else (task.workflowStepResults ??= []).push(result);
      return { persisted: true, scopeCurrent: true };
    },
  });

  return {
    result: await executor.run(task, { autoMerge: true }, workflow.ir, PLAN_REVIEW_ID),
    records,
    requestFix,
    completeNoOp,
    holdNoOp,
  };
}

function terminalPlanReviewRecord(records: WorkflowStepResult[]): WorkflowStepResult | undefined {
  return [...records].reverse().find((result) => result.workflowStepId === PLAN_REVIEW_ID && result.status !== "pending");
}

describe("Plan Review exclusive outcomes across built-in workflows", () => {
  it("covers every registered built-in and its exact three-way Plan Review route", () => {
    const expected = BUILTIN_WORKFLOWS
      .filter((definition) => (definition.ir as WorkflowIr).nodes.some((node) => node.id === PLAN_REVIEW_ID))
      .map((definition) => definition.id)
      .sort();
    expect(PLAN_REVIEW_WORKFLOWS.map((workflow) => workflow.id).sort()).toEqual(expected);
    expect(expected.length).toBeGreaterThan(0);

    for (const workflow of PLAN_REVIEW_WORKFLOWS) {
      const outgoing = workflow.ir.edges
        .filter((edge) => edge.from === PLAN_REVIEW_ID)
        .map((edge) => ({ condition: edge.condition, to: edge.to }))
        .sort((left, right) => String(left.condition).localeCompare(String(right.condition)));
      expect(outgoing).toEqual([
        { condition: "failure", to: workflow.replanTarget },
        { condition: "outcome:close-no-op", to: workflow.noOpTarget },
        { condition: "success", to: workflow.successTarget },
      ]);
      expect(workflow.ir.nodes.find((node) => node.id === workflow.replanTarget)?.config).toMatchObject({
        workflowAction: "plan-replan",
        forWorkflowStepId: PLAN_REVIEW_ID,
      });
      expect(workflow.ir.nodes.find((node) => node.id === workflow.noOpTarget)?.config).toMatchObject({
        workflowAction: "plan-review-no-op",
      });
    }
  });

  describe.each(PLAN_REVIEW_WORKFLOWS)("$id", (workflow) => {
    it.each(["APPROVE", "APPROVE_WITH_NOTES"] as const)("routes %s only to execution", async (verdict) => {
      const evidence = await runPlanReview(workflow, verdict);
      const result = terminalPlanReviewRecord(evidence.records);

      expect(evidence.result.visitedNodeIds).toContain(PLAN_REVIEW_ID);
      expect(evidence.result.visitedNodeIds).toContain(`${PLAN_REVIEW_ID}::${PLAN_REVIEW_STEP_ID}`);
      expect(evidence.result.visitedNodeIds).toContain(workflow.successTarget);
      expect(evidence.result.visitedNodeIds).not.toContain(workflow.replanTarget);
      expect(evidence.result.visitedNodeIds).not.toContain(workflow.noOpTarget);
      expect(result).toMatchObject({ status: "passed", verdict });
      expect(isPlanReviewSatisfied(result!)).toBe(true);
      expect(evidence.result.context[`node:${PLAN_REVIEW_ID}:fixScheduled`]).toBeUndefined();
      expect(evidence.requestFix).not.toHaveBeenCalled();
      expect(evidence.completeNoOp).not.toHaveBeenCalled();
    });

    it.each([
      { reviseOutcome: "failure" as const, accepted: true, status: "failed", terminalValue: "remediation-scheduled" },
      { reviseOutcome: "success" as const, accepted: true, status: "advisory_failure", terminalValue: "remediation-scheduled" },
      { reviseOutcome: "failure" as const, accepted: false, status: "failed", terminalValue: "remediation-not-scheduled" },
    ])("routes $reviseOutcome REVISE only to replanning when remediation acceptance is $accepted", async ({ reviseOutcome, accepted, status, terminalValue }) => {
      const evidence = await runPlanReview(workflow, "REVISE", {
        remediationAccepted: accepted,
        reviseOutcome,
      });
      const result = terminalPlanReviewRecord(evidence.records);

      expect(evidence.result.visitedNodeIds).toContain(PLAN_REVIEW_ID);
      expect(evidence.result.visitedNodeIds).toContain(workflow.replanTarget);
      expect(evidence.result.visitedNodeIds).not.toContain(workflow.successTarget);
      expect(evidence.result.visitedNodeIds).not.toContain(workflow.noOpTarget);
      expect(result).toMatchObject({ status, verdict: "REVISE" });
      expect(isPlanReviewSatisfied(result!)).toBe(false);
      expect(evidence.result.context[`node:${PLAN_REVIEW_ID}:fixScheduled`]).toBe(accepted ? true : undefined);
      expect(evidence.result.outcome).toBe(accepted ? "success" : "failure");
      expect(evidence.result.context[`node:${workflow.replanTarget}:value`]).toBe(terminalValue);
      expect(evidence.requestFix).toHaveBeenCalledTimes(1);
      expect(evidence.requestFix).toHaveBeenCalledWith(taskIdFor(workflow, "REVISE"), expect.objectContaining({
        stepName: "Plan Review",
        phase: "pre-merge",
        feedback: expect.stringContaining("focused regression test"),
        verdict: "REVISE",
        nodeId: PLAN_REVIEW_ID,
      }));
      expect(evidence.completeNoOp).not.toHaveBeenCalled();
    });

    it("fails closed when a verdict-required Plan Review returns no verdict", async () => {
      const evidence = await runPlanReview(workflow, "MISSING");
      const result = terminalPlanReviewRecord(evidence.records);

      expect(evidence.result.outcome).toBe("failure");
      expect(evidence.result.visitedNodeIds).toContain(PLAN_REVIEW_ID);
      expect(evidence.result.visitedNodeIds).not.toContain(workflow.successTarget);
      expect(evidence.result.visitedNodeIds).not.toContain(workflow.replanTarget);
      expect(evidence.result.visitedNodeIds).not.toContain(workflow.noOpTarget);
      expect(result).toMatchObject({ status: "failed", verdictRequired: true });
      expect(result?.verdict).toBeUndefined();
      expect(evidence.requestFix).not.toHaveBeenCalled();
    });

    it("routes a valid CLOSE_NO_OP only to terminal completion", async () => {
      const closeNotes = "NO-OP: the requested behavior is already present.";
      const evidence = await runPlanReview(workflow, "CLOSE_NO_OP", { closeNotes });
      const result = terminalPlanReviewRecord(evidence.records);

      expect(evidence.result.visitedNodeIds).toContain(PLAN_REVIEW_ID);
      expect(evidence.result.visitedNodeIds).toContain(workflow.noOpTarget);
      expect(evidence.result.visitedNodeIds).not.toContain(workflow.successTarget);
      expect(evidence.result.visitedNodeIds).not.toContain(workflow.replanTarget);
      expect(result).toMatchObject({ status: "passed", verdict: "CLOSE_NO_OP", notes: closeNotes });
      expect(evidence.completeNoOp).toHaveBeenCalledTimes(1);
      expect(evidence.requestFix).not.toHaveBeenCalled();
      expect(evidence.holdNoOp).not.toHaveBeenCalled();
    });

    it("holds an invalid CLOSE_NO_OP without entering execution or replanning", async () => {
      const evidence = await runPlanReview(workflow, "CLOSE_NO_OP", { closeNotes: "This has no completion sentinel." });
      const result = terminalPlanReviewRecord(evidence.records);

      expect(evidence.result.suspended).toMatchObject({ reason: "hold", nodeId: PLAN_REVIEW_ID });
      expect(evidence.result.visitedNodeIds).not.toContain(workflow.successTarget);
      expect(evidence.result.visitedNodeIds).not.toContain(workflow.replanTarget);
      expect(evidence.result.visitedNodeIds).not.toContain(workflow.noOpTarget);
      expect(result).toMatchObject({ status: "failed", verdict: "CLOSE_NO_OP" });
      expect(evidence.completeNoOp).not.toHaveBeenCalled();
      expect(evidence.requestFix).not.toHaveBeenCalled();
      expect(evidence.holdNoOp).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ reason: "invalid" }));
    });
  });
});

function taskIdFor(workflow: PlanReviewWorkflowCase, verdict: string): string {
  return `FN-${workflow.id.replace(/[^a-z0-9]/gi, "-")}-${verdict}`;
}

describe("Plan Review durable execution gates", () => {
  it("admits execution only for a durable approval", async () => {
    const approved = createPlanReviewApprovedState();
    const revised = createPlanReviewRevisedState();
    const approvedButReplanning = createPlanReviewApprovedState({ status: "needs-replan" });
    const superseded = createSupersededPlanReviewApproval();
    const bypassed = createPlanReviewApprovedState({
      workflowStepResults: [{
        workflowStepId: PLAN_REVIEW_ID,
        workflowStepName: "Plan Review",
        phase: "pre-merge",
        status: "skipped",
        bypassedBy: "operator",
        bypassedAt: "2026-09-06T00:00:00.000Z",
        bypassReason: "Reviewed manually",
        bypassedFromStatus: "failed",
        bypassedFromVerdict: "REVISE",
      }],
    });
    const noVerdict = createPlanReviewApprovedState({ workflowStepResults: [] });
    const store = {
      updateTask: vi.fn(),
      moveTask: vi.fn(),
      logEntry: vi.fn(),
    };

    const ir = PLAN_REVIEW_WORKFLOWS.find((workflow) => workflow.id === "builtin:coding")!.ir;
    await expect(evaluateUnplannedForExecution(store as never, approved, ir)).resolves.toMatchObject({
      unplanned: false,
      reason: null,
      planReview: { satisfied: true },
    });
    await expect(evaluateUnplannedForExecution(store as never, bypassed, ir)).resolves.toMatchObject({
      unplanned: false,
      reason: null,
      planReview: { satisfied: true },
    });
    await expect(evaluateUnplannedForExecution(store as never, revised, ir)).resolves.toMatchObject({
      unplanned: true,
      reason: "plan-review-pending",
    });
    await expect(evaluateUnplannedForExecution(store as never, approvedButReplanning, ir)).resolves.toMatchObject({
      unplanned: true,
      reason: "needs-replan",
    });
    await expect(evaluateUnplannedForExecution(store as never, superseded, ir)).resolves.toMatchObject({
      unplanned: true,
      reason: "plan-review-pending",
    });
    await expect(evaluateUnplannedForExecution(store as never, noVerdict, ir)).resolves.toMatchObject({
      unplanned: true,
      reason: "plan-review-pending",
    });
    expect(store.updateTask).not.toHaveBeenCalled();
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(store.logEntry).not.toHaveBeenCalled();
  });

  it("persists an actionable REVISE bounce while preserving the plan and closing execution", async () => {
    const task = createPlanReviewRevisedState({
      id: "FN-PLAN-REVISE-BOUNCE",
      column: "todo",
      status: undefined,
      error: "old error",
      steps: [
        { title: "Implementation", description: "First implementation step", status: "pending" },
        { title: "Regression proof", description: "Focused test step", status: "pending" },
      ],
    });
    const originalPrompt = task.prompt;
    const updates: Array<Partial<Task>> = [];
    const logs: Array<{ message: string; outcome?: string }> = [];
    const store = {
      getTask: async () => task,
      getSettings: async () => ({}),
      listWorkflowWorkItemsForTask: async () => [{
        id: "wi-capacity",
        taskId: task.id,
        kind: "task",
        nodeId: "plan-review",
        state: "runnable",
        waitReason: "capacity",
        sourceColumn: "todo",
        payload: {},
        attempt: 0,
        retryAfter: null,
        createdAt: "2026-09-06T00:00:00.000Z",
        updatedAt: "2026-09-06T00:00:00.000Z",
      }],
      getTaskWorkflowSelection: () => ({ workflowId: "builtin:coding", stepIds: [PLAN_REVIEW_ID] }),
      getWorkflowDefinition: async () => undefined,
      updateTask: async (_id: string, patch: Partial<Task>) => {
        updates.push(patch);
        Object.assign(task, patch);
      },
      logEntry: async (_id: string, message: string, outcome?: string) => {
        logs.push({ message, outcome });
      },
    };

    const parked = await requestPreMergeOptionalStepFix({
      store: store as never,
      getRunContextFor: () => undefined,
      recoverMissingRequiredArtifacts: vi.fn(async () => undefined),
      parkPlanReviewReplanCapExhausted: vi.fn(async () => undefined),
      clearPausedAborted: vi.fn(),
      readTaskArtifact: vi.fn(async () => undefined),
      appendReviewRemediationSteps: vi.fn(async () => "appended"),
      workflowLifecycleMovesInFlight: new Set(),
      sendTaskBackForFix: vi.fn(async () => undefined),
    }, task.id, task, {
      stepName: "Plan Review",
      feedback: "Add a focused regression test before execution.",
      phase: "pre-merge",
      status: "failed",
      verdict: "REVISE",
      nodeId: PLAN_REVIEW_ID,
      maxRevisions: "unbounded",
      findings: task.workflowStepResults?.[0]?.findings,
    });

    expect(parked).toBe(true);
    expect(task).toMatchObject({ column: "todo", status: "needs-replan", prompt: originalPrompt });
    expect(task.error).toBeNull();
    expect(task.steps).toEqual([
      expect.objectContaining({ title: "Implementation", status: "pending" }),
      expect.objectContaining({ title: "Regression proof", status: "pending" }),
    ]);
    expect(task.workflowStepResults).toEqual([
      expect.objectContaining({
        workflowStepId: PLAN_REVIEW_ID,
        status: "failed",
        verdict: "REVISE",
        notes: PLAN_REVIEW_NOTES,
      }),
    ]);
    expect(updates).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "needs-replan", error: null }),
    ]));
    expect(logs.map((entry) => entry.message)).toEqual(expect.arrayContaining([
      "AI spec revision requested",
      expect.stringContaining("Plan Review requested a plan revision"),
    ]));
    const durableFeedback = logs.map((entry) => entry.outcome ?? "").join("\n");
    expect(durableFeedback).toContain("Revision source: plan-review/plan-review");
    expect(durableFeedback).toContain("Add a focused regression test before execution.");
    const ir = PLAN_REVIEW_WORKFLOWS.find((workflow) => workflow.id === "builtin:coding")!.ir;
    await expect(evaluateUnplannedForExecution(store as never, task, ir)).resolves.toMatchObject({
      unplanned: true,
      reason: "needs-replan",
    });
  });
});
