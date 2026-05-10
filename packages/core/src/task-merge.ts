import type { Task, WorkflowStepResult } from "./types.js";

export interface MergeTargetResolution {
  branch: string;
  source: "task-base-branch" | "task-branch-context" | "project-default" | "legacy-main";
}

export interface MergeTargetResolverOptions {
  projectDefaultBranch?: string;
  legacyFallbackBranch?: string;
}

export function resolveTaskMergeTarget(
  task: Pick<Task, "baseBranch" | "branchContext">,
  options: MergeTargetResolverOptions = {},
): MergeTargetResolution {
  const configuredBase = task.baseBranch?.trim();
  if (configuredBase) {
    return { branch: configuredBase, source: "task-base-branch" };
  }

  const inheritedBase = task.branchContext?.inheritedBaseBranch?.trim();
  if (inheritedBase) {
    return { branch: inheritedBase, source: "task-branch-context" };
  }

  const projectDefault = options.projectDefaultBranch?.trim();
  if (projectDefault) {
    return { branch: projectDefault, source: "project-default" };
  }

  const legacyFallback = options.legacyFallbackBranch?.trim() || "main";
  return { branch: legacyFallback, source: "legacy-main" };
}

const BLOCKING_TASK_STATUSES = new Set([
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
  // ── Scheduler-side transient state ───────────────────────────────────
  "queued",                  // scheduler placed the task in line; not finalized
  // ── Abnormal termination — defensive guard ───────────────────────────
  // Task was killed by the stuck detector. If it surfaces in in-review,
  // it needs investigation, not auto-merge.
  "stuck-killed",
]);

const NON_TERMINAL_STEP_STATUSES = new Set([
  "pending",
  "in-progress",
]);

const NON_TERMINAL_WORKFLOW_STATUSES = new Set<WorkflowStepResult["status"]>([
  "pending",
]);

/**
 * Returns a human-readable reason when a task in review is not safe to finalize.
 * Undefined means the task is eligible to move from `in-review` to `done`.
 */
export function getTaskMergeBlocker(
  task: Pick<Task, "column" | "paused" | "status" | "error" | "steps" | "workflowStepResults">,
): string | undefined {
  if (task.column !== "in-review") {
    return `task is in '${task.column}', must be in 'in-review'`;
  }

  if (task.paused) {
    return "task is paused";
  }

  if (task.status && BLOCKING_TASK_STATUSES.has(task.status)) {
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

export function isTaskReadyForMerge(
  task: Pick<Task, "column" | "paused" | "status" | "error" | "steps" | "workflowStepResults">,
): boolean {
  return getTaskMergeBlocker(task) === undefined;
}

export interface TaskCompletionBlockerOptions {
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
  if (task.blockedBy?.trim()) {
    return `task is blocked by ${task.blockedBy.trim()}`;
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
