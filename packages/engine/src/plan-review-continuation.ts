import {
  ACTIVE_WORKFLOW_WORK_ITEM_STATES,
  computeWorkflowIrPin,
  isTaskBlockedOnApproval,
  isPlanReviewSatisfied,
  isUnplannedSeedPrompt,
  type Task,
  type TaskStore,
  type WorkflowIr,
  type WorkflowWorkItem,
} from "@fusion/core";
import { resolvePreReleasePlanReviewNode } from "./execution/hold-release.js";
import {
  classifyPersistedPlanHandoff,
  LEGACY_NULL_PLAN_HANDOFF_STALE_MS,
} from "./planning-handoff-recovery.js";

export type StrandedHoldContinuationReason =
  | "not-hold-column" | "no-pre-release-review" | "active-continuation"
  | "plan-review-passed" | "seed-prompt" | "prompt-missing" | "triage-owned"
  | "planning-recovery-owned"
  | "awaiting-approval"
  | "paused" | "engine-paused" | "live" | "too-fresh" | "auto-merge-off" | "ready";

/** The durable outcome of resuming a manually approved pre-release Plan Review. */
export type ApprovedPlanReviewHandoffResult = {
  resumed: boolean;
  reason: "seeded" | "not-plan-in-place" | "awaiting-approval" | "paused" | "needs-replan"
    | "active-continuation" | "plan-review-passed";
  workItemId?: string;
};

/**
 * FNXC:StrandedHoldContinuation 2026-07-26-12:00:
 * Both normal specification completion and FN-8592 self-healing use this
 * single continuation shape. Reads intentionally include every work-item kind:
 * an active non-task continuation means the graph is not idle, even though the
 * newly seeded continuation itself remains kind `task` for processor parity.
 */
/*
FNXC:PlanningHandoffAtomicity 2026-08-13-04:20:
The bail-reason union is exported so the runtime reaction's quiet-park set stays type-linked to it:
a rename or new reason here must be a compile error at the consumer, not a silent behavior change.
"no-pre-release-plan-review" exists because a workflow with no pre-release Plan Review node (or a
plan-review gate living in a WIP column) is a legitimate configuration — the reaction must treat
that bail as a quiet park, not an anomaly worth retries and warnings.
*/
export type PlanReviewSeedBailReason =
  | "no-pre-release-plan-review"
  | "active-continuation"
  | "plan-review-passed"
  | "awaiting-approval"
  | "paused";

export async function seedPreReleasePlanReviewContinuation(
  store: TaskStore,
  task: Task,
  ir: WorkflowIr,
  options: { atomic?: boolean; retirePredecessorId?: string } = {},
): Promise<{
  seeded: boolean;
  reason?: PlanReviewSeedBailReason;
  workItemId?: string;
}> {
  const node = resolvePreReleasePlanReviewNode(ir);
  if (!node || node.column !== task.column) return { seeded: false, reason: "no-pre-release-plan-review" };
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
  /*
  FNXC:PlanningHandoffAtomicity 2026-08-13-03:49:
  The normal planning handoff names its own just-finished plan work item via
  `retirePredecessorId`. That row is often still `running` here because triage
  announces completion BEFORE its finally block marks the row terminal, so counting
  it as "active" made the seeder bail on its own predecessor and strand the card
  until FN-8592 self-healing re-seeded it ~10 minutes later. The predecessor is
  excluded from this advisory pre-check and retired atomically with the successor
  install inside the store operation; any OTHER active row still blocks the seed.
  */
  const active = items.filter((item) =>
    ACTIVE_WORKFLOW_WORK_ITEM_STATES.includes(item.state) && item.id !== options.retirePredecessorId);
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
  /*
  FNXC:PlanningHandoffAtomicity 2026-08-13-03:49:
  A caller that names a predecessor gets the atomic conditional seed regardless of the
  `atomic` flag: the pre-check above is advisory (outside any transaction), so the
  retire-predecessor + idle-recheck + successor-install must all land in ONE store
  transaction under the task lock for the handoff to be ordering-proof.
  */
  if (options.retirePredecessorId) {
    return store.seedStrandedPlanReviewContinuation(input, { retirePredecessorId: options.retirePredecessorId });
  }
  if (options.atomic) return store.seedStrandedPlanReviewContinuation(input);
  const item = await store.replaceActiveTaskWorkflowContinuation(input);
  return { seeded: true, workItemId: item.id };
}

/**
 * FNXC:PlanApprovalDispatch 2026-08-05-01:57:
 * Dashboard approval clears the human hold but does not own Plan Review's verdict or capacity
 * boundary. This public engine seam resumes the graph by atomically seeding its normal runnable
 * continuation only after approval is durable. The conditional store writer serializes every
 * concurrent continuation writer, preserves terminal history, and refuses duplicate active work.
 *
 * Approval callers must hold `withPlanningLifecycleLock` around their state transition and this
 * handoff. A failed seed leaves ordinary stranded-continuation recovery as the restart owner;
 * this seam never manufactures a satisfied review result or a capacity continuation.
 */
export async function resumeApprovedPlanReviewHandoff(
  store: TaskStore,
  task: Task,
  ir: WorkflowIr,
): Promise<ApprovedPlanReviewHandoffResult> {
  const node = resolvePreReleasePlanReviewNode(ir);
  if (!node || node.column !== task.column) return { resumed: false, reason: "not-plan-in-place" };
  if (isTaskBlockedOnApproval(task)) return { resumed: false, reason: "awaiting-approval" };
  if (task.paused === true || task.userPaused === true) return { resumed: false, reason: "paused" };
  if (task.status === "needs-replan") return { resumed: false, reason: "needs-replan" };

  const seeded = await seedPreReleasePlanReviewContinuation(store, task, ir, { atomic: true });
  if (seeded.seeded) return { resumed: true, reason: "seeded", workItemId: seeded.workItemId };
  // FNXC:PlanningHandoffAtomicity 2026-08-13-04:20: the no-node bail now carries its own reason
  // token; this seam already pre-checked the node above, so map it to its legacy result name.
  return {
    resumed: false,
    reason: seeded.reason === undefined || seeded.reason === "no-pre-release-plan-review"
      ? "not-plan-in-place"
      : seeded.reason,
  };
}

/**
 * FNXC:StrandedHoldContinuation 2026-07-26-12:00:
 * This pure shared definition prevents the hold-release warning and recovery
 * sweep from drifting. `active-continuation` and `plan-review-passed` are quiet
 * non-candidates here; after a candidate has been freshly rechecked, the same
 * tokens represent an audit-worthy race loss from the conditional store op.
 */
export function evaluateStrandedHoldContinuation(input: {
  task: Pick<Task,
    | "id" | "title" | "description" | "column" | "status" | "paused" | "userPaused" | "pausedReason"
    | "approvedPlanFingerprint" | "awaitingApprovalReason" | "workflowStepResults" | "updatedAt" | "steps"
    | "worktree" | "firstExecutionAt" | "executionStartedAt"
  >;
  columnFlags: { hold?: boolean; intake?: boolean };
  ir: WorkflowIr;
  continuations: WorkflowWorkItem[];
  stepResults: Task["workflowStepResults"];
  effectiveSettings: { autoMerge?: boolean };
  enginePaused: boolean;
  promptContent: string | null;
  live: boolean;
  stalenessMs: number;
  graceMs: number;
  now?: number;
}): { stranded: boolean; candidate: boolean; reason: StrandedHoldContinuationReason } {
  if (!input.columnFlags.hold) return { stranded: false, candidate: false, reason: "not-hold-column" };
  const review = resolvePreReleasePlanReviewNode(input.ir);
  if (!review || review.column !== input.task.column) return { stranded: false, candidate: false, reason: "no-pre-release-review" };
  if (input.continuations.some((item) => ACTIVE_WORKFLOW_WORK_ITEM_STATES.includes(item.state))) return { stranded: false, candidate: false, reason: "active-continuation" };
  if (input.stepResults?.some(isPlanReviewSatisfied)) return { stranded: false, candidate: false, reason: "plan-review-passed" };
  if (input.promptContent === null) return { stranded: false, candidate: false, reason: "prompt-missing" };
  if (isUnplannedSeedPrompt(input.promptContent, input.task.id, input.task.title, input.task.description)) return { stranded: false, candidate: false, reason: "seed-prompt" };
  if (input.task.status === "planning" || input.task.status === "needs-replan") return { stranded: false, candidate: false, reason: "triage-owned" };
  /*
  FNXC:PlanningDependencyReseed 2026-08-04-04:10:
  A pre-U11 planning handoff can have a real PROMPT, persisted parsed steps, and
  null status before lifecycle recovery publishes approval/continuation state.
  On a merged intake+hold lane that shape also looks like a stranded Plan Review
  continuation. Give the conservative legacy shape to exactly one owner: planning
  lifecycle recovery. Ordinary null-status held cards remain continuation-owned.
  */
  if (input.columnFlags.intake && classifyPersistedPlanHandoff(input.task, {
    now: input.now ?? Date.now(),
    hasLivePlanningWork: input.live,
    legacyStaleMs: LEGACY_NULL_PLAN_HANDOFF_STALE_MS,
    requirePersistedSteps: true,
  }) === "legacy-null") {
    return { stranded: false, candidate: false, reason: "planning-recovery-owned" };
  }
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
