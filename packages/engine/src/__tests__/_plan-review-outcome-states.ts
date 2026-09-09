import type { Task, TaskStore, WorkflowStepResult } from "@fusion/core";
import { requestPreMergeOptionalStepFix } from "../executor/request-pre-merge-optional-step-fix.js";
import { formatPlanReviewRevisionFeedback } from "../plan-review-feedback-history.js";

export const PLAN_REVIEW_ID = "plan-review";
export const PLAN_REVIEW_TIMESTAMP = "2026-09-06T00:00:00.000Z";
export const PLAN_REVIEW_NOTES = "PLAN-REVIEW-NOTES: add the focused race regression before execution.";
export const PLAN_REVIEW_OUTPUT = "PLAN-REVIEW-OUTPUT: add the focused race regression before execution.";
export const EXCLUDED_REVISION_LOG_PREVIEW = "EXCLUDED-REVISION-LOG-PREVIEW: this bounded log preview is not the planner input.";
export const REJECTED_PLAN_DRAFT = `# Existing rejected plan

## Mission
Preserve this rejected draft while revising it surgically.

## Steps
### Step 0: Preflight
Inspect the existing behavior.

### Step 1: Implement
Correct the race and add its regression proof.
`;

function planReviewResult(
  status: WorkflowStepResult["status"],
  verdict: WorkflowStepResult["verdict"],
  overrides: Partial<WorkflowStepResult> = {},
): WorkflowStepResult {
  return {
    workflowStepId: PLAN_REVIEW_ID,
    workflowStepName: "Plan Review",
    phase: "pre-merge",
    source: "optional-group",
    reviewKind: "plan",
    status,
    verdict,
    notes: verdict === "REVISE" ? PLAN_REVIEW_NOTES : "The plan is ready for execution.",
    startedAt: PLAN_REVIEW_TIMESTAMP,
    completedAt: PLAN_REVIEW_TIMESTAMP,
    ...overrides,
  };
}

/** Durable task state produced when ordinary Plan Review approval opens the execution path. */
export function createPlanReviewApprovedState(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-PLAN-APPROVED",
    title: "Approved Plan Review state",
    description: "Reusable approved state for Plan Review output-chain tests.",
    column: "todo",
    status: null,
    paused: false,
    userPaused: false,
    dependencies: [],
    steps: [{ title: "Implement", description: "Implement the task", status: "pending" }],
    currentStep: 0,
    log: [],
    prompt: REJECTED_PLAN_DRAFT,
    enabledWorkflowSteps: [PLAN_REVIEW_ID],
    workflowStepResults: [planReviewResult("passed", "APPROVE")],
    createdAt: PLAN_REVIEW_TIMESTAMP,
    updatedAt: PLAN_REVIEW_TIMESTAMP,
    ...overrides,
  } as Task;
}

/** Durable task state produced after the Plan Review remediation seam requests replanning. */
export function createPlanReviewRevisedState(overrides: Partial<Task> = {}): Task {
  return {
    ...createPlanReviewApprovedState({
      id: "FN-PLAN-REVISED",
      status: "needs-replan",
      log: [{
        timestamp: PLAN_REVIEW_TIMESTAMP,
        action: "AI spec revision requested",
        outcome: formatPlanReviewRevisionFeedback(PLAN_REVIEW_ID, "failed", EXCLUDED_REVISION_LOG_PREVIEW),
      }],
      workflowStepResults: [
        planReviewResult("failed", "REVISE", {
          output: PLAN_REVIEW_OUTPUT,
          priorAttempts: [planReviewResult("failed", "REVISE", {
            notes: "PRIOR-PLAN-REVIEW-NOTES: retain the earlier review decision in the ledger.",
          })],
          findings: [{
            id: "missing-regression-test",
            title: "Regression proof is missing",
            body: "Add a focused regression test for the reported race.",
            severity: "high",
            resolution: "open",
          }],
        }),
      ],
    }),
    ...overrides,
  } as Task;
}

export interface ProducedPlanReviewRevisedState {
  task: Task;
  updates: Array<Partial<Task>>;
  logs: Array<{ message: string; outcome?: string }>;
  moves: string[];
}

/*
FNXC:PlanReviewOutputChain 2026-09-06-01:28:
The REVISE reader proof must start from the real remediation writer, not a fixture that copies its
expected status and logs. This harness persists a genuine `requestPreMergeOptionalStepFix` result and
returns that exact mutable row so `TriageProcessor.specifyTask` consumes the production output for
notes, output fallback, and missing-draft variants.
*/
export async function producePlanReviewRevisedState(options: {
  id: string;
  feedbackField?: "notes" | "output";
  revisionLogFeedback?: string;
}): Promise<ProducedPlanReviewRevisedState> {
  const feedbackField = options.feedbackField ?? "notes";
  const result = planReviewResult("failed", "REVISE", {
    notes: feedbackField === "notes" ? PLAN_REVIEW_NOTES : undefined,
    output: PLAN_REVIEW_OUTPUT,
    priorAttempts: [planReviewResult("failed", "REVISE", {
      notes: "PRIOR-PLAN-REVIEW-NOTES: retain the earlier review decision in the ledger.",
    })],
    findings: [{
      id: "missing-regression-test",
      title: "Regression proof is missing",
      body: "Add a focused regression test for the reported race.",
      severity: "high",
      resolution: "open",
    }],
  });
  const task = createPlanReviewApprovedState({
    id: options.id,
    status: null,
    error: "old error",
    log: [],
    workflowStepResults: [result],
  });
  const updates: Array<Partial<Task>> = [];
  const logs: Array<{ message: string; outcome?: string }> = [];
  const moves: string[] = [];
  const store = {
    getTask: async () => task,
    getSettings: async () => ({}),
    listWorkflowWorkItemsForTask: async () => [{
      id: "wi-plan-review",
      taskId: task.id,
      kind: "task",
      nodeId: PLAN_REVIEW_ID,
      state: "runnable",
      waitReason: "capacity",
      sourceColumn: "todo",
      payload: {},
      attempt: 0,
      retryAfter: null,
      createdAt: PLAN_REVIEW_TIMESTAMP,
      updatedAt: PLAN_REVIEW_TIMESTAMP,
    }],
    getTaskWorkflowSelection: () => ({ workflowId: "builtin:coding", stepIds: [PLAN_REVIEW_ID] }),
    getWorkflowDefinition: async () => undefined,
    updateTask: async (_id: string, patch: Partial<Task>) => {
      updates.push(patch);
      Object.assign(task, patch);
      return task;
    },
    moveTask: async (_id: string, column: Task["column"]) => {
      moves.push(column);
      Object.assign(task, { column, status: null });
      return task;
    },
    logEntry: async (_id: string, message: string, outcome?: string) => {
      logs.push({ message, outcome });
      task.log = [...(task.log ?? []), { timestamp: PLAN_REVIEW_TIMESTAMP, action: message, outcome }];
    },
  } as unknown as TaskStore;
  const scheduled = await requestPreMergeOptionalStepFix({
    store,
    getRunContextFor: () => undefined,
    recoverMissingRequiredArtifacts: async () => undefined,
    parkPlanReviewReplanCapExhausted: async () => undefined,
    clearPausedAborted: () => undefined,
    readTaskArtifact: async () => undefined,
    appendReviewRemediationSteps: async () => "appended",
    workflowLifecycleMovesInFlight: new Set(),
    sendTaskBackForFix: async () => undefined,
  }, task.id, task, {
    stepName: "Plan Review",
    feedback: options.revisionLogFeedback ?? EXCLUDED_REVISION_LOG_PREVIEW,
    phase: "pre-merge",
    status: "failed",
    verdict: "REVISE",
    nodeId: PLAN_REVIEW_ID,
    maxRevisions: "unbounded",
    findings: result.findings,
  });
  if (!scheduled) throw new Error(`Plan Review REVISE was not scheduled for ${task.id}`);
  return { task, updates, logs, moves };
}

export function createSupersededPlanReviewApproval(overrides: Partial<Task> = {}): Task {
  const approved = createPlanReviewApprovedState();
  return createPlanReviewApprovedState({
    ...overrides,
    workflowStepResults: approved.workflowStepResults?.map((result) => ({
      ...result,
      supersededAt: PLAN_REVIEW_TIMESTAMP,
    })),
  });
}
