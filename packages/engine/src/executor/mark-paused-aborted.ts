/**
 * FNXC:CodeOrganization 2026-08-03-17:30:
 * markPausedAborted peeled from TaskExecutor (U4).
 *
 * FNXC:WorkflowLifecycle 2026-07-01-22:24:
 * Pause aborts are frequent enough that operators need task-log breadcrumbs at the marker source.
 * Log first-mark/provenance-change events so a task card shows why a workflow was interrupted.
 */
import type { PausedAbortProvenance } from "./paused-abort-provenance.js";

export type MarkPausedAbortedDeps = {
  pausedAborted: Set<string>;
  pausedAbortProvenance: Map<string, PausedAbortProvenance>;
  safeLogEntry: (taskId: string, message: string) => void;
};

export function markPausedAborted(
  deps: MarkPausedAbortedDeps,
  taskId: string,
  provenance: PausedAbortProvenance = "hard-cancel",
  source = "unspecified",
): void {
  const previousProvenance = deps.pausedAbortProvenance.get(taskId);
  const alreadyMarked = deps.pausedAborted.has(taskId);
  deps.pausedAborted.add(taskId);
  deps.pausedAbortProvenance.set(taskId, provenance);
  if (!alreadyMarked || previousProvenance !== provenance) {
    deps.safeLogEntry(
      taskId,
      `Pause abort marked: provenance=${provenance} source=${source}${previousProvenance && previousProvenance !== provenance ? ` previous=${previousProvenance}` : ""}`,
    );
  }
}
