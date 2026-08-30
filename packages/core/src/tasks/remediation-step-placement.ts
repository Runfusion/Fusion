import type { TaskStep } from "../types/task/task-log.js";

export const REMEDIATION_VERIFICATION_STEP_NAME = "Testing & Verification";

export interface RemediationPlacementPlan {
  steps: TaskStep[];
  insertionIndex: number;
  verificationStepIndex?: number;
}

/** Return the final step only when it is the task's trailing verification gate. */
export function resolveTrailingVerificationStepIndex(steps: readonly TaskStep[]): number | undefined {
  const index = steps.length - 1;
  if (index < 0) return undefined;
  const name = steps[index]!.name.replace(/^\s*Step\s+\d+\s*:\s*/i, "").trim();
  return /(?:testing|verification)/i.test(name) ? index : undefined;
}

/*
FNXC:ReviewGatedRemediation 2026-08-28-15:11:
A completed verification step is immutable task history. Append named fixes after the existing list and append a new pending verification occurrence so every revision visibly requires a fresh verification pass before review.
*/
export function planRemediationPlacement(
  existing: readonly TaskStep[],
  appended: readonly TaskStep[],
): RemediationPlacementPlan {
  const insertionIndex = existing.length;
  if (appended.length === 0) {
    return { steps: [...existing], insertionIndex };
  }

  const verificationStepIndex = insertionIndex + appended.length;
  return {
    steps: [
      ...existing,
      ...appended,
      { name: REMEDIATION_VERIFICATION_STEP_NAME, status: "pending" },
    ],
    insertionIndex,
    verificationStepIndex,
  };
}
