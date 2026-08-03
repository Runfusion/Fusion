/**
 * FNXC:CodeOrganization 2026-08-03-18:30:
 * safeLogEntry peeled from TaskExecutor (U4).
 *
 * FNXC:WorkflowLifecycle 2026-07-01-16:20:
 * Breadcrumb task-log writes on abort/pause/finalize paths are best-effort diagnostics and must
 * NEVER break control flow. Swallow both synchronous throws and async rejections into a warn.
 */
import type { TaskStore } from "@fusion/core";
import { executorLog } from "../logger.js";
import type { EngineRunContext } from "../util/run-audit.js";

export type SafeLogEntryDeps = {
  store: TaskStore;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
};

export function safeLogEntry(
  deps: SafeLogEntryDeps,
  taskId: string,
  message: string,
): void {
  try {
    const result = deps.store.logEntry(taskId, message, undefined, deps.getRunContextFor(taskId));
    void Promise.resolve(result).catch((error) => {
      executorLog.warn(`${taskId}: failed to write task-log breadcrumb: ${error instanceof Error ? error.message : String(error)}`);
    });
  } catch (error) {
    executorLog.warn(`${taskId}: failed to write task-log breadcrumb: ${error instanceof Error ? error.message : String(error)}`);
  }
}
