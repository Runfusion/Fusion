/**
 * Workflow lifecycle reconciliation (U5, R15/R20).
 *
 * Defines the policy for every case where a card's column could stop existing
 * under it:
 *
 *   (a) workflow SWITCH — the task's selection changes. If the new workflow
 *       defines a column with the task's current column id, position is
 *       preserved; otherwise the card re-homes to the new workflow's entry
 *       (intake-flagged, falling back to the first) column. In-flight processing
 *       is aborted first via an injected abort callback (engine wires the real
 *       abort; core ships a safe no-op default + audit entry so core stays
 *       engine-free).
 *
 *   (b) workflow EDIT removing an occupied column — the update path blocks with
 *       a typed {@link OccupiedColumnsError} listing per-column occupant counts.
 *       An explicit `rehomeTo` option allows the save plus re-home of every
 *       occupant (one audit event per card).
 *
 *   (c) workflow DELETE with occupants — built-ins stay blocked; custom
 *       workflows re-home occupants to the DEFAULT workflow's entry column,
 *       clear their selection rows, and preserve task fields (preserveProgress
 *       semantics), one audit event per card.
 *
 * Re-homing moves go through `moveTask` with `moveSource: "engine"` +
 * `bypassGuards` (a recovery-class move, KTD-9) — never a raw column write — so
 * capacity (KTD-10) and the single transition authority (KTD-3) are honored.
 *
 * This module is pure policy + a DI seam. The store (and dashboard routes via
 * the store) own the actual DB reads/writes and the `moveTask` call; this module
 * supplies the column-resolution rules and the abort indirection so the policy
 * is independently testable and reused identically across switch/edit/delete.
 */

import type {
  WorkflowIr,
  WorkflowIrV2,
  WorkflowIrColumn,
  WorkflowFieldDefinition,
} from "./workflow-ir-types.js";
import { resolveColumnFlags } from "./trait-registry.js";
import { workflowHasColumn } from "./workflow-transitions.js";

// ── Entry-column resolution ──────────────────────────────────────────────────

/** The v2 columns of an IR, or `[]` when (defensively) absent. */
function columnsOf(ir: WorkflowIr): WorkflowIrColumn[] {
  const v2 = ir as WorkflowIrV2;
  return Array.isArray(v2.columns) ? v2.columns : [];
}

/**
 * The entry column id for a workflow: the intake-flagged column (resolved via
 * the trait registry's effective-flag merge), falling back to the FIRST
 * declared column. Returns `undefined` only when the workflow declares no
 * columns at all (should never happen post-parse) — callers treat that as a
 * non-reconcilable workflow and leave the card where it is.
 */
export function resolveEntryColumnId(ir: WorkflowIr): string | undefined {
  const columns = columnsOf(ir);
  if (columns.length === 0) return undefined;
  for (const column of columns) {
    if (resolveColumnFlags(column).intake) return column.id;
  }
  return columns[0].id;
}

// ── (a) Workflow switch ──────────────────────────────────────────────────────

/** The outcome of resolving where a card lands when its workflow switches. */
export interface SwitchReconciliation {
  /** The column the card should occupy under the new workflow. */
  targetColumn: string;
  /** True when the card's current column id exists in the new workflow and was
   *  therefore preserved; false when it was re-homed to the entry column. */
  preserved: boolean;
  /** The entry column the card would re-home to (always resolved, for audit). */
  entryColumn: string | undefined;
}

/**
 * Resolve where a card currently in `currentColumn` lands under `newWorkflowIr`.
 * Same-id columns preserve position; otherwise the card re-homes to the new
 * workflow's entry column. Pure — the caller performs the abort + move.
 */
export function resolveSwitchReconciliation(
  newWorkflowIr: WorkflowIr,
  currentColumn: string,
): SwitchReconciliation {
  const entryColumn = resolveEntryColumnId(newWorkflowIr);
  if (workflowHasColumn(newWorkflowIr, currentColumn)) {
    return { targetColumn: currentColumn, preserved: true, entryColumn };
  }
  // No same-id column: re-home to the entry column. When the new workflow
  // declares no columns at all (entryColumn undefined), leave the card where it
  // is rather than strand it in nowhere.
  return {
    targetColumn: entryColumn ?? currentColumn,
    preserved: false,
    entryColumn,
  };
}

/*
FNXC:WorkflowColumns 2026-07-28-00:00 (U12 — PR #2513 review):
A workflow SWITCH commits the new selection first, then re-homes the card. When the
destination rejects the move (capacity), `rehomeOccupant` swallows the error — so the
selection said one thing and the card's column said another, and nothing reported it.
A torn write with no alarm is the one outcome that must not survive.

The state is RECOVERABLE and deliberately left in place rather than rolled back: the
selection is committed and the card sits in a column the new workflow does not
declare, which is exactly what the R7 startup sweep `reconcileUndeclaredTaskColumns`
repairs. What was missing is the alarm, so this error IS the alarm — it names the
task, both columns, and the underlying rejection so an operator can retry or make
room instead of discovering it later from a card in a lane that cannot be drawn.
*/
export class WorkflowSwitchRehomeFailedError extends Error {
  readonly taskId: string;
  readonly workflowId: string;
  readonly fromColumn: string;
  readonly intendedColumn: string;
  readonly reason?: string;
  /** True when the workflow selection was already COMMITTED — i.e. the card is torn
   *  and needs recovery. False when the switch was rejected before any write, which
   *  leaves the card fully consistent and is the ordinary case. */
  readonly committed: boolean;
  constructor(args: {
    taskId: string;
    workflowId: string;
    fromColumn: string;
    intendedColumn: string;
    reason?: string;
    committed: boolean;
  }) {
    super(
      args.committed
        ? `Task '${args.taskId}' was switched to workflow '${args.workflowId}', but re-homing it ` +
            `from '${args.fromColumn}' to '${args.intendedColumn}' was rejected` +
            `${args.reason ? `: ${args.reason}` : ""}. The workflow selection IS COMMITTED and the ` +
            `card remains in '${args.fromColumn}', which that workflow does not declare — the card ` +
            `is inconsistent. Make room in '${args.intendedColumn}' and move the card there, or ` +
            `switch the task back; startup reconciliation will otherwise re-home it.`
        : `Cannot switch task '${args.taskId}' to workflow '${args.workflowId}': it would have to ` +
            `move from '${args.fromColumn}' to '${args.intendedColumn}'` +
            `${args.reason ? `, but ${args.reason}` : ", but that move was rejected"}. Nothing was ` +
            `changed — the task keeps its current workflow and column. Make room in ` +
            `'${args.intendedColumn}' and retry.`,
    );
    this.name = "WorkflowSwitchRehomeFailedError";
    this.taskId = args.taskId;
    this.workflowId = args.workflowId;
    this.fromColumn = args.fromColumn;
    this.intendedColumn = args.intendedColumn;
    this.committed = args.committed;
    if (args.reason !== undefined) this.reason = args.reason;
  }
}

/**
 * Decide what a completed workflow switch should REPORT, given the column the task
 * actually has afterwards (`undefined` when the row could not be read).
 *
 * FNXC:WorkflowColumns 2026-07-28-00:00 (U12 — PR #2512 review, greptile P1):
 * Extracted as a pure seam because the case that matters is not reachable through
 * the public call. `selectTaskWorkflow` rejects a soft-deleted task up front with
 * `TaskDeletedError`, so "the task is soft-deleted BETWEEN the first read and the
 * final one" is a genuine race that cannot be driven from outside — and it is the
 * case where the previous fallback fabricated a live column for a row that is gone.
 * Racing a lifecycle read against a soft-delete is a documented hazard here (the
 * soft-delete verification matrix; FN-8004). Testing the decision directly is honest;
 * asserting it from reading the code is not.
 */
export function buildSwitchReconciliation(
  fromColumn: string,
  actualColumn: string | undefined,
): { preserved: boolean; fromColumn: string; toColumn: string } | undefined {
  // Absent is absent — never synthesize a column from the stale pre-switch read.
  if (actualColumn === undefined) return undefined;
  return { preserved: actualColumn === fromColumn, fromColumn, toColumn: actualColumn };
}

// ── (b) Workflow edit removing an occupied column ────────────────────────────

/** Per-column occupant count for a blocked edit/delete. */
export interface ColumnOccupancy {
  columnId: string;
  count: number;
}

/**
 * Thrown by the store's update path (and surfaced as a structured 409 by the
 * dashboard) when a workflow edit would remove one or more columns that still
 * hold cards, and no `rehomeTo` was supplied. Carries the per-column occupant
 * counts so the surface can prompt for a re-home target.
 */
export class OccupiedColumnsError extends Error {
  readonly workflowId: string;
  readonly occupancies: ColumnOccupancy[];
  constructor(workflowId: string, occupancies: ColumnOccupancy[]) {
    const summary = occupancies
      .map((o) => `${o.columnId} (${o.count})`)
      .join(", ");
    super(
      `Workflow '${workflowId}' edit removes occupied column(s): ${summary}. ` +
        `Re-home the occupants (rehomeTo) or move them out first.`,
    );
    this.name = "OccupiedColumnsError";
    this.workflowId = workflowId;
    this.occupancies = occupancies;
  }
}

/**
 * Compute which currently-occupied columns would be removed by replacing the
 * existing IR with `nextIr`. `occupantsByColumn` maps a column id to the number
 * of cards currently in it (under this workflow). Returns one entry per removed
 * column that still has occupants, in the existing IR's column order.
 */
export function computeRemovedOccupiedColumns(
  existingIr: WorkflowIr,
  nextIr: WorkflowIr,
  occupantsByColumn: Map<string, number>,
): ColumnOccupancy[] {
  const nextIds = new Set(columnsOf(nextIr).map((c) => c.id));
  const removed: ColumnOccupancy[] = [];
  for (const column of columnsOf(existingIr)) {
    if (nextIds.has(column.id)) continue;
    const count = occupantsByColumn.get(column.id) ?? 0;
    if (count > 0) removed.push({ columnId: column.id, count });
  }
  return removed;
}

/**
 * Thrown when a supplied `rehomeTo` names a column that does not exist in the
 * post-edit workflow. Distinct from {@link OccupiedColumnsError} (which signals
 * a conflict needing a re-home target) — this is a bad-request input error and
 * the dashboard maps it to a 400, not a 409.
 */
export class InvalidRehomeTargetError extends Error {
  readonly workflowId: string;
  readonly rehomeTo: string;
  constructor(workflowId: string, rehomeTo: string) {
    super(
      `Workflow '${workflowId}' has no column '${rehomeTo}' to re-home occupants into.`,
    );
    this.name = "InvalidRehomeTargetError";
    this.workflowId = workflowId;
    this.rehomeTo = rehomeTo;
  }
}

/**
 * Validate that `rehomeTo` (when supplied for an edit that removes occupied
 * columns) names a column that survives in `nextIr`. Throws when it does not, so
 * occupants are never re-homed into a column that won't exist either.
 */
export function assertRehomeTargetValid(nextIr: WorkflowIr, rehomeTo: string): void {
  if (!workflowHasColumn(nextIr, rehomeTo)) {
    throw new InvalidRehomeTargetError(
      (nextIr as WorkflowIrV2).name ?? "(unknown)",
      rehomeTo,
    );
  }
}

// ── Custom-field schema-evolution reconciliation (U11/KTD-13) ────────────────

/** A field whose type changed incompatibly while tasks hold values under it. */
export interface IncompatibleFieldChange {
  fieldId: string;
  fromType: string;
  toType: string;
  /** Number of tasks (under this workflow) currently holding a value for it. */
  occupantCount: number;
}

/**
 * Thrown by the workflow update path when an IR edit changes one or more custom
 * fields' types incompatibly for tasks that already hold a value, and no
 * `coerce` option was supplied. Mirrors {@link OccupiedColumnsError}: a typed,
 * conflict-signaling error the surface maps to a 409 prompting for a coercion
 * choice (`drop` | `keep-orphaned`).
 */
export class IncompatibleFieldChangeError extends Error {
  readonly workflowId: string;
  readonly changes: IncompatibleFieldChange[];
  constructor(workflowId: string, changes: IncompatibleFieldChange[]) {
    const summary = changes
      .map((c) => `${c.fieldId} (${c.fromType}→${c.toType}, ${c.occupantCount})`)
      .join(", ");
    super(
      `Workflow '${workflowId}' edit changes field type(s) incompatibly: ${summary}. ` +
        `Supply coerce ("drop" | "keep-orphaned") to proceed.`,
    );
    this.name = "IncompatibleFieldChangeError";
    this.workflowId = workflowId;
    this.changes = changes;
  }
}

/** The v2 fields of an IR, or `[]` when absent (v1 or undeclared). */
function fieldsOf(ir: WorkflowIr): WorkflowFieldDefinition[] {
  const v2 = ir as WorkflowIrV2;
  return Array.isArray(v2.fields) ? v2.fields : [];
}

/** Enum-kind sibling check (enum / multi-enum). */
function sameEnumKind(a: string, b: string): boolean {
  const enumKind = (t: string) => t === "enum" || t === "multi-enum";
  return enumKind(a) && enumKind(b);
}

/**
 * Compute which custom fields change type INCOMPATIBLY between `existingIr` and
 * `nextIr` AND still have occupant tasks holding a value. A type is compatible
 * with itself; enum↔multi-enum is treated as compatible-shape (values are
 * re-validated against the new options at reconcile time — a value dropped by
 * the new options orphans individually, not via a hard block). A field removed
 * outright is NOT a conflict (removal always orphans, never blocks). Returns one
 * entry per blocking change in the existing IR's field order.
 *
 * `occupantsByField` maps a field id to the count of tasks (under this workflow)
 * currently holding a value for it.
 */
export function computeIncompatibleFieldChanges(
  existingIr: WorkflowIr,
  nextIr: WorkflowIr,
  occupantsByField: Map<string, number>,
): IncompatibleFieldChange[] {
  const nextById = new Map(fieldsOf(nextIr).map((f) => [f.id, f]));
  const changes: IncompatibleFieldChange[] = [];
  for (const oldField of fieldsOf(existingIr)) {
    const next = nextById.get(oldField.id);
    if (!next) continue; // removed → orphan, not a block
    if (next.type === oldField.type) continue; // identical type → fine
    if (sameEnumKind(oldField.type, next.type)) continue; // enum↔multi-enum → soft
    const occupantCount = occupantsByField.get(oldField.id) ?? 0;
    if (occupantCount > 0) {
      changes.push({
        fieldId: oldField.id,
        fromType: oldField.type,
        toType: next.type,
        occupantCount,
      });
    }
  }
  return changes;
}

// ── Abort-on-switch DI seam (core stays engine-free) ─────────────────────────
//
// A workflow switch must abort the card's in-flight processing BEFORE the move
// (mirroring abort-on-exit, KTD-9). Aborting touches engine machinery (sessions
// / leases), which core cannot import. The engine wires its abort in via
// `setReconciliationAbort` (mirrors `setCreateFnAgent`); when unset (isolated
// core tests, or engine not loaded) the default is a safe no-op that records an
// audit breadcrumb so the bypass is visible — degraded, not crashed.

/** What the store passes to the abort callback so the engine can locate the
 *  session/lease to abort and the store can record audit. */
export interface ReconciliationAbortContext {
  taskId: string;
  fromColumn: string;
  reason: "workflow-switch" | "workflow-delete" | "workflow-edit-rehome";
}

/** The injected abort implementation. Returns nothing; failures must not throw
 *  (a failed abort degrades to an audit entry — it never strands the card). */
export type ReconciliationAbort = (ctx: ReconciliationAbortContext) => void | Promise<void>;

let reconciliationAbort: ReconciliationAbort | undefined;

/**
 * Wire the engine's abort implementation into core. Called by `@fusion/engine`
 * at module load; tests may register a stub (or leave it unset for the no-op).
 * Passing `undefined` restores the default no-op.
 */
export function setReconciliationAbort(fn: ReconciliationAbort | undefined): void {
  reconciliationAbort = fn;
}

/**
 * Run the wired abort, or the safe default no-op when none is registered. Always
 * resolves (swallows abort errors) so reconciliation never wedges on a failing
 * abort. Returns `true` when a real abort ran, `false` for the default no-op —
 * the store records the appropriate audit either way.
 */
export async function runReconciliationAbort(ctx: ReconciliationAbortContext): Promise<boolean> {
  if (!reconciliationAbort) return false;
  try {
    await reconciliationAbort(ctx);
  } catch {
    // A failed abort must not strand the card — the caller still re-homes it,
    // and records a degraded-abort audit. Swallow here.
  }
  return true;
}

/** Test-only: reset the wired abort to the default no-op. */
export function __resetReconciliationAbortForTests(): void {
  reconciliationAbort = undefined;
}
