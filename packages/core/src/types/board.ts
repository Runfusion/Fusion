/**
 * Board column, priority, and thinking-level domain types for the Fusion core contract.
 *
 * FNXC:CodeOrganization 2026-07-15-00:00:
 * Extracted from types.ts barrel so domain types are navigable while types.ts remains the
 * browser-safe @fusion/core Vite alias re-export surface.
 */

/**
 * Valid thinking effort levels for AI agent sessions, controlling the cost/quality tradeoff of reasoning.
 * Includes extra-high for maximum-effort requests on reasoning-capable models.
 *
 * FNXC:Settings-ThinkingLevel 2026-06-19-14:55:
 * The central thinking-level enum must expose `xhigh` so UI settings and API validation can pass maximum reasoning requests through to CLI adapters. Runtime adapters map `xhigh` to `high` for non-Opus models and `max` for Opus models.
 */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/**
 * The legacy default-workflow column set. Workflow-aware task movement resolves
 * valid columns from each task's workflow definition (the default workflow's
 * column IDs are byte-identical to these — KTD-1). New code should prefer the
 * workflow-resolved path (`resolveAllowedColumns` / `workflowHasColumn` in
 * `workflow-transitions.ts`) and trait predicates over string equality; this
 * enum remains the canonical id set for the built-in default workflow.
 */
export const COLUMNS = ["triage", "todo", "in-progress", "in-review", "done", "archived"] as const;
/**
 * The closed legacy column union — still the correct type for default-workflow
 * column ids. Movement entry points accept the wider {@link ColumnId}; runtime
 * code validates ids against the task's resolved workflow.
 */
export type Column = (typeof COLUMNS)[number];

/**
 * Column identifier accepted at task-movement entry points (KTD-1).
 * Equals the legacy `Column` union for autocomplete purposes, but admits
 * workflow-defined custom column ids; runtime paths validate the id against the
 * task's resolved workflow.
 */
export type ColumnId = Column | (string & {});

export const DEFAULT_COLUMN: Column = "triage";

/**
 * Tests membership against the closed legacy column enum. Note: under the
 * workflowColumns flag, column validity is workflow-scoped — flag-aware code
 * should use `workflowHasColumn(ir, columnId)` (`workflow-transitions.ts`);
 * this remains correct for the flag-OFF path and default-workflow ids.
 */
export function isColumn(value: unknown): value is Column {
  return typeof value === "string" && (COLUMNS as readonly string[]).includes(value);
}

/**
 * @deprecated (workflowColumns, U12) Coerces an arbitrary value to a legacy
 * column, DISCARDING workflow-defined custom column ids — lossy under the
 * flag. Resolve and validate against the task's workflow instead. Retained
 * for the legacy flag-OFF path while the flag exists.
 */
export function normalizeColumn(value: unknown, fallback: Column = DEFAULT_COLUMN): Column {
  return isColumn(value) ? value : fallback;
}

/*
FNXC:WorkflowColumns 2026-07-19-2b:00 (U12 / R2 / R11):
The workflow-aware counterpart to `normalizeColumn`, and the one client code should use when
sanitizing a column id off the wire.

`normalizeColumn` answers "is this one of the SIX legacy ids", so it silently rewrites every
workflow-defined id to `triage`. That is correct only for the closed default-workflow set; applied
to a real board it teleports cards. A custom `merging` column's cards rendered in Triage because
the dashboard ran every task through the legacy coercion on ingest.

The right invariant at a deserialization boundary is narrower: reject only what is structurally
unusable (non-string / empty), and pass every real id through untouched. Membership is not this
function's business — the task's resolved workflow decides that, via `workflowHasColumn`.
*/
export function normalizeColumnId(value: unknown, fallback: ColumnId = DEFAULT_COLUMN): ColumnId {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

/** Ordered task-priority levels for the core task domain contract. */
export const TASK_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

/**
 * Default task priority used for legacy rows/entries and create flows when
 * callers omit the priority field.
 */
export const DEFAULT_TASK_PRIORITY: TaskPriority = "normal";
