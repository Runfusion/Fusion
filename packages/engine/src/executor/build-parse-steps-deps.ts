/**
 * FNXC:CodeOrganization 2026-08-03-17:00:
 * buildParseStepsDeps peeled from TaskExecutor (U4).
 *
 * Artifact/step-write deps bag for the parse-steps graph handler, including
 * foreach expansion pin protection (KTD-3).
 */
import type { TaskStep, TaskStore } from "@fusion/core";
import type { ParseStepsHandlerDeps } from "../workflows/workflow-node-handlers.js";
import type { WorkflowStepInstanceState } from "../workflows/workflow-graph-foreach.js";
import { executorLog } from "../logger.js";

export type BuildParseStepsDepsDeps = {
  store: TaskStore;
  readTaskArtifact: (taskId: string, key: string) => Promise<string | undefined>;
};

export function buildParseStepsDeps(
  deps: BuildParseStepsDepsDeps,
  runId?: string,
): ParseStepsHandlerDeps {
  return {
    readArtifact: (task, key): Promise<string | undefined> => deps.readTaskArtifact(task.id, key),
    writeSteps: async (task, steps: TaskStep[]): Promise<void> => {
      await deps.store.updateTask(task.id, { steps });
    },
    hasExpandedForeach: async (task): Promise<boolean> => {
      const store = deps.store as unknown as {
        loadWorkflowRunStepInstancesAsync?: (taskId: string, runId: string) => Promise<WorkflowStepInstanceState[]>;
        loadWorkflowRunStepInstances?: (taskId: string, runId: string) => WorkflowStepInstanceState[];
      };
      if (typeof store.loadWorkflowRunStepInstancesAsync !== "function" && typeof store.loadWorkflowRunStepInstances !== "function") return false;
      try {
        // Any persisted instance row for THIS run means a foreach has expanded —
        // re-parsing would desynchronize the pinned instance set (KTD-3). Probe
        // under the REAL run id (threaded from executeWorkflowGraph) so the
        // pin protection actually fires; fall back to the legacy literal only when
        // the run id was not threaded (older store / no definition).
        const rows = await store.loadWorkflowRunStepInstancesAsync?.(task.id, runId ?? `${task.id}:run`)
          ?? store.loadWorkflowRunStepInstances?.(task.id, runId ?? `${task.id}:run`)
          ?? [];
        return rows.length > 0;
      } catch {
        return false;
      }
    },
    audit: (reason, detail) => {
      // The detail string carries the task id (handler convention); emit on the
      // engine log so the routable failure is auditable without a taskId arg.
      executorLog.warn(`[parse-steps] ${reason}: ${detail}`);
    },
  };
}
