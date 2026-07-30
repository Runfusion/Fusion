import {
  ACTIVE_WORKFLOW_WORK_ITEM_STATES,
  computeWorkflowIrPin,
  isTaskBlockedOnApproval,
  isUnplannedSeedPrompt,
  PLAN_REVIEW_GROUP_ID,
  type Task,
  type TaskStore,
  type WorkflowIr,
  type WorkflowWorkItem,
} from "@fusion/core";
import { resolvePreReleasePlanReviewNode } from "./hold-release.js";

export type StrandedHoldContinuationReason =
  | "not-hold-column" | "no-pre-release-review" | "active-continuation"
  | "plan-review-passed" | "seed-prompt" | "prompt-missing" | "triage-owned"
  | "awaiting-approval"
  | "paused" | "engine-paused" | "live" | "too-fresh" | "auto-merge-off" | "ready";

/**
 * FNXC:StrandedHoldContinuation 2026-07-26-12:00:
 * Both normal specification completion and FN-8592 self-healing use this
 * single continuation shape. Reads intentionally include every work-item kind:
 * an active non-task continuation means the graph is not idle, even though the
 * newly seeded continuation itself remains kind `task` for processor parity.
 */
export async function seedPreReleasePlanReviewContinuation(
  store: TaskStore,
  task: Task,
  ir: WorkflowIr,
  options: { atomic?: boolean } = {},
): Promise<{
  seeded: boolean;
  reason?: "active-continuation" | "plan-review-passed" | "awaiting-approval" | "paused";
  workItemId?: string;
}> {
  const node = resolvePreReleasePlanReviewNode(ir);
  if (!node || node.column !== task.column) return { seeded: false };
  /*
  FNXC:PlanApprovalHold 2026-07-27-19:30 (U7 / R4):
  Arming a runnable continuation is starting AI work on this card, so the parks
  belong here at the seam rather than in each caller. Both callers already
  pre-checked something — the runtime's `onSpecifyComplete` reaction checks the
  pause flags, FN-8592's self-healing sweep checks its own fuller predicate — but
  NEITHER checked the approval hold, and the seeder itself checked nothing.

  Why that mattered: the manual plan-approval gate parks the card by RETURNING
  EARLY from `finalizeApprovedTask` after writing `status: "awaiting-approval"`,
  while `specifyTask` announces completion unconditionally afterwards. For a
  plan-in-place card (`node.column === task.column` — Coding (Ideas), or a
  `needs-replan` revision resting in the default workflow's `todo`) the guard
  above passes, so a Plan Review run was armed for a plan the operator had not
  approved yet. The pause check is added alongside it because a seam that starts
  work must refuse every operator park, not the subset its callers happened to
  filter.
  */
  if (isTaskBlockedOnApproval(task)) return { seeded: false, reason: "awaiting-approval" };
  if (task.paused === true || task.userPaused === true) return { seeded: false, reason: "paused" };
  const items = await store.listWorkflowWorkItemsForTask(task.id);
  const active = items.filter((item) => ACTIVE_WORKFLOW_WORK_ITEM_STATES.includes(item.state));
  if (active.length > 0) return { seeded: false, reason: "active-continuation" };
  // FNXC:StrandedHoldContinuation 2026-07-26-16:10:
  // A terminal predecessor is still part of this task's durable run history.
  // Use all items (not the zero active count) for the identity suffix so a
  // stranded card with a failed/cancelled prior continuation can be reseeded
  // as a new row instead of attempting to requeue that terminal row.
  const continuationSequence = items.length;
  const input = {
    runId: `${task.id}:planning-continuation:${node.id}:${continuationSequence}`,
    taskId: task.id,
    nodeId: node.id,
    kind: "task" as const,
    state: "runnable" as const,
    stableWorkflowRunId: `${task.id}:${ir.name}`,
    continuationSequence,
    waitReason: "planning" as const,
    sourceColumn: task.column,
    targetColumn: task.column,
    irHash: computeWorkflowIrPin(ir, node.id).irHash,
  };
  if (options.atomic) return store.seedStrandedPlanReviewContinuation(input);
  const item = await store.replaceActiveTaskWorkflowContinuation(input);
  return { seeded: true, workItemId: item.id };
}

/**
 * FNXC:StrandedHoldContinuation 2026-07-26-12:00:
 * This pure shared definition prevents the hold-release warning and recovery
 * sweep from drifting. `active-continuation` and `plan-review-passed` are quiet
 * non-candidates here; after a candidate has been freshly rechecked, the same
 * tokens represent an audit-worthy race loss from the conditional store op.
 */
export function evaluateStrandedHoldContinuation(input: {
  task: Pick<Task, "id" | "title" | "description" | "column" | "status" | "paused" | "userPaused" | "pausedReason">;
  columnFlags: { hold?: boolean };
  ir: WorkflowIr;
  continuations: WorkflowWorkItem[];
  stepResults: Task["workflowStepResults"];
  effectiveSettings: { autoMerge?: boolean };
  enginePaused: boolean;
  promptContent: string | null;
  live: boolean;
  stalenessMs: number;
  graceMs: number;
}): { stranded: boolean; candidate: boolean; reason: StrandedHoldContinuationReason } {
  if (!input.columnFlags.hold) return { stranded: false, candidate: false, reason: "not-hold-column" };
  const review = resolvePreReleasePlanReviewNode(input.ir);
  if (!review || review.column !== input.task.column) return { stranded: false, candidate: false, reason: "no-pre-release-review" };
  if (input.continuations.some((item) => ACTIVE_WORKFLOW_WORK_ITEM_STATES.includes(item.state))) return { stranded: false, candidate: false, reason: "active-continuation" };
  if (input.stepResults?.some((result) => result.workflowStepId === PLAN_REVIEW_GROUP_ID && result.status === "passed")) return { stranded: false, candidate: false, reason: "plan-review-passed" };
  if (input.promptContent === null) return { stranded: false, candidate: false, reason: "prompt-missing" };
  if (isUnplannedSeedPrompt(input.promptContent, input.task.id, input.task.title, input.task.description)) return { stranded: false, candidate: false, reason: "seed-prompt" };
  if (input.task.status === "planning" || input.task.status === "needs-replan") return { stranded: false, candidate: false, reason: "triage-owned" };
  /*
  FNXC:PlanApprovalHold 2026-07-27-19:30 (U7 / R4):
  An approval-held card is not stranded — it is exactly where the operator's
  pending decision left it, so re-seeding would run Plan Review on an unapproved
  plan. Reported as a CANDIDATE (like `paused`, unlike `triage-owned`) because the
  block is an operator park that clears on its own: once the decision lands the
  card becomes repairable again, and the audit distinction between "quiet
  non-candidate" and "race loss" should still apply to it.
  Placed before `paused` so the STATUS-only hold shape — the one the plan-approval
  gate actually writes, with no pause flag — is matched at all.
  */
  if (isTaskBlockedOnApproval(input.task)) return { stranded: false, candidate: true, reason: "awaiting-approval" };
  if (input.task.paused || input.task.userPaused) return { stranded: false, candidate: true, reason: "paused" };
  if (input.enginePaused) return { stranded: false, candidate: true, reason: "engine-paused" };
  if (input.live) return { stranded: false, candidate: true, reason: "live" };
  if (input.stalenessMs < input.graceMs) return { stranded: false, candidate: true, reason: "too-fresh" };
  if (input.effectiveSettings.autoMerge === false) return { stranded: false, candidate: true, reason: "auto-merge-off" };
  return { stranded: true, candidate: true, reason: "ready" };
}
