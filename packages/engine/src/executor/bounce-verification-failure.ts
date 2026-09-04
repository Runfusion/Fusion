/**
 * FNXC:VerificationRemediation 2026-08-26-04:58:
 * The bounce shape for a red deterministic verification (the FN-3345 gate in run-implementation.ts,
 * which runs `testCommand`/`buildCommand` after every planned step succeeds and BEFORE the in-review
 * handoff). A failing verification must hand the executor NAMED work to do, never a bare bounce.
 *
 * `stepReopenPolicy` decides the shape, and the two are not interchangeable:
 *
 *  - `reopen-trailing` — the workflow expects the trailing completed step to be reopened and redone
 *    in place. `sendTaskBackForFix` performs that reopen itself. This is every ordinary coding
 *    workflow (builtin:coding, builtin:coding-ideas).
 *  - `none` — the workflow declared (`parse.implementationOnlySteps` + `preserveRemediationSteps`)
 *    that remediation arrives as APPENDED named steps, so nothing may be reopened.
 *
 * The defect this seam exists to fix: `none` used to reach `sendTaskBackForFix` all the same, which
 * under that policy reopens nothing (send-task-back-for-fix.ts guards the reopen on
 * `reopen-trailing`). The task bounced back to implementation with ZERO pending steps, the foreach
 * answered `already-expanded`, and the card walked on to Code Review with the failing command
 * unaddressed — the verification result was measured, reported, and then silently discarded.
 * Measured on builtin:coding-ideas-v2, the only built-in that selects `none`.
 *
 * `appendReviewRemediationSteps` is the existing authority for the appended shape (it already serves
 * the Code Review gate). Its `Verification` branch has been caller-less since the graph's
 * `verification` node was removed, which is why the gap was invisible: the code was present and
 * correct, and nothing called it. It derives one step per file named in the failing output, widens
 * the PROMPT.md File Scope to those files, and performs the bounce ITSELF — so this path must not
 * bounce again.
 *
 * It returns a non-blocking release when it cannot derive work (unchanged normalized verification
 * evidence, out-of-scope-only evidence, or no actionable findings). Remediation waves are unbounded.
 * A follow-up `sendTaskBackForFix` would create the empty executor bounce this contract forbids, so
 * released outcomes stop here without lifecycle mutation.
 */
import type { StepReopenPolicy, Task, TaskStore, WorkflowReviewFinding } from "@fusion/core";
import type { AppendReviewRemediationOutcome } from "./append-review-remediation-steps.js";

/** What actually happened to the card, so callers and tests observe an outcome rather than a spy. */
export type VerificationBounceOutcome =
  /** Named remediation steps were appended and the executor was re-dispatched to run them. */
  | "named-remediation"
  /** Remediation refused to invent work and released the gate without lifecycle mutation. */
  | "released-non-blocking"
  /** Legacy shape retained for callers that schedule explicit trailing remediation. */
  | "reopened-trailing";

export type BounceVerificationFailureDeps = {
  store: Pick<TaskStore, "getTask">;
  appendReviewRemediationSteps: (
    task: Task,
    info: {
      stepName: string;
      feedback: string;
      phase: "pre-merge";
      status: "failed";
      nodeId: string;
    },
    options?: { worktreePath?: string },
  ) => Promise<AppendReviewRemediationOutcome>;
  sendTaskBackForFix: (
    task: Task,
    worktreePath: string,
    failureFeedback: string,
    stepName: string,
    reason: string,
    preserveResumeState: boolean,
    mergeVerificationFailure: boolean,
    retryPresentation?: { attempt: number; max?: number },
    findings?: WorkflowReviewFinding[],
    persistWorktreePath?: boolean,
    stepReopenPolicy?: StepReopenPolicy,
  ) => Promise<void>;
  clearCompletedTaskWatchdog: (taskId: string) => void;
};

export type BounceVerificationFailureParams = {
  task: Task;
  worktreePath: string;
  /** Which configured command failed — carried into the step label the executor will read. */
  failedType: "test" | "build";
  /** Command, exit code, and truncated output. Remediation mines it for the files to fix. */
  feedback: string;
  /** Human-readable cause, recorded on the legacy bounce path. */
  reason: string;
  stepReopenPolicy: StepReopenPolicy;
};

export async function bounceVerificationFailure(
  deps: BounceVerificationFailureDeps,
  params: BounceVerificationFailureParams,
): Promise<VerificationBounceOutcome> {
  const { task, worktreePath, failedType, feedback } = params;
  const stepName = `Verification (${failedType})`;

  /*
   * Re-read first: `task` is the pre-session snapshot, while remediation scope-checks the failing
   * files against `modifiedFiles` and counts existing waves off `steps`. A stale snapshot would
   * classify the executor's own just-written files as upstream work and park instead of fixing.
   */
  const liveTask = await deps.store.getTask(task.id).catch(() => task);
  /*
   * Hand over the checkout this gate just verified. Falling back to `task.worktree` would let an
   * empty pointer reach `performWorkflowRerunBounce`, which persists it — wiping the worktree the
   * remediation is about to run in.
   */
  const remediationOutcome = await deps.appendReviewRemediationSteps(
    liveTask ?? task,
    {
      stepName,
      feedback,
      phase: "pre-merge",
      status: "failed",
      nodeId: "verification",
    },
    { worktreePath },
  );
  if (remediationOutcome === "appended") return "named-remediation";
  deps.clearCompletedTaskWatchdog(task.id);
  return "released-non-blocking";
}
