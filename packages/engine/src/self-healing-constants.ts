/**
 * FNXC:CodeOrganization 2026-07-15-16:00:
 * Self-healing public timing/budget constants peeled from self-healing.ts.
 * Re-exported from self-healing.ts for stable import paths.
 */

export const COMPLETED_BLOCKED_PAUSE_REASON = "completed-work-blocked";
export const STALE_TEMP_MERGE_WORKTREE_MS = 2 * 60 * 60 * 1000;
export const DONE_TASK_TEMP_WORKTREE_GRACE_MS = 10 * 60 * 1000;
export const MIN_TEMP_WORKTREE_REAP_AGE_MS = DONE_TASK_TEMP_WORKTREE_GRACE_MS;
export const STALE_ACTIVE_BRANCH_EXECUTION_GRACE_MS = 10 * 60_000;
export const COMPLETION_HANDOFF_LIMBO_GRACE_MS = 5 * 60_000;
export const MAX_COMPLETION_HANDOFF_LIMBO_RECOVERIES = 3;
export const MAX_POST_DONE_NONCONTINUABLE_WEDGE_RECOVERIES = 3;
export const VALIDATOR_RUN_STALE_MAX_AGE_MS = 6 * 60 * 60 * 1000;
export const MAX_WORKTREE_SESSION_RETRIES = 3;
export const PAUSE_ABORT_PARK_ERROR_MARKER = "Workflow graph failure surfaced after paused";
export const PAUSE_ABORT_PARK_OPERATOR_MARKER = "operator action required";
export const MAX_AUTO_MERGE_RETRIES = 3;
/*
 * FNXC:MergeReliability 2026-07-15-18:50:
 * FN-8004 raised this bounded transient-only recovery budget from 2 to 5:
 * extra retries can recover completed reviewed work after provider or network
 * blips, while exhaustion remains visible and requires manual review.
 */
export const MAX_TRANSIENT_MERGE_RECOVERIES = 5;
