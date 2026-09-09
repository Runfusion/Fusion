/**
 * Board column, priority, and thinking-level domain types for the Fusion core contract.
 *
 * FNXC:CodeOrganization 2026-07-15-00:00:
 * Extracted from types.ts barrel so domain types are navigable while types.ts remains the
 * browser-safe @fusion/core Vite alias re-export surface.
 */

/**
 * Valid thinking effort levels for AI agent sessions, controlling the cost/quality tradeoff of reasoning.
 * The ordered tuple is the single persisted/runtime vocabulary; model-specific capability maps decide which entries a selector offers.
 *
 * FNXC:Settings-ThinkingLevel 2026-08-18-23:38:
 * The central vocabulary includes both opt-in extended levels, `xhigh` and `max`. Pi documents that providers may support either level, both, or neither through a model-level thinkingLevelMap, so validation must accept both without guessing from provider or model names while model-bound controls filter to advertised support.
 */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/**
 * The legacy default-workflow column set. Workflow-aware task movement resolves
 * valid columns from each task's workflow definition (the default workflow's
 * column IDs are byte-identical to these — KTD-1). New code should prefer the
 * workflow-resolved path (`resolveAllowedColumns` / `workflowHasColumn` in
 * `workflow-transitions.ts`) and trait predicates over string equality; this
 * exported tuple is the visible built-in board and therefore excludes the historical sentinel.
 *
 * FNXC:TaskArchiveRemoval 2026-09-04-10:36:
 * `getLiveTaskColumn` deliberately manufactures `"archived"` for soft-deleted parents. The literal
 * remains type-readable for those internal snapshots without restoring it to the board column list.
 */
export const COLUMNS = ["triage", "todo", "in-progress", "in-review", "done"] as const;
/**
 * The built-in workflow columns plus the read-only historical soft-delete sentinel. Movement entry
 * points accept the wider {@link ColumnId}; runtime code validates ids against the task's workflow.
 */
export type Column = (typeof COLUMNS)[number] | "archived";

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

/*
FNXC:WorkflowColumns 2026-07-29-00:00 (U12 — R8):
`normalizeColumn` is DELETED. It carried one of the two `@deprecated (workflowColumns,
U12)` markers this unit was named for.

It coerced an arbitrary value to a LEGACY column, rewriting every workflow-defined
custom id to `triage` — silent data loss for any project whose workflow declares a
column outside the six built-ins. `normalizeColumnId` (retained, just below) is the
non-lossy replacement: it sanitises structurally (non-string/empty -> fallback) and
passes real ids through untouched.

Deleted rather than left deprecated because it had ZERO callers — the dashboard's
ingest path and move handler both migrated to `normalizeColumnId` when the lossy
behaviour was diagnosed (see `useTasks.ts` and `routes-trait-rekey.test.ts`, which pin
that migration). Leaving an exported lossy coercion next to its safe twin is an
invitation to pick the wrong one; `__tests__/no-lossy-column-coercion-export.test.ts`
now ratchets that shut, by behaviour rather than by name.
*/


/*
FNXC:WorkflowColumns 2026-07-19-2b:00 (U12 / R2 / R11):
The workflow-aware column sanitiser — the one client code should use when
sanitizing a column id off the wire.

The deleted `normalizeColumn` answered "is this one of the SIX legacy ids", so it silently rewrote every
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
