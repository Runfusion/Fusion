import type { Task } from "@fusion/core";

export const PLANNING_RESET_HOLD_MS = 30_000;

/*
FNXC:TaskReset 2026-08-28-20:50:
The 30-second planning reset hold is cleared by the reset publication event. Graph replans still identify themselves with `needs-replan`, while operator Reset now publishes a fresh null-status, empty-plan shape; keying only on the old literal would make every reset wait out the conservative TTL. The execution-pointer checks keep ordinary task updates from impersonating a reset, and `clearHold` is a no-op when no hold exists, so widening this predicate cannot suppress a legitimate hold.
*/
export function isPlanningResetHoldClearingUpdate(task: Task): boolean {
  if (task.status === "needs-replan") return true;
  return task.status == null
    && task.steps.length === 0
    && task.worktree == null
    && task.branch == null
    && task.sessionFile == null
    && (task.workflowStepResults?.length ?? 0) === 0
    && task.error == null;
}

/**
 * FNXC:TaskReset 2026-08-22-04:32:
 * A reset invalidates planner attempts by generation so an aborted session cannot recreate a worktree or prompt after reset publication.
 */
export class PlanningResetFence {
  private readonly generations = new Map<string, number>();
  private readonly holds = new Map<string, number>();
  constructor(private readonly now: () => number = Date.now) {}
  currentGeneration(taskId: string): number { return this.generations.get(taskId) ?? 0; }
  cancelPlanning(taskId: string): number {
    const generation = this.currentGeneration(taskId) + 1;
    this.generations.set(taskId, generation);
    this.holds.set(taskId, this.now() + PLANNING_RESET_HOLD_MS);
    return generation;
  }
  isStale(taskId: string, capturedGeneration: number): boolean { return this.currentGeneration(taskId) !== capturedGeneration; }
  isResetHoldActive(taskId: string, now = this.now()): boolean {
    const expiresAt = this.holds.get(taskId);
    if (!expiresAt) return false;
    if (expiresAt <= now) { this.holds.delete(taskId); return false; }
    return true;
  }
  clearHold(taskId: string): void { this.holds.delete(taskId); }
}
