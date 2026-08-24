export const PLANNING_RESET_HOLD_MS = 30_000;

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
