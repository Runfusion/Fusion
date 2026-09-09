/*
FNXC:WorkflowResolvedColumns 2026-07-29-00:00 (U12 — R8 drift conversion):
ONE place that answers "what ROLE does this column play?" when trait metadata may be
missing, replacing three copy-pasted id fallbacks in ListView.

WHY A HELPER AND NOT A BARE TRAIT READ. Trait flags come from the resolved workflow, so
`columnFlagsById` legitimately has no entry in two states:

  1. the pre-load window — the board renders before the workflows fetch resolves;
  2. a stranded card resting in a column its workflow no longer declares.

A bare `flags.intake === true` returns false in both, which is silent degradation rather
than a visible failure: the Planning badge just stops appearing, and a move back into a
pre-implementation lane stops asking whether to preserve step progress — so an operator
loses completed steps with no prompt and no error. That is why the fallback exists and
why deleting it is not the cleanup it looks like.

What was wrong was having the fallback THREE TIMES, inline, as `column === "todo" ||
column === "triage"`. Copies drift, none of them were reachable from a test, and each
read like a lifecycle rule rather than the degraded mode it is. Here it is named, has one
definition, and is covered — including the degraded path itself, which is the part that
never had a test.
*/

/** The subset of a column's resolved trait flags these role questions need. */
export interface ColumnRoleFlags {
  readonly intake?: boolean;
  readonly hold?: boolean;
  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-19:00 (fleet phase):
  The terminal and mid-flight traits, added for the four role helpers at the bottom of this file.
  Every one of these is already produced by the trait registry and already carried on the flag
  objects callers pass in (`TaskContextMenuColumnFlags` declares all of them) — this interface had
  simply only declared the two the earlier helpers needed, so callers were passing them and the type
  was discarding them.
  */
  readonly complete?: boolean;
  readonly countsTowardWip?: boolean;
  readonly mergeBlocker?: boolean;
  readonly humanReview?: boolean;
}

/**
 * The pre-graph column ids that behaved as pre-implementation lanes.
 *
 * NOT a lifecycle rule — a last-resort guess used only when a column has no resolved
 * traits. `todo` is the post-U11 merged planning column; `triage` is its pre-merge
 * predecessor, retained because a project upgraded mid-flight can still hold cards there
 * while its workflow no longer declares it.
 */
const LEGACY_PRE_IMPLEMENTATION_COLUMN_IDS: ReadonlySet<string> = new Set(["todo", "triage"]);

/** Pre-merge intake id, used only when a column has no resolved traits. */
const LEGACY_INTAKE_COLUMN_ID = "triage";

/**
 * Does this column play the INTAKE role — the lane a card enters before implementation?
 *
 * Drives the transient Planning badge. Traits when resolved; the legacy intake id only
 * when they are absent, so the badge does not vanish during first paint.
 */
export function isIntakeColumnRole(flags: ColumnRoleFlags | undefined, columnId: string): boolean {
  return flags ? flags.intake === true : columnId === LEGACY_INTAKE_COLUMN_ID;
}

/**
 * Is this column a PRE-IMPLEMENTATION lane — intake or a hold?
 *
 * Drives the "preserve progress?" prompt when a card with completed steps is moved
 * backwards. Either trait qualifies: both mean work has not started there, so moving a
 * part-done card in risks discarding steps.
 */
export function isPreImplementationColumnRole(flags: ColumnRoleFlags | undefined, columnId: string): boolean {
  return flags
    ? Boolean(flags.intake || flags.hold)
    : LEGACY_PRE_IMPLEMENTATION_COLUMN_IDS.has(columnId);
}

/**
 * Does this column play the HOLD role — a lane a card WAITS in rather than works in?
 *
 * FNXC:WorkflowResolvedColumns 2026-07-30-23:30 (U12 — worktree upcoming-work list):
 * Distinct from {@link isPreImplementationColumnRole}, whose degraded id set is `{todo, triage}`.
 * This one degrades to `todo` ALONE, because `triage` was the intake lane and never the
 * wait-for-capacity lane — listing an intake card as "upcoming work" in the worktree view would
 * report a card that has no plan yet as ready to run.
 *
 * Same shape, different degraded answer — the asymmetry U11 verified for
 * `isPreExecutionHoldColumn` and this file already documents elsewhere.
 */
export function isHoldColumnRole(flags: ColumnRoleFlags | undefined, columnId: string): boolean {
  /*
  FNXC:WorkflowLifecycleColumns 2026-07-30-07:25 (U12 — census gate repair) DELIBERATE-LITERAL:
  This IS the no-metadata fallback, so the literal is the answer rather than an unconverted guard —
  the same status as `LEGACY_INTAKE_COLUMN_ID` on the line above, which reads as a named constant and
  so was never counted while this inline twin was.

  Deleting it is not available: `columnFlags` is legitimately absent during first paint and for a card
  in a column its workflow no longer declares, and a bare trait read there silently drops the
  affordance this drives. The reason is recorded in full at the top of this file.

  `todo` ALONE, deliberately — not the `{todo, triage}` pair used by the pre-implementation helper.
  `triage` was the intake lane and never the wait-for-capacity lane, so listing an intake card as
  upcoming work would report a card with no plan as ready to run.
  */
  return flags ? flags.hold === true : columnId === "todo";
}

/** Legacy pre-implementation id pair, used only when a column has no resolved traits. */
const LEGACY_FIELD_EDITABLE_COLUMN_IDS: ReadonlySet<string> = new Set(["triage", "todo"]);

/**
 * May a card's title/description be edited in this column?
 *
 * FNXC:WorkflowResolvedColumns 2026-07-30-00:15 (U12 — one affordance, two components):
 * Editing belongs to PRE-IMPLEMENTATION lanes: the card has no session, no worktree, and no plan
 * being executed against the text. Any terminal, executing or review trait VETOES it even when
 * `intake`/`hold` is also present — a column carrying both is still one where work is underway, and
 * rewriting a description out from under a running plan is the failure being prevented.
 *
 * Extracted because `TaskDetailModal` resolved this from traits (U10/R8) while `TaskCard` kept a
 * hardcoded `{triage, todo}` set with NO trait path at all, even though `taskColumnFlags` was already
 * in scope there. On a renamed board the operator could edit a task's title in the detail modal but
 * the pencil button was absent from its card. One affordance living in two components with one of
 * them converted is the FN-6115 -> FN-6118 -> FN-6123 shape; a shared definition is what stops it
 * recurring, not a second conversion.
 */
export function isFieldEditableColumnRole(
  flags: (ColumnRoleFlags & {
    readonly complete?: boolean;
    readonly countsTowardWip?: boolean;
    readonly mergeBlocker?: boolean;
    readonly humanReview?: boolean;
  }) | undefined,
  columnId: string,
): boolean {
  if (!flags) return LEGACY_FIELD_EDITABLE_COLUMN_IDS.has(columnId);
  if (flags.complete || flags.countsTowardWip || flags.mergeBlocker || flags.humanReview) {
    return false;
  }
  return flags.intake === true || flags.hold === true;
}

/* -------------------------------------------------------------------------- */
/* Terminal / mid-flight roles                                                 */
/* -------------------------------------------------------------------------- */

/*
FNXC:WorkflowResolvedColumns 2026-07-30-19:00 (fleet phase — completing the pattern, not adding one):
THE MID-FLIGHT AND TERMINAL ROLES THE HELPERS WERE MISSING.

The existing helpers originally covered only intake and hold. Complete, review, and implementation
callers need the same flags-first behavior rather than copied id comparisons.

These are not a new abstraction. They are the SAME one — flags-first, legacy id only as the
documented no-metadata fallback — applied to the roles it did not yet cover. The alternative is
inlining flags-plus-fallback expressions at every call site, which recreates the copy-paste drift
the helpers were created to remove: three inline copies in ListView is what started this file.

Every flag used here is already produced by the trait registry and already passed by callers —
`TaskContextMenuColumnFlags` declares all of them. `ColumnRoleFlags` had only DECLARED the two the
earlier helpers needed, so callers were handing them over and the type was dropping them on the
floor. Widening the interface threads nothing new through any call site.

WHY EACH KEEPS AN ID FALLBACK. `columnFlags` is legitimately absent during first paint and for a card
in a column its workflow no longer declares. A bare trait read returns false there, which is silent
degradation — a Done card stops rendering as complete. Same reasoning recorded at the top of this file.
*/

/** Terminal-success id, used only when a column has no resolved traits. */
const LEGACY_COMPLETE_COLUMN_ID = "done";
/** Implementation-lane id, used only when a column has no resolved traits. */
const LEGACY_WIP_COLUMN_ID = "in-progress";
/** Review-lane id, used only when a column has no resolved traits. */
const LEGACY_REVIEW_COLUMN_ID = "in-review";

/**
 * Is this the terminal-success column?
 *
 * The historical `archived` sentinel is deliberately not included; startup reconciliation owns it.
 */
export function isCompleteColumnRole(flags: ColumnRoleFlags | undefined, columnId: string): boolean {
  return flags ? flags.complete === true : columnId === LEGACY_COMPLETE_COLUMN_ID;
}

/**
 * Does this column occupy an implementation/WIP slot?
 *
 * Keyed on `countsTowardWip` rather than a `wip` trait name because that is the flag the trait
 * registry exposes, and it is the one capacity arithmetic already uses — so a board cannot have a
 * column that counts toward WIP for capacity but not for this predicate.
 */
export function isWipColumnRole(flags: ColumnRoleFlags | undefined, columnId: string): boolean {
  return flags ? flags.countsTowardWip === true : columnId === LEGACY_WIP_COLUMN_ID;
}

/**
 * Is this the review / merge-orchestration lane?
 *
 * EITHER trait qualifies. `mergeBlocker` and `humanReview` are separable — a lane can block merges
 * without a human in it, and vice versa — but every caller converted so far asks "is this card in
 * review", for which both are true. A caller that genuinely needs one and not the other should read
 * the flag directly rather than widen this.
 */
export function isReviewColumnRole(flags: ColumnRoleFlags | undefined, columnId: string): boolean {
  return flags
    ? flags.mergeBlocker === true || flags.humanReview === true
    : columnId === LEGACY_REVIEW_COLUMN_ID;
}
