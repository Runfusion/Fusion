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

import { VALID_TRANSITIONS } from "../types.js";
import type { Column } from "../types.js";
import type { WorkflowIr, WorkflowIrV2 } from "./workflow-ir-types.js";
import { DEFAULT_WORKFLOW_COLUMN_IDS } from "./workflow-ir.js";

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
  return orderDerivedAdjacency(v2);
}

/**
 * The allowed target columns for a move out of `fromColumn` under this workflow.
 * Returns an empty array when `fromColumn` is unknown to the workflow (callers
 * should first check column existence to distinguish "unknown column" from "no
 * legal targets").
 */
export function resolveAllowedColumns(ir: WorkflowIr, fromColumn: string): string[] {
  return resolveColumnAdjacency(ir).get(fromColumn) ?? [];
}

/** True when `toColumn` is a defined column of the workflow. */
export function workflowHasColumn(ir: WorkflowIr, columnId: string): boolean {
  const v2 = ir as WorkflowIrV2;
  return Array.isArray(v2.columns) && v2.columns.some((c) => c.id === columnId);
}
