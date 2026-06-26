/**
 * Task ID allocator responsibility area.
 *
 * FNXC:TaskStoreDecompose 2026-06-24-00:00:
 * Responsibility boundary for task-ID allocation and reconciliation.
 * The allocator logic currently lives in distributed-task-id.ts
 * (createDistributedTaskIdAllocator, reconcileTaskIdState) and is invoked by
 * the TaskStore facade on open and during create. This module documents the
 * boundary; U12 will migrate the allocator's DB call sites to async Drizzle.
 *
 * Behavioral invariants preserved (see docs/storage.md):
 *   - On store open, each prefix sequence is bumped to
 *     max(current, max(task suffix)+1, max(archived suffix)+1, max(reservation)+1).
 *   - Soft-deleted/archived IDs stay reserved (never reassigned).
 */
export {
  createDistributedTaskIdAllocator,
  reconcileTaskIdState,
  resolveLocalNodeId,
  type DistributedTaskIdAllocator,
} from "../distributed-task-id.js";

export {
  detectTaskIdIntegrityAnomalies,
  type TaskIdIntegrityReport,
} from "../task-id-integrity.js";
