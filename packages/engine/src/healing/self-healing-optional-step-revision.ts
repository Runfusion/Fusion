/**
 * FNXC:CodeOrganization 2026-07-16-14:00:
 * Optional workflow-step revision key helpers peeled from self-healing.ts.
 */
import type { Task } from "@fusion/core";

export const OPTIONAL_STEP_REVISION_KEY_MARKER = "Workflow revision key:";

export function normalizeOptionalStepRevisionKey(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

export function optionalStepRevisionKey(nodeId: string | undefined, stepName: string | undefined): string {
  return normalizeOptionalStepRevisionKey(nodeId) || normalizeOptionalStepRevisionKey(stepName) || "pre-merge-optional-step";
}

export function countOptionalStepRevisionAttempts(task: Pick<Task, "log">, key: string, stepName: string | undefined): number {
  const normalizedKey = normalizeOptionalStepRevisionKey(key);
  const normalizedStepName = normalizeOptionalStepRevisionKey(stepName);
  return (task.log ?? []).filter((entry) => {
    const action = entry.action ?? "";
    const outcome = entry.outcome ?? "";
    if (!/attempt \d+\//.test(action)) return false;
    const markerIndex = outcome.indexOf(OPTIONAL_STEP_REVISION_KEY_MARKER);
    if (markerIndex >= 0) {
      const markerValue = outcome.slice(markerIndex + OPTIONAL_STEP_REVISION_KEY_MARKER.length).split(/\r?\n/, 1)[0]?.trim();
      return normalizeOptionalStepRevisionKey(markerValue) === normalizedKey;
    }
    if (!normalizedStepName) return false;
    return normalizeOptionalStepRevisionKey(outcome).includes(`step: ${normalizedStepName}`);
  }).length;
}

export function optionalStepRevisionLogOutcome(details: string, key: string): string {
  return `${details}\n${OPTIONAL_STEP_REVISION_KEY_MARKER} ${key}`;
}
