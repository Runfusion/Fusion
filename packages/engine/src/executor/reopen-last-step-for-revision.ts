/**
 * FNXC:CodeOrganization 2026-08-03-18:30:
 * reopenLastStepForRevision peeled from TaskExecutor (U4).
 *
 * FNXC:WorkflowStepReopenAuthority 2026-08-23-08:51:
 * FN-180 requires the workflow-resolved replay policy to be the only authority after a review
 * rejection. Step-title heuristics reopened Testing and Documentation steps by name, creating a
 * second authority that could make a confirmed merge's checklist stale. A permitted replay reopens
 * exactly the last actionable completed step; workflows that must preserve remediation steps select
 * the `none` policy before reaching this helper.
 */
import type { Task, TaskStore } from "@fusion/core";

export async function reopenLastStepForRevision(
  store: TaskStore,
  taskId: string,
  task: Task,
): Promise<{ index: number; name: string; indexes: number[] } | null> {
  const steps = task.steps;
  if (steps.length === 0) return null;

  let lastNonPendingIndex = -1;
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i].status !== "pending") {
      lastNonPendingIndex = i;
      break;
    }
  }

  if (lastNonPendingIndex === -1) {
    await store.updateTask(taskId, { currentStep: 0 });
    return null;
  }

  const index = lastNonPendingIndex;
  await store.updateStep(taskId, index, "pending");
  await store.updateTask(taskId, { currentStep: index });
  return { index, name: steps[index].name, indexes: [index] };
}
