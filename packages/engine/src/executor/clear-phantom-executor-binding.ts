/**
 * FNXC:CodeOrganization 2026-08-03-09:20:
 * clearPhantomExecutorBinding peeled from TaskExecutor (U4).
 *
 * FNXC:ExecutorBinding 2026-06-19-00:00:
 * FN-6736 gives self-healing a narrow escape hatch for phantom in-memory executor bindings after the liveness gate proves the owner is dead. Never use this as a general task stopper: it refuses to detach observable live session surfaces, then clears only stale bookkeeping (`executing`, resume/recovery sets, process-wide graph routing, activeWorktrees, activeSessionRegistry paths, and executingTaskLock) so the scheduler can re-dispatch the preserved worktree.
 *
 * FNXC:ExecutorBinding 2026-06-30-00:00:
 * `preserveWorktrees: true` is the FN-6736 self-healing path. When the caller has already committed to `moveTask(..., { preserveWorktree: true })`, unregistering the held worktree path from `activeSessionRegistry` defeats the preserve: re-dispatch then sees the path as free and re-acquires a brand-new worktree (observed on FN-7249: gentle-peach orphaned, rosy-thorn rebuilt ~20s after reclaim). The preserve variant clears only the in-memory executor/lock bookkeeping and leaves the session-registry path entry intact so the re-dispatch reattaches to the same worktree. Non-self-healing callers (leaked-slot reaper, pause-abort recovery) keep the default full-clear behavior.
 *
 * FNXC:NodeWorktreeIsolation 2026-07-29-02:10 (FN-6756 — planner worktrees reaped from under live planners):
 * THE REGISTRY IS PART OF THE LIVENESS SIGNAL, not just something this method
 * tears down.
 *
 * This is documented as "the last line of defense against pulling a worktree out
 * from under a running agent" (see `reapLeakedConcurrencySlots`). It was blind to
 * an entire class of agent. The four sets below are all TaskExecutor-owned; a
 * triage PLANNING session is owned by `TriageProcessor` and lives in ITS OWN
 * `activeSessions` map, so a live planner matched none of them.
 *
 * The consequence was not theoretical — it is FN-8600 recurring through a second
 * door. Under plan-in-place a card is specified while it sits in `todo`/`triage`,
 * both of which `reapLeakedConcurrencySlots` treats as reapable, and planning
 * routinely outlives that sweep's 60s grace. Every earlier gate passes for a
 * planner (not in the executor's `executing` set, reapable column, past grace), so
 * this method decided alone — and returned true, releasing the slot and then
 * UNREGISTERING the planner's own registry paths below. It destroyed the very
 * evidence that proves the planner alive.
 *
 * FN-8600 fixed the self-owned-branch reclaim sweep by registering planning paths
 * here (`triage.ts` acquireActiveSessionPath, and see the "planning" kind note in
 * active-session-registry.ts). That fix landed at ONE surface. This is the second,
 * which is what the AGENTS.md Surface Enumeration rule exists to prevent.
 *
 * Deliberately keyed on ANY registered path for the task, not on kind: the point
 * is that a registered session surface of any kind means someone is working in
 * that worktree. A leaked entry now blocks THIS sweep rather than a live planner
 * losing its worktree — the strictly safer failure, and the one the "last line of
 * defense" wording already promises. The registry is process-local and in-memory,
 * so a leak cannot outlive the process; stale entries have their own reconciler
 * (`reconcileStaleSelfOwned`) and the reclaim-aware `acquireActiveSessionPath`.
 *
 * NOT fixed by raising the grace period: a longer timeout only makes this rarer
 * and harder to reproduce. The liveness gate is the bug.
 *
 * FNXC:Workspace 2026-06-21-12:00: KTD2 — collect every worktree path the task holds (a workspace task holds N) before clearing the binding, so the registry sweep below unregisters all of them, not just one.
 */
import { executorLog } from "../logger.js";
import { activeSessionRegistry, executingTaskLock } from "../agents/active-session-registry.js";

export type ClearPhantomExecutorBindingDeps = {
  hasLiveSessionSurface: (taskId: string) => boolean;
  getActiveWorktreePaths: (taskId: string) => string[];
  activeWorktrees: Map<string, Set<string>>;
  executing: Set<string>;
  recoveringCompleted: Set<string>;
  resumingUnpaused: Set<string>;
  approvalSuspended: Set<string>;
  approvalResumeAfterUnwind: Set<string>;
  processWideGraphRouting: Set<string>;
  effectiveColumnAgentByTask: Map<string, string>;
};

export function clearPhantomExecutorBinding(
  deps: ClearPhantomExecutorBindingDeps,
  taskId: string,
  options: { preserveWorktrees?: boolean } = {},
): boolean {
  if (deps.hasLiveSessionSurface(taskId)) {
    executorLog.warn(`${taskId}: refusing to clear phantom executor binding because a live session surface is still registered`);
    return false;
  }

  const heldWorktreePaths = deps.getActiveWorktreePaths(taskId);
  deps.activeWorktrees.delete(taskId);
  deps.executing.delete(taskId);
  deps.recoveringCompleted.delete(taskId);
  deps.resumingUnpaused.delete(taskId);
  deps.approvalSuspended.delete(taskId);
  deps.approvalResumeAfterUnwind.delete(taskId);
  deps.processWideGraphRouting.delete(taskId);
  executingTaskLock.release(taskId);
  deps.effectiveColumnAgentByTask.delete(taskId);

  if (options.preserveWorktrees) {
    executorLog.warn(`${taskId}: cleared phantom executor binding for self-healing re-dispatch (worktree session-registry entries preserved)`);
    return true;
  }

  const registeredPaths = new Set(activeSessionRegistry.pathsForTask(taskId));
  for (const path of heldWorktreePaths) {
    registeredPaths.add(path);
  }
  for (const path of registeredPaths) {
    activeSessionRegistry.unregisterPath(path);
  }

  executorLog.warn(`${taskId}: cleared phantom executor binding for self-healing re-dispatch`);
  return true;
}
