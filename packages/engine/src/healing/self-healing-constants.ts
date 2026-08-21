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
/*
 * FNXC:ChatInFlightRecovery 2026-08-20-20:17 (RUFU-144):
 * Staleness floor for dashboard chat in_flight_generation flags. A generation cannot
 * outlive the dashboard process that started it and no owner/PID is recorded, so the
 * flag's startedAt (fallback: session updated_at) older than this floor is provably
 * dead. The floor is far longer than any single LLM turn (a live generation is never
 * cleared) and far shorter than how long a human notices a zombie "generating" box
 * (recovery stays timely). Dashboard restarts are the known stranding source.
 */
export const CHAT_IN_FLIGHT_GENERATION_STALE_MS = 30 * 60_000;
