import type { Task } from "@fusion/core";

/** A bounded, operator-safe description of a task that cannot make progress. */
export interface TaskWedgeDescriptor {
  reasonKey: string;
  reason: string;
  action: string;
  gate?: string;
}

/**
 * FNXC:TaskWedgeNotifications 2026-07-22-14:30:
 * Self-healing can deliberately decline a backward move without mutating task
 * status. These bounded stage keys make that ownerless escalation visible through
 * the same durable episode seam as failed and paused terminal parks.
 */
const SELF_HEALING_NO_ACTIONS: Record<string, Omit<TaskWedgeDescriptor, "reasonKey">> = {
  "reclaim-pr-conflict": {
    reason: "Self-healing could not reclaim a stalled pull-request conflict.",
    action: "Inspect the branch conflict and retry or reset the task to todo.",
  },
  "reclaim-self-owned-branch-conflict": {
    reason: "Self-healing could not recover a stalled branch conflict.",
    action: "Inspect the branch conflict and retry or reset the task to todo.",
  },
  "reconcile-in-review-unmet-dependencies": {
    reason: "Unmet dependencies are preventing review from progressing.",
    action: "Resolve the dependencies, then retry or reset the task to todo.",
  },
  "reconcile-dependency-blocking-lease": {
    reason: "A dependency-blocking task lease could not be safely reclaimed.",
    action: "Inspect the task owner and lease, then retry or reset the task to todo.",
  },
  "auto-rebound-paused-scope-decay": {
    reason: "A paused task with stale scope could not be safely resumed.",
    action: "Inspect the task scope and retry or reset the task to todo.",
  },
  "stuck-merge-deadlock": {
    reason: "A merge deadlock needs operator intervention.",
    action: "Inspect merge ownership and retry or reset the task to todo.",
  },
  "missing-worktree-merge-active": {
    reason: "An active merge has an unusable worktree and could not be recovered.",
    action: "Repair the worktree or reset the task to todo and retry.",
  },
  "missing-worktree-review": {
    reason: "Review has an unusable worktree and could not be recovered.",
    action: "Repair the worktree or reset the task to todo and retry.",
  },
  "finalize-no-op-review": {
    reason: "A no-op review task could not be safely finalized.",
    action: "Inspect merge state and retry or reset the task to todo.",
  },
  "stale-incomplete-review": {
    reason: "Incomplete review work could not be safely resumed.",
    action: "Inspect incomplete steps and retry or reset the task to todo.",
  },
  "ghost-review": {
    reason: "A review task has no recoverable workflow owner.",
    action: "Inspect workflow state and retry or reset the task to todo.",
  },
  "no-progress-no-task-done": {
    reason: "Execution stopped without progress and could not be safely requeued.",
    action: "Inspect the task worktree and retry or reset the task to todo.",
  },
  "partial-progress-no-task-done": {
    reason: "Partial execution progress could not be safely resumed.",
    action: "Inspect partial work and retry or reset the task to todo.",
  },
};

/** Returns an actionable descriptor only for an ownerless self-healing escalation. */
export function describeSelfHealingNoActionWedge(task: Task, stage: string, metadata: Record<string, unknown> | undefined): TaskWedgeDescriptor | null {
  const description = SELF_HEALING_NO_ACTIONS[stage];
  if (!description || task.userPaused || task.paused || task.autoMerge === false) return null;
  // Test and legacy proof producers may omit metadata; absent ownership evidence
  // remains ownerless rather than turning best-effort notification into a park failure.
  const proof = metadata ?? {};
  // These proof signals mean a live executor, checkout, or queued merge owns the task.
  if (proof.taskActive === true || proof.hasExecutingTaskLock === true || proof.mergePending === true) return null;
  if (Array.isArray(proof.livePaths) && proof.livePaths.length > 0) return null;
  return { reasonKey: `self-healing-no-action:${stage}`, ...description };
}

/*
FNXC:TaskWedgeNotifications 2026-07-22-12:00:
Terminal task updates are the shared delivery seam for merger, executor, heartbeat,
and self-healing writers. Classify only states that have no scheduled owner; raw
error output is never used as an idempotency key or forwarded into audit metadata.
*/
export function describeTaskWedge(task: Task): TaskWedgeDescriptor | null {
  const error = task.error ?? "";
  if (task.pausedReason === "completed-blocked") {
    return { reasonKey: "completion-blocked", reason: "Completed work is blocked from advancing to review.", action: "Clear the blocker or reset the task to todo." };
  }
  if (task.pausedReason === "error-retry-exhausted") {
    return { reasonKey: "heartbeat-retry-exhausted", reason: "The assigned agent exhausted its heartbeat recovery budget.", action: "Repair the agent configuration, then retry the task." };
  }
  if (task.pausedReason === "error-unrecoverable") {
    return { reasonKey: "heartbeat-error-unrecoverable", reason: "The assigned agent needs operator repair before it can resume.", action: "Repair credentials, access, or configuration, then retry the task." };
  }
  /*
  FNXC:TaskWedgeNotifications 2026-07-22-19:00:
  Branch and remediation safety parks deliberately stop automatic recovery. They
  are actionable terminal writers rather than user-controlled approval pauses.
  Keep their reason keys stable so a changed safety failure opens a new episode.
  */
  const pausedDescriptors: Record<string, TaskWedgeDescriptor> = {
    "branch-cross-contamination": { reasonKey: "branch-cross-contamination", reason: "Branch contamination recovery requires operator intervention.", action: "Inspect the branch history, repair the contamination, then retry or reset to todo." },
    "branch-conflict-tripwire": { reasonKey: "branch-conflict-tripwire", reason: "A repeated branch conflict stopped automatic recovery.", action: "Resolve the branch conflict, then retry or reset to todo." },
    "branch-conflict-recovery-exhausted": { reasonKey: "branch-conflict-recovery-exhausted", reason: "Branch conflict recovery retries were exhausted.", action: "Resolve the conflict, then retry or reset to todo." },
    "branch-conflict-unrecoverable": { reasonKey: "branch-conflict-unrecoverable", reason: "An unrecoverable branch conflict needs operator intervention.", action: "Resolve the conflict or reset the task to todo and retry." },
    "stuck-loop-exhausted-manual-intervention-required": { reasonKey: "stuck-loop-exhausted", reason: "Self-healing exhausted its stalled-task recovery loop.", action: "Inspect the task state, then retry or reset to todo." },
    "non-retryable-provider-error": { reasonKey: "non-retryable-provider-error", reason: "A non-retryable provider error stopped the task.", action: "Repair provider access or configuration, then retry the task." },
    "in-review-stall-deadlock": { reasonKey: "in-review-stall-deadlock", reason: "Review stalled in a deadlock that needs operator intervention.", action: "Inspect review ownership and retry or reset to todo." },
  };
  if (task.pausedReason && pausedDescriptors[task.pausedReason]) return pausedDescriptors[task.pausedReason];
  if (task.status !== "failed") return null;
  if (error.startsWith("EXECUTION_DISPATCH_LOOP_EXHAUSTED")) {
    return { reasonKey: "execution-dispatch-loop-exhausted", reason: "Execution re-queued without progress until its retry budget was exhausted.", action: "Retry, decompose, or rescope the task." };
  }
  if (error.includes("tool failure") || error.includes("Tool failure")) {
    return { reasonKey: "tool-failure-retry-exhausted", reason: "Execution tool-failure retries were exhausted.", action: "Inspect the failing tool and retry the task." };
  }
  if (/escalat(?:ion|ed).*exhaust|exhaust.*escalat/i.test(error)) {
    return { reasonKey: "execution-escalation-exhausted", reason: "The alternate execution escalation was exhausted.", action: "Inspect the failure and retry or rescope the task." };
  }
  if (/review.*(?:retry|rework|revision).*(?:exhaust|limit)|(?:exhaust|limit).*review/i.test(error)) {
    return { reasonKey: "review-retry-exhausted", reason: "The configured review recovery budget was exhausted.", action: "Review the feedback, fix the task, or use the approved review recovery action." };
  }
  const gate = error.match(/check:([\w:-]+)/)?.[1];
  if (gate) {
    return {
      reasonKey: `merge-blocked:${gate}`,
      reason: `Merge is blocked by the check:${gate} verification gate.`,
      action: gate === "changeset-format" ? "Fix the changeset format, then retry the task." : "Fix the failing gate or reset the task to todo and retry.",
      gate: `check:${gate}`,
    };
  }
  if (error.startsWith("BLOCKED:")) {
    return { reasonKey: "execution-blocked", reason: "Execution was parked because an external blocker requires operator action.", action: "Resolve the dependency or blocker, then retry the task." };
  }
  if (/merge.*(?:blocked|verification|gate)|(?:verification|gate).*(?:failed|exhaust)/i.test(error)) {
    return { reasonKey: "merge-blocked", reason: "Merge verification cannot progress without operator action.", action: "Fix the failing verification, then retry the task." };
  }
  /*
  FNXC:TaskWedgeNotifications 2026-07-22-20:00:
  An opaque failure or exhausted merge-retry budget is terminal evidence when no
  named writer classified it. NotificationService checks FN-5627 transient merge
  failures before calling this classifier, preserving self-healing ownership.
  Failures without either signal retain the generic grace path because recovery
  may still own them.
  */
  if (!error && (task.mergeRetries ?? 0) < 3) return null;
  return {
    reasonKey: "terminal-failed",
    reason: "The task entered a terminal failed state and needs operator intervention.",
    action: "Inspect the task error, fix the underlying issue, then retry or reset to todo.",
  };
}
