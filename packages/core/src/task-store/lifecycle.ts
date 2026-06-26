/**
 * Task lifecycle / moves responsibility area.
 *
 * FNXC:TaskStoreDecompose 2026-06-24-00:00:
 * Responsibility boundary for task lifecycle transitions (moveTask,
 * moveTaskInternal, workflow-transition reconciliation, column-capacity
 * enforcement). The logic currently lives in the TaskStore class body.
 * This module documents the boundary; U13 will migrate these call sites to
 * async Drizzle, preserving the transactional invariants.
 *
 * Related modules consumed by this area:
 *   - workflow-reconciliation, workflow-transitions, workflow-capacity
 *   - transition-types, transition-pending
 *   - default-workflow-hooks
 */

