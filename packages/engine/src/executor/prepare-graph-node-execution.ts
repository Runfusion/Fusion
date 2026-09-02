/**
 * FNXC:CodeOrganization 2026-08-03-11:45:
 * prepareGraphNodeExecution peeled from TaskExecutor (U4).
 *
 * FNXC:WorktreeBaseRefresh 2026-08-01-16:32:
 * An existing code-node checkout must remain attached so it takes the guarded reuse/refresh path.
 * Only a missing recorded path is cleared to permit fresh creation.
 *
 * FNXC:WorkflowExecution 2026-06-29-15:28 / 09:50:
 * Graph declares worktree requirement; this adapter fulfills it. Stale paths are reacquired before write-capable nodes.
 *
 * FNXC:PlanningBoundary 2026-09-01-14:49:
 * Only write-capable nodes may acquire or refresh a checkout. Plan, Plan Review, and replan nodes
 * return before store or workspace acquisition so planning remains rooted on dependency-installed main.
 */
import { existsSync } from "node:fs";
import type { Settings, TaskDetail, TaskStore, WorkflowIrNode, WorkspaceConfig } from "@fusion/core";
import type { WorkflowNodePreparationRequirement } from "../workflows/workflow-graph-executor.js";
import type { EngineRunContext } from "../util/run-audit.js";
import { workflowNodeRequiresWorktree } from "../workflows/workflow-node-execution-needs.js";
import { resolveWorkspaceConfigOnce } from "./workspace-config-resolver.js";

export type PrepareGraphNodeExecutionDeps = {
  store: TaskStore;
  rootDir: string;
  workspaceConfigOwner: object;
  getWorkspaceConfig: () => WorkspaceConfig | null | undefined;
  setWorkspaceConfig: (config: WorkspaceConfig | null) => void;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
  ensureGraphCustomNodeWorktree: (
    task: TaskDetail,
    settings: Settings,
    nodeId: string,
    refreshStaleBase?: boolean,
  ) => Promise<TaskDetail>;
};

export async function prepareGraphNodeExecution(
  deps: PrepareGraphNodeExecutionDeps,
  node: WorkflowIrNode,
  nodeTask: TaskDetail,
  settings: Settings,
  requirement: WorkflowNodePreparationRequirement,
): Promise<void> {
  if (!requirement.requiresWorktree) return;
  const writeCapable = workflowNodeRequiresWorktree(node);
  if (!writeCapable) return;
  const live = await deps.store.getTask(nodeTask.id);
  await resolveWorkspaceConfigOnce(deps);
  const executionCodeNode = node.kind === "code";
  if (live.worktree && existsSync(live.worktree) && !executionCodeNode) return;
  const taskForAcquisition = live.worktree && !existsSync(live.worktree)
    ? ({ ...live, worktree: undefined, sessionFile: undefined } as TaskDetail)
    : live;
  if (live.worktree) {
    await deps.store.logEntry(
      live.id,
      `Workflow node '${node.id}' assigned worktree is missing — reacquiring before node execution`,
      live.worktree,
      deps.getRunContextFor(live.id),
    );
  }
  await deps.ensureGraphCustomNodeWorktree(taskForAcquisition, settings, node.id, executionCodeNode);
}
