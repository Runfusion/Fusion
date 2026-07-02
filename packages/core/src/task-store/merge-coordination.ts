/**
 * Merge coordination responsibility area.
 *
 * FNXC:TaskStoreDecompose 2026-06-24-00:00:
 * Responsibility boundary for merge-queue and merge coordination. The logic
 * currently lives in the TaskStore class body (handoffToReview, merge-queue
 * lease acquire/release, merge execution). This module documents the boundary;
 * U13 will migrate these call sites to async Drizzle.
 *
 * Transactional invariant (VAL-DATA-013): the column move, mergeQueue insert,
 * and handoff audit fan-out run in one transaction; observers never see
 * column = "in-review" without the matching queue row.
 *
 * Merge-queue lease semantics (VAL-DATA-014): leases are acquired
 * priority-first, FIFO within priority; expired leases recover without
 * incrementing attempts.
 */
export type {
  MergeQueueEnqueueOptions,
  MergeQueueAcquireOptions,
  MergeQueueReleaseOutcome,
  HandoffToReviewOptions,
} from "../types.js";

export type { MergeQueueRow, MergeRequestRow } from "./row-types.js";
