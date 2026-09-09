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

import {
  DEFAULT_PROJECT_SETTINGS,
  RETIRED_BUILTIN_WORKFLOW_SUCCESSORS,
  type Settings,
} from "../types.js";
import type { WorkflowIr, WorkflowIrV2, WorkflowIrColumn } from "./workflow-ir-types.js";
import { DEFAULT_WORKFLOW_COLUMN_IDS } from "./workflow-ir.js";
import { getTraitRegistry } from "./trait-registry.js";

/** The default-workflow column whose WIP limit read-through is
 *  `settings.maxConcurrent` (the legacy "N agents in-progress" gate). */
const DEFAULT_WIP_COLUMN_ID = "in-progress";

/** Shipped worktree default; kept as an export for capacity consumers and tests. */
export const DEFAULT_MAX_WORKTREES = DEFAULT_PROJECT_SETTINGS.maxWorktrees;

/** Shipped agent-concurrency default. */
export const DEFAULT_MAX_CONCURRENT = DEFAULT_PROJECT_SETTINGS.maxConcurrent;

/** Settings-like input accepted by every live, fast, and fallback capacity reader. */
export type ConcurrencySettingsInput = Partial<Pick<Settings, "maxConcurrent" | "maxWorktrees" | "worktreeLimitEnabled">> | Record<string, unknown> | null | undefined;

/*
FNXC:CapacityModel 2026-07-28-11:20:
THE one place "are worktrees a capacity dimension for this project?" is answered.

The capacity model is two configurable numbers per project:
  1. total agents  (`maxConcurrent`)  — always binds
  2. `maxWorktrees`                   — binds ONLY when worktrees are enabled

When `worktreeLimitEnabled === false` the operator asked for "limit via total agents
only". This returns `null` for that case, and callers construct NO worktree gate
at all — rather than a gate with a very high or infinite limit. That distinction
is the whole point: a limiter that still exists and merely happens not to bind is
the bug class this program keeps excavating (the pool-id sentinel that never
matched a real pool; the approval gate three surfaces re-derived; the always-true
flag whose "disabled" branch was the live one). An absent gate cannot silently
start binding again; a gate holding `Infinity` can, the moment someone "fixes" a
comparison. `ConcurrencyGateDiagnostic.maxWorktreesGate` is therefore OPTIONAL,
so consulting a worktree limit in OFF mode does not type-check.

Deliberately NOT expressed as `maxWorktrees === 0`. Zero is a legible number that
already means something to the gate (`used >= 0` is true on an empty board, so a
0 limit deadlocks dispatch rather than disabling it) and the Command Center
slider clamps it to a 1..50 range. Overloading a value as a mode is how sentinels
become defects; the boolean says what it means.

── AUDITED: the one other consumer of `maxWorktrees`, which does NOT come through here ──

`SelfHealingManager.enforceWorktreeCap()` (packages/engine/src/self-healing.ts) reads
`settings.maxWorktrees` RAW and caps on-disk worktree directories at `2 x` it. Measured: that
is the only remaining raw read that bounds anything; every admission decision resolves through
this function, whose single call site is `scheduler.ts`.

It is deliberately left alone, because it is not the same kind of number. This function answers
"is a worktree a CAPACITY dimension" — an admission question. `enforceWorktreeCap` answers "how
many worktree directories may sit on disk" — a hygiene question, and it only ever removes IDLE
ones. Worktrees still exist on disk in OFF mode (everything runs in a worktree, planning
included), so that bound must keep applying or idle directories accumulate without limit.

Consequence, recorded rather than fixed: with `worktreeLimitEnabled === false` the number still
governs disk retention, so a very small `maxWorktrees` reaps idle worktrees eagerly even though
it gates no admission. The operator scoped this out explicitly ("don't worry about worktrees off
or worktree capacity 0 — that's unimportant"). Do NOT "unify" the two readers on that basis:
routing hygiene through `resolveWorktreeCapacityLimit` would return `null` in OFF mode and
silently remove the disk bound altogether, which is a leak, not a simplification.

`worktree-capacity-limit.test.ts` enforces this as a ratchet: every file bounding on
`maxWorktrees` must be named with a reason, so a future raw admission bound fails instead of
quietly re-limiting a project that turned worktrees off.
*/
export function resolveWorktreeCapacityLimit(settings: ConcurrencySettingsInput): number | null {
  if (settings?.worktreeLimitEnabled === false) return null;
  const limit = settings?.maxWorktrees;
  return typeof limit === "number" && Number.isFinite(limit) && limit > 0
    ? limit
    : DEFAULT_MAX_WORKTREES;
}

/*
FNXC:CapacityModel 2026-08-21-15:25:
FN-9185 consolidates the operator-reported max-concurrent mismatch into one resolver.
The live project settings blob is authoritative; registry snapshots and boot options are
fallback-only inputs, so every surface falls back to shipped defaults rather than private literals.
*/
export function resolveMaxConcurrentSetting(settings: ConcurrencySettingsInput): number {
  const value = settings?.maxConcurrent;
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_MAX_CONCURRENT;
}

export interface EffectiveConcurrency {
  maxConcurrent: number;
  worktreeLimit: number | null;
}

/*
FNXC:CapacityModel 2026-09-01-14:49:
The two concurrency knobs are orthogonal. `maxConcurrent` bounds provider/LLM load across every
AI-active task, including planning, while `maxWorktrees` bounds host build, memory, and disk load
across execution checkouts only. Reintroducing one `Math.min(maxConcurrent, maxWorktrees)` ceiling
would recreate FN-282: a small worktree cap would throttle checkout-free planning.
*/
/** Resolves the independent agent and worktree capacity dimensions. */
export function resolveEffectiveConcurrency(settings: ConcurrencySettingsInput): EffectiveConcurrency {
  return {
    maxConcurrent: resolveMaxConcurrentSetting(settings),
    worktreeLimit: resolveWorktreeCapacityLimit(settings),
  };
}

/** U6 (KTD-10): sentinel effective-workflow id for default-workflow
 *  (null-selection) tasks, so they all share one per-column capacity pool. It
 *  is not a real workflow row id (no `builtin:`/custom collision possible). */
export const DEFAULT_WORKFLOW_POOL_ID = "__default-workflow__";

/*
FNXC:WorkflowCapacity 2026-07-28-19:05 (pool-id sentinel fix):
THE one place the "no selection → which pool?" convention is expressed.

It exists because the convention was previously restated at each end of the
comparison, and the two restatements disagreed: the COUNTER bucketed
selection-less rows under `DEFAULT_WORKFLOW_POOL_ID` while `moves.ts` asked the
counter for pool `"builtin:coding"`. Nothing ever landed in the pool being asked
about, so the count came back 0 and a finite limit could never bind — the
in-transaction capacity gate was structurally dead for every default-workflow
task (Phase A3, R1).

A shared constant alone would NOT have prevented that: both sides had the
constant available and one of them still wrote a literal. Both sides now call
THIS function, so "what pool does a selection-less task belong to" has exactly
one answer and no call site is in a position to disagree with it.

NOT to be confused with `DEFAULT_WORKFLOW_ID` ("builtin:coding"). That is a real,
resolvable workflow row id and is the correct fallback when the value is used to
RESOLVE AN IR (as `scheduler.ts` does). This is a bucketing key that deliberately
cannot collide with any workflow id. Using either one in the other's role is the
bug this function exists to make unspellable.

FNXC:WorkflowSuccession 2026-09-06-02:54:
Capacity is keyed by durable workflow identity, so historical selections must join their named successor's pool. Canonicalizing in this shared resolver keeps move candidates, synchronous counters, asynchronous transaction counters, and scheduler snapshots from treating one workflow as two independent capacity budgets.
*/
export function resolveCapacityPoolId(selectionWorkflowId: string | null | undefined): string {
  const poolId = selectionWorkflowId ?? DEFAULT_WORKFLOW_POOL_ID;
  return RETIRED_BUILTIN_WORKFLOW_SUCCESSORS.get(poolId) ?? poolId;
}

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
 *   2. A `limitSetting: "maxConcurrent"` declaration reads through to the
 *      project setting, making the built-in workflow's capacity policy explicit.
 *   3. Otherwise, for the DEFAULT workflow's `in-progress` column, read through
 *      to `settings.maxConcurrent` (default 2) so the legacy knob keeps working
 *      and flag-ON default-workflow scheduling matches flag-OFF (legacy parity).
 *   4. Otherwise the column has a capacity trait but no resolvable finite limit
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
  let limitSetting: string | undefined;
  let countPending = true;
  for (const ct of column.traits) {
    const def = getTraitRegistry().getTrait(ct.trait);
    if (!def?.flags.countsTowardWip) continue;
    const cfg = ct.config ?? {};
    if (typeof cfg.limit === "number" && Number.isFinite(cfg.limit)) {
      configLimit = cfg.limit;
    }
    if (typeof cfg.limitSetting === "string") {
      limitSetting = cfg.limitSetting;
    }
    if (typeof cfg.countPending === "boolean") {
      countPending = cfg.countPending;
    }
    break;
  }

  let limit: number;
  if (configLimit !== undefined) {
    limit = configLimit;
  } else if (limitSetting === "maxConcurrent") {
    limit = resolveMaxConcurrentSetting(settings);
  } else if (columnId === DEFAULT_WIP_COLUMN_ID && isDefaultWorkflowColumns(ir)) {
    // Read-through: legacy maxConcurrent maps onto the default workflow's
    // in-progress WIP limit (U6 scheduler integration).
    limit = resolveMaxConcurrentSetting(settings);
  } else {
    limit = Infinity;
  }

  return { hasCapacity: true, limit, countPending };
}

/*
FNXC:WorkflowCapacity 2026-07-19-02:20 (U4/KTD-9):
Multiple `wip` columns SHARE one budget when they resolve their limit the same
way — via a shared `limitSetting` (e.g. maxConcurrent) or the default-workflow
in-progress read-through. The scheduler's single counter must count occupants
across ALL columns sharing the target's budget, so operator-visible concurrency
does not silently multiply when a workflow has two wip columns. A column with an
explicit numeric `limit` is INDEPENDENT — its budget is itself alone. This pure
helper resolves that column set; both enforcement points (the in-txn check in
moves.ts and the hold/release sweep) sum their live counts across it, keeping one
budget authority (KTD-5).
*/

/** The budget "key" a wip column resolves its limit through. Two columns share a
 *  budget iff their keys are equal. `undefined` = not a capacity column. */
function resolveColumnBudgetKey(ir: WorkflowIr, columnId: string): string | undefined {
  const column = findColumn(ir, columnId);
  if (!column) return undefined;
  const flags = getTraitRegistry().resolveColumnFlags(column);
  if (!flags.countsTowardWip) return undefined;
  for (const ct of column.traits) {
    const def = getTraitRegistry().getTrait(ct.trait);
    if (!def?.flags.countsTowardWip) continue;
    const cfg = ct.config ?? {};
    // An explicit numeric limit is an independent per-column budget.
    if (typeof cfg.limit === "number" && Number.isFinite(cfg.limit)) return `col:${columnId}`;
    // A shared setting (maxConcurrent, …) pools every column that names it.
    if (typeof cfg.limitSetting === "string") return `setting:${cfg.limitSetting}`;
    break;
  }
  // Default-workflow in-progress read-through pools with the maxConcurrent setting.
  if (columnId === DEFAULT_WIP_COLUMN_ID && isDefaultWorkflowColumns(ir)) return "setting:maxConcurrent";
  // Capacity trait but no resolvable shared source → independent (self only).
  return `col:${columnId}`;
}

/**
 * Resolve the set of column ids whose live WIP occupancy shares ONE budget with
 * `targetColumn` (KTD-9). Returns `[targetColumn]` for an explicit-`limit` or
 * otherwise-independent column, every column sharing a `limitSetting`/default
 * read-through for a pooled budget, and `[]` when the target is not a capacity
 * column. Deterministic (declared column order).
 */
export function resolveWipBudgetColumns(ir: WorkflowIr, targetColumn: string): string[] {
  const targetKey = resolveColumnBudgetKey(ir, targetColumn);
  if (!targetKey) return [];
  // A truthy targetKey proves findColumn located targetColumn, which proves
  // `columns` is an array — and the loop necessarily re-collects targetColumn
  // itself, so the set is never empty. No defensive fallbacks needed.
  const set: string[] = [];
  for (const c of (ir as WorkflowIrV2).columns) {
    if (resolveColumnBudgetKey(ir, c.id) === targetKey) set.push(c.id);
  }
  return set;
}
