import type { TaskDetail } from "@fusion/core";

export interface WorkflowCompletionSummaryStore {
  updateTask?: (taskId: string, updates: { summary: string }) => Promise<unknown> | unknown;
  logEntry?: (taskId: string, action: string, detail?: string) => Promise<unknown> | unknown;
}

export interface WorkflowCompletionSummaryInput {
  reason: string;
  workflowId?: string;
  runId?: string;
}

function truncateList(values: string[], limit: number): string {
  const head = values.slice(0, limit);
  const remaining = values.length - head.length;
  return remaining > 0 ? `${head.join(", ")} and ${remaining} more` : head.join(", ");
}

export function buildWorkflowCompletionSummary(
  task: Pick<TaskDetail, "id" | "title" | "steps" | "modifiedFiles" | "workflowStepResults">,
  input: WorkflowCompletionSummaryInput,
): string {
  const title = task.title?.trim() || task.id;
  const steps = task.steps ?? [];
  const doneSteps = steps.filter((step) => step.status === "done" || step.status === "skipped").length;
  const workflowResults = task.workflowStepResults ?? [];
  const passedWorkflowSteps = workflowResults.filter((step) => step.status === "passed" || step.status === "skipped").length;
  const files = (task.modifiedFiles ?? []).filter((file) => file.trim().length > 0);

  const parts = [`Workflow completed: ${title}.`];
  if (steps.length > 0) {
    parts.push(`Completed ${doneSteps}/${steps.length} task step${steps.length === 1 ? "" : "s"}.`);
  }
  if (workflowResults.length > 0) {
    parts.push(`Recorded ${passedWorkflowSteps}/${workflowResults.length} workflow check${workflowResults.length === 1 ? "" : "s"} as passed or skipped.`);
  }
  if (files.length > 0) {
    parts.push(`Changed files: ${truncateList(files, 6)}.`);
  }
  parts.push(`Completion source: ${input.reason}${input.workflowId ? ` (${input.workflowId})` : ""}.`);
  return parts.join(" ");
}

export async function ensureWorkflowCompletionSummary(
  store: WorkflowCompletionSummaryStore,
  task: TaskDetail,
  input: WorkflowCompletionSummaryInput,
): Promise<void> {
  if (task.summary?.trim()) return;
  if (!store.updateTask) return;

  /*
   * FNXC:WorkflowCompletion 2026-06-29-10:58:
   * Workflow-owned tasks can finish through graph nodes and resumable merge work
   * items without an agent calling `fn_task_done`. Persist a deterministic
   * completion summary at the workflow lifecycle boundary so Done/Review cards,
   * GitHub tracking, evals, and archival views see the same `task.summary`
   * contract as legacy executor completions. Existing agent-authored summaries
   * remain authoritative.
   */
  const summary = buildWorkflowCompletionSummary(task, input);
  await store.updateTask(task.id, { summary });
  await store.logEntry?.(
    task.id,
    "Workflow completion summary recorded",
    JSON.stringify({
      reason: input.reason,
      workflowId: input.workflowId,
      runId: input.runId,
    }),
  );
}
