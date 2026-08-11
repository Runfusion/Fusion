/**
 * FNXC:CodeOrganization 2026-08-03-11:15:
 * maybeDispatchWorkflowWorkEngine peeled from TaskExecutor (U4).
 * Column extension work-engine dispatch before default execute routing.
 */
import type { Task, TaskDetail, TaskStore, WorkflowIr, WorkflowWorkEngineDispatchResult } from "@fusion/core";
import { getWorkflowExtensionRegistry, resolveWorkflowIrForTask } from "@fusion/core";
import { executorLog } from "../logger.js";
import { generateSyntheticRunId } from "../util/run-audit.js";

export type MaybeDispatchWorkflowWorkEngineDeps = {
  store: TaskStore;
};

export async function maybeDispatchWorkflowWorkEngine(
  deps: MaybeDispatchWorkflowWorkEngineDeps,
  task: Task,
): Promise<boolean> {
  let detail: TaskDetail;
  let workflow: WorkflowIr;
  try {
    detail = await deps.store.getTask(task.id);
    workflow = await resolveWorkflowIrForTask(deps.store, task.id);
  } catch (error) {
    executorLog.warn(`${task.id}: failed to resolve workflow work-engine bindings: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
  if (workflow.version !== "v2") return false;

  const column = workflow.columns.find((candidate) => candidate.id === detail.column);
  const extensionEntries = Object.entries(column?.extensions ?? {});
  if (extensionEntries.length === 0) return false;

  const registry = getWorkflowExtensionRegistry();
  for (const [extensionId, metadata] of extensionEntries) {
    const definition = registry.get(extensionId);
    const extension = definition?.extension;
    if (!definition || definition.degraded || extension?.kind !== "work-engine" || !extension.dispatch) continue;

    let result: WorkflowWorkEngineDispatchResult;
    try {
      result = await extension.dispatch({
        task: detail,
        workflow,
        columnId: detail.column,
        metadata,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      executorLog.warn(`${task.id}: workflow work-engine ${extensionId} failed: ${message}`);
      if (extension.fallback === "degradeToDefault") continue;
      await deps.store.logEntry(task.id, `Workflow work engine ${extensionId} failed`, message);
      await deps.store.updateTask(task.id, {
        status: extension.fallback === "parkNeedsAttention" ? "queued" : "failed",
        error: message,
      });
      return true;
    }

    if (result.kind === "not-claimed") continue;
    if (result.kind === "degraded-to-default") {
      executorLog.warn(`${task.id}: workflow work-engine ${extensionId} degraded to default: ${result.reason}`);
      await deps.store.logEntry(task.id, `Workflow work engine ${extensionId} degraded to default`, result.reason);
      continue;
    }
    if (result.kind === "parked") {
      await deps.store.logEntry(task.id, result.message, result.reason);
      await deps.store.updateTask(task.id, { status: "queued", error: result.reason });
      return true;
    }

    await deps.store.logEntry(
      task.id,
      result.message ?? `Workflow work engine ${extensionId} claimed execution`,
    );
    try {
      await deps.store.recordRunAuditEvent?.({
        taskId: task.id,
        agentId: "workflow-work-engine",
        runId: result.runId ?? generateSyntheticRunId("workflow-work-engine", task.id),
        domain: "database",
        mutationType: "workflow:work-engine:claimed",
        target: task.id,
        metadata: {
          extensionId,
          columnId: detail.column,
          pluginId: definition.pluginId,
        },
      });
    } catch (error) {
      executorLog.warn(`${task.id}: failed to record workflow work-engine claim audit: ${error instanceof Error ? error.message : String(error)}`);
    }
    return true;
  }

  return false;
}
