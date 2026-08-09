/**
 * FNXC:CodeOrganization 2026-08-03-14:15:
 * buildStepInstancePersistence peeled from TaskExecutor (U4).
 *
 * FNXC:PostgresOnlyDataAccess 2026-07-16-12:40:
 * Async store methods; persistence interface awaits Promise-returning impls.
 */
import type { TaskStore } from "@fusion/core";
import type {
  WorkflowStepInstancePersistence,
  WorkflowStepInstanceState,
} from "../workflows/workflow-graph-foreach.js";

export type BuildStepInstancePersistenceDeps = {
  store: TaskStore;
};

export function buildStepInstancePersistence(
  deps: BuildStepInstancePersistenceDeps,
): WorkflowStepInstancePersistence | undefined {
  // FNXC:PostgresOnlyDataAccess 2026-07-16-12:40: async store methods; the
  // persistence interface awaits Promise-returning impls.
  const store = deps.store as unknown as {
    saveWorkflowRunStepInstanceAsync?: (state: WorkflowStepInstanceState) => Promise<void>;
    loadWorkflowRunStepInstancesAsync?: (taskId: string, runId: string) => Promise<WorkflowStepInstanceState[]>;
    clearWorkflowRunStepInstancesAsync?: (taskId: string, keepRunId: string) => Promise<void>;
    saveWorkflowRunStepInstance?: (state: WorkflowStepInstanceState) => void;
    loadWorkflowRunStepInstances?: (taskId: string, runId: string) => WorkflowStepInstanceState[];
    clearWorkflowRunStepInstances?: (taskId: string, keepRunId: string) => void;
  };
  if (typeof store.saveWorkflowRunStepInstanceAsync !== "function" && typeof store.saveWorkflowRunStepInstance !== "function") return undefined;
  return {
    saveInstanceState: (state) => store.saveWorkflowRunStepInstanceAsync?.(state) ?? store.saveWorkflowRunStepInstance?.(state),
    loadInstanceStates: async (taskId, runId) =>
      await store.loadWorkflowRunStepInstancesAsync?.(taskId, runId) ?? store.loadWorkflowRunStepInstances?.(taskId, runId) ?? [],
    clearStaleInstanceStates: (taskId, keepRunId) =>
      store.clearWorkflowRunStepInstancesAsync?.(taskId, keepRunId) ?? store.clearWorkflowRunStepInstances?.(taskId, keepRunId),
  };
}
