import { taskHasManualOpenPullRequest } from "./task-helpers.js";
import type { BranchGroup, Settings, Task, WorkflowStepResult } from "./types.js";

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

function isFusionSiblingBranch(branch: string): boolean {
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
 * Shared-branch member integration still bypasses this function via `allowInReviewMergeProcessing(... ) || isSharedBranchGroupMemberIntegration(task)`, so a manual PR on a shared member can still be integrated to its group branch; group-to-default promotion remains gated separately.
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
 * member branch → shared group branch. This path is exempt from the global
 * `autoMerge:false` in-review terminal gate so member integration can proceed,
 * but shared-branch → default-branch promotion remains separately gated.
 */
export function isSharedBranchGroupMemberIntegration(
  task: Pick<Task, "branchContext">,
): boolean {
  return task.branchContext?.assignmentMode === "shared"
    && Boolean(task.branchContext.groupId?.trim());
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

const NON_TERMINAL_WORKFLOW_STATUSES = new Set<WorkflowStepResult["status"]>([
  "pending",
]);

export const TASK_DONE_BYPASS_BLOCKER_MESSAGE =
  "done bypass requires merge confirmation or explicit no-commits policy";

/**
 * Returns a human-readable reason when a task in review is not safe to finalize.
 * Undefined means the task is eligible to move from `in-review` to `done`.
 */
export function getTaskMergeBlocker(
  task: Pick<Task, "column" | "paused" | "status" | "error" | "steps" | "workflowStepResults">,
  options: { manual?: boolean } = {},
): string | undefined {
  if (task.column !== "in-review") {
    return `task is in '${task.column}', must be in 'in-review'`;
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

export function getTaskHardMergeBlocker(
  task: Pick<Task, "column" | "paused" | "status" | "error" | "steps" | "workflowStepResults">,
): string | undefined {
  return getTaskMergeBlocker({
    ...task,
    steps: task.steps ?? [],
    paused: false,
    status: task.status === "failed" ? undefined : task.status,
    error: undefined,
  });
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
  task: Pick<Task, "column" | "paused" | "status" | "error" | "steps" | "workflowStepResults">,
): boolean {
  return getTaskMergeBlocker(task) === undefined;
}

export interface TaskCompletionBlockerOptions {
  /**
   * Resolves a task reference so completion gating can distinguish live blockers
   * from stale `blockedBy` markers. Missing tasks and blockers already in
   * `done`/`archived` are treated as non-blocking.
   */
  resolveTask?: (taskId: string) => Promise<Pick<Task, "id" | "column"> | null | undefined>;
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
    if (blocker && blocker.column !== "done" && blocker.column !== "archived") {
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
    if (!dependency || (dependency.column !== "done" && dependency.column !== "in-review" && dependency.column !== "archived")) {
      unresolvedDependencies.push(dependencyId);
    }
  }

  if (unresolvedDependencies.length > 0) {
    return `task has unresolved dependencies: ${unresolvedDependencies.join(", ")}`;
  }

  return undefined;
}
