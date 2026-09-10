/**
 * FNXC:CodeOrganization 2026-08-10-04:05:
 * Shared sweep budgets peeled from self-healing.ts (U5 / wave19 Slice B).
 */
export const PHANTOM_EXECUTOR_BINDING_AGE_MULTIPLIER = 3;

/**
 * FNXC:PlanningEvacuation 2026-07-25-23:20:
 * Pre-execution worktree sweep waits a month of complete inactivity before reclaiming.
 */
export const PRE_EXECUTION_WORKTREE_MAX_IDLE_MS = 30 * 24 * 60 * 60 * 1000;

export const MAX_STARVATION_DROPS = 3;

/*
FNXC:Workspace 2026-08-15-05:13:
Failed workspace tasks are routinely retried with their progress preserved. Terminal teardown therefore
waits a full day, unlike short lease recovery floors, so a transient park cannot discard repo worktrees.

FNXC:CodeOrganization 2026-08-15-22:49:
Main landed this floor after the U5 peel; keep it next to MAX_STARVATION_DROPS so both
workspace-reconcile.ts and SelfHealingManager share one value.
*/
export const TERMINAL_WORKSPACE_WORKTREE_TEARDOWN_MIN_IDLE_MS = 24 * 60 * 60 * 1000;
