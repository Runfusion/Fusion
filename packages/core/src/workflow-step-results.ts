import type { WorkflowStepResult } from "./types.js";

/*
FNXC:WorkflowStepResults 2026-07-09-00:20:
FN-7727: both engine `WorkflowStepResult` recorders (the executor graph adapter's
`recordWorkflowStepResult` and triage's `recordPlanReviewWorkflowResult`) used to
upsert by `workflowStepId` with a bare `existing[idx] = result` replace-in-place.
When self-healing (`recoverFailedPreMergeWorkflowStep` /
`recoverReviewTasksWithFailedPreMergeSteps`) sends a failed pre-merge review step
back for fix and the graph re-runs that same node, the new attempt silently
overwrote the prior `status:"failed"` record — losing its `output`/`notes`/
`verdict`/timestamps forever. This shared, PURE helper is the single upsert path
for every recorder: it snapshots a replaced `failed`/`advisory_failure` entry into
the new entry's `priorAttempts` (bounded, oldest-dropped, single-level — snapshots
never carry their own nested `priorAttempts`), and carries forward already-
accumulated history across successive re-runs. `priorAttempts` is read-only
history: callers that select "the current failed step" (self-healing selection,
`getTaskMergeBlocker`, progress/timing) must keep reading the top-level array
entries only and never flatten/inspect `priorAttempts` for that purpose.
*/

/** Default cap on the number of prior terminal-failure attempts retained per step. */
export const MAX_WORKFLOW_STEP_PRIOR_ATTEMPTS = 5;

const TERMINAL_FAILURE_STATUSES: ReadonlySet<WorkflowStepResult["status"]> = new Set([
  "failed",
  "advisory_failure",
]);

function isTerminalFailure(result: WorkflowStepResult): boolean {
  return TERMINAL_FAILURE_STATUSES.has(result.status);
}

/**
 * Strip a result down to a single-level history snapshot: its own
 * `priorAttempts` are dropped so nesting never grows beyond one level deep.
 */
function toSnapshot(result: WorkflowStepResult): WorkflowStepResult {
  if (!result.priorAttempts || result.priorAttempts.length === 0) return result;
  const { priorAttempts: _drop, ...rest } = result;
  return rest as WorkflowStepResult;
}

/**
 * Pure upsert of a `WorkflowStepResult` by `workflowStepId`, preserving a
 * bounded history of prior terminal-failure attempts on the surviving entry.
 *
 * - Absent → the incoming result is appended.
 * - Present → the existing entry is replaced IN PLACE (array position
 *   preserved). The existing entry's already-accumulated `priorAttempts` are
 *   carried forward onto the incoming result. If the existing entry represents
 *   a DIFFERENT attempt (deduped by `startedAt` — a same-run `pending`→`failed`
 *   transition of the same attempt is not a new attempt) and its status is a
 *   terminal failure (`failed` | `advisory_failure`), a single-level snapshot
 *   of it is pushed onto the incoming result's `priorAttempts`.
 * - `priorAttempts` is bounded to `opts.maxPriorAttempts` (default
 *   `MAX_WORKFLOW_STEP_PRIOR_ATTEMPTS`), newest-first, oldest dropped.
 *
 * Never mutates `existing` or `incoming`; always returns a new array.
 */
export function upsertWorkflowStepResult(
  existing: WorkflowStepResult[] | undefined,
  incoming: WorkflowStepResult,
  opts?: { maxPriorAttempts?: number },
): WorkflowStepResult[] {
  const maxPriorAttempts = opts?.maxPriorAttempts ?? MAX_WORKFLOW_STEP_PRIOR_ATTEMPTS;
  const source = existing ?? [];
  const idx = source.findIndex((r) => r.workflowStepId === incoming.workflowStepId);

  if (idx < 0) {
    const next = [...source];
    next.push({ ...incoming });
    return next;
  }

  const previous = source[idx];
  const isSameAttempt = previous.startedAt !== undefined
    && incoming.startedAt !== undefined
    && previous.startedAt === incoming.startedAt;

  let priorAttempts = previous.priorAttempts ? [...previous.priorAttempts] : [];
  if (!isSameAttempt && isTerminalFailure(previous)) {
    priorAttempts = [toSnapshot(previous), ...priorAttempts];
  }
  if (priorAttempts.length > maxPriorAttempts) {
    priorAttempts = priorAttempts.slice(0, maxPriorAttempts);
  }

  const replacement: WorkflowStepResult = { ...incoming };
  if (priorAttempts.length > 0) {
    replacement.priorAttempts = priorAttempts;
  } else {
    delete replacement.priorAttempts;
  }

  const next = [...source];
  next[idx] = replacement;
  return next;
}
