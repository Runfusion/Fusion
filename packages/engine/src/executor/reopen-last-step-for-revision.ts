/**
 * FNXC:CodeOrganization 2026-08-03-18:30:
 * reopenLastStepForRevision peeled from TaskExecutor (U4).
 *
 * FNXC:WorkflowOptionalStepFix 2026-06-27-18:03:
 * Code Review / Browser Verification REVISE bounces must reopen the step that can actually make the requested code change, not only a trailing Documentation & Delivery or Testing & Verification step. Otherwise the graph rerun can complete a trivial terminal step, re-evaluate the optional group against unchanged code, and loop or strand pending work. Reopen the trailing verification/delivery suffix plus the nearest preceding implementation step so both in-progress and in-review bounce sources re-launch execution on actionable work before optional-step re-evaluation.
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

  // Match step-title words rather than arbitrary substrings so an implementation step
  // like "DataVerificationLayer" is not treated as a trailing delivery/check step.
  const isTerminalVerificationOrDeliveryStep = (name: string): boolean =>
    /(^|[^a-z])(testing|verification|documentation|delivery)([^a-z]|$)/i.test(name);

  const resetIndexes = new Set<number>([lastNonPendingIndex]);
  if (isTerminalVerificationOrDeliveryStep(steps[lastNonPendingIndex].name)) {
    let cursor = lastNonPendingIndex;
    while (cursor >= 0 && isTerminalVerificationOrDeliveryStep(steps[cursor].name)) {
      resetIndexes.add(cursor);
      cursor--;
    }
    while (cursor >= 0 && steps[cursor].status === "pending") {
      cursor--;
    }
    if (cursor >= 0) {
      resetIndexes.add(cursor);
    }
  }

  const indexes = [...resetIndexes].sort((a, b) => a - b);
  for (const index of indexes) {
    if (steps[index].status !== "pending") {
      await store.updateStep(taskId, index, "pending");
    }
  }
  const currentStep = indexes[0] ?? lastNonPendingIndex;
  await store.updateTask(taskId, { currentStep });
  return { index: currentStep, name: steps[currentStep].name, indexes };
}
