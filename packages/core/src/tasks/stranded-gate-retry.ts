import type { Task } from "../types.js";
import type { WorkflowIr, WorkflowIrV2 } from "../workflows/workflow-ir-types.js";
import { resolveColumnFlags } from "../workflows/trait-registry.js";
import { resolveRequiredPreMergeStepIds } from "../merge/required-pre-merge-steps.js";
import { findVerdictLessFailedRequiredGates, isVerdictLessFailedGateRow } from "../merge/pre-merge-approval.js";
import { workflowDeclaresColumnModel } from "../workflows/workflow-transitions.js";
import { buildManualRetryResetPatch, type ManualRetryResetPatch } from "./manual-retry-reset.js";
import { resolveWorkflowIrForTask } from "../workflows/workflow-ir-resolver.js";

/*
FNXC:StrandedGateRetry 2026-10-13 (STAS-299, from the STAS-281 stall):
Self-heal can declare a review session dead (`FN-8492`) and flip its `pending` gate row to `failed`
while the card itself still sits in its hold lane with an approved plan and an untouched step list.
That card's only failure evidence is plumbing: nobody ever produced a verdict, so no reviewer opinion
is being overturned by running the gate again (RUFU-217's verdict-less class says the same thing
about the merge door).

Two things were wrong with what happened next. Each retry surface re-derived its own idea of what is
retryable, so an agent's `fn_task_retry`, the CLI, the chat tool and the board's Retry button could
answer one card four ways — the exact FNXC:WorkflowLifecycleColumns defect class. And the board's
answer for this shape was the worst available one: the locked stage restart serves a hold-lane card
with `scope: "plan"`, which stamps `needs-replan`, empties the step list, clears the approved-plan
fingerprint and force-deletes PROMPT.md. A card whose review session hiccuped would lose the plan its
reviewer was reading, and `needs-replan` refuses every release mode in `evaluateUnplannedForExecution`
— the retry would have traded one dead zone for a permanent one.

This module is the ONE classification and the ONE patch for that shape. Every retry surface consumes
it, so the answer cannot differ by surface and cannot be destructive by accident.
*/

/**
 * Statuses that still mean "nothing owns this card's recovery". A card with no status at all is the
 * pre-STAS-299 stranded shape and must be rescuable too; any other status was written by a lane that
 * still owns the card (replan, approval, merge in flight) and keeps its own un-park.
 */
function statusIsStranded(status: Task["status"] | undefined | null): boolean {
  return status === undefined || status === null || status === "failed" || status === "stuck-killed";
}

export type StrandedGateRetryClassification =
  | { kind: "stranded-gate"; gateStepIds: string[] }
  | { kind: "not-stranded"; reason: StrandedGateRetryRefusal };

/** Why a card is NOT this retry class — so a retry surface can answer "why not", not just "no". */
export type StrandedGateRetryRefusal =
  | "legacy-board"
  | "unknown-column"
  | "lane-owns-its-own-recovery"
  | "status-owned-by-another-lane"
  | "no-approved-plan"
  | "no-verdict-less-required-gate";

/**
 * Whether the card is parked by plumbing alone: it dwells in a pre-execution (hold/intake) lane,
 * still holds the plan its reviewer approved, and its only failure evidence is a required gate row
 * that failed with no verdict.
 *
 * Deliberately narrow, and each refusal names the leg that failed: a WIP/review/complete card is
 * owned by the execution, in-review, or merge recovery lanes; a card carrying any other status
 * belongs to the lane that stamped it (`needs-replan` and friends keep their destructive restart);
 * and a gate row with an authored REVISE is the remediation lane, never a re-run.
 */
export type StrandedGateRetryTask = Pick<Task,
  | "id"
  | "column"
  | "status"
  | "approvedPlanFingerprint"
  | "workflowStepResults"
  | "enabledWorkflowSteps"
  | "repositoryScope"
  | "executionMode"
  | "humanPlanApproval">;

export function classifyStrandedGateRetry(input: {
  task: StrandedGateRetryTask;
  ir: WorkflowIr | undefined;
}): StrandedGateRetryClassification {
  const { task, ir } = input;
  if (!ir || !workflowDeclaresColumnModel(ir)) return { kind: "not-stranded", reason: "legacy-board" };
  const column = (ir as WorkflowIrV2).columns?.find((entry) => entry.id === task.column);
  if (!column) return { kind: "not-stranded", reason: "unknown-column" };

  const flags = resolveColumnFlags(column);
  const isPreExecutionLane = (flags.hold === true || flags.intake === true)
    && flags.countsTowardWip !== true
    && flags.mergeBlocker !== true
    && flags.humanReview !== true
    && flags.complete !== true;
  if (!isPreExecutionLane) return { kind: "not-stranded", reason: "lane-owns-its-own-recovery" };

  if (!statusIsStranded(task.status)) return { kind: "not-stranded", reason: "status-owned-by-another-lane" };
  if (!task.approvedPlanFingerprint) return { kind: "not-stranded", reason: "no-approved-plan" };

  const requiredPreMergeStepIds = resolveRequiredPreMergeStepIds(ir, task.enabledWorkflowSteps, task);
  const gateStepIds = findVerdictLessFailedRequiredGates(task, { requiredPreMergeStepIds });
  if (gateStepIds.length === 0) return { kind: "not-stranded", reason: "no-verdict-less-required-gate" };

  return { kind: "stranded-gate", gateStepIds };
}

/**
 * Classify against the card's OWN workflow, resolved from the store it lives in.
 *
 * Retry surfaces hold a TaskStore, not an IR, and each of them resolving the IR themselves is how
 * two surfaces end up classifying the same card against two different boards (FNXC:StateMachine
 * 2026-07-31-20:10 measured a sync resolver answering with the DEFAULT workflow for every
 * PostgreSQL task). One call, one IR source, one answer.
 *
 * An unresolvable workflow classifies as `legacy-board` rather than throwing: the surface then keeps
 * the retry behavior it already had, so the new class can only ever ADD a non-destructive route.
 */
export async function classifyStrandedGateRetryForTask(
  store: Parameters<typeof resolveWorkflowIrForTask>[0],
  task: StrandedGateRetryTask,
): Promise<StrandedGateRetryClassification> {
  const ir = await resolveWorkflowIrForTask(store, task.id).catch(() => undefined);
  return classifyStrandedGateRetry({ task, ir });
}

/**
 * The non-destructive re-queue patch for a classified card: the shipped manual-retry reset (the same
 * episode/counter clears every Retry surface already applies), the failure state cleared, and the
 * verdict-less gate rows dropped so the graph's own gate can be evaluated again — a dropped required
 * gate reads as `missing`, which is the admission half of the bounded-fresh-run recovery lanes.
 *
 * Dropping the row is the same row-level discard the locked column restart already performs for the
 * nodes of the column it restarts (`shouldDiscard` in `task-column-restart.ts`), narrowed here to
 * exactly the verdict-less gate rows — strictly less destructive than what the board's Retry button
 * does to this card today. Everything that makes the card re-runnable without re-planning — lane,
 * step list, `currentStep`, approved-plan fingerprint, PROMPT.md, worktree and branch — is left
 * untouched, because preserving them is the entire point of the class.
 */
export function buildStrandedGateRetryPatch(
  task: Pick<Task, "workflowStepResults">,
  gateStepIds: readonly string[],
): ManualRetryResetPatch {
  const gateIdSet = new Set(gateStepIds);
  const workflowStepResults = (task.workflowStepResults ?? []).filter(
    (result) => !(gateIdSet.has(result.workflowStepId) && isVerdictLessFailedGateRow(result)),
  );
  return {
    ...buildManualRetryResetPatch({ resetMergeRetries: true }),
    status: null as unknown as Task["status"],
    error: null as unknown as Task["error"],
    workflowStepResults,
  };
}
