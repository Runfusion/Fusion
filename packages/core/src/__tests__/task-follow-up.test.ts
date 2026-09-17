/*
FNXC:TaskFollowUp 2026-09-17-15:55:
FN-513 Step 1 — the ONE eligibility/sub-type rule behind the Follow-up action.

These are behavior tables, not comment assertions: every row states the boolean (or the fixed refusal
reason) a menu, the store mode, the HTTP route, and the planner must all agree on. The negative rows
matter as much as the positive ones — the failure this rule prevents is offering Follow-up on a
terminal, manual-intake, deleted, or unplanned card, which would produce a child derived from a plan
that does not exist.
*/
import { describe, expect, it } from "vitest";
import {
  FOLLOW_UP_METADATA_KEY,
  FOLLOW_UP_METADATA_VERSION,
  buildFollowUpSourceMetadata,
  evaluateFollowUpEligibility,
  isFollowUpEligible,
  isFollowUpTask,
  type FollowUpColumnFlags,
  type FollowUpEligibilityInput,
  type FollowUpIneligibleReason,
  type FollowUpReviewResultInput,
} from "../tasks/task-follow-up.js";

const marker = { [FOLLOW_UP_METADATA_KEY]: { version: FOLLOW_UP_METADATA_VERSION } };

describe("isFollowUpTask", () => {
  it("recognizes a refinement carrying a parent and the versioned marker", () => {
    expect(isFollowUpTask({
      sourceType: "task_refine",
      sourceParentTaskId: "FN-1",
      sourceMetadata: marker,
    })).toBe(true);
  });

  it.each<[string, Parameters<typeof isFollowUpTask>[0]]>([
    ["null input", null],
    ["undefined input", undefined],
    ["ordinary refinement with no metadata", { sourceType: "task_refine", sourceParentTaskId: "FN-1" }],
    ["ordinary refinement with unrelated metadata", {
      sourceType: "task_refine",
      sourceParentTaskId: "FN-1",
      sourceMetadata: { duplicateOfTaskIds: ["FN-9"] },
    }],
    ["duplicate source type", { sourceType: "task_duplicate", sourceParentTaskId: "FN-1", sourceMetadata: marker }],
    ["dashboard source type", { sourceType: "dashboard", sourceParentTaskId: "FN-1", sourceMetadata: marker }],
    ["missing parent", { sourceType: "task_refine", sourceMetadata: marker }],
    ["blank parent", { sourceType: "task_refine", sourceParentTaskId: "   ", sourceMetadata: marker }],
    ["null metadata", { sourceType: "task_refine", sourceParentTaskId: "FN-1", sourceMetadata: null }],
    ["marker is a string", { sourceType: "task_refine", sourceParentTaskId: "FN-1", sourceMetadata: { followUp: "1" } }],
    ["marker is an array", { sourceType: "task_refine", sourceParentTaskId: "FN-1", sourceMetadata: { followUp: [1] } }],
    ["marker is null", { sourceType: "task_refine", sourceParentTaskId: "FN-1", sourceMetadata: { followUp: null } }],
    ["marker has no version", { sourceType: "task_refine", sourceParentTaskId: "FN-1", sourceMetadata: { followUp: {} } }],
    ["marker version is a string", {
      sourceType: "task_refine",
      sourceParentTaskId: "FN-1",
      sourceMetadata: { followUp: { version: "1" } },
    }],
    ["marker version is unknown", {
      sourceType: "task_refine",
      sourceParentTaskId: "FN-1",
      sourceMetadata: { followUp: { version: 2 } },
    }],
  ])("degrades to an ordinary refinement: %s", (_label, input) => {
    expect(isFollowUpTask(input)).toBe(false);
  });

  it("stamps the marker while preserving sibling metadata keys", () => {
    const built = buildFollowUpSourceMetadata({ duplicateOfTaskIds: ["FN-9"] });
    expect(built.duplicateOfTaskIds).toEqual(["FN-9"]);
    expect(isFollowUpTask({ sourceType: "task_refine", sourceParentTaskId: "FN-1", sourceMetadata: built })).toBe(true);
  });

  it("stamps the marker from absent metadata", () => {
    expect(isFollowUpTask({
      sourceType: "task_refine",
      sourceParentTaskId: "FN-1",
      sourceMetadata: buildFollowUpSourceMetadata(),
    })).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */

const WIP: FollowUpColumnFlags = { countsTowardWip: true };
const REVIEW_MERGE: FollowUpColumnFlags = { mergeBlocker: true };
const REVIEW_HUMAN: FollowUpColumnFlags = { humanReview: true };
const COMPLETE: FollowUpColumnFlags = { complete: true };
const HOLD: FollowUpColumnFlags = { hold: true };
const AUTO_INTAKE: FollowUpColumnFlags = { intake: true };
const MANUAL_INTAKE: FollowUpColumnFlags = { intake: true, manualIntake: true };

function approvedPlanReview(over: Partial<FollowUpReviewResultInput> = {}): FollowUpReviewResultInput {
  return { workflowStepId: "plan-review", status: "passed", verdict: "APPROVE", ...over };
}

describe("evaluateFollowUpEligibility — lanes", () => {
  const rows: Array<[string, FollowUpEligibilityInput, true | FollowUpIneligibleReason]> = [
    // Implementation lane — the operator's primary case.
    ["WIP by trait", { column: "in-progress", columnFlags: WIP }, true],
    ["WIP by renamed column with trait", { column: "Construction", columnFlags: WIP }, true],
    ["WIP by legacy id with no traits at all", { column: "in-progress" }, true],
    ["paused WIP card stays eligible", { column: "in-progress", columnFlags: WIP, status: "paused" }, true],
    ["failed WIP card stays eligible", { column: "in-progress", columnFlags: WIP, status: "failed" }, true],

    // Review lanes — both traits qualify, and a board may declare several.
    ["review by mergeBlocker", { column: "in-review", columnFlags: REVIEW_MERGE }, true],
    ["review by humanReview", { column: "Relecture", columnFlags: REVIEW_HUMAN }, true],
    ["second review column", { column: "qa", columnFlags: { mergeBlocker: true, humanReview: true } }, true],
    ["review by legacy id with no traits", { column: "in-review" }, true],

    // Terminal wins over contradictory flags: Refine owns those cards.
    ["complete by trait", { column: "done", columnFlags: COMPLETE }, "source-terminal"],
    ["complete by legacy id", { column: "done" }, "source-terminal"],
    ["complete beats countsTowardWip", { column: "Livré", columnFlags: { complete: true, countsTowardWip: true } }, "source-terminal"],
    ["complete beats mergeBlocker", { column: "Livré", columnFlags: { complete: true, mergeBlocker: true } }, "source-terminal"],

    // Manual capture: nothing has been planned yet.
    ["manual intake by trait", { column: "Idées", columnFlags: MANUAL_INTAKE }, "source-manual-intake"],
    ["manual intake by legacy id", { column: "ideas" }, "source-manual-intake"],
    [
      "manual intake refuses even with an approved plan review",
      { column: "Idées", columnFlags: MANUAL_INTAKE, workflowStepResults: [approvedPlanReview()] },
      "source-manual-intake",
    ],

    // Deleted parents are refused before any column reasoning.
    ["soft-deleted WIP source", { column: "in-progress", columnFlags: WIP, deletedAt: "2026-09-17T00:00:00.000Z" }, "source-deleted"],
    ["soft-deleted complete source reports deletion first", { column: "done", columnFlags: COMPLETE, deletedAt: "2026-09-17T00:00:00.000Z" }, "source-deleted"],

    // An unknown column is never assumed to be an execution lane.
    ["unknown column with empty flags", { column: "Parking", columnFlags: {} }, "source-column-unsupported"],
    ["unknown column with explicitly negative flags", {
      column: "Parking",
      columnFlags: { intake: false, hold: false, countsTowardWip: false, mergeBlocker: false, humanReview: false, complete: false },
    }, "source-column-unsupported"],
    ["unknown column with no traits at all", { column: "Parking" }, "source-column-unsupported"],
  ];

  it.each(rows)("%s", (_label, input, expected) => {
    const verdict = evaluateFollowUpEligibility(input);
    if (expected === true) {
      expect(verdict.eligible).toBe(true);
    } else {
      expect(verdict).toEqual({ eligible: false, reason: expected });
    }
    expect(isFollowUpEligible(input)).toBe(expected === true);
  });

  it("reports the lane it admitted, so callers can branch without re-deriving the column role", () => {
    expect(evaluateFollowUpEligibility({ column: "x", columnFlags: WIP })).toEqual({ eligible: true, lane: "implementation" });
    expect(evaluateFollowUpEligibility({ column: "x", columnFlags: REVIEW_MERGE })).toEqual({ eligible: true, lane: "review" });
    expect(evaluateFollowUpEligibility({
      column: "x",
      columnFlags: HOLD,
      workflowStepResults: [approvedPlanReview()],
    })).toEqual({ eligible: true, lane: "planning" });
  });
});

/*
FNXC:TaskFollowUp 2026-09-17-15:55:
The Planning exception is the strict half of the operator's request ("seulement si le plan-review est
approuvé"). These rows pin the two ways it is easy to get wrong: reading ANY historical APPROVE
instead of the current one, and accepting a release that is not a reviewer verdict about the plan
(skip, operator bypass, arbitration, human plan approval).
*/
describe("evaluateFollowUpEligibility — the Planning exception", () => {
  const planningRows: Array<[string, FollowUpEligibilityInput, true | FollowUpIneligibleReason]> = [
    ["hold column with a current APPROVE", { column: "todo", columnFlags: HOLD, workflowStepResults: [approvedPlanReview()] }, true],
    ["automatic intake column with a current APPROVE", { column: "triage", columnFlags: AUTO_INTAKE, workflowStepResults: [approvedPlanReview()] }, true],
    ["renamed planning column with a current APPROVE", { column: "Planification", columnFlags: HOLD, workflowStepResults: [approvedPlanReview()] }, true],
    ["legacy todo id with no traits and a current APPROVE", { column: "todo", workflowStepResults: [approvedPlanReview()] }, true],
    ["legacy triage id with no traits and a current APPROVE", { column: "triage", workflowStepResults: [approvedPlanReview()] }, true],
    ["result matched by legacy display name", {
      column: "todo",
      columnFlags: HOLD,
      workflowStepResults: [{ workflowStepName: "Plan Review", status: "passed", verdict: "APPROVE" }],
    }, true],

    ["no results at all", { column: "todo", columnFlags: HOLD }, "plan-review-not-approved"],
    ["empty results", { column: "todo", columnFlags: HOLD, workflowStepResults: [] }, "plan-review-not-approved"],
    ["only an unrelated gate passed", {
      column: "todo",
      columnFlags: HOLD,
      workflowStepResults: [{ workflowStepId: "code-review", status: "passed", verdict: "APPROVE" }],
    }, "plan-review-not-approved"],
    ["pending review", { column: "todo", columnFlags: HOLD, workflowStepResults: [approvedPlanReview({ status: "pending", verdict: undefined })] }, "plan-review-not-approved"],
    ["failed review", { column: "todo", columnFlags: HOLD, workflowStepResults: [approvedPlanReview({ status: "failed", verdict: "REVISE" })] }, "plan-review-not-approved"],
    ["passed but REVISE verdict", { column: "todo", columnFlags: HOLD, workflowStepResults: [approvedPlanReview({ verdict: "REVISE" })] }, "plan-review-not-approved"],
    ["passed with no verdict at all", { column: "todo", columnFlags: HOLD, workflowStepResults: [approvedPlanReview({ verdict: undefined })] }, "plan-review-not-approved"],
    ["APPROVE_WITH_NOTES is not APPROVE", { column: "todo", columnFlags: HOLD, workflowStepResults: [approvedPlanReview({ verdict: "APPROVE_WITH_NOTES" })] }, "plan-review-not-approved"],
    ["skipped gate that never ran", { column: "todo", columnFlags: HOLD, workflowStepResults: [approvedPlanReview({ status: "skipped" })] }, "plan-review-not-approved"],
    ["operator bypass carrier", {
      column: "todo",
      columnFlags: HOLD,
      workflowStepResults: [approvedPlanReview({ status: "skipped", bypassedBy: "operator" })],
    }, "plan-review-not-approved"],
    ["a passed result that an operator bypassed is still not a reviewer approval", {
      column: "todo",
      columnFlags: HOLD,
      workflowStepResults: [approvedPlanReview({ bypassedBy: "operator" })],
    }, "plan-review-not-approved"],
    ["superseded APPROVE belongs to a retired planning episode", {
      column: "todo",
      columnFlags: HOLD,
      workflowStepResults: [approvedPlanReview({ supersededAt: "2026-09-17T00:00:00.000Z" })],
    }, "plan-review-not-approved"],
    ["remediation-archived APPROVE is history, not the current gate", {
      column: "todo",
      columnFlags: HOLD,
      workflowStepResults: [approvedPlanReview({ remediationArchivedAt: "2026-09-17T00:00:00.000Z" })],
    }, "plan-review-not-approved"],

    // The ordering trap: an older APPROVE cannot be revived by ignoring what came after it.
    ["an APPROVE followed by a pending round", {
      column: "todo",
      columnFlags: HOLD,
      workflowStepResults: [approvedPlanReview(), approvedPlanReview({ status: "pending", verdict: undefined })],
    }, "plan-review-not-approved"],
    ["an APPROVE followed by a failed REVISE", {
      column: "todo",
      columnFlags: HOLD,
      workflowStepResults: [approvedPlanReview(), approvedPlanReview({ status: "failed", verdict: "REVISE" })],
    }, "plan-review-not-approved"],
    ["a failed round later replaced by a current APPROVE", {
      column: "todo",
      columnFlags: HOLD,
      workflowStepResults: [approvedPlanReview({ status: "failed", verdict: "REVISE" }), approvedPlanReview()],
    }, true],
    ["a superseded newer round does not hide the current APPROVE", {
      column: "todo",
      columnFlags: HOLD,
      workflowStepResults: [approvedPlanReview(), approvedPlanReview({ status: "failed", verdict: "REVISE", supersededAt: "2026-09-17T00:00:00.000Z" })],
    }, true],

    // A live replan invalidates the exception regardless of what the results say.
    ["status planning", { column: "todo", columnFlags: HOLD, status: "planning", workflowStepResults: [approvedPlanReview()] }, "plan-review-not-approved"],
    ["status needs-replan", { column: "todo", columnFlags: HOLD, status: "needs-replan", workflowStepResults: [approvedPlanReview()] }, "plan-review-not-approved"],

    // Deletion still wins over the planning exception.
    ["deleted planning source", {
      column: "todo",
      columnFlags: HOLD,
      deletedAt: "2026-09-17T00:00:00.000Z",
      workflowStepResults: [approvedPlanReview()],
    }, "source-deleted"],
  ];

  it.each(planningRows)("%s", (_label, input, expected) => {
    const verdict = evaluateFollowUpEligibility(input);
    if (expected === true) {
      expect(verdict).toEqual({ eligible: true, lane: "planning" });
    } else {
      expect(verdict).toEqual({ eligible: false, reason: expected });
    }
  });
});
