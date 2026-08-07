/**
 * FNXC:CodeOrganization 2026-08-03-18:00:
 * updateStepGraph peeled from TaskExecutor (U4).
 *
 * Graph-owned step status writes go through store.updateStep with source:"graph".
 */
import type { StepStatus, TaskStore } from "@fusion/core";

export type UpdateStepGraphDeps = {
  store: TaskStore;
};

export async function updateStepGraph(
  deps: UpdateStepGraphDeps,
  taskId: string,
  stepIndex: number,
  status: StepStatus,
): Promise<void> {
  const store = deps.store as unknown as {
    updateStep: (
      id: string,
      idx: number,
      status: StepStatus,
      opts?: { source?: "graph" },
    ) => Promise<unknown>;
  };
  await store.updateStep(taskId, stepIndex, status, { source: "graph" });
}
