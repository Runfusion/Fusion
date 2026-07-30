import type { ColumnCount, LiveSnapshot } from "@fusion/core";

/*
FNXC:LiveActivity 2026-07-20-09:30:
FN-8429 defines Overview Live activity from the current project snapshot, never
from date-ranged analytics. Keep its in-progress aliases identical to Mission
Control so custom and legacy board columns cannot silently show zero work.
*/
/** Whether a live board column belongs to the in-progress funnel stage. */
export function isInProgressColumn(column: string): boolean {
  const normalized = column.trim().toLowerCase();
  /*
  FNXC:CommandCenterLiveMetrics 2026-07-30-20:10:
  DELIBERATE-LITERAL — ALIAS MATCHING, not a lifecycle guard.

  This is a census false positive. The values here are DISPLAY-NAME aliases for a funnel stage
  ("in progress" with a space, "doing"), matched case-insensitively against a snapshot's column
  labels — there is no task and no workflow to resolve a trait from, which is why the signature takes
  a bare string. `"in-progress"` appears because it is one of the alias spellings, not because a
  lifecycle role is being asked for.

  Converting it to a role helper is not possible without inventing a task to resolve, and widening
  the alias list is the documented intent above: the aliases exist precisely so custom boards do NOT
  show zero work.
  */
  return normalized === "in-progress" || normalized === "in progress" || normalized === "doing";
}

/** Sum the current live board's in-progress aliases without consulting historical analytics. */
export function countLiveInProgressTasks(columns: ColumnCount[] | undefined): number {
  return (columns ?? []).reduce(
    (total, column) => total + (isInProgressColumn(column.column) ? column.count : 0),
    0,
  );
}

/**
 * FNXC:LiveActivity 2026-07-20-09:30:
 * FN-8429 makes the Live activity strip use the current snapshot rather than a
 * date-ranged agent aggregate. Sessions and heartbeat runs are the snapshot's
 * two authoritative active-work sources, so both contribute while the label
 * remains live rather than historical.
 */
export function countLiveAgentsWorking(snapshot: LiveSnapshot | null): number {
  return (snapshot?.activeSessions ?? 0) + (snapshot?.activeRuns ?? 0);
}
