/*
FNXC:WorkflowLifecycleTraits 2026-07-19-06:10 (U6 / KTD-10):
Pure, per-IR trait→column primitives shared by the self-healing recovery sweeps.
Two concerns, both keyed on trait flags (never literal column ids) so a custom or
renamed workflow behaves correctly while builtin:coding stays byte-identical
(KTD-7: the builtin column ids ARE the legacy enum, so every predicate below
resolves to the same columns the old literals named):

  - `columnsWithFlag(ir, flag)` — the trait→columnIds expansion. A sweep resolves
    the workflow IR ONCE, expands each trait it enumerates by (wip / merge-
    orchestration / complete / hold / intake) to the set of column ids
    that carry it, then filters its task snapshot by that set — no per-task IR
    resolution, no new store API (U6 architecture).

  - `resolveReboundTarget(ir)` — KTD-10 rebound target ordering: the workflow's
    `hold` column, else its `intake` column, else its first column. Self-healing's
    "requeue to backlog" rebounds target this instead of the literal "todo" so a
    custom workflow lacking a `todo` column still lands its recovered cards somewhere
    valid. For builtin:coding this resolves to `todo` (its hold column) — identical.
*/

import type { WorkflowIr, WorkflowIrColumn } from "./workflow-ir-types.js";
import type { TraitFlags } from "./trait-types.js";
import { getTraitRegistry } from "./trait-registry.js";
import { resolveWorkflowIrForTask, type WorkflowIrResolverStore, type WorkflowSelectionCache } from "./workflow-ir-resolver.js";

/** The v2 column list, or [] for a v1/column-less IR. */
function columnsOf(ir: WorkflowIr): WorkflowIrColumn[] {
  return ir.version === "v2" ? ir.columns : [];
}

/**
 * The set of column ids whose resolved (OR-merged) trait flags set `flag` — the
 * trait→columnIds expansion. Deterministic (declared column order). Empty for a
 * column-less IR or when no column carries the flag.
 */
/*
FNXC:WorkflowLifecycleColumns 2026-07-30-21:15 (a DECLARATION is not a GUARD — I conflated them and
published the mistake, so it is written down here):

The census counts COMPARISONS against a legacy column id. It does not count a workflow DECLARING a
column with that id, and the two answer different questions:

    triage column guards in the tree            0     (no code compares against the literal)
    `triage` declared by the default lineage    yes   (builtin-coding-workflow-ir.ts:49, the intake lane)

Both are true at once. "The backlog reached zero for `triage`" means nothing in the code branches on
that NAME any more; it does not mean the column stopped existing, and a reader who takes it that way
will conclude a resolver's `?? "triage"` fallback is dead when it is the default board's actual intake
answer.

I asserted the stronger version in a review audit and it was wrong. One grep of
`builtin-coding-workflow-ir.ts` would have caught it, which is the cheap check worth doing before any
claim about what a lineage contains.
*/
/*
FNXC:WorkflowLifecycleColumns 2026-07-30-19:20 (an EMPTY result has TWO meanings — measured, not assumed):

Everything below returns nothing for a column set that carries no traits, and there are two very
different reasons a board can look like that:

  DECLARED AND EMPTY   a v2 workflow the operator wrote that genuinely has no complete lane. "No such
                       lane" is the right answer, and a guard should act on it.

  SYNTHESIZED          a v1 graph upgraded to v2. `synthesizeDefaultColumns` (workflow-ir.ts) emits
                       `{ id, name: id, traits: [] }` for the five default ids — placement only, by
                       design, with the real trait set living in BUILTIN_CODING_WORKFLOW_IR. Those
                       columns ARE the legacy lanes; the traits were simply never expressed.

MEASURED on such an IR:
    resolveLifecycleColumns  ->  {}                      (every role undefined)
    resolveReviewColumns     ->  []
    columnsWithFlag(wip)     ->  []
    resolveTerminalColumns   ->  ["done"]                 (its own legacy fallback saves it)

CONSEQUENCE FOR CONVERTED GUARDS. A consumer that reads "resolved and empty" as "this board declares
no such lane" is CORRECT for the first case and WRONG for the second — on a v1-upgraded board it
withdraws every role at once. Callers that kept a `length > 0 ? resolved : legacy` guard are unaffected.

I introduced that reading deliberately in #2731/#2733/#2734 to fix the opposite bug (a legacy fallback
masking a genuinely absent lane), and it is right for hand-written v2. This note exists because it is
NOT right for the upgrade path, and the difference is invisible at the call site — both arrive here as
an empty array.

The root fix would be for the upgrade to carry the real traits rather than placeholders; that changes
behaviour for every persisted v1 workflow, so it is flagged here rather than made in passing.
*/
export function columnsWithFlag(ir: WorkflowIr, flag: keyof TraitFlags): string[] {
  const registry = getTraitRegistry();
  return columnsOf(ir)
    .filter((c) => registry.resolveColumnFlags(c)[flag] === true)
    .map((c) => c.id);
}

/*
FNXC:WorkflowResolvedColumns 2026-07-30-10:40 (batch-core):
DOES THIS WORKFLOW EXPRESS ANY LIFECYCLE TRAITS AT ALL?

The distinction this program keeps paying for is "could not read" vs "read, and the answer is none".
There is a THIRD state that looks identical to the second and means the opposite:
`synthesizeDefaultColumns` (workflow-ir.ts:158-159) upgrades a v1 graph by emitting every default
column with `traits: []`. Such a board resolves cleanly and answers EMPTY for every role, while its
`done` and `in-review` columns plainly exist and hold cards.

A caller that treats an empty role set as a real answer is correct for a v2 board that deliberately
declares no such lane, and wrong for a v1 upgrade — where it silently disables whatever the guard
protected. This predicate separates the two: a workflow that expresses NO trait on ANY column has not
made a statement about its lifecycle, so its callers should keep the legacy vocabulary rather than
conclude the role is absent.

Cheap by construction: it stops at the first column carrying anything.
*/
export function declaresAnyLifecycleTrait(ir: WorkflowIr): boolean {
  const registry = getTraitRegistry();
  return columnsOf(ir).some((c) => {
    const flags = registry.resolveColumnFlags(c);
    return Object.values(flags).some((v) => v === true);
  });
}

/** Convenience predicate: does `columnId` carry `flag` in this IR? */
export function columnHasFlag(ir: WorkflowIr, columnId: string, flag: keyof TraitFlags): boolean {
  const column = columnsOf(ir).find((c) => c.id === columnId);
  if (!column) return false;
  return getTraitRegistry().resolveColumnFlags(column)[flag] === true;
}

/**
 * U7 — the workflow's COMPLETE (terminal-success) column: the first column
 * carrying the `complete` trait. Finalization moves a confirmed-merged card here
 * instead of the literal "done"; builtin:coding resolves to `done`. Returns
 * undefined when no column is complete (caller keeps its literal fallback).
 */
export function resolveCompleteColumn(ir: WorkflowIr): string | undefined {
  return columnsWithFlag(ir, "complete")[0];
}

/*
FNXC:WorkflowLifecycleColumns 2026-07-31-05:20 (the divergence four consumers each solved differently):
REVIEW IS A SET, AND `humanReview` COUNTS.

`resolveLifecycleColumns().review` is a SINGLE id derived from ONE flag (`mergeOrchestration`). The
domain is not that shape: a lane can host human review without orchestrating a merge, and a board may
declare more than one review lane. So every consumer asking "is this card in review" re-derived its own
answer, and they drifted:

  #2713  routes    terminal columns needed membership; fixed there only
  #2722  notifier  a `humanReview`-only lane resolved to nothing — review notifications never fired
  #2723  routes    the union was broader than core's single id
  #2728  CLI       `fn task retry` refused a card `POST /tasks/:id/retry` accepted

Four files, four patches, and a fifth site inside #2722 itself that the first pass missed. The shared
answer belongs here.

ADDITIVE ON PURPOSE. `resolveLifecycleColumns().review` is untouched, so nothing that reads it changes
behaviour — this is the missing helper, not a reshaping of the existing one. `.review` remains correct
for its own question ("which single lane does the merge gate live in"); this answers the other one
("is this card ALREADY in a review lane"), which is the question every drifting consumer was asking.

MONOTONIC, which the #2723 review round argued about: a column carrying BOTH `humanReview` and
`mergeOrchestration` is included. Adding a trait must never remove a lane from this set, or a card
stops counting as in review because its column gained an unrelated capability.
*/
/*
FNXC:WorkflowLifecycleColumns 2026-07-30-11:30 (a flaw in this helper as merged, found by trying to
migrate its consumers onto it):
THIS IS THE BROAD SET, AND IT IS THE WRONG ANSWER FOR STATE-CHANGING ADMISSION.

Two different questions were being answered by one name:

  BROAD   "is this card in a lane where review happens?"  -> every mergeOrchestration lane, plus every
          mergeBlocker and humanReview lane. Safe when over-admission is harmless: notifications, badges,
          read-only surfaces. This function.

  NARROW  "is this card in THE review lane the engine acts on?" -> `resolveLifecycleColumns().review` is
          `columnsWithFlag(ir, "mergeOrchestration")[0]`, ONE lane, and that is what the executor, the
          scheduler and project-engine act on. A caller that ADMITS on the broad set and then MOVES the
          card will move cards the engine does not consider in review.

`register-task-workflow-routes.ts` keeps its own narrower resolver for exactly that reason (#2723): its
re-engagement moves the card, so admitting a SECOND merge lane is a state change the engine will not
agree with. That local copy is not drift from this helper — it is the other question, and migrating it
onto this one would reintroduce the over-admission its review round reasoned away.

Stated here because the name does not carry the distinction: a future consumer reaching for "the review
columns" on a state-changing path wants the narrow form. The pair below is pinned in
`workflow-lifecycle-traits.test.ts`.
*/
export function resolveReviewColumns(ir: WorkflowIr): string[] {
  return [...new Set([
    ...columnsWithFlag(ir, "mergeOrchestration"),
    ...columnsWithFlag(ir, "mergeBlocker"),
    ...columnsWithFlag(ir, "humanReview"),
  ])];
}

/**
 * U7 — the workflow's MERGE-ORCHESTRATION column: the first column carrying the
 * `mergeOrchestration` trait (where the merge-gate node lives). Merge-failure
 * rebounds that stay in the merge lane and `human-review` manual holds park here
 * instead of the literal "in-review"; builtin:coding resolves to `in-review`.
 * Returns undefined when no column orchestrates merge.
 */
export function resolveMergeOrchestrationColumn(ir: WorkflowIr): string | undefined {
  return columnsWithFlag(ir, "mergeOrchestration")[0];
}

/**
 * Every terminal-success column resolves through the `complete` trait. The archive lifecycle role
 * no longer exists; historical `"archived"` handling is isolated to soft-delete sentinels and the
 * bounded startup reconciliation.
 */
export function resolveTerminalColumns(ir: WorkflowIr): readonly [string] {
  const lifecycle = resolveLifecycleColumns(ir);
  return [lifecycle?.complete ?? "done"] as const;
}

/**
 * KTD-10 rebound target: where a self-healing sweep requeues a recovered card.
 * Preference order — the workflow's `hold` column, else its `intake` column, else
 * its first column. Returns undefined only for a column-less (v1) IR, where the
 * caller keeps the legacy literal fallback. For builtin:coding this is `todo`.
 */
/*
FNXC:WorkflowEvents 2026-07-31-21:00 (fleet):
The resolved lane answer carried on a `task:moved` payload. A plain data shape, not a resolver: the
whole point is that a listener does not resolve anything.
*/
export interface TaskMoveLanes {
  readonly hold?: string;
  readonly intake?: string;
  readonly wip?: string;
  readonly review?: string;
  readonly complete?: string;
  /*
  FNXC:WorkflowResolvedColumns 2026-07-31-11:05 (u12 — a role SET cannot be carried by a role ID):
  Every other field answers "which column IS this role", which is first-match-per-role. `terminal`
  answers a different question — "is this column ONE OF the finished lanes" — and a workflow may
  declare more than one complete-trait column (a merged lane and a shipped lane).

  Without this the payload could not express that board at all: `scheduler.ts` rebuilt its terminal
  set as `new Set([complete, archived])`, so a card landing in a SECOND complete column was not seen
  as finished and its dependents were never unblocked. That is a card that waits forever, and it is
  the one behaviour that supplying lanes did NOT fix when measured (10 passed / 1 failed).

  Optional, so every existing emitter and listener keeps compiling; a listener that ignores it is
  exactly as correct as it was before.
  */
  readonly terminal?: readonly string[];
}

/** Resolve the `task:moved` lane payload for a task's own workflow. Returns undefined if unresolvable. */
export function toTaskMoveLanes(ir: WorkflowIr | undefined): TaskMoveLanes | undefined {
  if (!ir) return undefined;
  const l = resolveLifecycleColumns(ir);
  if (!l) return undefined;
  /* Read from the trait flags, NOT from `l`: `resolveLifecycleColumns` is first-match-per-role and
     would collapse a second complete-trait column, which is the whole defect this field exists for. */
  const terminal = [...new Set(columnsWithFlag(ir, "complete"))];
  return {
    hold: l.hold, intake: l.intake, wip: l.wip, review: l.review, complete: l.complete,
    ...(terminal.length > 0 ? { terminal } : {}),
  };
}

export function resolveReboundTarget(ir: WorkflowIr): string | undefined {
  const columns = columnsOf(ir);
  if (columns.length === 0) return undefined;
  const registry = getTraitRegistry();
  const hold = columns.find((c) => registry.resolveColumnFlags(c).hold === true);
  if (hold) return hold.id;
  const intake = columns.find((c) => registry.resolveColumnFlags(c).intake === true);
  if (intake) return intake.id;
  return columns[0].id;
}

/**
 * Resolve the destination for an automatic dependency-driven re-specification.
 * A manual intake is a capture lane, so its intake target is not safe for an
 * automated replan; use the workflow's hold lane instead. Returns undefined
 * when the workflow has no usable trait-derived destination.
 *
 * FNXC:WorkflowLifecycleTraits 2026-08-19-02:45:
 * Dependency-driven replans must not auto-route into a manual intake. Coding
 * (Ideas) therefore returns its Planning hold column while automatic workflows
 * retain their declared intake destination. This policy affects only automatic
 * dependency-driven replan relocation; new-task creation and manual promotion
 * keep their existing intake behavior.
 */
export function resolveDependencyReplanTarget(ir: WorkflowIr | undefined): string | undefined {
  if (!ir) return undefined;
  const columns = columnsOf(ir);
  if (columns.length === 0) return undefined;

  const registry = getTraitRegistry();
  const intake = columns.find((column) => registry.resolveColumnFlags(column).intake === true);
  if (!intake) return undefined;

  const intakeTrait = intake.traits.find((trait) => trait.trait === "intake");
  if (intakeTrait?.config?.autoTriage === false) {
    return columns.find((column) => registry.resolveColumnFlags(column).hold === true)?.id;
  }
  return intake.id;
}

/*
FNXC:WorkflowLifecycleColumns 2026-07-27-09:10 (U1 / KTD-2 — workflow-owned lifecycle):
THE lifecycle-column resolution seam. ~207 production sites decide the lifecycle by
comparing `task.column` against a hardcoded id ("todo", "in-progress", …). Those guards
do not FAIL when the column moves underneath them — they silently stop matching, which
disables a recovery path with a green suite. Phases B–D convert those sites onto the two
functions below, so conversion is mechanical rather than a per-site IR plumbing exercise.

Why a single struct rather than six separate lookups: most call sites need two or three
lifecycle columns at once (a sweep gated on the hold column that rebounds into it, a
release path comparing hold against wip). Resolving them together keeps one IR read and
one cache entry per workflow.

Trait → role mapping (the trait vocabulary is the source of truth, not these names):
  intake   → `intake`             where new cards land
  hold     → `hold`               passive dwell with a release condition (capacity)
  wip      → `countsTowardWip`    occupies an implementation slot
  review   → `mergeOrchestration` the merge/PR orchestration lane
  complete → `complete`           terminal success

CONSERVATIVE-ON-UNRESOLVABLE (deliberate): a v1 / column-less IR resolves to `undefined`
for the WHOLE struct, not to a struct of undefined roles. The distinction matters — a
caller must be able to tell "this workflow declares no hold column" (hold: undefined,
struct present) apart from "this workflow has no column vocabulary at all" (undefined).
The first is a real workflow shape to honor; the second means the caller has no basis to
decide and must skip-and-log rather than guess a legacy literal.
*/
/*
FNXC:WorkflowLifecycleColumns 2026-07-31-07:00 (arity contract, after two production bugs):
EACH FIELD IS **ONE** COLUMN, EVEN WHEN THE WORKFLOW DECLARES SEVERAL.

Uniqueness is validated for exactly ONE trait. `TraitRegistry.validateColumnTraits` raises
`multiple-intake-columns` when more than one column carries `intake` — and raises nothing for
`hold`, `countsTowardWip`, `mergeBlocker`, `humanReview` or `complete`. Those may
legitimately repeat: a workflow can split `mergeBlocker` and `humanReview` across a merge lane and a
separate sign-off lane, or declare two terminal columns. `columnsWithFlag` returns an array and
`first()` below picks its head, so this struct names only one of each.

So `intake` is safe to compare by equality; every other field is not.

That makes these fields safe for ONE question and unsafe for another:

  SAFE    "where should this card GO"      — a move target must be exactly one column
  UNSAFE  "is this card ALREADY there"     — that is membership; use `columnsWithFlag(ir, flag)`
                                             and test `.includes(task.column)`

Two shipped bugs came from the unsafe use, both in PR #2713: a task in a second terminal column was
rejected with a 409, and a task in a human-review lane split from the merge lane was classified as
outside review entirely, suppressing comment re-engagement. Both read like ordinary conversions.

Known call sites comparing `task.column` against these fields:
  packages/engine/src/self-healing.ts     `columns.intake` SAFE (validated unique);
                                          `columns.hold`   AT RISK — hold has no uniqueness rule
  packages/core/src/builtin-workflows.ts  `lifecycle.intake` SAFE (validated unique)
*/
export interface LifecycleColumns {
  /** Where new cards land. */
  intake: string | undefined;
  /** Passive dwell column with a release condition (capacity hold). */
  hold: string | undefined;
  /** Occupies an implementation/WIP slot. */
  wip: string | undefined;
  /** The merge/PR orchestration lane. */
  review: string | undefined;
  /** Terminal-success column. */
  complete: string | undefined;
}

/** The trait carrying each lifecycle role. Declared once so the roles and the
 *  trait vocabulary cannot drift apart silently. */
const LIFECYCLE_ROLE_FLAGS: Record<keyof LifecycleColumns, keyof TraitFlags> = {
  intake: "intake",
  hold: "hold",
  wip: "countsTowardWip",
  review: "mergeOrchestration",
  complete: "complete",
};

/**
 * Resolve an IR's lifecycle columns by trait — the FIRST column carrying each
 * trait, in declared column order. A role no column carries is `undefined`
 * (never substituted from an unrelated column).
 *
 * Returns `undefined` for a v1 / column-less IR: there is no column vocabulary
 * to resolve, so the caller has no workflow-derived answer to act on.
 *
 * FNXC:WorkflowResolvedColumns 2026-07-31-19:40: THIS ANSWERS "WHERE SHOULD A CARD GO", NOT
 * "IS THIS CARD ALREADY THERE".
 *
 * Each field is a SINGLE id — the first column carrying that trait. A board may declare several
 * columns with one role (two pre-review working lanes, a review lane plus a merge-blocked lane),
 * and every one after the first is invisible here. Using a field for MEMBERSHIP therefore reads as
 * a working check while silently ignoring lanes: a card resting in the second hold column is
 * classified as not-held, and the guard that depends on it never fires.
 *
 * That misreading has now landed in three separate places — the `hold` guard in `self-healing.ts`
 * (#3084), the progressed-lane check in `notification-service.ts` (#3096), and the review-set
 * mismatch in #3088 — so it is a property of this signature, not three unlucky authors.
 *
 * For membership, use one of:
 *   - `columnsWithFlag(ir, role)` — every column with the role on ONE board
 *   - `resolveProjectColumnsForRoles(store, roles)` — the union across a project's workflows
 *
 * Rule of thumb: a routing/move target wants this function; a `.has(task.column)` test does not.
 */
export function resolveLifecycleColumns(ir: WorkflowIr): LifecycleColumns | undefined {
  const columns = columnsOf(ir);
  if (columns.length === 0) return undefined;
  const registry = getTraitRegistry();
  /*
  FNXC:WorkflowLifecycleColumns 2026-07-27-15:40 (U1, PR #2467 review):
  Resolve each column's flags ONCE. A per-role `columns.find(...)` re-resolved
  every column's traits per role — up to 6N resolutions — and this function is
  not memoized, so a Phase B sweep sharing an IR cache across 400 cards would
  still pay it per card (the cache holds the IR, not the resolved struct).
  */
  const resolved = columns.map((c) => ({ id: c.id, flags: registry.resolveColumnFlags(c) }));
  const first = (flag: keyof TraitFlags): string | undefined =>
    resolved.find((c) => c.flags[flag] === true)?.id;
  return {
    intake: first(LIFECYCLE_ROLE_FLAGS.intake),
    hold: first(LIFECYCLE_ROLE_FLAGS.hold),
    wip: first(LIFECYCLE_ROLE_FLAGS.wip),
    review: first(LIFECYCLE_ROLE_FLAGS.review),
    complete: first(LIFECYCLE_ROLE_FLAGS.complete),
  };
}

/**
 * Store-aware form: resolve a TASK's lifecycle columns through its workflow
 * selection.
 *
 * `cache` is CALLER-OWNED on purpose. A self-healing pass over 400 cards spanning
 * three workflows must read three IRs, not 400 — the caller allocates one map per
 * sweep and hands it to every resolution in that pass (the shape the periodic
 * sweep's existing `irCache` already uses). A module-level cache would instead
 * have to guess when a mid-flight workflow edit invalidates it.
 *
 * Returns `undefined` when the workflow cannot be resolved to a column
 * vocabulary — callers keep conservative behavior (skip and log) rather than
 * falling back to a legacy literal.
 */
export async function resolveTaskLifecycleColumns(
  store: WorkflowIrResolverStore,
  taskId: string,
  cache?: Map<string, WorkflowIr>,
  selectionCache?: WorkflowSelectionCache,
): Promise<LifecycleColumns | undefined> {
  try {
    const ir = await resolveWorkflowIrForTask(store, taskId, cache, selectionCache);
    return resolveLifecycleColumns(ir);
  } catch {
    return undefined;
  }
}

/*
FNXC:WorkflowResolvedColumns 2026-07-30-20:50 (census-invisible moveTask destinations):
MOVE-TARGET resolvers, kept beside `resolveTaskLifecycleColumns` because they answer the same question
for the other half of a conversion.

The lifecycle-column census is an AST scan for COMPARISONS, so a `moveTask` DESTINATION — a call
argument — is invisible to it. A share of those deliberately pass `recoveryRehome: true` (the #1411
legacy safe-landing escape, which must not be converted); the rest are rejected outright on a board
that does not declare the target, now that U12 hoisted the `workflowHasColumn` check out of its dead
flag-gated branch. See
`docs/solutions/architecture-patterns/hardcoded-movetask-destinations-are-census-invisible.md`.

THE COUNTS THAT USED TO BE HERE ARE GONE ON PURPOSE. This note read "51 such destinations exist in
production; 22 deliberately pass `recoveryRehome: true`". Both were true when measured and neither is
now — the program has been converting them since — and unlike the census totals there is no command
that regenerates these, so the figures could only rot. A comment that states an un-reproducible count
about other files is a comment that will eventually lie; the shape is what matters here, and the
current numbers are one grep away:

    grep -rnE 'moveTask\([^,]+, *"(todo|in-progress|in-review|done|archived|triage)"' packages \
      --include='*.ts' | grep -v __tests__

(approximate — it sees single-line call sites only, which is precisely why it was never a total worth
pinning in prose).

Both fall back to the legacy id: `resolveWorkflowIrForTask` degrades to the BUILT-IN IR rather than
throwing, so a board whose workflow cannot be read behaves exactly as before.

ONE definition each, rather than a copy per call site — four sites already needed the rebound target and
they must not drift apart.
*/
export async function resolveReboundTargetForTask(store: WorkflowIrResolverStore, taskId: string): Promise<string> {
  try {
    const ir = await resolveWorkflowIrForTask(store, taskId);
    if (ir) {
      const target = resolveReboundTarget(ir);
      if (target) return target;
    }
  } catch { /* degraded: legacy id */ }
  return "todo";
}

/**
 * The WIP lane this task's workflow declares, or the legacy id. See above.
 *
 * FIRST `countsTowardWip` column, deliberately: this answers "where does a card go when it re-enters
 * execution?", which is a single destination, not a membership test. Callers asking "is this card in
 * WIP?" want `columnsWithFlag(ir, "countsTowardWip")` instead — a board may declare several.
 */
/*
FNXC:LifecycleContainment 2026-08-28-01:09:
FN-207 keeps automatic repair adjacent to the task's current lifecycle role.
`resolveReboundTarget` remains hold-first for WIP replanning, but it is unsafe for
review cards because it would skip implementation. This resolver has no literal
or first-column fallback: an absent destination means the caller must retain the
card in place rather than inventing a planning route.
*/
export function resolveContainedBackwardTarget(ir: WorkflowIr, fromColumnId: string): string | undefined {
  const source = columnsOf(ir).find((column) => column.id === fromColumnId);
  if (!source) return undefined;
  const roleFlags = getTraitRegistry().resolveColumnFlags(source);
  if (roleFlags.mergeOrchestration || roleFlags.mergeBlocker || roleFlags.humanReview) {
    return columnsWithFlag(ir, "countsTowardWip")[0];
  }
  if (roleFlags.countsTowardWip) return columnsWithFlag(ir, "hold")[0];
  return undefined;
}

export async function resolveContainedBackwardTargetForTask(
  store: WorkflowIrResolverStore,
  taskId: string,
  fromColumnId: string,
): Promise<string | undefined> {
  try {
    const ir = await resolveWorkflowIrForTask(store, taskId);
    return ir ? resolveContainedBackwardTarget(ir, fromColumnId) : undefined;
  } catch {
    return undefined;
  }
}

export async function resolveWipTargetForTask(store: WorkflowIrResolverStore, taskId: string): Promise<string> {
  try {
    const ir = await resolveWorkflowIrForTask(store, taskId);
    if (ir) {
      const wip = columnsWithFlag(ir, "countsTowardWip");
      if (wip.length > 0) return wip[0];
    }
  } catch { /* degraded: legacy id */ }
  return "in-progress";
}

