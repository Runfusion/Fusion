/**
 * Workflow capacity resolution (U6, KTD-10, R9 capacity half).
 *
 * WIP/capacity limits are trait *configuration*; their *enforcement* is a
 * substrate capability that runs INSIDE `moveTaskInternal`'s transaction and is
 * NEVER bypassable (not a guard — runs regardless of bypassGuards/recoveryRehome
 * /moveSource). This module is the pure resolution layer shared by both the
 * in-txn check (`store.ts`) and the hold/release sweep (`@fusion/engine`
 * `hold-release.ts`): given a workflow IR + a column id + settings it answers
 *   - does this column have a `wip` (capacity) trait?
 *   - what is its effective limit (read-through to `settings.maxConcurrent` for
 *     the default workflow's in-progress column so the legacy knob keeps working
 *     — U6 scheduler-integration half)?
 *   - does its config opt into counting mid-`transitionPending` cards?
 *
 * It performs NO DB access and NO counting — the caller owns the count (the
 * store counts in-txn; the sweep counts from a listTasks snapshot). Keeping the
 * resolution pure means the two enforcement points can never disagree on what a
 * limit *is*, only on the live count, which is exactly the serialization the
 * in-txn check arbitrates (two holds, one slot → one wins).
 */

import type { Settings } from "./types.js";
import type { WorkflowIr, WorkflowIrV2, WorkflowIrColumn } from "./workflow-ir-types.js";
import { DEFAULT_WORKFLOW_COLUMN_IDS } from "./workflow-ir.js";
import { getTraitRegistry } from "./trait-registry.js";

/** The default-workflow column whose WIP limit read-through is
 *  `settings.maxConcurrent` (the legacy "N agents in-progress" gate). */
const DEFAULT_WIP_COLUMN_ID = "in-progress";

/** U6 (KTD-10): sentinel effective-workflow id for default-workflow
 *  (null-selection) tasks, so they all share one per-column capacity pool. It
 *  is not a real workflow row id (no `builtin:`/custom collision possible). */
export const DEFAULT_WORKFLOW_POOL_ID = "__default-workflow__";

/** Resolved capacity configuration for a single column. */
export interface ColumnCapacity {
  /** True when the column carries a capacity (`wip`/`countsTowardWip`) trait. */
  hasCapacity: boolean;
  /** The effective max concurrent cards. `Infinity` means "no finite limit"
   *  (a capacity trait with no resolvable limit does not gate). */
  limit: number;
  /** Whether mid-`transitionPending` cards (holding their destination slot from
   *  commit time) count toward the limit. Defaults true: a card that has
   *  committed its move into the column holds the slot even before its
   *  post-commit hooks finish (KTD-10). */
  countPending: boolean;
}

const NO_CAPACITY: ColumnCapacity = { hasCapacity: false, limit: Infinity, countPending: true };

function findColumn(ir: WorkflowIr, columnId: string): WorkflowIrColumn | undefined {
  const v2 = ir as WorkflowIrV2;
  if (!Array.isArray(v2.columns)) return undefined;
  return v2.columns.find((c) => c.id === columnId);
}

/** True when the IR's column set is exactly the default-workflow column ids. */
function isDefaultWorkflowColumns(ir: WorkflowIr): boolean {
  const v2 = ir as WorkflowIrV2;
  if (!Array.isArray(v2.columns)) return false;
  const ids = v2.columns.map((c) => c.id);
  if (ids.length !== DEFAULT_WORKFLOW_COLUMN_IDS.length) return false;
  const set = new Set(ids);
  return DEFAULT_WORKFLOW_COLUMN_IDS.every((id) => set.has(id));
}

/**
 * Resolve the capacity configuration for `columnId` under `ir`.
 *
 * Limit resolution order:
 *   1. An explicit numeric `limit` in the column's `wip` trait config wins.
 *   2. Otherwise, for the DEFAULT workflow's `in-progress` column, read through
 *      to `settings.maxConcurrent` (default 2) so the legacy knob keeps working
 *      and flag-ON default-workflow scheduling matches flag-OFF (legacy parity).
 *   3. Otherwise the column has a capacity trait but no resolvable finite limit
 *      → `Infinity` (does not gate; the trait is inert until configured).
 */
export function resolveColumnCapacity(
  ir: WorkflowIr,
  columnId: string,
  settings?: Pick<Settings, "maxConcurrent"> | undefined,
): ColumnCapacity {
  const column = findColumn(ir, columnId);
  if (!column) return NO_CAPACITY;

  const flags = getTraitRegistry().resolveColumnFlags(column);
  if (!flags.countsTowardWip) return NO_CAPACITY;

  // The capacity trait config (the `wip` trait carries `limit` + `countPending`).
  // Find the first trait config whose trait sets countsTowardWip.
  let configLimit: number | undefined;
  let countPending = true;
  for (const ct of column.traits) {
    const def = getTraitRegistry().getTrait(ct.trait);
    if (!def?.flags.countsTowardWip) continue;
    const cfg = ct.config ?? {};
    if (typeof cfg.limit === "number" && Number.isFinite(cfg.limit)) {
      configLimit = cfg.limit;
    }
    if (typeof cfg.countPending === "boolean") {
      countPending = cfg.countPending;
    }
    break;
  }

  let limit: number;
  if (configLimit !== undefined) {
    limit = configLimit;
  } else if (columnId === DEFAULT_WIP_COLUMN_ID && isDefaultWorkflowColumns(ir)) {
    // Read-through: legacy maxConcurrent maps onto the default workflow's
    // in-progress WIP limit (U6 scheduler integration).
    const maxConcurrent = settings?.maxConcurrent;
    limit = typeof maxConcurrent === "number" && Number.isFinite(maxConcurrent) ? maxConcurrent : 2;
  } else {
    limit = Infinity;
  }

  return { hasCapacity: true, limit, countPending };
}
