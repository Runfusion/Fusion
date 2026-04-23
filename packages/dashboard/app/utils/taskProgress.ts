import type { Task, WorkflowStepResult, WorkflowStepPhase, StepStatus } from "@fusion/core";

export type UnifiedTaskProgressStatus = StepStatus | "failed";

export interface UnifiedTaskProgressItem {
  id: string;
  name: string;
  status: UnifiedTaskProgressStatus;
  source: "step" | "workflow";
  phase: WorkflowStepPhase;
}

export interface UnifiedTaskProgress {
  total: number;
  completed: number;
  items: UnifiedTaskProgressItem[];
}

function mapWorkflowStatus(status: WorkflowStepResult["status"]): UnifiedTaskProgressStatus {
  switch (status) {
    case "passed":
      return "done";
    case "failed":
      return "failed";
    case "skipped":
      return "skipped";
    case "pending":
    default:
      return "pending";
  }
}

function isCompleted(status: UnifiedTaskProgressStatus): boolean {
  return status === "done" || status === "skipped";
}

export function getUnifiedTaskProgress(task: Pick<Task, "steps" | "enabledWorkflowSteps" | "workflowStepResults">): UnifiedTaskProgress {
  const stepItems: UnifiedTaskProgressItem[] = (task.steps ?? []).map((step, index) => ({
    id: `step-${index}`,
    name: step.name,
    status: step.status,
    source: "step",
    phase: "pre-merge",
  }));

  const workflowResultsById = new Map(
    (task.workflowStepResults ?? []).map((result) => [result.workflowStepId, result] as const),
  );

  const workflowItems: UnifiedTaskProgressItem[] = (task.enabledWorkflowSteps ?? []).map((workflowStepId) => {
    const result = workflowResultsById.get(workflowStepId);
    return {
      id: `workflow-${workflowStepId}`,
      name: result?.workflowStepName || workflowStepId,
      status: result ? mapWorkflowStatus(result.status) : "pending",
      source: "workflow",
      phase: result?.phase ?? "pre-merge",
    };
  });

  const items = [...stepItems, ...workflowItems];
  const total = items.length;
  const completed = items.filter((item) => isCompleted(item.status)).length;

  return { total, completed, items };
}
