/**
 * FNXC:CodeOrganization 2026-08-03-17:30:
 * buildBranchPersistence peeled from TaskExecutor (U4).
 *
 * FNXC:PostgresOnlyDataAccess 2026-07-16-12:40:
 * Store methods are async (PostgreSQL routing); persistence interfaces await them.
 */
import type { TaskStore } from "@fusion/core";
import type {
  WorkflowBranchPersistence,
  WorkflowBranchRunState,
} from "../workflows/workflow-graph-branches.js";

export type BuildBranchPersistenceDeps = {
  store: TaskStore;
};

export function buildBranchPersistence(
  deps: BuildBranchPersistenceDeps,
): WorkflowBranchPersistence | undefined {
  const store = deps.store as unknown as {
    saveWorkflowRunBranch?: (state: WorkflowBranchRunState) => void | Promise<void>;
    loadWorkflowRunBranches?: (taskId: string, runId: string) => WorkflowBranchRunState[] | Promise<WorkflowBranchRunState[]>;
    clearWorkflowRunBranches?: (taskId: string, keepRunId: string) => void | Promise<void>;
  };
  if (typeof store.saveWorkflowRunBranch !== "function") return undefined;
  return {
    saveBranchState: (state) => store.saveWorkflowRunBranch?.(state),
    loadBranchStates: async (taskId, runId) => (await store.loadWorkflowRunBranches?.(taskId, runId)) ?? [],
    clearStaleBranchStates: (taskId, keepRunId) => store.clearWorkflowRunBranches?.(taskId, keepRunId),
  };
}
