import type { Task } from "../types.js";

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
 *
 * FNXC:Lifecycle 2026-07-16-14:20:
 * FN-8141 laundered a REVERTED (commit-expected) task to `done`: pi SDK bumps kept breaking verify, the work was reverted 5x, and the agent marked "Testing & Verification" + "Documentation & Delivery" skipped. The branch was empty vs main, so the AI empty-merge lane finalized it as a no-op with `mergeConfirmed:true` and no reviewer ever saw it.
 * The FN-6461 rule missed it twice: it only fired for `noCommitsExpected === true` (FN-8141 was commit-expected), and even then only when incomplete >= done (FN-8141 had 3 done vs 2 skipped).
 * New invariant: a zero-diff/no-op finalize is blocked whenever ANY step is `skipped` (empty diff + skipped step means work was never done or was reverted, so `done` is unsafe). A verification-flavored skipped step (name matching /test|verif|qa|review/i) blocks unconditionally; any other skipped step blocks unless every non-skipped step is `done` AND the task is the legacy `noCommitsExpected` ops shape. This is evaluated only at zero-diff finalize lanes, so the empty-diff condition is supplied by the caller.
 */
const VERIFICATION_STEP_NAME = /test|verif|qa|review/i;

export function evaluateNoCommitsNoOpFinalize(
  task: Pick<Task, "noCommitsExpected" | "steps">,
): NoCommitsNoOpFinalizeEvaluation {
  const steps = task.steps ?? [];
  const doneCount = steps.filter((step) => step.status === "done").length;
  const incompleteCount = steps.length - doneCount;
  const noCommitsExpected = task.noCommitsExpected === true;

  const skippedSteps = steps.filter((step) => step.status === "skipped");

  // FN-8141: skipped step + empty diff. Applies to ALL tasks regardless of `noCommitsExpected`.
  if (skippedSteps.length > 0) {
    const verificationSkipped = skippedSteps.filter((step) =>
      VERIFICATION_STEP_NAME.test(step.name ?? ""),
    );

    // A skipped verification/QA/review step over an empty diff blocks unconditionally:
    // there is no reviewer or test evidence, so `done` cannot be trusted.
    if (verificationSkipped.length > 0) {
      const names = verificationSkipped.map((step) => step.name).join(", ");
      return {
        blocked: true,
        reason: `skipped verification step(s) with no net branch changes: ${names}`,
        doneCount,
        incompleteCount,
      };
    }

    // Other skipped steps only pass for the legacy ops shape: every non-skipped step
    // completed (`done`) AND the task explicitly expected no commits. Anything else
    // (e.g. a reverted commit-expected task like FN-8141) blocks.
    const everyNonSkippedDone = steps
      .filter((step) => step.status !== "skipped")
      .every((step) => step.status === "done");
    if (!(everyNonSkippedDone && noCommitsExpected)) {
      const names = skippedSteps.map((step) => step.name).join(", ");
      return {
        blocked: true,
        reason: `skipped step(s) with no net branch changes and no operator/reviewer sign-off: ${names}`,
        doneCount,
        incompleteCount,
      };
    }
  }

  // Legacy FN-6461 rule: no-commits ops tasks whose incomplete work (incl. pending/in-progress)
  // ties or outweighs completed work must not finalize on step evidence alone.
  if (
    noCommitsExpected &&
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
