import type { TaskStep } from "../types/task/task-log.js";

export interface RemediationStepInput {
  name?: string;
  remediation: NonNullable<TaskStep["remediation"]>;
  dependsOn?: number[];
}

/**
 * FNXC:ReviewGatedCoding 2026-08-23-04:52:
 * Review remediation names deliberately omit their gate. `Fix (Verification): …` collides with
 * legacy lexical replay/evidence rules, while the durable remediation provenance is the sole
 * authority for gate identity.
 */
export function formatRemediationStepName(input: { detail?: string; name?: string }): string {
  const detail = (input.detail ?? input.name ?? "review finding").replace(/\s+/g, " ").trim();
  return `Fix: ${detail || "review finding"}`;
}

/** Structural provenance, rather than a step name, classifies appended review work. */
export function isRemediationStep(step: TaskStep): step is TaskStep & { remediation: NonNullable<TaskStep["remediation"]> } {
  return step.remediation !== undefined;
}

export function remediationWaveCount(steps: readonly TaskStep[]): number {
  return steps.reduce((highest, step) => Math.max(highest, step.remediation?.wave ?? 0), 0);
}

const normalize = (value: string | undefined): string => (value ?? "").replace(/\\/g, "/").trim().replace(/\s+/g, " ").toLowerCase();

/** Only open equivalent work is deduplicated; a recurrence after completion is new work. */
export function hasOpenEquivalentRemediationStep(
  steps: readonly TaskStep[],
  candidate: Pick<TaskStep, "remediation">,
): boolean {
  const remediation = candidate.remediation;
  if (!remediation) return false;
  return steps.some((step) =>
    isRemediationStep(step)
    && (step.status === "pending" || step.status === "in-progress")
    && normalize(step.remediation.filePath) === normalize(remediation.filePath)
    && normalize(step.remediation.detail) === normalize(remediation.detail),
  );
}

export function remediationDeclaredFiles(steps: readonly TaskStep[]): string[] {
  return [...new Set(steps.flatMap((step) => step.remediation?.declaredFiles ?? []).map((file) => file.trim()).filter(Boolean))].sort();
}
