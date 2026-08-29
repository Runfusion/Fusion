import type { Task, TaskReleaseGateVerdict } from "@fusion/core";

export const RELEASE_GATE_VERDICT_MAX_AGE_MS = 30_000;

/** Stable browser-visible evidence; undefined and [] intentionally serialize differently. */
export function releaseGateEvidenceFingerprint(task: Pick<Task, "column" | "status" | "paused" | "pausedReason" | "workflowIrPin" | "workflowIrPinNodeId" | "enabledWorkflowSteps" | "workflowStepResults" | "steps">): string {
  const review = (task.workflowStepResults ?? [])
    .filter((entry) => entry.workflowStepId === "plan-review")
    .map((entry) => [entry.workflowStepId, entry.status, entry.verdict ?? null, entry.supersededAt ?? null])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return JSON.stringify({
    column: task.column, status: task.status ?? null, paused: task.paused ?? null, pausedReason: task.pausedReason ?? null,
    workflowIrPin: task.workflowIrPin ?? null, workflowIrPinNodeId: task.workflowIrPinNodeId ?? null,
    enabledWorkflowSteps: task.enabledWorkflowSteps === undefined ? "__undefined__" : [...task.enabledWorkflowSteps].sort(),
    review, stepCount: task.steps?.length ?? 0,
  });
}

export interface ReleaseGateProvenance { fingerprint: string; capturedAt: number; }

export function isReleaseGateVerdictFresh(verdict: TaskReleaseGateVerdict, task: Task, provenance: ReleaseGateProvenance | undefined, now: number): boolean {
  if (!provenance || provenance.fingerprint !== releaseGateEvidenceFingerprint(task)) return false;
  if (task.updatedAt && (!verdict.evaluatedForUpdatedAt || task.updatedAt > verdict.evaluatedForUpdatedAt)) return false;
  const evaluatedAt = Date.parse(verdict.evaluatedAt);
  return Number.isFinite(evaluatedAt) && now - evaluatedAt <= RELEASE_GATE_VERDICT_MAX_AGE_MS;
}
