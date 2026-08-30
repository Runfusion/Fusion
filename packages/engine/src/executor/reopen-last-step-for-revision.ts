/**
 * FNXC:CodeOrganization 2026-08-03-18:30:
 * reopenLastStepForRevision peeled from TaskExecutor (U4).
 *
 * FNXC:WorkflowStepReopenAuthority 2026-08-23-08:51:
 * FN-180 requires the workflow-resolved replay policy to be the only authority after a review
 * rejection. Step-title heuristics created a second authority that could make a confirmed merge's
 * checklist stale. A permitted replay targets exactly the last actionable completed step; workflows
 * that must preserve remediation steps select the `none` policy before reaching this helper.
 *
 * FNXC:WorkflowStepReopenAuthority 2026-08-28-15:11:
 * A completed step is immutable execution history. The single replay authority appends a new pending
 * occurrence instead of rewriting the completed occurrence, while existing pending work prevents
 * duplicate growth.
 */
import type { Task, TaskStore } from "@fusion/core";

export async function reopenLastStepForRevision(
  store: TaskStore,
  taskId: string,
  _task: Task,
): Promise<{ index: number; name: string; indexes: number[] } | null> {
  let replay: { index: number; name: string; indexes: number[] } | null = null;

  await store.updateTaskAtomic(taskId, (current) => {
    const steps = current.steps ?? [];
    if (steps.length === 0 || steps.every((step) => step.status === "pending")) {
      return { currentStep: 0 };
    }
    if (steps.some((step) => step.status === "pending")) {
      return null;
    }

    const trailing = steps.at(-1)!;
    const index = steps.length;
    replay = { index, name: trailing.name, indexes: [index] };
    return {
      steps: [...steps, { name: trailing.name, status: "pending" }],
      currentStep: index,
    };
  });

  return replay;
}
