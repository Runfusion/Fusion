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
an inline `todo`-or-legacy-intake id test. Copies drift, none of them were reachable from a test, and each
read like a lifecycle rule rather than the degraded mode it is. Here it is named, has one
definition, and is covered — including the degraded path itself, which is the part that
never had a test.
*/

/** The subset of a column's resolved trait flags these role questions need. */
export interface ColumnRoleFlags {
  readonly intake?: boolean;
  readonly hold?: boolean;
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
 * Pre-graph hold id, used only when a column has no resolved traits.
 *
 * Post-U11 `todo` carries BOTH `intake` and `hold` in the default lineage, which is why
 * the intake and hold fallbacks name different ids and neither can be derived from the
 * other.
 */
const LEGACY_HOLD_COLUMN_ID = "todo";

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
 * Does this column play the HOLD role — a lane a card waits in rather than works in?
 *
 * Traits when resolved; the legacy hold id only when they are absent.
 */
export function isHoldColumnRole(flags: ColumnRoleFlags | undefined, columnId: string): boolean {
  return flags ? flags.hold === true : columnId === LEGACY_HOLD_COLUMN_ID;
}

/**
 * May a card in this column be sent back to PLANNING — i.e. is it a pre-execution hold?
 *
 * Traits behave like {@link isPreImplementationColumnRole}: either `intake` or `hold`
 * qualifies. The FALLBACK is deliberately narrower — the legacy INTAKE id only, never
 * `todo`.
 *
 * Why the asymmetry, which is easy to mistake for an oversight: the pre-implementation
 * fallback guards a PROMPT ("keep your progress?"), so guessing generously costs one extra
 * confirmation. This one gates an ACTION that re-plans a task, and pre-U11 `todo` was the
 * ready-to-execute lane, so guessing generously would offer Plan on a card that is running.
 * Widening it is a behaviour change with a real failure mode, not a vocabulary conversion —
 * so it stays faithful, and `packages/dashboard/app/components/__tests__/TaskContextMenu.test.tsx`
 * fails if it is widened (that is how the asymmetry was found rather than assumed).
 */
export function isPreExecutionHoldColumnRole(flags: ColumnRoleFlags | undefined, columnId: string): boolean {
  return flags
    ? Boolean(flags.intake || flags.hold)
    : columnId === LEGACY_INTAKE_COLUMN_ID;
}

/**
 * Is this column the PLANNER's lane — where planner-agent activity should read as active?
 *
 * Narrower than {@link isPreImplementationColumnRole}: an intake lane always qualifies, but
 * a plain hold lane counts only while the card is replanning. A parked hold card is waiting,
 * not being worked on, and treating it as agent-active would light the pulsing badge, the
 * row border, and the column header's executing count on an idle card.
 */
export function isPlannerLaneColumnRole(
  flags: ColumnRoleFlags | undefined,
  columnId: string,
  isReplanning: boolean,
): boolean {
  return flags
    ? flags.intake === true || (flags.hold === true && isReplanning)
    : columnId === LEGACY_INTAKE_COLUMN_ID || (columnId === LEGACY_HOLD_COLUMN_ID && isReplanning);
}
