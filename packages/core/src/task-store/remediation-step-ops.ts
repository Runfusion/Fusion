import type { TaskStore } from "../store.js";
import type { Task, TaskStep } from "../types.js";
import { hasOpenEquivalentRemediationStep, remediationWaveCount } from "../tasks/remediation-steps.js";
import { planRemediationPlacement } from "../tasks/remediation-step-placement.js";

export interface AppendRemediationStepsOptions {
  wave?: number;
}

export interface AppendRemediationStepsResult {
  task: Task;
  appended: TaskStep[];
  appendedCount: number;
  wave: number;
  insertionIndex?: number;
  verificationStepIndex?: number;
}

/**
 * FNXC:ReviewGatedCoding 2026-08-23-04:52:
 * Remediation can arrive while an execution session owns the same task. Append under the task's
 * atomic mutation so existing implementation steps are never reordered, rewritten, or lost.
 */
export async function appendRemediationStepsImpl(
  store: Pick<TaskStore, "updateTaskAtomic">,
  taskId: string,
  candidates: readonly TaskStep[],
  options: AppendRemediationStepsOptions = {},
): Promise<AppendRemediationStepsResult> {
  let appended: TaskStep[] = [];
  let wave = 0;
  let insertionIndex: number | undefined;
  let verificationStepIndex: number | undefined;
  const task = await store.updateTaskAtomic(taskId, (current) => {
    const existing = current.steps ?? [];
    wave = options.wave ?? remediationWaveCount(existing) + 1;
    appended = candidates
      .filter((candidate) => candidate.remediation !== undefined)
      .filter((candidate) => !hasOpenEquivalentRemediationStep([...existing, ...appended], candidate))
      .map((candidate) => ({
        ...candidate,
        status: "pending",
        remediation: { ...candidate.remediation!, wave: candidate.remediation?.wave ?? wave },
        ...(candidate.dependsOn ? { dependsOn: [...candidate.dependsOn] } : {}),
      }));
    if (appended.length === 0) return null;
    const placement = planRemediationPlacement(existing, appended);
    insertionIndex = placement.insertionIndex;
    verificationStepIndex = placement.verificationStepIndex;
    return { steps: placement.steps, currentStep: placement.insertionIndex };
  });
  return {
    task,
    appended,
    appendedCount: appended.length,
    wave,
    ...(insertionIndex === undefined ? {} : { insertionIndex }),
    ...(verificationStepIndex === undefined ? {} : { verificationStepIndex }),
  };
}
