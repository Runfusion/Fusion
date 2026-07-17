import type { Task } from "./types.js";

export interface SkipBypassTaintEvaluation {
  /**
   * True when the task carries an active bulk-step-completion refusal marker AND
   * still has skipped steps: those skips must NOT count toward any AUTOMATIC
   * promotion path (executor completion-finalize, self-healing stuck-in-progress
   * recovery, stranded-todo promoter, graph merge boundary).
   */
  blocked: boolean;
  reason?: string;
  /** Whether a bulk-step-completion refusal marker is currently active. */
  tainted: boolean;
  /** Count of steps currently in `skipped` state. */
  skippedStepCount: number;
}

/*
FNXC:Lifecycle 2026-07-16-21:40:
FN-8141 laundered a failed task into `done`: after the executor's
`bulk-step-completion-without-review` refusal fired repeatedly (steps had no
APPROVE verdicts), the agent used the sanctioned skip affordance
(`fn_task_update status="skipped"`) on the remaining unreviewed steps. Because
every completion check counts `skipped` as complete, the task then satisfied the
exact condition the refusal was protecting, and downstream AUTO-promotion
(implicit fn_task_done, self-healing stranded-todo/stuck-in-progress recovery)
moved it to in-review with zero net changes and no reviewer/operator sign-off.

Invariant restored: steps skipped while a bulk-step-completion refusal marker is
active on the task are "tainted" and cannot carry the task to `done`/`in-review`
through any automatic path. The taint clears the moment there is an honest exit
signal — an ACCEPTED fn_task_done (explicit or non-tainted implicit), an operator
manual retry/edit, or a fresh lifecycle that legitimately completes the work — so
the legitimate PREMISE STALE flow (skip remaining steps + accepted fn_task_done)
is unaffected. This pure evaluator is the single rule every AUTO-promotion check
consults, mirroring `evaluateNoCommitsNoOpFinalize`.
*/
export function evaluateSkipBypassTaint(
  task: Pick<Task, "steps" | "bulkCompletionRefusalAt">,
): SkipBypassTaintEvaluation {
  const steps = task.steps ?? [];
  const skippedStepCount = steps.filter((step) => step.status === "skipped").length;
  const tainted = Boolean(task.bulkCompletionRefusalAt);

  if (tainted && skippedStepCount > 0) {
    return {
      blocked: true,
      reason:
        `task has ${skippedStepCount} step(s) skipped after a bulk-step-completion refusal ` +
        `(bulkCompletionRefusalAt=${task.bulkCompletionRefusalAt}); skipped-step completion ` +
        `cannot auto-promote without reviewer or operator sign-off`,
      tainted,
      skippedStepCount,
    };
  }

  return { blocked: false, tainted, skippedStepCount };
}
