/**
 * FNXC:CodeOrganization 2026-08-03-18:30:
 * reopenLastStepForRevision peeled from TaskExecutor (U4).
 *
 * FNXC:WorkflowStepReopenAuthority 2026-08-23-08:51:
 * FN-180 requires the workflow-resolved replay policy to be the only authority after a review
 * rejection. Step-title heuristics created a second authority that could make a confirmed merge's
 * checklist stale. A permitted replay targets exactly the last actionable completed step; workflows
 * that must preserve remediation steps select the `none` policy before reaching this helper.
 *
 * FNXC:WorkflowStepReopenAuthority 2026-08-28-15:11:
 * A completed step is immutable execution history. The single replay authority appends a new pending
 * occurrence instead of rewriting the completed occurrence, while existing pending work prevents
 * duplicate growth.
 *
 * FNXC:ReviewRemediationBudget 2026-09-08-01:02:
 * When failed-review recovery supplies accounting, the trailing replay is published through the
 * project-scoped remediation fence. The replay, ledger reopen marker, keyed attempt, and aggregate
 * increment are indivisible; an exhausted, superseded, or duplicate request changes none of them.
 */
import { buildStepLedgerReopenLog, type RunMutationContext, type Task, type TaskStore } from "@fusion/core";
import {
  countOptionalStepRevisionAttempts,
  hasReviewRemediationAttemptForEpisode,
  optionalStepRevisionLogOutcome,
  reviewRemediationEpisodeIdentity,
} from "./optional-step-revision.js";
import { reviewInputSignature } from "./request-pre-merge-optional-step-fix.js";

export type TrailingReplayAccounting = {
  revisionKey: string;
  stepName: string;
  status: string;
  maxRevisions: number | "unbounded";
  expectedWorkflowStepId: string;
  /** Legacy content-review signature retained for adapter compatibility. */
  expectedReviewSignature?: string;
  expectedReviewEpisodeIdentity?: string;
  expectedColumn?: string;
  expectedStatus?: Task["status"];
  runContext?: RunMutationContext;
};

export type TrailingReplayAccountingOutcome =
  | { kind: "appended"; replay: { index: number; name: string; indexes: number[] } }
  | { kind: "already-committed" }
  | { kind: "budget-exhausted" | "superseded" | "duplicate-no-new-work" | "unavailable" };

export async function reopenLastStepForRevision(
  store: TaskStore,
  taskId: string,
  _task: Task,
): Promise<{ index: number; name: string; indexes: number[] } | null>;
export async function reopenLastStepForRevision(
  store: TaskStore,
  taskId: string,
  _task: Task,
  accounting: TrailingReplayAccounting,
): Promise<TrailingReplayAccountingOutcome>;
export async function reopenLastStepForRevision(
  store: TaskStore,
  taskId: string,
  _task: Task,
  accounting?: TrailingReplayAccounting,
): Promise<{ index: number; name: string; indexes: number[] } | null | TrailingReplayAccountingOutcome> {
  let replay: { index: number; name: string; indexes: number[] } | null = null;
  let refusal: TrailingReplayAccountingOutcome["kind"] = "duplicate-no-new-work";
  const initialExpected = accounting
    ? (_task.workflowStepResults ?? []).find((result) =>
        result.workflowStepId === accounting.expectedWorkflowStepId && result.status === "failed",
      )
    : undefined;
  const expectedEpisodeIdentity = accounting?.expectedReviewEpisodeIdentity
    ?? (initialExpected ? reviewRemediationEpisodeIdentity(initialExpected) : undefined);
  const expectedColumn = accounting?.expectedColumn ?? _task.column;
  const expectedStatus = accounting?.expectedStatus ?? _task.status;

  const mutate = (current: Task) => {
    if (accounting) {
      const expected = (current.workflowStepResults ?? []).find((result) =>
        result.workflowStepId === accounting.expectedWorkflowStepId && result.status === "failed",
      );
      const legacySignatureMatches = accounting.expectedReviewSignature === undefined
        || (expected !== undefined && (reviewInputSignature(expected) ?? "") === accounting.expectedReviewSignature);
      if (current.deletedAt || current.paused || current.userPaused || current.autoMerge === false
        || current.column !== expectedColumn || current.status !== expectedStatus
        || !expectedEpisodeIdentity || !expected
        || reviewRemediationEpisodeIdentity(expected) !== expectedEpisodeIdentity
        || !legacySignatureMatches) {
        refusal = "superseded";
        return null;
      }
    }

    const steps = current.steps ?? [];
    if (steps.length === 0 || steps.every((step) => step.status === "pending")) {
      return accounting ? null : { currentStep: 0 };
    }
    if (steps.some((step) => step.status === "pending")) {
      if (accounting && expectedEpisodeIdentity && hasReviewRemediationAttemptForEpisode(current, expectedEpisodeIdentity)) {
        refusal = "already-committed";
      }
      return null;
    }
    if (accounting) {
      const attempts = countOptionalStepRevisionAttempts(current, accounting.revisionKey, accounting.stepName);
      if (accounting.maxRevisions !== "unbounded" && attempts >= accounting.maxRevisions) {
        refusal = "budget-exhausted";
        return null;
      }
    }

    const trailing = steps.at(-1)!;
    const index = steps.length;
    replay = { index, name: trailing.name, indexes: [index] };
    const attemptCount = accounting
      ? countOptionalStepRevisionAttempts(current, accounting.revisionKey, accounting.stepName)
      : 0;
    const attemptEntry = accounting ? {
      timestamp: new Date().toISOString(),
      action: `Auto-reviving in-review task with failed pre-merge workflow step (attempt ${attemptCount + 1}/${accounting.maxRevisions})`,
      outcome: optionalStepRevisionLogOutcome(
        `Step: ${accounting.stepName}\nStatus: ${accounting.status}`,
        accounting.revisionKey,
        expectedEpisodeIdentity,
      ),
      ...(accounting.runContext ? { runContext: accounting.runContext } : {}),
    } : undefined;
    const logWithAttempt = [...(current.log ?? []), ...(attemptEntry ? [attemptEntry] : [])];
    const log = buildStepLedgerReopenLog(
      logWithAttempt,
      `trailing replay step ${index} (${trailing.name}) appended after completion`,
    );
    return {
      steps: [...steps, { name: trailing.name, status: "pending" as const }],
      currentStep: index,
      ...(attemptEntry || log ? { log: log ?? logWithAttempt } : {}),
      ...(accounting ? { postReviewFixCount: (current.postReviewFixCount ?? 0) + 1 } : {}),
    };
  };

  if (accounting) {
    const publish = store.publishReviewRemediationFenced?.bind(store);
    if (!publish) return { kind: "unavailable" };
    const outcome = await publish(taskId, mutate);
    if (!outcome.applied || !replay) {
      return { kind: !outcome.applied && "reason" in outcome && outcome.reason === "unavailable" ? "unavailable" : refusal };
    }
    return { kind: "appended", replay };
  }

  await store.updateTaskAtomic(taskId, mutate);
  return replay;
}
