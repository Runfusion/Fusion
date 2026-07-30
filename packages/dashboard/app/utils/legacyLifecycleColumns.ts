/*
FNXC:WorkflowLifecycleColumns 2026-07-30-17:10 (U11 — dashboard pre-implementation guards):

ONE definition of "this id was a PRE-IMPLEMENTATION column before workflows owned the
vocabulary", used by every dashboard guard that still needs a no-metadata fallback.

WHY A HELPER RATHER THAN INLINE LITERALS. Several dashboard predicates already resolve
by trait when `columnFlags` are present and fall back to `column === "triage" || column
=== "todo"` when they are not. Those fallbacks are deliberate — a card can render before
its workflow metadata has loaded, and losing the guard entirely is worse than answering
from the legacy ids. But written inline they are indistinguishable from an unconverted
guard: they read as `=== "triage"` to every census and every reviewer, and the real
question ("has this been converted?") cannot be answered by looking.

Naming the set answers it. A call to `isLegacyPreImplementationColumn` is visibly a
FALLBACK; a bare `=== "triage"` is visibly not.

BEHAVIOUR IS UNCHANGED. This is the same two ids the inline comparisons used, kept as a
set so the fallthrough is explicit: anything else is not a pre-implementation column.
Post-#2515 the default lineage's planning column is `todo`, and `triage` remains legal
for stored rows and for workflows that still declare it — which is exactly why both ids
stay.
*/

/** The pre-implementation column ids from before workflows owned the vocabulary. */
export const LEGACY_PRE_IMPLEMENTATION_COLUMN_IDS: ReadonlySet<string> = new Set([
  "triage",
  "todo",
]);

/** The legacy INTAKE id specifically — the planner lane on a board that still splits it. */
export const LEGACY_INTAKE_COLUMN_ID = "triage";

/**
 * Fallback for "is this a pre-implementation column?" when no resolved column traits
 * are available. Prefer the caller's `columnFlags` whenever it has them.
 */
export function isLegacyPreImplementationColumn(column: string): boolean {
  return LEGACY_PRE_IMPLEMENTATION_COLUMN_IDS.has(column);
}

/**
 * Fallback for "is this the INTAKE lane?" — narrower than the above, for guards whose
 * legacy form named only `triage` and would change behaviour if widened to include the
 * hold column.
 */
export function isLegacyIntakeColumn(column: string): boolean {
  return column === LEGACY_INTAKE_COLUMN_ID;
}
