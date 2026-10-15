/**
 * FNXC:CodeOrganization 2026-08-03-20:15:
 * listWorktreeHolders peeled from TaskExecutor (U4).
 *
 * FNXC:Workspace 2026-06-21-12:00: KTD2 — flat-map each task's Set into one holder row per worktree path.
 * A workspace task emits N rows; self-healing reaper keys off taskId and is idempotent across duplicate-task rows.
 */
export function listWorktreeHolders(
  activeWorktrees: Map<string, Set<string>>,
): Array<{ taskId: string; worktreePath: string }> {
  const holders: Array<{ taskId: string; worktreePath: string }> = [];
  for (const [taskId, worktreePaths] of activeWorktrees) {
    for (const worktreePath of worktreePaths) {
      holders.push({ taskId, worktreePath });
    }
  }
  return holders;
}

/*
FNXC:WorktreeLiveness 2026-10-08-04:04 (RUFU-323):
The runtime's `inFlightTasks` metric must report bindings whose task is LIVE, not raw map size.
`activeWorktrees` is released at roughly twenty in-process run-exit points plus the run's own
`finally`, so any terminal park that skips its release leaves a durable binding attached to a card
whose board row already reads `failed` — and raw size counts that card as in flight forever. Measured
incidents: FN-8925 ("stuck in failed but holds activeWorktrees", the origin of the leaked-slot
reaper), FN-7802/RUFU-219 (`missing usable worktree` retry chains), FN-9253 (interrupted step session
repaired in place, which deliberately keeps the binding for the next dispatch).

The predicate is injected rather than derived here so this stays a pure helper over the map: callers
pass the canonical liveness triple (`isTaskActive` || `hasLiveTaskSessionSurface` ||
`resumingUnpaused`, `is-task-live-for-overseer-retry.ts`) — the same expression self-healing's
leaked-slot reaper classifies with — so the metric and the reaper cannot drift.

Counts DISTINCT taskIds, never paths: a workspace task bound to N sub-repos is ONE in-flight task.
 */
export function countLiveWorktreeHolders(
  activeWorktrees: Map<string, Set<string>>,
  isTaskLive: (taskId: string) => boolean,
): number {
  return listLiveWorktreeHolders(activeWorktrees, isTaskLive).length;
}

/*
FNXC:IsolationTransitionBlockers 2026-10-15-03:15 (RUFU-328):
The id-level twin of the count, so "how many" and "which ones" cannot drift: the count IS this list's
length. The isolation-transition veto needs the ids — a refusal that names nothing is an operator
being told "2 tasks are running" with nothing to look at — and RUFU-323 left the veto reading the raw
ownership map, which is the same third path to the same state its own FNXC comment warns about.

Same holder rule as the count: a task with an empty checkout Set holds nothing, and a workspace card
bound to N sub-repos appears once.
 */
export function listLiveWorktreeHolders(
  activeWorktrees: Map<string, Set<string>>,
  isTaskLive: (taskId: string) => boolean,
): string[] {
  const liveIds: string[] = [];
  for (const [taskId, worktreePaths] of activeWorktrees) {
    // An empty Set holds no checkout, so it is not a holder at all — mirrors `listWorktreeHolders`.
    if (worktreePaths.size > 0 && isTaskLive(taskId)) liveIds.push(taskId);
  }
  return liveIds;
}

/*
FNXC:IsolationTransitionBlockers 2026-10-15-03:15 (RUFU-328):
Every held id, liveness aside — the input the durable blocker decision enumerates. Deliberately wider
than the LIVE list: the veto asks "what would a transition destroy", and a card the in-memory triple
calls not-live while its durable row still says `executing` is exactly the stale-negative that must not
be waved through. Liveness stays relevant to that decision only as drift evidence
(`classifyIsolationBlockers`), so the enumeration must not pre-filter by it.
 */
export function listWorktreeHolderIds(activeWorktrees: Map<string, Set<string>>): string[] {
  const holderIds: string[] = [];
  for (const [taskId, worktreePaths] of activeWorktrees) {
    if (worktreePaths.size > 0) holderIds.push(taskId);
  }
  return holderIds;
}
