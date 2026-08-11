import { describe, expect, it } from "vitest";
import {
  RELEASE_GATE_VERDICT_MAX_AGE_MS,
  isReleaseGateVerdictFresh,
  releaseGateEvidenceFingerprint,
} from "../releaseGate";

const task = {
  id: "FN-8987",
  description: "test",
  column: "todo",
  status: null,
  paused: false,
  workflowIrPin: "builtin:coding",
  enabledWorkflowSteps: undefined,
  workflowStepResults: [],
  steps: [{ name: "Plan", status: "pending" }],
  updatedAt: "2026-08-11T20:00:00.000Z",
} as any;
const verdict = {
  promoteBlocked: false,
  unplannedForExecution: false,
  blockedOnApproval: false,
  reason: null,
  readyAtCapacityBoundary: false,
  evaluatedAt: "2026-08-11T20:00:00.000Z",
  evaluatedForUpdatedAt: task.updatedAt,
} as const;

describe("release-gate freshness", () => {
  it("fingerprints every browser-visible release input deterministically", () => {
    const fingerprint = releaseGateEvidenceFingerprint(task);
    expect(releaseGateEvidenceFingerprint({ ...task, enabledWorkflowSteps: ["code-review", "plan-review"] })).toBe(
      releaseGateEvidenceFingerprint({ ...task, enabledWorkflowSteps: ["plan-review", "code-review"] }),
    );
    expect(releaseGateEvidenceFingerprint({ ...task, enabledWorkflowSteps: [] })).not.toBe(fingerprint);
    expect(releaseGateEvidenceFingerprint({ ...task, pausedReason: "awaiting-approval" })).not.toBe(fingerprint);
    expect(releaseGateEvidenceFingerprint({ ...task, workflowStepResults: [{ workflowStepId: "plan-review", status: "passed" }] })).not.toBe(fingerprint);
  });

  it("drops a verdict when its row clock, evidence, or bounded age becomes unsafe", () => {
    const provenance = { fingerprint: releaseGateEvidenceFingerprint(task), capturedAt: 0 };
    const now = Date.parse(verdict.evaluatedAt);
    expect(isReleaseGateVerdictFresh(verdict, task, provenance, now)).toBe(true);
    expect(isReleaseGateVerdictFresh(verdict, { ...task, status: "planning" }, provenance, now)).toBe(false);
    expect(isReleaseGateVerdictFresh(verdict, { ...task, updatedAt: "2026-08-11T20:00:00.001Z" }, provenance, now)).toBe(false);
    expect(isReleaseGateVerdictFresh(verdict, task, provenance, now + RELEASE_GATE_VERDICT_MAX_AGE_MS + 1)).toBe(false);
  });
});
