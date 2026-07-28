import { describe, expect, it } from "vitest";
import { instanceNodeId } from "../column-agent-resolver.js";
import { evaluateForeachMergeProof } from "../workflow-merge-proof.js";
import type { TaskStep, WorkflowIr, WorkflowStepResult } from "../types.js";

const steps = (statuses: Array<TaskStep["status"]>): TaskStep[] => statuses.map((status, index) => ({ id: `s${index}`, title: `Step ${index}`, status }));
const result = (id: string, status: WorkflowStepResult["status"] = "passed"): WorkflowStepResult => ({ workflowStepId: id, source: "node", phase: "pre-merge", status, completedAt: new Date().toISOString() });
const foreachIr = (seam = true): WorkflowIr => ({ version: 2, columns: [], nodes: [{ id: "steps", kind: "foreach", config: { source: "task-steps", template: { nodes: seam ? [{ id: "step-execute", kind: "prompt", config: { seam: "step-execute" } }] : [{ id: "review", kind: "prompt" }], edges: [] } } }], edges: [] });
const plainIr: WorkflowIr = { version: 2, columns: [], nodes: [{ id: "execute", kind: "prompt", config: { seam: "execute" } }], edges: [] };

describe("evaluateForeachMergeProof", () => {
  it("is vacuously complete without a foreach seam, including empty results", () => {
    for (const ir of [plainIr, foreachIr(false)]) {
      const proof = evaluateForeachMergeProof({ ir, steps: steps(["pending"]), workflowStepResults: [] });
      expect(proof).toMatchObject({ hasForeachStepExecute: false, expectedInstanceIds: [], missingInstanceIds: [] });
    }
  });

  it("covers complete, partial, zero-step, already-terminal, failed, post-merge, and duplicate result shapes", () => {
    const ids = [0, 1, 2].map((index) => instanceNodeId("steps", index, "step-execute"));
    expect(evaluateForeachMergeProof({ ir: foreachIr(), steps: steps(["pending", "pending", "pending"]), workflowStepResults: ids.map((id) => result(id)) })).toMatchObject({ missingInstanceIds: [] });
    expect(evaluateForeachMergeProof({ ir: foreachIr(), steps: steps(["pending", "pending", "pending"]), workflowStepResults: [result(ids[0])] })).toMatchObject({ missingInstanceIds: [ids[1], ids[2]] });
    expect(evaluateForeachMergeProof({ ir: foreachIr(), steps: [], workflowStepResults: [] })).toMatchObject({ hasForeachStepExecute: true, missingInstanceIds: [] });
    expect(evaluateForeachMergeProof({ ir: foreachIr(), steps: steps(["done", "skipped", "pending"]), workflowStepResults: [result(ids[2])] })).toMatchObject({ missingInstanceIds: [] });
    expect(evaluateForeachMergeProof({ ir: foreachIr(), steps: steps(["pending"]), workflowStepResults: [result(ids[0], "failed")] }).missingInstanceIds).toEqual([ids[0]]);
    expect(evaluateForeachMergeProof({ ir: foreachIr(), steps: steps(["pending"]), workflowStepResults: [{ ...result(ids[0]), phase: "post-merge" }] }).missingInstanceIds).toEqual([ids[0]]);
    expect(evaluateForeachMergeProof({ ir: foreachIr(), steps: steps(["pending"]), workflowStepResults: [result(ids[0]), result(ids[0])] }).missingInstanceIds).toEqual([]);
  });

  it("uses persisted rows only to widen expected identities, never as satisfaction", () => {
    const id0 = instanceNodeId("steps", 0, "step-execute");
    const id1 = instanceNodeId("steps", 1, "step-execute");
    const proof = evaluateForeachMergeProof({ ir: foreachIr(), steps: steps(["pending"]), workflowStepResults: [result(id0)], persistedInstances: [{ foreachNodeId: "steps", stepIndex: 1, pinnedStepCount: 2 }] });
    expect(proof.expectedInstanceIds).toEqual([id0, id1]);
    expect(proof.missingInstanceIds).toEqual([id1]);
  });

  it("keeps coverage independent from unrelated failed node results", () => {
    const ids = [0, 1].map((index) => instanceNodeId("steps", index, "step-execute"));
    const proof = evaluateForeachMergeProof({ ir: foreachIr(), steps: steps(["pending", "pending"]), workflowStepResults: [...ids.map((id) => result(id)), result("unrelated", "failed")] });
    expect(proof.missingInstanceIds).toEqual([]);
  });
});
