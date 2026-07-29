/**
 * Workflow-resolved transition adjacency (U4, R4/R9/R13).
 *
 * `moveTaskInternal` (flag ON) and `board.ts` both derive "which columns can a
 * card move to from here" from the SAME helper so the two surfaces never
 * diverge — `resolveAllowedColumns(ir, fromColumn)`.
 *
 * ── Why an explicit adjacency, not pure graph-derivation ──────────────────────
 *
 * The plan asks: derive allowed column adjacency from node placement + edges,
 * and for the DEFAULT workflow it MUST reproduce `VALID_TRANSITIONS` exactly.
 * Pure graph-edge derivation CANNOT reproduce it: `VALID_TRANSITIONS` encodes
 * backward/reopen edges (in-review → todo, done → todo, archived → done, …) and
 * cross edges (in-progress → done) that have no counterpart in the linear
 * execute → review → merge → end pipeline graph. The IR edges describe the
 * forward automation walk; the column adjacency describes legal *board* moves
 * (drags, reopens, recovery), which is a strictly larger, partly-cyclic set.
 *
 * So per the plan's documented fallback we attach an explicit per-column
 * `transitions` adjacency:
 *   - For the BUILT-IN default workflow we reproduce `VALID_TRANSITIONS` verbatim
 *     (keyed by the legacy column ids, which are exactly the default workflow's
 *     column ids — KTD-1). This is the parity contract the transition-parity
 *     suite machine-checks.
 *   - For CUSTOM workflows (no explicit adjacency authored yet — authoring lands
 *     with the editor in U10) we derive a linear forward+back adjacency from the
 *     declared column ORDER: each column may move to its neighbors (prev/next).
 *     This is a safe, predictable default that keeps every column reachable and
 *     never strands a card; richer custom adjacency is future work.
 *
 * The adjacency is intentionally a column→columns map computed once per IR; it
 * is read-only and pure.
 */

import { VALID_TRANSITIONS } from "./types.js";
import type { Column } from "./types.js";
import type { WorkflowIr, WorkflowIrV2 } from "./workflow-ir-types.js";
import { DEFAULT_WORKFLOW_COLUMN_IDS } from "./workflow-ir.js";
import { resolveLifecycleColumns, resolveReboundTarget } from "./workflow-lifecycle-traits.js";

/** A column→allowed-target-columns adjacency map. */
export type ColumnAdjacency = Map<string, string[]>;

/** True when the IR's columns are exactly the legacy default-workflow column ids
 *  (same set), i.e. this is the built-in default workflow (or an equivalent). */
function isDefaultWorkflowColumns(ir: WorkflowIrV2): boolean {
  const ids = ir.columns.map((c) => c.id);
  if (ids.length !== DEFAULT_WORKFLOW_COLUMN_IDS.length) return false;
  const set = new Set(ids);
  return DEFAULT_WORKFLOW_COLUMN_IDS.every((id) => set.has(id));
}

/** Build the verbatim `VALID_TRANSITIONS` adjacency keyed by column id. */
function defaultWorkflowAdjacency(): ColumnAdjacency {
  const adj: ColumnAdjacency = new Map();
  for (const [from, targets] of Object.entries(VALID_TRANSITIONS) as [Column, Column[]][]) {
    adj.set(from, [...targets]);
  }
  return adj;
}

/** Derive a neighbor (prev/next by declared order) adjacency for a custom
 *  workflow. Each column can move to the column before and after it in the
 *  authored order. Endpoints have a single neighbor. */
function orderDerivedAdjacency(ir: WorkflowIrV2): ColumnAdjacency {
  const adj: ColumnAdjacency = new Map();
  const ids = ir.columns.map((c) => c.id);
  for (let i = 0; i < ids.length; i++) {
    const targets: string[] = [];
    if (i > 0) targets.push(ids[i - 1]);
    if (i < ids.length - 1) targets.push(ids[i + 1]);
    adj.set(ids[i], targets);
  }
  return adj;
}


/*
FNXC:MergedPlanningColumn 2026-07-29-11:05 (U11):
`isDefaultWorkflowColumns` recognises the default workflow by matching the legacy SIX column ids
as a set. U11 merges Todo into Planning, so the default declares FIVE — the match stops firing and
the default board silently falls through to `orderDerivedAdjacency`, which is neighbor-only.

That is a real, operator-visible loss, not a cosmetic one. Measured against `VALID_TRANSITIONS`,
neighbor adjacency both DROPS legal moves and INVENTS an illegal one:

  in-progress -> done       DROPPED — the mission-validation cross edge, which is the exact case
                            `custom-review-lane-merge-blocker` covers
  in-review   -> todo       DROPPED — sending review work back to planning
  todo/done   -> archived   DROPPED — the FN-4892 direct-archival edges
  done        -> in-review  INVENTED — a backward edge into review that no rule ever allowed

So adjacency is derived from lifecycle ROLES instead of column ids. `VALID_TRANSITIONS` is a
role-level statement wearing legacy id clothing; expressing it that way makes it survive a rename
or a merge, which is the whole point of this program. Applied only when the workflow declares the
full lifecycle role set — anything less is a genuinely custom shape and keeps neighbor adjacency,
so no existing custom workflow changes behavior.

For the legacy six, intake and hold are distinct columns and this reproduces `VALID_TRANSITIONS`
verbatim (asserted). For the merged shape the two roles resolve to the SAME column, so the
self-edges collapse and the remaining edges are exactly the legacy ones with `triage` folded in.
*/
const ROLE_TRANSITIONS: Record<string, string[]> = {
  intake: ["hold", "archived"],
  hold: ["wip", "intake", "archived"],
  wip: ["review", "hold", "intake", "complete"],
  review: ["complete", "wip", "hold", "intake"],
  complete: ["hold", "intake", "archived"],
  archived: ["complete"],
};

/** Role→column-id for this workflow, or `undefined` when a lifecycle role is missing. */
function resolveRoleColumns(ir: WorkflowIrV2): Record<string, string> | undefined {
  const lifecycle = resolveLifecycleColumns(ir);
  if (!lifecycle) return undefined;
  const { intake, hold, wip, review, complete, archived } = lifecycle;
  // A workflow missing any lifecycle role is a genuinely custom shape; neighbor adjacency is the
  // honest answer there rather than a half-applied lifecycle.
  if (!wip || !review || !complete || !archived) return undefined;
  const planning = hold ?? intake;
  if (!planning) return undefined;
  return {
    intake: intake ?? planning,
    hold: planning,
    wip,
    review,
    complete,
    archived,
  };
}

function roleDerivedAdjacency(ir: WorkflowIrV2): ColumnAdjacency | undefined {
  const roles = resolveRoleColumns(ir);
  if (!roles) return undefined;
  const declared = new Set(ir.columns.map((c) => c.id));
  const adj: ColumnAdjacency = new Map();
  for (const [role, targetRoles] of Object.entries(ROLE_TRANSITIONS)) {
    const fromColumn = roles[role];
    if (!fromColumn || !declared.has(fromColumn)) continue;
    const targets: string[] = [];
    for (const targetRole of targetRoles) {
      const toColumn = roles[targetRole];
      // Skip self-edges (merged roles resolve to the same column) and undeclared targets.
      if (!toColumn || toColumn === fromColumn || !declared.has(toColumn)) continue;
      if (!targets.includes(toColumn)) targets.push(toColumn);
    }
    // Merged roles write the same key twice; union rather than overwrite.
    const existing = adj.get(fromColumn) ?? [];
    adj.set(fromColumn, [...existing, ...targets.filter((t) => !existing.includes(t))]);
  }
  return adj;
}

/**
 * Resolve the full column adjacency for a workflow IR. The default workflow
 * reproduces `VALID_TRANSITIONS` exactly; custom workflows use order-derived
 * neighbor adjacency.
 */
export function resolveColumnAdjacency(ir: WorkflowIr): ColumnAdjacency {
  // v1 IR is upgraded to v2 on parse, but accept either defensively.
  const v2 = ir as WorkflowIrV2;
  if (!Array.isArray(v2.columns)) {
    // No columns (shouldn't happen post-parse) → empty adjacency.
    return new Map();
  }
  if (isDefaultWorkflowColumns(v2)) {
    return defaultWorkflowAdjacency();
  }
  const roleDerived = roleDerivedAdjacency(v2);
  if (roleDerived) return roleDerived;
  return orderDerivedAdjacency(v2);
}

/**
 * The allowed target columns for a move out of `fromColumn` under this workflow.
 * Returns an empty array when `fromColumn` is unknown to the workflow (callers
 * should first check column existence to distinguish "unknown column" from "no
 * legal targets").
 */
export function resolveAllowedColumns(ir: WorkflowIr, fromColumn: string): string[] {
  const adjacency = resolveColumnAdjacency(ir).get(fromColumn);
  if (adjacency) return adjacency;

  /*
  FNXC:MergedPlanningColumn 2026-07-29-10:25 (U11 migration):
  A card can outlive the column it is stored in — U11 removes `triage` from the default coding
  workflow, so after upgrade every card still sitting there is in a column its own workflow no
  longer declares. Adjacency is derived from the graph, so an undeclared source has none, and this
  returned `[]`: EVERY move rejected with "Valid targets: none", including the one that would
  rescue the card. `reconcileUndeclaredTaskColumns` re-homes such rows, but only when it runs; in
  between, an operator dragging the card got a hard rejection with nothing actionable in it.

  So an undeclared source column resolves to the workflow's own rebound target (hold -> intake ->
  first declared column). This is an ESCAPE HATCH, not a relaxation: there is no adjacency to
  violate from a column that is not in the graph, and every declared column keeps exactly the
  targets its graph gives it — the `if (adjacency) return adjacency` above is unconditional.

  Deliberately the rebound target ONLY, not "any declared column". A stranded card needs a way back
  INTO the lifecycle, not a way to skip it; allowing any target would let a card jump from a removed
  planning column straight to a review or complete column, which the ordinary adjacency rules exist
  to prevent. An operator who wants it elsewhere moves it twice.

  A workflow with no declared columns (v1 IR) has nothing to rebound to and still resolves to `[]`,
  so callers keep their conservative rejection rather than being handed an invented target.
  */
  const rebound = resolveReboundTarget(ir);
  return rebound ? [rebound] : [];
}

/** True when `toColumn` is a defined column of the workflow. */
export function workflowHasColumn(ir: WorkflowIr, columnId: string): boolean {
  const v2 = ir as WorkflowIrV2;
  return Array.isArray(v2.columns) && v2.columns.some((c) => c.id === columnId);
}
