/**
 * FNXC:CodeOrganization 2026-08-03-18:30:
 * safeLogEntry peeled from TaskExecutor (U4).
 *
 * FNXC:WorkflowLifecycle 2026-07-01-16:20:
 * Breadcrumb task-log writes on the abort/pause/finalize paths are best-effort diagnostics and must
 * NEVER break control flow. FN-7335 wired store.logEntry() straight into the SYNCHRONOUS
 * markPausedAborted() as `void this.store.logEntry(...).catch(...)`; when store.logEntry is
 * absent/throws synchronously (undefined method, store closed mid-abort, corrupted pager) the call
 * throws a TypeError BEFORE the promise exists, so the trailing .catch() never runs and the
 * exception unwinds out of markPausedAborted — aborting hard-cancel/pause and stranding the
 * in-review handoff. Route every breadcrumb write through safeLogEntry() so both synchronous throws
 * and async rejections are swallowed into a warn.
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
