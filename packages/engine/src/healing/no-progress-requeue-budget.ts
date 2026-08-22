/**
 * FNXC:SelfHealing 2026-08-21-15:44:
 * Issue #3496 showed that no-progress task failures can be environmental and
 * repeat indefinitely. All recovery owners share this sentinel so an exhausted
 * park cannot be reopened by a differently scoped recovery path.
 */
export const NO_PROGRESS_REQUEUE_BUDGET_EXHAUSTED_PREFIX = "NO_PROGRESS_REQUEUE_BUDGET_EXHAUSTED:";
