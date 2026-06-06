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
import type { WorkflowColumnRole, WorkflowIr, WorkflowIrV2 } from "./workflow-ir-types.js";
import { DEFAULT_WORKFLOW_COLUMN_IDS } from "./workflow-ir.js";
import { isCompanyBoardIr } from "./company-board-template.js";

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

/** Derive an all-to-all adjacency (every column reachable from every other) for
 *  a company-model board. The actor-rule layer ({@link validateCompanyBoardMove})
 *  enforces the strict movement matrix on top of this graph (the human matrix and
 *  the agent adjacent-forward / Lead-Reviewer-backward rules), so the base column
 *  graph stays permissive and never strands a card.
 *  Self-edges are omitted (a same-column move is a no-op handled upstream). */
function companyBoardAdjacency(ir: WorkflowIrV2): ColumnAdjacency {
  const adj: ColumnAdjacency = new Map();
  const ids = ir.columns.map((c) => c.id);
  for (const id of ids) {
    adj.set(
      id,
      ids.filter((other) => other !== id),
    );
  }
  return adj;
}

/**
 * Resolve the full column adjacency for a workflow IR. The default workflow
 * reproduces `VALID_TRANSITIONS` exactly; a company-model board allows any
 * column→column move at the graph level (the human owner is unrestricted; agent
 * moves are narrowed by the actor rule); other custom workflows use order-derived
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
  if (isCompanyBoardIr(v2)) {
    return companyBoardAdjacency(v2);
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

// ── Company-model actor-aware movement rules (U3, R5) ────────────────────────
//
// On a company-model board (its IR carries `role` markers — `isCompanyBoardIr`)
// movement is restricted by WHO is moving the card. The matrix is strict for
// everyone (KTD "The movement matrix is strict for everyone"):
//
//   - an agent (`actor.kind === "agent"`) may only move strictly
//     ADJACENT-FORWARD in the board's column order (no skipping). The single
//     exception is BACKWARD: an agent may move a card backward only when its
//     effective identity is the board's Lead or Reviewer (the two roles allowed
//     to send work back, R5); a backward target may be any earlier column. The
//     CEO is not the board's Lead/Reviewer, so it gets the standard agent rules
//     (no special movement powers — R5).
//   - the human owner (`actor.kind === "human"`) is limited to the exact human
//     matrix (R5/R24): idea ↔ todo, done → archived, and the revert paths
//     done → todo and archived → todo. Any other human move (e.g. dragging into
//     or out of in-review, skipping stages) is rejected with
//     `"human-move-not-allowed"`. The revert paths only PERMIT the move here; the
//     actual git revert (R24) lands elsewhere.
//
// These rules are layered ON TOP of the column-graph adjacency check (which still
// runs), and fire only for company boards — a legacy/custom workflow never
// carries `role` markers, so `validateCompanyBoardMove` returns `undefined` for
// it and the move is governed solely by `resolveAllowedColumns`.

/** The actor performing a move (U3, R5). Default posture is the human owner so
 *  existing UI/HTTP callers pass through the human matrix; agent tool callers pass
 *  their identity. */
export interface MoveActor {
  kind: "human" | "agent";
  /** The acting agent's id (when `kind === "agent"`). Resolved against the
   *  board's role-column bindings to decide Lead/Reviewer backward permission. */
  agentId?: string;
}

/** Reasons a company-model move is rejected (U3, R5). */
export type CompanyBoardMoveReason =
  /** An agent tried to skip forward (non-adjacent forward move). */
  | "agent-skip-forward"
  /** A non-Lead/Reviewer agent tried to move a card backward. */
  | "agent-backward-not-allowed"
  /** A human tried a move outside the human matrix (R5/R24). */
  | "human-move-not-allowed";

/** The exact set of column→column moves a human owner may perform on a company
 *  board (R5/R24): idea ↔ todo, done → archived, done → todo, archived → todo. */
const HUMAN_ALLOWED_MOVES: ReadonlySet<string> = new Set([
  "idea→todo",
  "todo→idea",
  "done→archived",
  "done→todo",
  "archived→todo",
]);

/** A typed rejection of a company-model agent move (U3, R5). */
export interface CompanyBoardMoveRejection {
  reason: CompanyBoardMoveReason;
  message: string;
}

/** The board-order index of a column id (custom columns included), or -1. */
function columnOrderIndex(ir: WorkflowIrV2, columnId: string): number {
  return ir.columns.findIndex((c) => c.id === columnId);
}

/** The company-model role an agent holds on this board, by matching its id
 *  against the role columns' agent bindings. Returns undefined when the agent
 *  staffs no role column (it is an Executor-class or unrelated agent). */
function roleOfAgent(ir: WorkflowIrV2, agentId: string): WorkflowColumnRole | undefined {
  for (const col of ir.columns) {
    if (col.role !== undefined && col.agent?.agentId === agentId) return col.role;
  }
  return undefined;
}

/**
 * Validate an actor-aware move on a company-model board (U3, R5). Returns a typed
 * rejection when the move is illegal for the actor, or `undefined` when it is
 * allowed (or when the board is not a company board / the actor is human).
 *
 * The caller still runs the column-graph adjacency check separately; this layer
 * only adds the actor restriction. Assumes `fromColumn`/`toColumn` differ.
 */
export function validateCompanyBoardMove(
  ir: WorkflowIr,
  fromColumn: string,
  toColumn: string,
  actor: MoveActor,
): CompanyBoardMoveRejection | undefined {
  if (!isCompanyBoardIr(ir)) return undefined;

  // Human owner: limited to the exact human matrix (R5/R24). Any other move is
  // rejected. Keyed by literal column ids — the company template's matrix columns
  // (idea/todo/done/archived) are fixed locked ids.
  if (actor.kind === "human") {
    if (HUMAN_ALLOWED_MOVES.has(`${fromColumn}→${toColumn}`)) return undefined;
    return {
      reason: "human-move-not-allowed",
      message:
        `Human moves are limited to idea ↔ todo, done → archived, and the revert ` +
        `paths done → todo / archived → todo; '${fromColumn}' → '${toColumn}' rejected`,
    };
  }

  const v2 = ir as WorkflowIrV2;
  const fromIdx = columnOrderIndex(v2, fromColumn);
  const toIdx = columnOrderIndex(v2, toColumn);
  // Unknown columns are an adjacency/structural concern handled by the caller;
  // don't second-guess them here.
  if (fromIdx < 0 || toIdx < 0) return undefined;

  const forward = toIdx > fromIdx;
  if (forward) {
    // Agent forward moves must be strictly adjacent (no skipping).
    if (toIdx !== fromIdx + 1) {
      return {
        reason: "agent-skip-forward",
        message:
          `Agent moves must advance one column at a time; ` +
          `'${fromColumn}' → '${toColumn}' skips columns`,
      };
    }
    return undefined;
  }

  // Backward move: only the board's Lead or Reviewer may do it (any earlier
  // column is a legal target for them).
  const role = actor.agentId ? roleOfAgent(v2, actor.agentId) : undefined;
  if (role === "lead" || role === "reviewer") return undefined;
  return {
    reason: "agent-backward-not-allowed",
    message:
      `Only the board's Lead or Reviewer may move a card backward; ` +
      `'${fromColumn}' → '${toColumn}' rejected`,
  };
}
