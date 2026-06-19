import type { Task } from "./types.js";

export interface NoCommitsNoOpFinalizeEvaluation {
  blocked: boolean;
  reason?: string;
  doneCount: number;
  incompleteCount: number;
}

/**
 * FNXC:Lifecycle 2026-06-14-19:54:
 * FN-6461/FN-6455 showed that release and ops tasks marked `noCommitsExpected` can be silently finalized as no-op after skipping substantive steps.
 * Zero-diff finalize lanes must only trust step evidence when completed work outweighs incomplete work; ties block because a todo requeue is recoverable while dropping operational work is not.
 */
export function evaluateNoCommitsNoOpFinalize(
  task: Pick<Task, "noCommitsExpected" | "steps">,
): NoCommitsNoOpFinalizeEvaluation {
  const steps = task.steps ?? [];
  const doneCount = steps.filter((step) => step.status === "done").length;
  const incompleteCount = steps.length - doneCount;

  if (
    task.noCommitsExpected === true &&
    steps.length > 0 &&
    incompleteCount > 0 &&
    // Equal counts still block: requeueing is recoverable, but silently dropping ops work is not.
    incompleteCount >= doneCount
  ) {
    return {
      blocked: true,
      reason: `no-commits task skipped/incomplete work outweighs completed work (done=${doneCount}, incomplete=${incompleteCount}) with no net branch changes`,
      doneCount,
      incompleteCount,
    };
  }

  return {
    blocked: false,
    doneCount,
    incompleteCount,
  };
}
