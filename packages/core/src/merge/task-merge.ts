import { isBranchGroupMemberLanded } from "../branch/branch-group-completion.js";
import { taskHasManualOpenPullRequest } from "../tasks/task-helpers.js";
import type { BranchGroup, Settings, Task, WorkflowStepResult } from "../types.js";
import type { MergeContentDescriptor } from "./merge-content-descriptor.js";
import { evaluatePreMergeApprovals } from "./pre-merge-approval.js";
import { isArchivedRemediationCarrier } from "../workflows/workflow-step-results.js";

export interface LandedMemberReviewAdvisory {
  taskId: string;
  workflowStepId: string;
  workflowStepName: string;
  status: WorkflowStepResult["status"];
  verdict?: WorkflowStepResult["verdict"];
  notes?: string;
  findings: NonNullable<WorkflowStepResult["findings"]>;
}

/**
 * FNXC:SharedBranchPromotionAdvisories 2026-08-08-01:58:
 * FN-8823 requires manual group promotion to expose non-clean, pre-merge code
 * review output from every landed member. Derive this ephemeral summary from
 * task rows rather than copying reviewer prose into branch-group persistence.
 */
export function collectLandedMemberReviewAdvisories(
  tasks: Array<Pick<Task, "id" | "mergeDetails" | "workflowStepResults">>,
  group: Pick<BranchGroup, "branchName">,
): LandedMemberReviewAdvisory[] {
  const seen = new Set<string>();
  const advisories: LandedMemberReviewAdvisory[] = [];
  for (const task of tasks) {
    if (!isBranchGroupMemberLanded(task, group)) continue;
    for (const result of task.workflowStepResults ?? []) {
      const isPreMergeCodeReview = (result.phase ?? "pre-merge") === "pre-merge" && result.reviewKind !== "plan";
      const nonClean = result.status === "advisory_failure"
        || result.status === "failed"
        || result.verdict === "APPROVE_WITH_NOTES";
      if (!isPreMergeCodeReview || result.status === "pending" || !nonClean) continue;
      const findings = result.findings ?? [];
      const key = JSON.stringify([task.id, result.workflowStepId, result.status, result.verdict, result.notes, findings]);
      if (seen.has(key)) continue;
      seen.add(key);
      advisories.push({
        taskId: task.id,
        workflowStepId: result.workflowStepId,
        workflowStepName: result.workflowStepName,
        status: result.status,
        verdict: result.verdict,
        notes: result.notes,
        findings,
      });
    }
  }
  return advisories.sort((left, right) =>
    left.taskId.localeCompare(right.taskId)
    || left.workflowStepId.localeCompare(right.workflowStepId)
    || left.workflowStepName.localeCompare(right.workflowStepName));
}

export interface MergeTargetResolution {
  branch: string;
  source: "task-base-branch" | "task-branch-context" | "branch-group-integration" | "project-default" | "legacy-main";
  /**
   * When the resolver rejects a candidate (e.g. baseBranch points at a sibling
   * `fusion/fn-*` branch), this records the rejected value and the reason. The
   * merger uses this to emit an audit event so the steering bug is observable
   * in the run-audit timeline rather than failing silently.
   */
  rejected?: {
    branch: string;
    source: "task-base-branch" | "task-branch-context" | "branch-group-integration";
    reason: "fusion-sibling-branch";
  };
}

export interface MergeTargetResolverOptions {
  projectDefaultBranch?: string;
  legacyFallbackBranch?: string;
  branchGroup?: Pick<BranchGroup, "branchName"> | null;
}

/**
 * Sibling task branches (`fusion/fn-<id>`) MUST NOT be used as merge targets.
 * They are start-point/rebase anchors, not destinations: landing a squash onto
 * a sibling branch strands the commit on a feature ref instead of advancing
 * the project integration branch (root cause of FN-5233/FN-5530 lost-on-main).
 */
const FUSION_SIBLING_BRANCH_RE = /^fusion\/fn-/i;

export function isFusionSiblingBranch(branch: string): boolean {
  return FUSION_SIBLING_BRANCH_RE.test(branch);
}

/**
 * Resolves a task's effective auto-merge behavior.
 * Explicit per-task values (`true`/`false`) take precedence over the global
 * setting; when `task.autoMerge` is `undefined`, falls back to
 * `settings.autoMerge`. `autoMergeProvenance` is metadata used by legacy-stamp
 * remediation; this resolver intentionally keys only on the value.
 */
export function resolveEffectiveAutoMerge(
  task: Pick<Task, "autoMerge">,
  settings: Pick<Settings, "autoMerge">,
): boolean {
  return task.autoMerge ?? settings.autoMerge;
}

/**
 * FNXC:SharedBranchMemberHold 2026-08-08-01:58:
 * FN-8823 supersedes the prior member-integration exemption under project Off.
 * An explicit task On opts in; otherwise the operator's project-level Off holds
 * every member, including mission, legacy, inherited, and unset values. With
 * project On, only a user-authored task Off is a hold; engine-authored false
 * values retain the live intermediate-group fast path.
 */
export function hasSharedBranchMemberAutoMergeHold(
  task: Pick<Task, "autoMerge" | "autoMergeProvenance">,
  settings: Pick<Settings, "autoMerge">,
): boolean {
  if (task.autoMerge === true) return false;
  if (settings.autoMerge === false) return true;
  return hasUserAutoMergeHold(task);
}

/** Returns whether an explicit task-level user Off is present. */
export function hasUserAutoMergeHold(
  task: Pick<Task, "autoMerge" | "autoMergeProvenance">,
): boolean {
  return task.autoMerge === false && task.autoMergeProvenance === "user";
}

/**
 * FNXC:SharedBranchMemberHold 2026-08-09-21:41:
 * FN-8910 narrows the FN-8823 project-Off consent arm after FN-8863 exposed
 * that it also reached remediation. Remediation reopens implementation; it
 * never merges. The broad shared-member hold remains the merge-admission
 * contract in merge-runner, project-engine, and self-healing, so only an
 * operator-authored task-level Off may fence shared and standalone remediation.
 * This preserves the merge checkpoint while allowing review findings to be fixed.
 */
export function hasPreMergeRemediationAutoMergeHold(
  task: Pick<Task, "autoMerge" | "autoMergeProvenance" | "branchContext">,
  _settings: Pick<Settings, "autoMerge">,
): boolean {
  return hasUserAutoMergeHold(task);
}

/**
 * Gate for auto-merge *processing* (engine enqueue + self-healing sweeps).
 * Additive relative to the global setting: when `settings.autoMerge` is on,
 * every task flows through — tasks with an explicit `autoMerge: false` are
 * parked as `manual-required` downstream by the merger, not silently skipped
 * here. When the global setting is off, only tasks with a per-task
 * `autoMerge: true` value proceed; legacy stamp provenance is surfaced and
 * reconciled separately. Distinct from
 * `resolveEffectiveAutoMerge`, which resolves the effective boolean and would
 * (incorrectly for processing gates) starve the manual-required parking path.
 *
 * FNXC:PrAutoMergeGate 2026-06-28-00:33:
 * FN-7182: a dashboard-created open PR is a human handoff, so exclude it from all automatic merge processing and self-healing recovery until the human merges or closes the PR.
 * This mirrors the `autoMerge:false` in-review gate while preserving manual Merge PR/manual done paths and pipeline PRs without `manual: true`.
 * Shared-branch member integration still bypasses this function only through
 * `isLiveSharedBranchGroupMemberIntegration(task, group, defaultBranch)`: its
 * live group branch must be a distinct intermediate target. Group-to-default
 * promotion remains gated separately.
 */
export function allowsAutoMergeProcessing(
  task: Pick<Task, "autoMerge" | "prInfo" | "prInfos">,
  settings: Pick<Settings, "autoMerge">,
): boolean {
  return (settings.autoMerge !== false || task.autoMerge === true) && !taskHasManualOpenPullRequest(task);
}

// Resolves group → default-branch PROMOTION auto-merge. See resolveEffectiveAutoMerge for the per-task member→group-integration step; the two are distinct and must not be conflated.
export function resolveEffectiveGroupAutoMerge(
  group: Pick<BranchGroup, "autoMerge">,
  settings: Pick<Settings, "autoMerge">,
): boolean {
  return group.autoMerge ?? settings.autoMerge;
}

/**
 * Shared-branch-group members perform a soft pre-integration step:
 * member branch → shared group branch. Under project auto-merge On, inherited
 * and engine-authored false values remain exempt while user Off holds. Under
 * project Off, `hasSharedBranchMemberAutoMergeHold` holds every non-opted-in
 * member; shared-branch → default promotion remains separately gated.
 */
export function isSharedBranchGroupMemberIntegration(
  task: Pick<Task, "branchContext">,
): boolean {
  return task.branchContext?.assignmentMode === "shared"
    && Boolean(task.branchContext.groupId?.trim());
}

/**
 * FNXC:AutoMergeHold 2026-07-09-16:42:
 * FN-7750 / Runfusion#1980: the `autoMerge:false` exemption for shared-branch members is valid only while the branch group is live. Missing, finalized, abandoned, or dissolved groups must degrade to the standalone manual-hold path so operator Merge & Close control is honored regardless of whether the task was API-, user-, or engine-created.
 *
 * FNXC:BranchGroupAutoMergeGate 2026-08-03-23:17:
 * Runfusion/Fusion#3324 requires human release controls to apply whenever a
 * shared-group member would land on the resolved default branch. Only a live,
 * nonblank intermediate branch distinct from that default may bypass
 * `autoMerge:false`; shape-only callers must keep using
 * `isSharedBranchGroupMemberIntegration` so stale members remain excluded from
 * solo finalization.
 */
export function isLiveSharedBranchGroupMemberIntegration(
  task: Pick<Task, "branchContext">,
  group: Pick<BranchGroup, "status" | "branchName"> | null | undefined,
  projectDefaultBranch?: string,
): boolean {
  const groupBranch = group?.branchName?.trim();
  const defaultBranch = projectDefaultBranch?.trim() || "main";
  return isSharedBranchGroupMemberIntegration(task)
    && group?.status === "open"
    && Boolean(groupBranch)
    && groupBranch !== defaultBranch;
}

export function resolveTaskMergeTarget(
  task: Pick<Task, "baseBranch" | "branchContext">,
  options: MergeTargetResolverOptions = {},
): MergeTargetResolution {
  let rejected: MergeTargetResolution["rejected"];

  const configuredBase = task.baseBranch?.trim();
  if (configuredBase) {
    if (isFusionSiblingBranch(configuredBase)) {
      rejected = { branch: configuredBase, source: "task-base-branch", reason: "fusion-sibling-branch" };
    } else {
      return { branch: configuredBase, source: "task-base-branch" };
    }
  }

  const branchGroupBranch = task.branchContext?.assignmentMode === "shared"
    ? options.branchGroup?.branchName?.trim()
    : undefined;
  if (branchGroupBranch) {
    if (isFusionSiblingBranch(branchGroupBranch)) {
      rejected = rejected ?? {
        branch: branchGroupBranch,
        source: "branch-group-integration",
        reason: "fusion-sibling-branch",
      };
    } else {
      return { branch: branchGroupBranch, source: "branch-group-integration", rejected };
    }
  }

  const inheritedBase = task.branchContext?.inheritedBaseBranch?.trim();
  if (inheritedBase) {
    if (isFusionSiblingBranch(inheritedBase)) {
      rejected = rejected ?? { branch: inheritedBase, source: "task-branch-context", reason: "fusion-sibling-branch" };
    } else {
      return { branch: inheritedBase, source: "task-branch-context", rejected };
    }
  }

  const projectDefault = options.projectDefaultBranch?.trim();
  if (projectDefault) {
    return { branch: projectDefault, source: "project-default", rejected };
  }

  const legacyFallback = options.legacyFallbackBranch?.trim() || "main";
  return { branch: legacyFallback, source: "legacy-main", rejected };
}

/*
 * FNXC:ApprovalHold 2026-07-09-00:00:
 * FN-7736: two distinct mechanisms park a task on a pending human approval —
 * (1) the triage plan-approval gate sets `task.status === "awaiting-approval"`
 * (already a HARD_BLOCKING_TASK_STATUSES member below), and (2) a gated tool
 * call parks a RUNNING task via `pauseForApproval` -> `store.pauseTask(id,
 * true, ...)`, which historically only set `paused:true` with no durable
 * `pausedReason`, so recovery/oversight code keying on `pausedReason` could
 * not recognize it and at least one sweep (self-healing's
 * `autoReboundPausedScopeDecay`) could rebound the held task back to `todo`
 * before the operator ever decided. `AWAITING_APPROVAL_PAUSE_REASON` is the
 * canonical, durable marker both `executor.ts` and `agent-heartbeat.ts`
 * `pauseForApproval` now stamp via `TaskStore.pauseTask`'s `pausedReason`
 * option, and `isTaskBlockedOnApproval` is the single shared predicate core
 * and engine code must consult before rebounding, requeuing, resuming,
 * re-planning, or otherwise advancing a task — it must return `true` for
 * EITHER hold shape so callers never have to special-case which mechanism
 * parked the task.
 */
export const AWAITING_APPROVAL_PAUSE_REASON = "awaiting-approval";

/**
 * Returns true when `task` is blocked on a pending human approval decision,
 * via either hold mechanism (see FNXC:ApprovalHold above). Every automated
 * recovery (self-healing) and oversight (planner overseer) path must treat
 * `true` as "take no lifecycle-advancing action on this task".
 */
export function isTaskBlockedOnApproval(
  task: Pick<Task, "paused" | "pausedReason" | "status">,
): boolean {
  if (task.paused === true && task.pausedReason === AWAITING_APPROVAL_PAUSE_REASON) return true;
  return task.status === "awaiting-approval";
}

export const HARD_BLOCKING_TASK_STATUSES = new Set([
  "failed",
  // ── User-attention / awaiting-handoff states ─────────────────────────
  "awaiting-inspection",
  "awaiting-user-review",
  "awaiting-approval",       // triage spec awaiting user approval
  // ── Active merge in-flight ───────────────────────────────────────────
  "merging",
  "merging-pr",
  // ── Re-planning / triage states (scope not finalized) ────────────────
  // A task in planning/triage hasn't finalized its scope yet — letting it
  // merge skips the work the user moved it back to plan. Same for the legacy
  // "specifying" alias migrated to "planning" in db.ts.
  "planning",
  "specifying",
  "needs-replan",            // scheduler/executor/triage signaled re-plan
  // ── Mission-level validation in flight ───────────────────────────────
  "mission-validation",
  // ── Abnormal termination — defensive guard ───────────────────────────
  // Task was killed by the stuck detector. If it surfaces in in-review,
  // it needs investigation, not auto-merge.
  "stuck-killed",
]);

export const SCHEDULER_TRANSIENT_STATUSES = new Set([
  // scheduler placed the task in line; not finalized
  "queued",
]);

export const BLOCKING_TASK_STATUSES = new Set([
  ...HARD_BLOCKING_TASK_STATUSES,
  ...SCHEDULER_TRANSIENT_STATUSES,
]);

const NON_TERMINAL_STEP_STATUSES = new Set([
  "pending",
  "in-progress",
]);

/*
FNXC:MergeBlockerReasons 2026-08-26-11:40:
The RULE behind the "task has incomplete steps" blocker, exported so a caller can ask the question
instead of matching the sentence.

`merge-confirmed-finalize.ts` carved out one case — a no-op merge with no landed commit whose work is
unfinished must fall through to stale-merge cleanup rather than consume the run — by comparing the
blocker reason with `===` against that exact string. The merge-authority work then made refusals more
informative, so a card in an error state reports `task is marked 'failed': … task has incomplete
steps`. Same meaning, different sentence, and the carve-out silently stopped applying: a filter
pinned to "subject is exactly Invoice" once invoices began arriving as "Invoice — March 2026".

A blocker MESSAGE is written for an operator to read and will be reworded again. The condition it
describes is what callers actually mean, so give them that.
*/
export function hasNonTerminalSteps(task: Pick<Task, "steps">): boolean {
  return (task.steps ?? []).some((step) => NON_TERMINAL_STEP_STATUSES.has(step.status));
}

const NON_TERMINAL_WORKFLOW_STATUSES = new Set<WorkflowStepResult["status"]>([
  "pending",
]);

/*
FNXC:RequiredPreMergeSteps 2026-08-22-22:40 (FN-9191 wedge):
"An enabled pre-merge gate has not produced a result yet" is a NOT-YET condition, not a
failure. FN-9191 proved the difference is load-bearing: the in-review auto-merge sweep
enqueued the card ~2s after `fn_task_done`, BEFORE the graph started its own Code Review
node, so the door correctly refused — and the auto-merge error path then parked the card
`status:"failed"` as a non-conflict failure. Code Review completed and APPROVED 2 minutes
later, but every subsequent merge (including the graph's own merge node) then failed with
`task is marked 'failed'`. A correct refusal became a permanent wedge.

The blocker message is exported so merge doors can throw the typed error below instead of a
bare `Error`, and so the auto-merge error path can classify it as a deferral rather than a
terminal park.
*/
export const PRE_MERGE_STEPS_NOT_RUN_BLOCKER =
  "task has enabled pre-merge workflow steps that never ran";

/*
FNXC:PreMergeApproval 2026-09-06-00:11:
Four production sites and three merge doors classify this blocker after it is wrapped in their
own error text. Keeping the wording as a named contract prevents an editorial change from silently
disabling stale-content recovery at every door.
*/
export const STALE_CONTENT_APPROVAL_BLOCKER =
  "task has a pre-merge approval recorded against different content";

/**
 * Thrown by merge doors when the ONLY thing standing between a card and merge is an
 * enabled pre-merge gate that has not run yet. Callers must treat it as "retry after the
 * gate reports", never as a terminal failure: no `status:"failed"` park, no retry-budget
 * burn, no operator handoff.
 */
export class PreMergeStepsNotRunError extends Error {
  readonly code = "pre-merge-steps-not-run" as const;
  readonly taskId: string;
  constructor(taskId: string, message = `Cannot merge ${taskId}: ${PRE_MERGE_STEPS_NOT_RUN_BLOCKER}`) {
    super(message);
    this.name = "PreMergeStepsNotRunError";
    this.taskId = taskId;
  }
}

/** True when a `getTaskMergeBlocker` reason is the deferrable unrun-gate reason. */
export function isPreMergeStepsNotRunBlocker(blocker: string | undefined): boolean {
  return blocker === PRE_MERGE_STEPS_NOT_RUN_BLOCKER;
}

/** True when a merge door or terminal park reports an approval against superseded content. */
export function isStaleContentApprovalBlocker(blocker: string | undefined | null): boolean {
  return typeof blocker === "string" && blocker.trim().endsWith(STALE_CONTENT_APPROVAL_BLOCKER);
}

export const TASK_DONE_BYPASS_BLOCKER_MESSAGE =
  "done bypass requires merge confirmation or explicit no-commits policy";

/**
 * Returns a human-readable reason when a task in review is not safe to finalize.
 * Undefined means the task is eligible to move from `in-review` to `done`.
 */
export function getTaskMergeBlocker(
  task: Pick<Task, "column" | "paused" | "status" | "error" | "steps" | "workflowStepResults" | "repositoryScope">,
  options: {
    manual?: boolean;
    skipColumnIdentityCheck?: boolean;
    reviewColumns?: ReadonlySet<string>;
    /*
    FNXC:RequiredPreMergeSteps 2026-08-22-21:11:
    Merge doors receive the workflow-resolved enabled pre-merge groups so an
    unrun gate cannot be mistaken for approval. Recovery scanners deliberately
    omit this input: they must still discover resultless cards and route them
    back to their graph gate rather than hiding a recoverable wedge.
    */
    requiredPreMergeStepIds?: ReadonlySet<string>;
    mergeContent?: MergeContentDescriptor;
  } = {},
): string | undefined {
  /*
  FNXC:WorkflowTransitionPolicy 2026-07-19-13:30 (PR #2341 review):
  `skipColumnIdentityCheck` exists for callers that have ALREADY proven review-lane
  identity by a stronger means than the literal column id — the KTD-5 transition
  validator resolves the source column's `merge-blocker` trait flag from the workflow
  IR, so a custom workflow's review lane can carry any column id. Those callers used
  to spoof `{ ...task, column: "in-review" }`, which would silently misapply any
  future column-dependent logic added here; the explicit option keeps the content
  checks (paused / blocking status / incomplete steps / pre-merge step results) as
  the sole deciders without lying about the task's actual column.
  */
  /*
  FNXC:WorkflowLifecycleColumns 2026-07-31-00:20 (batch-core feed):
  `reviewColumns` is an optional RESOLVED answer; omitted, this is exactly today's behaviour.

  Distinct from `skipColumnIdentityCheck`, which says "I have already proven lane identity, do not
  check at all". This says "check, against THESE columns" — the caller that knows the board but still
  wants the identity check enforced. Collapsing the two would let a caller silently skip the check
  when all it wanted was to name the lane.

  The live defect this fixes is in `moves.ts`: the review → complete transition guard resolves BOTH
  columns from the workflow, then called this helper, which re-asked with the literal and refused —
  so on a renamed board that move threw `Cannot move FN-1 to done: task is in 'signoff', must be in
  'in-review'` even though the transition had just been validated as legal. A half-conversion, where
  the outer question is resolved and the inner one is not.

  DELIBERATE-LITERAL — the unconverted-caller default, reviewed 2026-07-31-00:20. The message names
  the resolved lanes when they are known, so it can never point at a column the board does not have.
  */
  if (!options.skipColumnIdentityCheck) {
    /*
    FNXC:MergeReadiness 2026-08-23-18:49:
    An empty resolved lane set means the workflow supplied no usable trait answer. Preserve the
    documented legacy identity fallback until at least one resolved review lane is available; treating
    an empty Set as authoritative would make every column fail while the error still names `in-review`.
    */
    const reviewColumns = options.reviewColumns?.size ? options.reviewColumns : undefined;
    const inReviewLane = reviewColumns
      ? reviewColumns.has(task.column)
      : task.column === "in-review";
    if (!inReviewLane) {
      const expected = reviewColumns
        ? [...reviewColumns].map((c) => `'${c}'`).join(" or ")
        : "'in-review'";
      return `task is in '${task.column}', must be in ${expected}`;
    }
  }

  if (task.paused) {
    return "task is paused";
  }

  const blockingStatuses = options.manual === true ? HARD_BLOCKING_TASK_STATUSES : BLOCKING_TASK_STATUSES;
  if (task.status && blockingStatuses.has(task.status)) {
    return task.error
      ? `task is marked '${task.status}': ${task.error}`
      : `task is marked '${task.status}'`;
  }

  if (task.steps.length > 0 && task.steps.some((step) => NON_TERMINAL_STEP_STATUSES.has(step.status))) {
    return "task has incomplete steps";
  }

  /*
  FNXC:PreMergeApproval 2026-08-23-06:52:
  FN-180 requires a positive approval for each enabled gate. Missing and rejected
  results exit through a fresh gate run (or the audited FN-7720 bypass); stale and
  unprovable diff evidence exit through a review over current content.
  */
  const approval = evaluatePreMergeApprovals(task, options).find((candidate) => candidate.state !== "approved");
  if (approval?.state === "missing") return PRE_MERGE_STEPS_NOT_RUN_BLOCKER;
  /*
  FNXC:PreMergeApproval 2026-09-05-23:08:
  FN-295: name the gate. The bare sentence sent an operator hunting through three review lanes for the
  one row without an approval, and the wrong guess cost three full review re-runs. The gate id is the
  single fact needed to act; every other approval blocker already implies its own remedy.
  */
  if (approval?.state === "not-approved") {
    return `task has enabled pre-merge workflow steps without a current approval (gate '${approval.workflowStepId}')`;
  }
  if (approval?.state === "stale-content") return STALE_CONTENT_APPROVAL_BLOCKER;
  if (approval?.state === "unprovable-content") return "task has no provable approval for the content being merged";

  // Only pre-merge workflow step failures block merge.
  // Post-merge failures run after merge and do not block it.
  if (
    task.workflowStepResults?.some((result) => {
      const phase = result.phase || "pre-merge";
      return phase === "pre-merge" && NON_TERMINAL_WORKFLOW_STATUSES.has(result.status);
    })
  ) {
    return "task has incomplete or failed pre-merge workflow steps";
  }

  /*
   * FNXC:ReviewLaneBypass 2026-07-09-00:00:
   * `bypassFailedPreMergeReviewStep` (store.ts) recovers a card stranded here by
   * rewriting the selected step's `status` from `"failed"` to `"skipped"` (see
   * `getLatestFailedPreMergeReviewStep` below) plus bypass audit metadata. A
   * bypassed step therefore no longer matches this branch, so this function
   * stays byte-identical in logic — the bypass works upstream of the blocker,
   * not by special-casing it here (FN-7720).
   */
  if (
    task.workflowStepResults?.some((result) => {
      const phase = result.phase || "pre-merge";
      return phase === "pre-merge" && result.status === "failed";
    })
  ) {
    return "task has failed pre-merge workflow steps";
  }

  return undefined;
}

/*
FNXC:ReviewLaneBypass 2026-09-06-00:47:
An archived remediation carrier preserves a failed review for history but used to erase the only
status the audited operator bypass could select. Select that carrier without changing archive writers;
a live failure remains preferred and automatic remediation continues to select only live failures.
*/
export function getLatestFailedPreMergeReviewStep(
  task: Pick<Task, "workflowStepResults">,
): WorkflowStepResult | undefined {
  const results = task.workflowStepResults ?? [];
  const recentFirst = (a: WorkflowStepResult, b: WorkflowStepResult) => {
    const aTs = Date.parse(a.completedAt || a.startedAt || "");
    const bTs = Date.parse(b.completedAt || b.startedAt || "");
    return (Number.isFinite(bTs) ? bTs : 0) - (Number.isFinite(aTs) ? aTs : 0);
  };
  const isPreMerge = (result: WorkflowStepResult) => (result.phase || "pre-merge") === "pre-merge";
  return results.filter((result) => isPreMerge(result) && result.status === "failed").sort(recentFirst)[0]
    ?? results.filter((result) => isPreMerge(result)
      && isArchivedRemediationCarrier(result)
      && (result.remediationArchivedFromStatus === "failed" || result.remediationArchivedFromStatus === "advisory_failure")
      && !result.bypassedBy
      && !result.supersededAt).sort(recentFirst)[0];
}

/*
FNXC:WorkflowResolvedColumns 2026-07-30-20:50:
`reviewColumns` threads straight through to `getTaskMergeBlocker`, for the same reason that helper takes
it: omitted, the identity check falls back to the literal `in-review` and refuses a card sitting in its
own board's review lane.

This wrapper was the blind spot behind a whole class: its callers are self-healing sweeps whose column
QUERY was also a literal, so the unwired check was unreachable and therefore unnoticed. Widening a
sweep's query ACTIVATES it — the sweep starts finding renamed-board cards and this then declines every
one. Optional, so no caller changes behaviour until it passes the set.
*/
/*
FNXC:WorkflowResolvedColumns 2026-07-30-21:10:
DELIBERATE-LITERAL — the review-eligible SENTINEL, reviewed 2026-07-30-18:20.

NOT a lifecycle column. `getTaskHardMergeBlocker` answers "is this card blocked by anything other than
where it sits?", and its callers are recovery paths for work that has ALREADY LANDED — a merge-confirmed
card whose graph crashed can be resting in any column. They pass this sentinel so the identity check is
satisfied by construction and the real blockers (paused / blocking status / incomplete steps / failed
pre-merge steps) remain the sole deciders.

Named and exported because two recovery paths were spelling it independently, and one of them
(`project-engine.ts`) forgot to and instead passed the card's own column — which on a renamed board
parked already-merged work as `failed` with "Merge confirmed but finalization blocked: task is in
'signoff', must be in 'in-review'". One name, one meaning, one place to find it.
*/
export const REVIEW_ELIGIBLE_SENTINEL_COLUMN = "in-review";

/*
FNXC:WorkflowMerge 2026-07-30-21:25 (#2964 review — coderabbitai, "normalize `queued` before the
sentinel blocker check"): ONE SPELLING OF "TRANSIENT ON ALREADY-LANDED WORK", NOT TWO.

`mergeConfirmed` means the branch HAS landed. The statuses below are in-flight bookkeeping the graph
never got to clear, so on a merge-confirmed card they are soft state to drop — not hard blockers that
park finished work `failed`.

Extracted because the two finalization paths were spelling the set independently and had already
DIVERGED: `auto-merge-finalization.ts` cleared `queued`, `project-engine.ts` cleared only the two
`merging*` values. `queued` is a BLOCKING status (`SCHEDULER_TRANSIENT_STATUSES`), so a merge-confirmed
card the scheduler had queued reached the blocker check with it intact and got parked `failed` — the
same "already-landed work parked failed" bug this change fixes for renamed columns, surviving one layer
down. Same failure shape as the sentinel above, same remedy: one name, one meaning.
*/
export const MERGE_CONFIRMED_TRANSIENT_STATUSES: ReadonlySet<string> = new Set([
  "merging",
  "merging-pr",
  "queued",
]);

/** Status a merge-confirmed card should be judged on: transient in-flight bookkeeping cleared. */
export function clearMergeConfirmedTransientStatus(status: string | undefined): string | undefined {
  return status !== undefined && MERGE_CONFIRMED_TRANSIENT_STATUSES.has(status) ? undefined : status;
}

export function getTaskHardMergeBlocker(
  task: Pick<Task, "column" | "paused" | "status" | "error" | "steps" | "workflowStepResults" | "repositoryScope">,
  options: { reviewColumns?: ReadonlySet<string>; requiredPreMergeStepIds?: ReadonlySet<string>; mergeContent?: MergeContentDescriptor } = {},
): string | undefined {
  return getTaskMergeBlocker({
    ...task,
    steps: task.steps ?? [],
    paused: false,
    status: task.status === "failed" ? undefined : task.status,
    error: undefined,
  }, {
    reviewColumns: options.reviewColumns,
    requiredPreMergeStepIds: options.requiredPreMergeStepIds,
    mergeContent: options.mergeContent,
  });
}

/*
FNXC:MergeConfirmedFinalization 2026-08-23-21:40 (FN-9193 aftermath — the wedge that outlived the race):
A CARD WHOSE BRANCH IS ALREADY ON THE TARGET MUST ALWAYS BE ABLE TO FINALIZE. FN-9193 landed
eaa1d47c on main and was then left `mergeConfirmed: true` WITH incomplete steps, because a Code
Review revision request reset its steps while the approved merge was in flight. Every finalization
site evaluated `getTaskHardMergeBlocker`, which counts incomplete steps, so the card could never
reach `done` — it sat `failed` re-reading its own contradiction for five hours, and a RESTART made it
strictly worse: replanning issued seven fresh `pending` steps, so the retry that was supposed to
rescue the card re-created the exact condition blocking it. A self-defeating loop with no exit.

Incomplete steps are not a safety property here. Holding the card out of `done` does not un-merge
anything; the code is live on the target branch either way. The only thing the hold buys is an
inconsistent board and an alarming failed card. Landing proof is established BEFORE this check by
the callers' `hasDurableMergeProof` / reachability verification, so this is not a laundering path:
`mergeConfirmed` alone never reaches here.

What still blocks: a failed or pending PRE-MERGE workflow step (a review that actually rejected this
content is a real signal even post-landing, and the operator-bypass path exists for it). What no
longer blocks: incomplete `steps`, which describe implementation work that the landed branch has
already superseded. Callers must surface the unfinished steps rather than silently dropping them.
*/
export function getMergeConfirmedFinalizationBlocker(
  task: Pick<Task, "column" | "paused" | "status" | "error" | "steps" | "workflowStepResults" | "mergeDetails">,
  options: { reviewColumns?: ReadonlySet<string>; requiredPreMergeStepIds?: ReadonlySet<string> } = {},
): string | undefined {
  /*
  FNXC:MergeConfirmedFinalization 2026-08-23-17:55:
  THE EXEMPTION NEEDS A DURABLE MERGE RECORD, not merely a belief that content landed. Two nearby
  paths look similar and are not:

    - FN-9193's shape: `mergeConfirmed` with the landed `commitSha` — this engine performed the
      merge and recorded it. Incomplete steps here describe work the landed branch superseded, so
      they must not hold the card.
    - The content-scan recovery (`recoverAlreadyMergedReviewTasks`): mergeDetails is ABSENT and the
      sweep infers landing by finding matching content on the base branch, then synthesizes a
      record. That heuristic can match a cherry-pick or a similar commit, so exempting steps there
      would launder a genuinely unfinished task to `done` on a guess. Its own reliability test
      (`landed-content-soft-blocker.real-git.test.ts`) pins that distinction: soft blockers clear,
      incomplete steps hold.

  A no-op merge with no commit sha also fails this test, which is what the executor's no-op branch
  in `merge-confirmed-finalize.ts` depends on.
  */
  const hasDurableMergeRecord = task.mergeDetails?.mergeConfirmed === true
    && typeof task.mergeDetails.commitSha === "string"
    && task.mergeDetails.commitSha.length > 0;
  /*
  FNXC:MergeConfirmedFinalization 2026-08-23-09:38:
  Forward the resolved review-lane context explicitly so finalization keeps project workflow semantics and the lane-wiring ratchet can prove the seam is active.
  */
  return getTaskHardMergeBlocker(hasDurableMergeRecord ? { ...task, steps: [] } : task, {
    reviewColumns: options.reviewColumns,
    requiredPreMergeStepIds: options.requiredPreMergeStepIds,
  });
}

/** Non-terminal steps on a card being finalized after a proven merge — recorded, never silently dropped. */
export function getUnfinishedStepTitles(task: Pick<Task, "steps">): string[] {
  return (task.steps ?? [])
    .filter((step) => NON_TERMINAL_STEP_STATUSES.has(step.status))
    .map((step, index) => step.name?.trim() || `step ${index + 1}`);
}

export function getTaskDoneBypassBlocker(
  task: Pick<Task, "noCommitsExpected" | "mergeDetails" | "prInfo" | "prInfos">,
): string | undefined {
  if (task.noCommitsExpected === true) return undefined;
  if (task.mergeDetails?.mergeConfirmed === true) return undefined;
  if (task.prInfo?.status === "merged") return undefined;
  if (task.prInfos?.some((pr) => pr.status === "merged")) return undefined;
  return TASK_DONE_BYPASS_BLOCKER_MESSAGE;
}

export function isTaskReadyForMerge(
  task: Pick<Task, "column" | "paused" | "status" | "error" | "steps" | "workflowStepResults" | "repositoryScope">,
  options: {
    reviewColumns?: ReadonlySet<string>;
    requiredPreMergeStepIds?: ReadonlySet<string>;
    mergeContent?: MergeContentDescriptor;
  } = {},
): boolean {
  /*
  FNXC:WorkflowLifecycleColumns 2026-08-29-23:50:
  Forward each resolved lane input by name rather than spreading `options` through.
  #3514 wrote it this way so the lane-wiring census can prove the seam is active; a
  later merge of origin/main resolved the conflict back to the wholesale forward, and
  because a bare `options` pass reads as an unwired call site the ratchet went red on
  main — failing the Lint gate on every open PR at once, none of which had touched
  this file. Keep the arguments explicit: the census reads call sites, not types.
  */
  return getTaskMergeBlocker(task, {
    reviewColumns: options.reviewColumns,
    requiredPreMergeStepIds: options.requiredPreMergeStepIds,
    mergeContent: options.mergeContent,
  }) === undefined;
}

export interface TaskCompletionBlockerOptions {
  /**
   * Resolves a task reference so completion gating can distinguish live blockers
   * from stale `blockedBy` markers. Missing tasks and blockers already in
   * their workflow's Complete column are treated as non-blocking; historical-sentinel
   * rows are absent from ordinary live resolution.
   */
  resolveTask?: (taskId: string) => Promise<Pick<Task, "id" | "column"> | null | undefined>;
  /*
  FNXC:WorkflowLifecycleColumns 2026-07-31-00:20 (batch-core feed):
  Per-blocker resolved lane vocabulary, keyed by the BLOCKER's task id — not the blocked task's.
  A dependency lives on its own board and its own workflow decides when it is finished.

  Shaped and named to match `DependencySatisfactionColumns` in the scheduler so the two answers to
  "is this dependency satisfied?" read identically at both call sites. It is not the same TYPE only
  because that one lives in `@fusion/engine`, which core cannot import.

  A blocker missing from the map keeps the legacy literals, which is why the map is per-id rather
  than a flat pair of sets: a board spanning workflows must not have one dependency's `done` column
  answer for another's.
  */
  satisfactionColumnsByTaskId?: ReadonlyMap<string, { terminal: ReadonlySet<string>; review: ReadonlySet<string> }>;
}

/*
FNXC:WorkflowLifecycleColumns 2026-07-31-00:20 (batch-core feed):
The two dependency questions, resolved against the DEPENDENCY's own workflow.

Keyed on the literals, a blocker that had genuinely finished on a renamed board never counted as
terminal, so `blockedBy` never cleared and the blocked task waited forever. Nothing errors and
nothing retries — the card simply never becomes eligible, which is the failure mode this whole
program keeps finding.

They are SEPARATE because the two gates genuinely differ: a hard `blockedBy` marker clears only on
terminal (complete), while a declared dependency also clears once it reaches REVIEW — the
work is done even though the merge has not landed. Collapsing them would either strand every
dependent behind an unmerged dependency or release blocked cards too early.
*/
function isDependencyTerminal(
  dependency: Pick<Task, "id" | "column">,
  options: TaskCompletionBlockerOptions,
): boolean {
  const columns = options.satisfactionColumnsByTaskId?.get(dependency.id);
  /* DELIBERATE-LITERAL — the unconverted-caller default, reviewed 2026-07-31-00:20. */
  if (!columns) return dependency.column === "done";
  return columns.terminal.has(dependency.column);
}

function isDependencySatisfied(
  dependency: Pick<Task, "id" | "column">,
  options: TaskCompletionBlockerOptions,
): boolean {
  const columns = options.satisfactionColumnsByTaskId?.get(dependency.id);
  /* DELIBERATE-LITERAL — the same documented default, reviewed 2026-07-31-00:20. */
  if (!columns) {
    return dependency.column === "done" || dependency.column === "in-review";
  }
  return columns.terminal.has(dependency.column) || columns.review.has(dependency.column);
}

/**
 * Returns a human-readable reason when a task should not be treated as
 * successfully complete yet. Undefined means the task can be finalized.
 *
 * This is intentionally conservative: if dependency state cannot be resolved,
 * the helper only blocks when the task itself carries enough state to prove
 * completion is unsafe (`blockedBy`).
 */
export async function getTaskCompletionBlocker(
  task: Pick<Task, "blockedBy" | "dependencies">,
  options: TaskCompletionBlockerOptions = {},
): Promise<string | undefined> {
  const blockedBy = task.blockedBy?.trim();
  if (blockedBy) {
    if (!options.resolveTask) {
      return `task is blocked by ${blockedBy}`;
    }

    const blocker = await options.resolveTask(blockedBy);
    if (blocker && !isDependencyTerminal(blocker, options)) {
      return `task is blocked by ${blockedBy}`;
    }
  }

  const dependencies = task.dependencies ?? [];
  if (dependencies.length === 0 || !options.resolveTask) {
    return undefined;
  }

  const unresolvedDependencies: string[] = [];

  for (const dependencyId of dependencies) {
    const dependency = await options.resolveTask(dependencyId);
    if (!dependency || !isDependencySatisfied(dependency, options)) {
      unresolvedDependencies.push(dependencyId);
    }
  }

  if (unresolvedDependencies.length > 0) {
    return `task has unresolved dependencies: ${unresolvedDependencies.join(", ")}`;
  }

  return undefined;
}

/*
FNXC:StepResume 2026-07-19-21:34:
Operator escape hatch for in-review tasks with permanently pending workflow steps.
Finds the latest pre-merge workflow step in pending status so the operator can
then resume/bypass it. Does not consider post-merge steps.
*/
export function findPendingPreMergeStep(
  task: Pick<Task, "workflowStepResults">,
): WorkflowStepResult | undefined {
  if (!task.workflowStepResults) return undefined;

  const pendingPreMerge = task.workflowStepResults.filter(
    (step) => step.phase !== "post-merge" && step.status === "pending",
  );

  if (pendingPreMerge.length === 0) return undefined;

  // Return the newest pending pre-merge step (by startedAt, descending)
  return pendingPreMerge.sort(
    (a, b) => new Date(b.startedAt ?? 0).getTime() - new Date(a.startedAt ?? 0).getTime(),
  )[0];
}
