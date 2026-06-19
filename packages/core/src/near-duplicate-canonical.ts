import type { ColumnId } from "./types.js";

export interface NearDuplicateCanonicalState {
  column?: ColumnId | null;
  deletedAt?: string | null;
}

export function isActiveNearDuplicateColumn(column: ColumnId | null | undefined): boolean {
  return column !== "archived" && column !== "done";
}

/**
 * FNXC:NearDuplicateDetection 2026-06-14-12:00:
 * A near-duplicate flag is only actionable while its canonical task exists and remains active.
 * Treat missing, archived, done, and soft-deleted canonicals as inactive so stale persisted flags cannot strand executable work behind a false user-decision block.
 */
export function isNearDuplicateCanonicalInactive(canonical: NearDuplicateCanonicalState | undefined): boolean {
  if (!canonical) {
    return true;
  }
  if (canonical.deletedAt) {
    return true;
  }
  return !isActiveNearDuplicateColumn(canonical.column);
}
