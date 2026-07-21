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
