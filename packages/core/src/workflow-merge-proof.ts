import { instanceNodeId } from "./column-agent-resolver.js";
import type { TaskStep, WorkflowRunStepInstance, WorkflowStepResult } from "./types.js";
import type { WorkflowIr } from "./workflow-ir-types.js";

export interface ForeachMergeProofInput {
  ir: WorkflowIr;
  steps: readonly Pick<TaskStep, "status">[] | undefined;
  workflowStepResults: readonly WorkflowStepResult[] | undefined;
  persistedInstances?: readonly Pick<WorkflowRunStepInstance, "foreachNodeId" | "stepIndex" | "pinnedStepCount">[];
}

export interface ForeachMergeProof {
  expectedInstanceIds: string[];
  satisfiedInstanceIds: string[];
  missingInstanceIds: string[];
  hasForeachStepExecute: boolean;
}

/**
 * FNXC:WorkflowMerge 2026-07-27-12:00:
 * FN-8601 requires every expanded step-execute identity to have a terminal-success
 * workflowStepResult, unless its live task step is already done/skipped. Callers
 * must independently require a relevant pre-merge node result and that every such
 * result is passed/skipped: coverage is vacuously complete on non-foreach/no-seam
 * shapes and is never sole proof. Persisted rows only widen expectation; partial
 * projections cannot complete a checklist, prove implementation, or enter merge.
 */
export function evaluateForeachMergeProof(input: ForeachMergeProofInput): ForeachMergeProof {
  const steps = input.steps ?? [];
  const foreachTemplates = input.ir.nodes
    .filter((node) => node.kind === "foreach")
    .flatMap((node) => {
      const template = (node.config as { template?: { nodes?: WorkflowIr["nodes"] } } | undefined)?.template;
      return (template?.nodes ?? [])
        .filter((templateNode) => templateNode.kind === "prompt" && templateNode.config?.seam === "step-execute")
        .map((templateNode) => ({ foreachNodeId: node.id, templateNodeId: templateNode.id }));
    });
  const hasForeachStepExecute = foreachTemplates.length > 0;
  const expected = new Set<string>();
  const terminalLiveSteps = new Set<string>();

  for (const { foreachNodeId, templateNodeId } of foreachTemplates) {
    for (let stepIndex = 0; stepIndex < steps.length; stepIndex += 1) {
      const id = instanceNodeId(foreachNodeId, stepIndex, templateNodeId);
      expected.add(id);
      if (steps[stepIndex]?.status === "done" || steps[stepIndex]?.status === "skipped") terminalLiveSteps.add(id);
    }
  }

  // Rows may survive an IR/live-step discrepancy. Their pinned count can only widen
  // the IR/live expectation; a completed row never satisfies an identity by itself.
  for (const template of foreachTemplates) {
    const rows = (input.persistedInstances ?? []).filter((row) => row.foreachNodeId === template.foreachNodeId);
    const persistedCount = rows.reduce((maximum, row) => Math.max(maximum, row.pinnedStepCount, row.stepIndex + 1), 0);
    for (let stepIndex = 0; stepIndex < Math.max(steps.length, persistedCount); stepIndex += 1) {
      expected.add(instanceNodeId(template.foreachNodeId, stepIndex, template.templateNodeId));
    }
  }

  const successfulResults = new Set(
    (input.workflowStepResults ?? [])
      .filter((result) => result.source === "node" && (result.phase ?? "pre-merge") === "pre-merge")
      .filter((result) => result.status === "passed" || result.status === "skipped")
      .map((result) => result.workflowStepId),
  );
  const expectedInstanceIds = [...expected].sort();
  const satisfiedInstanceIds = expectedInstanceIds.filter((id) => terminalLiveSteps.has(id) || successfulResults.has(id));
  return {
    expectedInstanceIds,
    satisfiedInstanceIds,
    missingInstanceIds: expectedInstanceIds.filter((id) => !terminalLiveSteps.has(id) && !successfulResults.has(id)),
    hasForeachStepExecute,
  };
}
