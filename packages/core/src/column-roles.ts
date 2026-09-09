import type { TraitFlags } from "./workflows/trait-types.js";

/*
FNXC:WorkflowResolvedColumns 2026-07-30-15:05:
Column-ROLE predicates reachable from every package.

WHY THIS EXISTS AND WHY IT IS NOT A SECOND ABSTRACTION. The role helpers were introduced in
`packages/dashboard/app/utils/columnRoles.ts` — a dashboard-APP module. Measured against the census,
only 150 of 722 lifecycle guards (20%) sit where that module can be imported; engine (316), core
(148), the dashboard SERVER (78) and the CLI (24) cannot reach it at all. This is the SAME
flags-first / legacy-id-fallback predicate placed where the other 80% can call it, and core already
exports `resolveColumnFlags`, so no new resolution machinery comes with it. See
`docs/plans/workflow-owned-merge-stack/fleet-conversion-reachability.md` for the measurement.

SEMANTICS ARE MIRRORED, NOT INVENTED. The three distinctions below are the ones #2685 established
for the dashboard-side set, restated here deliberately so the two cannot answer the same question
differently:

  - `isWipColumnRole` keys on `countsTowardWip` — the same flag capacity arithmetic uses, so a board
    cannot have a column that counts toward WIP for capacity but not for this predicate.
  - `isReviewColumnRole` accepts `mergeBlocker` OR `humanReview`. They are separable traits, but
    every caller converted so far asks "is this card in review", for which both qualify. A caller
    that needs exactly one should read the flag directly rather than widen this.

WHY THE LEGACY FALLBACK IS NOT DEAD CODE. Flags are absent in two real states: a card resting in a
column its workflow no longer declares (mid-flight upgrade), and any caller holding a task row
without a resolved IR. A bare `flags.complete === true` returns false in both — silent degradation,
not a visible failure. The fallback is the degraded mode, named once and covered by tests, rather
than an inline id comparison repeated per call site.
*/

/**
 * Legacy column ids, used ONLY when a column has no resolved trait flags.
 *
 * NOT lifecycle rules. `todo` is the post-U11 merged planning column; `triage` is its pre-merge
 * predecessor, retained because a project upgraded mid-flight can still hold cards there while its
 * workflow no longer declares the column.
 */
const LEGACY_INTAKE_COLUMN_ID = "triage";
const LEGACY_PRE_IMPLEMENTATION_COLUMN_IDS: ReadonlySet<string> = new Set(["todo", "triage"]);
const LEGACY_HOLD_COLUMN_ID = "todo";
const LEGACY_WIP_COLUMN_ID = "in-progress";
const LEGACY_REVIEW_COLUMN_ID = "in-review";
const LEGACY_COMPLETE_COLUMN_ID = "done";

/** The subset of resolved trait flags these role questions read. */
export type ColumnRoleTraitFlags = Pick<
  TraitFlags,
  "intake" | "hold" | "countsTowardWip" | "mergeBlocker" | "humanReview" | "complete"
>;

/** Does this column play the INTAKE role — the lane a card enters before implementation? */
export function isIntakeColumnRole(flags: ColumnRoleTraitFlags | undefined, columnId: string): boolean {
  return flags ? flags.intake === true : columnId === LEGACY_INTAKE_COLUMN_ID;
}

/**
 * Is this column a PRE-IMPLEMENTATION lane — intake or a hold?
 *
 * Either trait qualifies: both mean work has not started there, so moving a part-done card in
 * risks discarding steps.
 */
export function isPreImplementationColumnRole(
  flags: ColumnRoleTraitFlags | undefined,
  columnId: string,
): boolean {
  return flags
    ? Boolean(flags.intake || flags.hold)
    : LEGACY_PRE_IMPLEMENTATION_COLUMN_IDS.has(columnId);
}

/** Does this column play the HOLD role — a lane a card WAITS in rather than works in? */
export function isHoldColumnRole(flags: ColumnRoleTraitFlags | undefined, columnId: string): boolean {
  return flags ? flags.hold === true : columnId === LEGACY_HOLD_COLUMN_ID;
}

/**
 * Does this column count as WORK IN PROGRESS?
 *
 * Keyed on `countsTowardWip` so this predicate and capacity arithmetic cannot disagree.
 */
export function isWipColumnRole(flags: ColumnRoleTraitFlags | undefined, columnId: string): boolean {
  return flags ? flags.countsTowardWip === true : columnId === LEGACY_WIP_COLUMN_ID;
}

/**
 * Is a card here awaiting REVIEW — a merge-blocking gate or an explicit human approval?
 *
 * Either trait qualifies; see the header note on why this is deliberately the union.
 */
export function isReviewColumnRole(flags: ColumnRoleTraitFlags | undefined, columnId: string): boolean {
  return flags
    ? Boolean(flags.mergeBlocker || flags.humanReview)
    : columnId === LEGACY_REVIEW_COLUMN_ID;
}

/**
 * Is this a terminal-SUCCESS column — work completed, dependencies satisfied?
 *
 * Deleted/historical rows are classified outside workflow role metadata.
 */
export function isCompleteColumnRole(flags: ColumnRoleTraitFlags | undefined, columnId: string): boolean {
  return flags ? flags.complete === true : columnId === LEGACY_COMPLETE_COLUMN_ID;
}

/**
 * Is a card here finished successfully? Task archiving no longer exists, so terminal and complete
 * are the same lifecycle role.
 */
export function isTerminalColumnRole(flags: ColumnRoleTraitFlags | undefined, columnId: string): boolean {
  return isCompleteColumnRole(flags, columnId);
}
