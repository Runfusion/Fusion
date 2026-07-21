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
