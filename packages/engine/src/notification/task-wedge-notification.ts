import {
  buildTaskExternalBlockReport,
  classifyTerminalFailureAutoRecovery,
  isPreMergeStepsNotRunRefusal,
  PRE_MERGE_STEPS_NOT_RUN_BLOCKER,
  type TaskExternalBlockReport,
  type TaskStallReasonCode,
  type TerminalFailureAutoRecoveryDecision,
  type Task,
} from "@fusion/core";
import { hasTransientMergeRecoveryOwner } from "../errors/transient-merge-error-classifier.js";
import { NO_PROGRESS_REQUEUE_BUDGET_EXHAUSTED_PREFIX } from "../healing/no-progress-requeue-budget.js";
import { describeWorkflowPrincipalFenceRequirement, getPlanningFencePark } from "../planning-handoff-recovery.js";

/** A bounded, operator-safe description of a task that cannot make progress. */
export interface TaskWedgeDescriptor {
  reasonKey: string;
  reason: string;
  action: string;
  gate?: string;
  /** Present only for an accepted external-block freeze; never use raw task error prose. */
  externalBlockReport?: TaskExternalBlockReport;
}

/** Durable evidence that a failed snapshot remains assigned to a bounded automatic recovery path. */
export interface TaskRecoveryOwner {
  kind: "scheduled-recovery" | "transient-merge-retry";
}

/*
FNXC:TaskWedgeNotifications 2026-08-05-04:53:
Mailbox and push wedge alerts mean an operator must act. A failed snapshot with
both scheduler retry fields, or an in-budget transient-merge retry marker, is
still owned by Fusion and must not create an actionable notification episode.
*/
export function describeTaskRecoveryOwner(task: Task): TaskRecoveryOwner | null {
  if (hasTransientMergeRecoveryOwner(task)) return { kind: "transient-merge-retry" };
  if (
    typeof task.recoveryRetryCount === "number"
    && Number.isInteger(task.recoveryRetryCount)
    && task.recoveryRetryCount >= 0
    && typeof task.nextRecoveryAt === "string"
    && Number.isFinite(Date.parse(task.nextRecoveryAt))
  ) {
    return { kind: "scheduled-recovery" };
  }
  return null;
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
  /*
  FNXC:TaskWedgeNotifications 2026-08-10-04:35:
  A declined self-healing move is actionable only when its proof says the card is
  ownerless. A live session, recent activity, or intentional pause/auto-merge-off
  hold means the card is working or deliberately waiting, not parked. Keep a
  usable worktree alerting: with a dead session and stale activity it is evidence
  of a genuinely stuck card, not progress.
  */
  if (
    proof.sessionDead === false
    || proof.noRecentActivity === false
    || proof.taskActive === true
    || proof.hasExecutingTaskLock === true
    || proof.mergePending === true
    || proof.reason === "paused-guard"
    || proof.reason === "auto-merge-processing-disabled"
  ) return null;
  if (Array.isArray(proof.livePaths) && proof.livePaths.length > 0) return null;
  return { reasonKey: `self-healing-no-action:${stage}`, ...description };
}

/*
FNXC:TaskWedgeNotifications 2026-08-09-06:30:
Resume paths deliberately retain pause markers for await-input and CLI-approval
protocols. A stale marker without real pause state, or any actively progressing
lifecycle state, is not an operator-actionable terminal wedge.
*/
export function isTaskProgressing(task: Task): boolean {
  return task.paused !== true
    && task.status !== "paused"
    && ["queued", "planning", "in-progress", "reviewing", "merging", "merging-pr", "merging-fix", "merged", "done"].includes(task.status ?? "");
}

/*
FNXC:TaskWedgeNotifications 2026-07-22-12:00:
Terminal task updates are the shared delivery seam for merger, executor, heartbeat,
and self-healing writers. Classify only states that have no scheduled owner; raw
error output is never used as an idempotency key or forwarded into audit metadata.
*/
/*
FNXC:TaskWedgeNotifications 2026-08-10-18:54:
Core owns only the durable budget rules. The generic failure classification stays here so
specific terminal descriptors cannot drift from notification withholding or self-healing.
A past display mirror is not a live recovery owner for this adapter.
*/
export function classifyTerminalFailureAutoRecoveryForTask(
  task: Task,
  options: { autoRecoveryEnabled: boolean; inTerminalSuccessColumn?: boolean; isDeletedOrHistorical?: boolean; now?: number },
): TerminalFailureAutoRecoveryDecision {
  const now = options.now ?? Date.now();
  const nextRecoveryAt = Date.parse(task.nextRecoveryAt ?? "");
  return classifyTerminalFailureAutoRecovery(task, {
    isGenericTerminalFailure: describeTaskWedge(task)?.reasonKey === "terminal-failed",
    hasRecoveryOwner: describeTaskRecoveryOwner(task) !== null && Number.isFinite(nextRecoveryAt) && nextRecoveryAt > now,
    isProgressing: isTaskProgressing(task),
    inTerminalSuccessColumn: options.inTerminalSuccessColumn === true,
    isDeletedOrHistorical: options.isDeletedOrHistorical === true || task.deletedAt != null,
    autoRecoveryEnabled: options.autoRecoveryEnabled,
    now: () => now,
  });
}

export function shouldWithholdWedgeAlertForAutoRecovery(task: Task, options: { autoRecoveryEnabled: boolean }): boolean {
  const decision = classifyTerminalFailureAutoRecoveryForTask(task, options);
  return decision.action === "retry" || (decision.action === "skip" && decision.reason === "escalation-already-delivered");
}

export function describeTaskWedge(task: Task): TaskWedgeDescriptor | null {
  if (isTaskProgressing(task)) return null;
  /*
  FNXC:ExternalBlockMailbox 2026-09-22-02:24:
  Only the classified durable freeze can open an external-block mailbox episode. Missing graph
  evidence and recovery-owned failures never reach this branch, so notification cannot become a
  second recovery authority or weaken merge-boundary proof.
  */
  if (
    task.status === "blocked"
    && task.paused === true
    && task.pausedReason === "external-block"
    && task.userPaused !== true
    && task.autoMerge !== false
    && task.externalBlock
  ) {
    const report = buildTaskExternalBlockReport(task.externalBlock, task.externalBlock.report);
    return {
      reasonKey: `external-block:${task.externalBlock.origin}:${task.externalBlock.code}`,
      reason: report.stopReason,
      action: report.unblockCondition,
      externalBlockReport: report,
    };
  }
  const error = task.error ?? "";
  const fencePark = getPlanningFencePark(task);
  const hasPauseProof = task.paused === true || task.status === "paused";
  if (hasPauseProof && task.pausedReason === "completed-blocked") {
    return { reasonKey: "completion-blocked", reason: "Completed work is blocked from advancing to review.", action: "Clear the blocker or reset the task to todo." };
  }
  if (hasPauseProof && task.pausedReason === "error-retry-exhausted") {
    return { reasonKey: "heartbeat-retry-exhausted", reason: "The assigned agent exhausted its heartbeat recovery budget.", action: "Repair the agent configuration, then retry the task." };
  }
  if (hasPauseProof && task.pausedReason === "error-unrecoverable") {
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
  if (hasPauseProof && task.pausedReason && pausedDescriptors[task.pausedReason]) return pausedDescriptors[task.pausedReason];
  if (task.status !== "failed") return null;
  if (error.startsWith("EXECUTION_DISPATCH_LOOP_EXHAUSTED")) {
    return { reasonKey: "execution-dispatch-loop-exhausted", reason: "Execution re-queued without progress until its retry budget was exhausted.", action: "Retry, decompose, or rescope the task." };
  }
  /*
  FNXC:TaskWedgeNotifications 2026-08-21-15:44:
  #3496's sentinel must precede preserved failure text matchers. Otherwise the
  terminal owner treats this park as generic, clears error, and restarts the loop.
  */
  if (error.startsWith(NO_PROGRESS_REQUEUE_BUDGET_EXHAUSTED_PREFIX)) {
    return { reasonKey: "no-progress-requeue-budget-exhausted", reason: "Self-healing exhausted its no-progress requeue budget.", action: "Repair the environment or task, then retry the task." };
  }
  /*
  FNXC:PlanningFenceRecovery 2026-10-02-01:20 (RUFU-288):
  A planning card exhausted by workflow-principal fence refusal used to fall through every matcher here
  into the generic `terminal-failed` descriptor, which cost the same two things RUFU-276 measured for the
  not-run class: the operator read "terminal failed, inspect the error" for a condition that is not about
  the spec at all, and — because `classifyTerminalFailureAutoRecoveryForTask` derives
  `isGenericTerminalFailure` from exactly this reason key — automatic recovery claimed a card it can never
  advance, so `shouldWithholdWedgeAlertForAutoRecovery` withheld an alert for a recovery that never came.
  RUFU-287 sat in that shape for over two hours while the infrastructure refusal had already self-cleared.

  The key is deliberately its own (`planning-fence-unavailable`, not `stall:`-prefixed): this is a terminal
  planning park, not a stall-code chip, and the stall ladder has no planning-fence code. The
  recovery-owner veto is preserved from the generic fallback so a card still holding live retry counters
  stays silent — an exhausted park nulls both fields precisely so this alert can fire.
  */
  if (fencePark) {
    if (describeTaskRecoveryOwner(task)) return null;
    return {
      reasonKey: "planning-fence-unavailable",
      // The requirement phrase is the operator's answer to "what was unavailable?" — a named park keeps
      // it in its marker, a legacy park derives it from the carried last-error text, so the sentence
      // stays readable for both populations instead of degrading to "inspect the error".
      reason: `Planning could not reach the durable planning-lane fence (${describeWorkflowPrincipalFenceRequirement({
        role: fencePark.role,
        requirement: fencePark.requirement,
        detail: fencePark.detail,
      })}), so the spec was never written.`,
      action: "Restore database availability for this project; self-healing re-probes the fence (reconcile-planning-fence-park) and retry forces one now.",
    };
  }
  /*
  FNXC:TaskWedgeNotifications 2026-09-22-23:05 (RUFU-276, AC4):
  A review-lane card terminalized by the pre-RUFU-276 auto-merge retry seam carried
  `AUTO_MERGE_RETRY_REJECTED: Cannot merge <id>: task has enabled pre-merge workflow steps that never
  ran` and fell through every matcher above into the generic `terminal-failed` park. That cost two
  things: the operator read "terminal failed, inspect the error" for a condition with a named remedy,
  and — because `classifyTerminalFailureAutoRecoveryForTask` derives `isGenericTerminalFailure` from
  exactly this reason key — automatic recovery claimed ownership of a card it can never advance, so
  `shouldWithholdWedgeAlertForAutoRecovery` withheld the alert for a recovery that never came
  (measured on RUFU-225: the RUFU-180 sweep selected the card and the service answered `unavailable`).

  The key deliberately equals `describeTaskWedgeFromStallReason`'s stall key: the same card is
  described by the stall arm once the repair lane clears its failed status, and one episode identity
  across that transition is what keeps storm control intact — the per-reason cooldown cannot dedupe
  two names for one condition. The recovery-owner veto below is preserved from the generic fallback so
  a genuinely scheduled retry stays silent. The action copy is shared with `STALL_WEDGE_ACTIONS` so
  the board chip, the menu, and this alert never disagree.
  */
  if (isPreMergeStepsNotRunRefusal(error)) {
    if (describeTaskRecoveryOwner(task)) return null;
    return {
      reasonKey: "stall:pre-merge-gate-pending",
      reason: PRE_MERGE_STEPS_NOT_RUN_BLOCKER,
      action: PRE_MERGE_GATE_PENDING_WEDGE_ACTION,
    };
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
  FNXC:TaskWedgeNotifications 2026-08-05-04:53:
  The generic fallback cannot convert a recovery-owned failed snapshot into an
  operator alert. Explicit terminal pause and error contracts above remain
  actionable; recovery exhaustion clears its durable marker and reaches this path.
  */
  if (describeTaskRecoveryOwner(task)) return null;
  if (!error && (task.mergeRetries ?? 0) < 3) return null;
  return {
    reasonKey: "terminal-failed",
    reason: "The task entered a terminal failed state and needs operator intervention.",
    action: "Inspect the task error, fix the underlying issue, then retry or reset to todo.",
  };
}

/*
FNXC:TaskWedgeNotifications 2026-09-25-17:48 (RUFU-273):
Operator next-step copy for every stall code, spelled as an exhaustive table over the WHOLE
`TaskStallReasonCode` union with `null` meaning "this code never alerts". The table used to be
`Record<Exclude<TaskStallReasonCode, "dependency-blocker">, string>`, which made "a new code was added
to the union" a silent non-event: the compiler only complained if someone happened to index the table
with it. RUFU-273 adds seven planning-lane codes and every one of them is deliberately silent here, so
the union-wide table with an explicit `null` arm is what forces a future author to decide — adding a
code without stating whether it alerts is now a compile error, which is the strictest form of the
fail-closed rule this file already documented for unknown codes.

Why each planning code is `null`: the wedge alert is a mailbox message saying "a human must act on this
card now", and none of these meet that bar. The card already names its cause on its face and in the
detail banner (RUFU-273's surface rule: the face names the cause, the body never re-asks for a human).
The capacity throttle is engine-owned and self-clears the moment a slot frees; the premise hold is
already announced by the plan-review path that wrote the episode; the recovery backoff is a scheduled
engine wait; `recoverable-work` is reported by the FN-283 vanished-work notice; and `plan-no-admission`
is a residual with no operator action to name. Alerting here would double-announce a cause that already
has an owner, which is the exact defect the `dependency-blocker` exclusion was written for.
*/
/**
 * The one action sentence shared by the legacy not-run-refusal arm above and the stall-code table
 * below, so the board chip, the menu, and this alert can never disagree. A named const rather than a
 * table index because the table is nullable (`null` = never alerts) and this arm always alerts.
 */
const PRE_MERGE_GATE_PENDING_WEDGE_ACTION = "Run the pending review gate from the card, or reset the card to todo so the pipeline runs the gate again.";

const STALL_WEDGE_ACTIONS: Record<TaskStallReasonCode, string | null> = {
  "merge-blocker": "Open the card and clear the blocker: re-run the review gate, bypass a failed pre-merge review step, or reset the card to todo.",
  "pre-merge-gate-pending": PRE_MERGE_GATE_PENDING_WEDGE_ACTION,
  "held-human-review": "Merge the card by hand, or turn automatic merge processing back on.",
  // Already announced elsewhere: normal queueing, and the blocking card announces its own stall.
  "dependency-blocker": null,
  /*
  FNXC:ReviewRevisionWait 2026-09-29-14:12 (RUFU-280):
  A card working through an authored review revision is excluded from wedge alerting for the same
  structural reason as `dependency-blocker`: the work it is waiting on has an owner that is already
  announceable elsewhere. The named remediation steps are published ON the card, the executor is dispatched
  to run them, and the Review lane itself reports the revision — an alert here would notify the operator
  about work the engine is performing, and `task:reconcile-review-stall-notification` would fire once per
  revision episode for a card that is not stuck at all.

  This table is a pure notification-admission allowlist: `describeTaskWedgeFromStallReason` returns at the
  `!action` line below, so `null` suppresses only the alert and the card's own `stallReason` copy stays
  rendered on its face and in detail. It has NO authority over lane state, which is what makes the `null`
  here different from the `null` in `STALL_WEDGE_ACTIONS`'s other exclusions only in degree — the two
  exclusions that were NOT deliberate (`plan-*`) exist only because RUFU-273 added codes to a table written
  against a smaller union. That exhaustive `Record` is the reason this change had to touch this table at
  all: TypeScript refuses the build rather than letting a new code silently decide its own alert policy.
  */
  "awaiting-review-revision": null,
  // Planning-lane codes (RUFU-273) — the card names the cause itself, so a wedge alert would double-announce.
  "plan-admission-throttled": null,
  /*
  FNXC:WipAdmissionPark 2026-11-02-07:10 (RUFU-393):
  Deliberately NOT alertable, and the reason is a delivery fact rather than a judgement about noise: today
  this code could never reach an operator through the wedge pipeline at all, so a non-null string here would
  be a dead affordance — config claiming an alert that no path can deliver.

  Two vetoes, both structural:
  1. No discovery path reaches it. RUFU-180's standing sweep is the only discovery for a stall that writes no
     `status`/`error`/`pausedReason`, and its candidate filter names the three review-lane codes
     (`self-healing.ts`, `reconcileReviewStallWedgeNotifications`) because it was authored for cards that stop
     being row-written once they land in review. A card held in its own hold lane is row-written on every sweep.
  2. The delivery path vetoes a hold-lane card. `notifyTaskStallWedge` settles through the pending mark, and
     the pending revalidation clears any wedge whose card is resting in a `hold`/`countsTowardWip`/`complete`
     lane (`notification-service.ts`, `hasProgressed`). `todo` carries the `hold` trait, so a withheld card is
     classified as having progressed and the alert is cancelled before dispatch — by design, since that veto is
     what keeps an ordinary queue from notifying.

  So the surfaces are the ones this code can actually own: the stall chip on the card face (with the age the
  escalation floor proved), one History line per published episode record, and the bounded audit row. The
  sibling planning-lane code RUFU-273 shipped the same way for the same reason. Making an aged WIP refusal
  mailbox-alertable needs a wedge class whose revalidation knows that a hold-lane card is NOT progress —
  notification-service work outside this task's scope, recorded as a follow-up rather than half-wired here.
  */
  "wip-admission-throttled": null,
  "plan-lane-ineligible": null,
  "plan-premise-held": null,
  "plan-spec-unreadable": null,
  "plan-recovery-backoff": null,
  "plan-no-admission": null,
  "recoverable-work": null,
};

/**
 * Classify the one population `describeTaskWedge` structurally cannot see: a review-lane refusal
 * that writes no `status`, no `pausedReason`, and no `error`, so the legacy
 * `task.status !== "failed"` bail classifies it as "nothing wrong".
 *
 * FNXC:TaskWedgeNotifications 2026-09-03-01:35 (RUFU-180):
 * A card whose merge is refused ("pre-merge gate never ran", "approval recorded against different
 * content", "automatic merge processing withheld") carries none of the legacy markers the sync
 * classifier reads, so it stayed silent on the board while the operator had to patrol for it. The
 * stall reason already hydrated server-side onto every task read is the same authority the merge
 * door consults, so this helper maps it into the wedge descriptor shape without re-deriving anything.
 *
 * Guards are the population definition, not defensive decoration: the silent population is exactly
 * review lane + null/absent status + no pause evidence + a hydrated stall reason. Any non-empty
 * string status is owned by another world already (failed by the sync classifier above;
 * merging/reviewing/landing by the progressing guard; awaiting-approval and awaiting-user-review by
 * their own notification paths; queued/stuck-killed by scheduler transients), so alerting there
 * would double-announce. `dependency-blocker` is deliberately silent: a todo card waiting on
 * dependencies is normal queueing and the blocking card announces its own stall, while an in-review
 * unmet-dependency wedge is already announced by the reconcile-in-review-unmet-dependencies
 * descriptor. An unknown future code fails closed rather than inventing an alert.
 *
 * reasonKeys are `stall:<code>` — stable per code so the durable episode CAS can collapse a
 * sustained wedge into one alert — and always prefixed so they can never equal the
 * `terminal-failed`, `completion-blocked`, `merge-blocked:<gate>`, `self-healing-no-action:<stage>`,
 * or pausedReason-keyed families.
 */
export function describeTaskWedgeFromStallReason(task: Task): TaskWedgeDescriptor | null {
  const stall = task.stallReason;
  if (!stall) return null;
  if (typeof task.status === "string" && task.status.length > 0) return null;
  if (task.paused === true || task.userPaused === true) return null;
  if (isTaskProgressing(task)) return null;
  // The exhaustive table decides silence; the literal guard stays so this arm is unchanged byte-for-byte.
  if (stall.code === "dependency-blocker") return null;
  const action = STALL_WEDGE_ACTIONS[stall.code];
  if (!action) return null;
  // The reason stays the canonical server sentence so the notifier and the board chip never drift.
  return { reasonKey: `stall:${stall.code}`, reason: stall.reason, action };
}

/**
 * The composed wedge authority: legacy classification first, stall reason only for what it misses.
 *
 * FNXC:TaskWedgeNotifications 2026-09-03-01:35 (RUFU-180):
 * Review-lane refusals must announce themselves, but the legacy `describeTaskWedge` status bail
 * stays as the FIRST pass — a failed, paused, or error-parked card keeps its existing descriptor
 * and reasonKey byte-for-byte, and a stall reason never re-silences the stall class. The composed
 * helper is the delivery/reclassification authority wherever the lifecycle makes a decision to
 * alert, hold, or clear; the generic-terminal-failure and failure-suppression questioners stay on
 * the sync classifier on purpose, because "is this a generic terminal failure" must remain
 * failed-only. Stall reasonKeys carry the `stall:` prefix and so can never collide with
 * `terminal-failed`.
 */
export function describeTaskWedgeWithStall(task: Task): TaskWedgeDescriptor | null {
  return describeTaskWedge(task) ?? describeTaskWedgeFromStallReason(task);
}
