import { isPlanReviewSatisfied, isTaskAwaitingPlanning } from "@fusion/core";
import type { Task } from "@fusion/core";
import { describe, expect, it } from "vitest";
import {
  createPlanReviewApprovedState,
  createPlanReviewRevisedState,
  createSupersededPlanReviewApproval,
  REJECTED_PLAN_DRAFT,
} from "./_plan-review-outcome-states.js";

/*
FNXC:PlanReviewOutputExclusivity 2026-09-06-01:01:
A Plan Review result selects one durable output chain: satisfaction selects execution, while
`needs-replan` selects planning and wins over an older approval. The scheduler and in-process
runtime intentionally duplicate the same event guard, so their production-path tests must cover
ordinary approval independently; an `awaiting-approval` pre-event would arm the first disjunct and
make either durable proof impossible to measure.

The REVISE writer's activity-log entry is deliberately excluded by the planner's feedback reader;
only the real workflow result proves that notes reach planning. This table therefore uses the
production result and planning predicates, not the unused log preview or a test-only interpretation.
*/

interface OutcomeState {
  task: Task;
  alreadyReleased?: boolean;
}

function classifyOutcomeState({ task, alreadyReleased = false }: OutcomeState) {
  const approvalHeldTaskIds = new Set<string>();
  const approvalReleasedTaskIds = new Set(alreadyReleased ? [task.id] : []);
  const reviewSatisfied = task.workflowStepResults?.some(isPlanReviewSatisfied) === true;
  const awaitingPlanning = isTaskAwaitingPlanning(task, REJECTED_PLAN_DRAFT);
  const executionSelected = !awaitingPlanning
    && (Boolean(task.approvedPlanFingerprint) || reviewSatisfied);
  const planningSelected = awaitingPlanning;
  const queuesExecutionNow = !task.status
    && !task.paused
    && !task.userPaused
    && (
      approvalHeldTaskIds.delete(task.id)
      || (
        (Boolean(task.approvedPlanFingerprint) || reviewSatisfied)
        && !approvalReleasedTaskIds.has(task.id)
      )
    );

  return {
    selectedChainCount: Number(executionSelected) + Number(planningSelected),
    executionSelected,
    planningSelected,
    queuesExecutionNow,
  };
}

describe("Plan Review outcome arms exactly one output chain", () => {
  const cases: Array<{
    label: string;
    state: OutcomeState;
    expected: ReturnType<typeof classifyOutcomeState>;
  }> = [
    {
      label: "ordinary APPROVE",
      state: { task: createPlanReviewApprovedState({ id: "FN-APPROVE" }) },
      expected: { selectedChainCount: 1, executionSelected: true, planningSelected: false, queuesExecutionNow: true },
    },
    {
      label: "ordinary APPROVE already released",
      state: { task: createPlanReviewApprovedState({ id: "FN-APPROVE-RELEASED" }), alreadyReleased: true },
      expected: { selectedChainCount: 1, executionSelected: true, planningSelected: false, queuesExecutionNow: false },
    },
    {
      label: "durable approval fingerprint",
      state: {
        task: createPlanReviewApprovedState({
          id: "FN-FINGERPRINT",
          approvedPlanFingerprint: "approved",
          workflowStepResults: [],
        }),
      },
      expected: { selectedChainCount: 1, executionSelected: true, planningSelected: false, queuesExecutionNow: true },
    },
    {
      label: "REVISE",
      state: { task: createPlanReviewRevisedState({ id: "FN-REVISE" }) },
      expected: { selectedChainCount: 1, executionSelected: false, planningSelected: true, queuesExecutionNow: false },
    },
    {
      label: "current REVISE with an older passed result",
      state: { task: createPlanReviewApprovedState({ id: "FN-CONFLICT", status: "needs-replan" }) },
      expected: { selectedChainCount: 1, executionSelected: false, planningSelected: true, queuesExecutionNow: false },
    },
    {
      label: "paused APPROVE",
      state: { task: createPlanReviewApprovedState({ id: "FN-PAUSED", paused: true }) },
      expected: { selectedChainCount: 1, executionSelected: true, planningSelected: false, queuesExecutionNow: false },
    },
    {
      label: "user-paused APPROVE",
      state: { task: createPlanReviewApprovedState({ id: "FN-USER-PAUSED", userPaused: true }) },
      expected: { selectedChainCount: 1, executionSelected: true, planningSelected: false, queuesExecutionNow: false },
    },
    {
      label: "superseded approval",
      state: { task: createSupersededPlanReviewApproval({ id: "FN-SUPERSEDED" }) },
      expected: { selectedChainCount: 0, executionSelected: false, planningSelected: false, queuesExecutionNow: false },
    },
    {
      label: "no approval evidence",
      state: { task: createPlanReviewApprovedState({ id: "FN-NO-PROOF", workflowStepResults: [] }) },
      expected: { selectedChainCount: 0, executionSelected: false, planningSelected: false, queuesExecutionNow: false },
    },
  ];

  it.each(cases)("classifies $label without arming both outputs", ({ state, expected }) => {
    expect(classifyOutcomeState(state)).toEqual(expected);
  });
});
