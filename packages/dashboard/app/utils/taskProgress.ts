import type { Task, WorkflowStepResult, WorkflowStepPhase, StepStatus } from "@fusion/core";

/*
FNXC:WorkflowSteps 2026-06-25-00:00:
Graph-native workflow steps (plan U3). Optional workflow step status now comes from graph-written
`task.workflowStepResults` entries keyed by node id === enabledWorkflowSteps[i]; top-level workflow nodes can also record explicit `source:"node"` progress for workflows that do not project every stage into `task.steps`. The legacy
`/api/workflow-steps` DB-row name lookup was dropped, so step names resolve from `result.workflowStepName`
with a fallback to the raw id.

Render states (design-lens): the progress model distinguishes
- `pending` (enabled, never started — no `startedAt`)
- `running` (graph node active — `pending` status with a `startedAt` and no `completedAt`)
- `done` (passed)
- `advisory_failure` (non-blocking REVISE — amber, counts as completed; does not block merge)
- `failed` (blocking gate failure — red)
- `skipped`
Disabled optional steps are simply absent from `enabledWorkflowSteps`, so they never appear in the
counter/bar. Recorded workflow-node progress is included independently because it represents an actual graph stage that ran, not a toggle placeholder.
*/

export type UnifiedTaskProgressStatus = StepStatus | "failed" | "advisory_failure" | "running";

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

function mapWorkflowStatus(result: WorkflowStepResult): UnifiedTaskProgressStatus {
  switch (result.status) {
    case "passed":
      return "done";
    case "failed":
      return "failed";
    case "advisory_failure":
      return "advisory_failure";
    case "skipped":
      return "skipped";
    case "pending":
    default:
      // The graph upserts a `pending` entry when a step starts running. A started-but-not-completed
      // entry is the in-progress/`running` display state; a bare `pending` (no `startedAt`) is an
      // enabled step that has not begun yet.
      return result.startedAt && !result.completedAt ? "running" : "pending";
  }
}

function isCompleted(status: UnifiedTaskProgressStatus): boolean {
  // advisory_failure is non-blocking: the step ran and returned feedback, so it counts as completed
  // (overall progress reads complete when only advisory steps returned REVISE).
  return status === "done" || status === "skipped" || status === "advisory_failure";
}

/*
FNXC:WorkflowStepResults 2026-06-26-16:30:
An enabled-but-not-yet-run workflow step has no recorded result yet, so there is no
`workflowStepName` to show. Rather than render the raw graph node id (e.g. `code-review`,
`browser-verification`), humanize it into a Title Case label ("Code Review",
"Browser Verification"). Once the graph records the step it carries the workflow's exact
`config.name`, which always wins; humanization is only the pre-run fallback. The UI must
show proper casing for workflow steps (e.g. "Code Review"), never the lowercase hyphenated id.
*/
function humanizeWorkflowStepId(workflowStepId: string): string {
  const words = workflowStepId
    .replace(/^plugin:/, "")
    .split(/[-_:\s]+/)
    .filter(Boolean);
  if (words.length === 0) return workflowStepId;
  return words
    .map((w) => (/^(ux|ui|qa|ai|api|pr|id)$/i.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

function resolveWorkflowStepName(workflowStepId: string, result: WorkflowStepResult | undefined): string {
  const resultName = result?.workflowStepName?.trim();
  if (resultName) {
    return resultName;
  }
  return humanizeWorkflowStepId(workflowStepId);
}

export function getUnifiedTaskProgress(
  task: Pick<Task, "steps" | "enabledWorkflowSteps" | "workflowStepResults">,
): UnifiedTaskProgress {
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
      name: resolveWorkflowStepName(workflowStepId, result),
      status: result ? mapWorkflowStatus(result) : "pending",
      source: "workflow",
      phase: result?.phase ?? "pre-merge",
    };
  });
  const enabledWorkflowStepIds = new Set(task.enabledWorkflowSteps ?? []);
  /*
  FNXC:TaskCardWorkflowProgress 2026-06-29-15:05:
  Compound Engineering runs top-level skill nodes (Plan, Execute, Commit/PR, Resolve feedback) that do real work but are not optional toggles and do not update `task.steps`. Include recorded `source:"node"` results even when `enabledWorkflowSteps` is empty so task cards and detail progress match the graph's actual active stage, while stale disabled optional-group results remain hidden.
  */
  const recordedNodeItems: UnifiedTaskProgressItem[] = (task.workflowStepResults ?? [])
    .filter((result) => result.source === "node" && !enabledWorkflowStepIds.has(result.workflowStepId))
    .map((result) => ({
      id: `workflow-${result.workflowStepId}`,
      name: resolveWorkflowStepName(result.workflowStepId, result),
      status: mapWorkflowStatus(result),
      source: "workflow",
      phase: result.phase ?? "pre-merge",
    }));

  /*
  FNXC:TaskCardWorkflowProgress 2026-06-29-00:41:
  Plan Review is a pre-execution optional step in the default stepwise Coding workflow, so task cards must show it before parsed implementation steps. End-of-work optional steps such as Code Review stay after implementation steps so the card order matches workflow execution order.
  */
  const preExecutionWorkflowItems = workflowItems.filter((item) => item.id === "workflow-plan-review");
  const remainingWorkflowItems = workflowItems.filter((item) => item.id !== "workflow-plan-review");
  const items = [...preExecutionWorkflowItems, ...stepItems, ...remainingWorkflowItems, ...recordedNodeItems];
  const total = items.length;
  const completed = items.filter((item) => isCompleted(item.status)).length;

  return { total, completed, items };
}
