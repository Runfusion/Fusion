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

/*
FNXC:PausedAbortProvenance 2026-08-26-09:52:
`quiet` records the marker WITHOUT the task-card breadcrumb, for a caller that does not yet know
whether anything was actually aborted.

The breadcrumb exists so an operator can see why a workflow was interrupted. It was emitted before
any surface was inspected, so a card with no session at all still announced one: every newly created
task logged `Pause abort marked: provenance=hard-cancel` 1-2 seconds after creation, because creation
moves the card out of the planning lane and that move is user-sourced. Nothing was interrupted and
the operator withdrew nothing — the line was false on both counts, and it is the second time this
label has lied (see the KB-PROV note in paused-abort-provenance.ts).

The in-memory marker itself is still recorded unconditionally: it is claimed synchronously before any
await precisely so two concurrent disposals cannot race, and the graph-failure classifiers depend on
it. Only the operator-facing line waits for evidence.
*/
export function markPausedAborted(
  deps: MarkPausedAbortedDeps,
  taskId: string,
  provenance: PausedAbortProvenance = "hard-cancel",
  source = "unspecified",
  options: { quiet?: boolean } = {},
): void {
  const previousProvenance = deps.pausedAbortProvenance.get(taskId);
  const alreadyMarked = deps.pausedAborted.has(taskId);
  deps.pausedAborted.add(taskId);
  deps.pausedAbortProvenance.set(taskId, provenance);
  if (options.quiet !== true && (!alreadyMarked || previousProvenance !== provenance)) {
    deps.safeLogEntry(
      taskId,
      `Pause abort marked: provenance=${provenance} source=${source}${previousProvenance && previousProvenance !== provenance ? ` previous=${previousProvenance}` : ""}`,
    );
  }
}
