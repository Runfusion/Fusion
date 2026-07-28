/*
FNXC:WorkflowLifecycleTraits 2026-07-19-06:10 (U6 / KTD-10):
Pure, per-IR trait→column primitives shared by the self-healing recovery sweeps.
Two concerns, both keyed on trait flags (never literal column ids) so a custom or
renamed workflow behaves correctly while builtin:coding stays byte-identical
(KTD-7: the builtin column ids ARE the legacy enum, so every predicate below
resolves to the same columns the old literals named):

  - `columnsWithFlag(ir, flag)` — the trait→columnIds expansion. A sweep resolves
    the workflow IR ONCE, expands each trait it enumerates by (wip / merge-
    orchestration / complete / archived / hold / intake) to the set of column ids
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
import { resolveWorkflowIrForTask, type WorkflowIrResolverStore } from "./workflow-ir-resolver.js";

/** The v2 column list, or [] for a v1/column-less IR. */
function columnsOf(ir: WorkflowIr): WorkflowIrColumn[] {
  return ir.version === "v2" ? ir.columns : [];
}

/**
 * The set of column ids whose resolved (OR-merged) trait flags set `flag` — the
 * trait→columnIds expansion. Deterministic (declared column order). Empty for a
 * column-less IR or when no column carries the flag.
 */
export function columnsWithFlag(ir: WorkflowIr, flag: keyof TraitFlags): string[] {
  const registry = getTraitRegistry();
  return columnsOf(ir)
    .filter((c) => registry.resolveColumnFlags(c)[flag] === true)
    .map((c) => c.id);
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
 * KTD-10 rebound target: where a self-healing sweep requeues a recovered card.
 * Preference order — the workflow's `hold` column, else its `intake` column, else
 * its first column. Returns undefined only for a column-less (v1) IR, where the
 * caller keeps the legacy literal fallback. For builtin:coding this is `todo`.
 */
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
  archived → `archived`           globally archived

CONSERVATIVE-ON-UNRESOLVABLE (deliberate): a v1 / column-less IR resolves to `undefined`
for the WHOLE struct, not to a struct of undefined roles. The distinction matters — a
caller must be able to tell "this workflow declares no hold column" (hold: undefined,
struct present) apart from "this workflow has no column vocabulary at all" (undefined).
The first is a real workflow shape to honor; the second means the caller has no basis to
decide and must skip-and-log rather than guess a legacy literal.
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
  /** Globally archived column. */
  archived: string | undefined;
}

/** The trait carrying each lifecycle role. Declared once so the roles and the
 *  trait vocabulary cannot drift apart silently. */
const LIFECYCLE_ROLE_FLAGS: Record<keyof LifecycleColumns, keyof TraitFlags> = {
  intake: "intake",
  hold: "hold",
  wip: "countsTowardWip",
  review: "mergeOrchestration",
  complete: "complete",
  archived: "archived",
};

/**
 * Resolve an IR's lifecycle columns by trait — the FIRST column carrying each
 * trait, in declared column order. A role no column carries is `undefined`
 * (never substituted from an unrelated column).
 *
 * Returns `undefined` for a v1 / column-less IR: there is no column vocabulary
 * to resolve, so the caller has no workflow-derived answer to act on.
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
    archived: first(LIFECYCLE_ROLE_FLAGS.archived),
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
): Promise<LifecycleColumns | undefined> {
  try {
    const ir = await resolveWorkflowIrForTask(store, taskId, cache);
    return resolveLifecycleColumns(ir);
  } catch {
    return undefined;
  }
}
