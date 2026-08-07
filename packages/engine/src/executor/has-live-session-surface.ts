/**
 * FNXC:CodeOrganization 2026-08-03-20:15:
 * hasLiveSessionSurface peeled from TaskExecutor (U4).
 *
 * FNXC:NodeWorktreeIsolation 2026-07-29-06:05 (FN-6756 — one liveness predicate, PR #2531 review):
 * READ-ONLY liveness probe, extracted so callers can ASK before they mutate.
 *
 * `clearPhantomExecutorBinding` both answers "is this live?" and performs a
 * destructive release, which forced every caller into a false choice: check first
 * and release ownership before their own fallible writes (a torn write — ownership
 * gone, task un-repaired, nobody owning the repair), or write first and discover the
 * refusal too late. Splitting the question from the act lets a caller gate on
 * liveness with no side effect and release only after its writes have committed.
 *
 * Deliberately the SAME expression the destructive path uses, not a copy: a probe
 * that could disagree with the guard it stands in for is worse than no probe, and
 * independent re-derivation of "liveness" at each call site is precisely how this
 * bug reached users three times (reclaim sweep -> leaked-slot reaper -> pause-abort).
 *
 * Registry paths count. A triage PLANNING session is owned by TriageProcessor and
 * appears in NONE of the four executor-owned maps; it registers here instead.
 */
import { hasLiveTaskSessionSurface, type HasLiveTaskSessionSurfaceDeps } from "./has-live-task-session-surface.js";

export type HasLiveSessionSurfaceDeps = HasLiveTaskSessionSurfaceDeps & {
  pathsForTask: (taskId: string) => readonly string[];
};

export function hasLiveSessionSurface(
  deps: HasLiveSessionSurfaceDeps,
  taskId: string,
): boolean {
  return hasLiveTaskSessionSurface(deps, taskId)
    || deps.pathsForTask(taskId).length > 0;
}
