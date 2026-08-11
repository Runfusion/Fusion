/**
 * FNXC:CodeOrganization 2026-08-03-12:45:
 * Pure workflow-step satisfaction helpers peeled from executor.ts (U4 Slice A).
 */
import type { Task, TaskDetail, WorkflowStepResult as CoreWorkflowStepResult } from "@fusion/core";

export function hasNonTerminalWorkflowSteps(task: Pick<TaskDetail, "steps">): boolean {
  return task.steps.length > 0 && task.steps.some((step) => step.status !== "done" && step.status !== "skipped");
}

export function workflowStepResultPassed(
  task: Pick<Task, "workflowStepResults"> | undefined,
  workflowStepId: string,
): boolean {
  const results = task?.workflowStepResults ?? [];
  return results.some((result) =>
    result.workflowStepId === workflowStepId
    && result.phase === "pre-merge"
    && result.status === "passed",
  );
}

export function areExplicitEnabledWorkflowStepsSatisfied(
  task: Pick<Task, "enabledWorkflowSteps" | "workflowStepResults"> | undefined,
): boolean {
  const enabled = task?.enabledWorkflowSteps;
  if (!Array.isArray(enabled) || enabled.length === 0) return false;
  return enabled.every((id) => workflowStepResultPassed(task, id));
}

export function hasUnsatisfiedExplicitEnabledWorkflowSteps(
  task: Pick<Task, "enabledWorkflowSteps" | "workflowStepResults"> | undefined,
): boolean {
  const enabled = task?.enabledWorkflowSteps;
  return Array.isArray(enabled) && enabled.length > 0 && !areExplicitEnabledWorkflowStepsSatisfied(task);
}

export function areEnabledPreMergeWorkflowStepsSatisfied(
  task: Pick<Task, "enabledWorkflowSteps" | "workflowStepResults"> | undefined,
): boolean {
  const preMergeGateIds = new Set(["plan-review", "browser-verification", "code-review"]);
  const enabled = task?.enabledWorkflowSteps;
  /*
   * FNXC:WorkflowLifecycle 2026-06-29-04:46:
   * Older/default coding tasks may not persist an explicit enabledWorkflowSteps
   * list even though default-on Plan Review and Code Review have already run.
   * Treat those two passed rows as satisfied defaults; keep explicit arrays
   * strict so custom/unknown enabled gates still re-enter the graph.
   */
  const enabledPreMerge = Array.isArray(enabled) && enabled.length > 0
    ? enabled.filter((id) => preMergeGateIds.has(id))
    : ["plan-review", "code-review"];
  if (enabledPreMerge.length === 0) return false;
  if (Array.isArray(enabled) && enabledPreMerge.length !== enabled.length) return false;
  return enabledPreMerge.every((id) => workflowStepResultPassed(task, id));
}

export function preservePreExecutionWorkflowStepResults(
  task: Pick<Task, "workflowStepResults" | "log">,
): CoreWorkflowStepResult[] {
  /*
   * FNXC:WorkflowLifecycle 2026-06-29-03:50:
   * Reverification cleanup must clear post-implementation verification residue
   * without erasing pre-execution Plan Review evidence. FN-7228 passed Plan
   * Review, then stale merge-state cleanup reset `workflowStepResults` to `[]`;
   * the dashboard showed Plan Review with no status while execution continued and
   * the graph no longer had durable proof to skip duplicate plan review.
   *
   * FNXC:WorkflowLifecycle 2026-06-29-04:19:
   * The durable Plan Review row may already be missing when stale merge cleanup
   * runs, while the task log still has the authoritative terminal Plan Review
   * entry. Reconstruct the passed row from that log so execution can continue
   * with a visible pre-execution review status instead of showing an active task
   * card with Plan Review blank.
   */
  const preserved = (task.workflowStepResults ?? []).filter((result) => result.workflowStepId === "plan-review");
  if (preserved.length > 0) return preserved;

  let latest: { timestamp?: string; outcome?: string; status: "passed" | "failed" } | undefined;
  for (const entry of task.log ?? []) {
    if (entry.action === "[pre-merge] Workflow step completed: Plan Review") {
      latest = { timestamp: entry.timestamp, outcome: entry.outcome, status: "passed" };
    } else if (entry.action === "[pre-merge] Workflow step failed: Plan Review") {
      latest = { timestamp: entry.timestamp, outcome: entry.outcome, status: "failed" };
    }
  }
  if (latest?.status !== "passed") return [];
  return [
    {
      workflowStepId: "plan-review",
      workflowStepName: "Plan Review",
      phase: "pre-merge",
      status: "passed",
      verdict: "APPROVE",
      ...(latest.outcome ? { output: latest.outcome, notes: latest.outcome } : {}),
      ...(latest.timestamp ? { startedAt: latest.timestamp, completedAt: latest.timestamp } : {}),
    },
  ];
}
