import { describe, expect, it } from "vitest";
import { evaluateTaskReleaseGate } from "@fusion/engine";
import type { WorkflowIr } from "@fusion/core";
import { resolvePromoteSuppressed } from "../reviewBudgetApproval";
import { isReleaseGateVerdictFresh, releaseGateEvidenceFingerprint } from "../releaseGate";

const ir: WorkflowIr = {
  version: "v2", name: "release-gate-contract", columns: [
    { id: "todo", name: "Todo", traits: [{ trait: "hold", config: { release: "capacity" } }] },
    { id: "in-progress", name: "In progress", traits: [{ trait: "wip" }] },
  ],
  nodes: [{ id: "start", kind: "start", column: "todo" }], edges: [],
} as WorkflowIr;

describe("release-gate client/server contract", () => {
  it("uses the engine verdict verbatim and refuses stale evidence", async () => {
    const task = {
      id: "FN-8987-contract", title: "Specified task", description: "Specified task", column: "todo",
      dependencies: [], status: null, enabledWorkflowSteps: undefined,
      updatedAt: "2026-08-11T20:00:00.000Z",
    } as any;
    const verdict = await evaluateTaskReleaseGate({ getTasksDir: () => "/missing" } as any, task, { ir });
    expect(verdict).toBeDefined();
    expect(resolvePromoteSuppressed({ releaseGate: verdict }, true)).toBe(verdict!.promoteBlocked);
    const provenance = { fingerprint: releaseGateEvidenceFingerprint(task), capturedAt: Date.now() };
    expect(isReleaseGateVerdictFresh(verdict!, task, provenance, Date.parse(verdict!.evaluatedAt))).toBe(true);
    expect(isReleaseGateVerdictFresh(verdict!, { ...task, updatedAt: "2026-08-11T20:00:00.001Z" }, provenance, Date.parse(verdict!.evaluatedAt))).toBe(false);
  });
});
