import type { ColumnId } from "../types.js";
import { isTerminalColumnRole, type ColumnRoleTraitFlags } from "../column-roles.js";

export interface NearDuplicateCanonicalState {
  column?: ColumnId | null;
  deletedAt?: string | null;
}

/*
FNXC:WorkflowLifecycleColumns 2026-07-31-04:00 (batch-core feed):
"Still active" is the negation of core's terminal ROLE, not of two column names.

`columnFlags` is the column's resolved trait flags; omitted, `isTerminalColumnRole` falls back to the
legacy ids, so an unconverted caller is byte-identical and this file carries no fallback of its own.

The failure direction here is the expensive one. This predicate exists (see the note below) so a
FINISHED canonical stops holding a near-duplicate flag open. Keyed on the literals, a finished
canonical on a renamed board still read as ACTIVE, so the flag never cleared and the flagged task
stayed parked behind a user decision that could never arrive — the exact stranding the FNXC note
above says this function was written to prevent.
*/
export function isActiveNearDuplicateColumn(
  column: ColumnId | null | undefined,
  columnFlags?: ColumnRoleTraitFlags,
): boolean {
  if (column === null || column === undefined) return true;
  // Historical pre-reintegration rows are inactive evidence, not a workflow terminal role.
  if (column === "archived") return false;
  return !isTerminalColumnRole(columnFlags, column);
}

/**
 * FNXC:NearDuplicateDetection 2026-06-14-12:00:
 * A near-duplicate flag is only actionable while its canonical task exists and remains active.
 * Treat missing, completed, and soft-deleted canonicals as inactive so stale persisted flags cannot strand executable work behind a false user-decision block.
 */
export function isNearDuplicateCanonicalInactive(
  canonical: NearDuplicateCanonicalState | undefined,
  columnFlags?: ColumnRoleTraitFlags,
): boolean {
  if (!canonical) {
    return true;
  }
  if (canonical.deletedAt) {
    return true;
  }
  return !isActiveNearDuplicateColumn(canonical.column, columnFlags);
}
