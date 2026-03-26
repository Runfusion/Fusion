import { resolveDependencyOrder, type TaskStore, type Task } from "@hai/core";

export interface SchedulerOptions {
  /** Max concurrent in-progress tasks. Default: 2 */
  maxConcurrent?: number;
  /** Max total worktrees (in-progress + in-review with worktree). Default: 4 */
  maxWorktrees?: number;
  /** Milliseconds between scheduling polls. Default: 15000 */
  pollIntervalMs?: number;
  /** Called when scheduler starts a task */
  onSchedule?: (task: Task) => void;
  /** Called when a task is blocked by deps */
  onBlocked?: (task: Task, blockedBy: string[]) => void;
}

/**
 * Scheduler watches the "todo" column and moves tasks to "in-progress"
 * when their dependencies are satisfied and concurrency allows.
 *
 * It respects:
 * - Dependency ordering (tasks depending on others wait)
 * - Concurrency limits (max N tasks in-progress at once)
 */
export class Scheduler {
  private running = false;
  private pollInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    private store: TaskStore,
    private options: SchedulerOptions = {},
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;

    const interval = this.options.pollIntervalMs ?? 15_000;
    this.pollInterval = setInterval(() => this.schedule(), interval);
    this.schedule();
    console.log(
      `[scheduler] Started (max concurrent: ${this.options.maxConcurrent ?? 2}, max worktrees: ${this.options.maxWorktrees ?? 4})`,
    );
  }

  stop(): void {
    this.running = false;
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    console.log("[scheduler] Stopped");
  }

  /** Run one scheduling pass. */
  async schedule(): Promise<void> {
    if (!this.running) return;

    try {
      const tasks = await this.store.listTasks();
      const maxConcurrent = this.options.maxConcurrent ?? 2;
      const maxWorktrees = this.options.maxWorktrees ?? 4;

      // Count all tasks with active worktrees (in-progress or in-review with worktree set)
      const activeWorktrees = tasks.filter(
        (t) =>
          t.column === "in-progress" ||
          (t.column === "in-review" && t.worktree),
      ).length;

      if (activeWorktrees >= maxWorktrees) {
        console.log(
          `[scheduler] Worktree limit reached (${activeWorktrees}/${maxWorktrees})`,
        );
        return;
      }

      const inProgress = tasks.filter((t) => t.column === "in-progress");
      const available = Math.min(
        maxConcurrent - inProgress.length,
        maxWorktrees - activeWorktrees,
      );
      if (available <= 0) return;

      const todo = tasks.filter((t) => t.column === "todo");
      if (todo.length === 0) return;

      // Resolve dependency order among todo tasks
      const ordered = resolveDependencyOrder(todo);
      let started = 0;

      for (const taskId of ordered) {
        const task = tasks.find((t) => t.id === taskId)!;

        // Check all deps are satisfied (done or in-review)
        const unmetDeps = task.dependencies.filter((depId) => {
          const dep = tasks.find((t) => t.id === depId);
          return dep && dep.column !== "done" && dep.column !== "in-review";
        });

        if (unmetDeps.length > 0) {
          await this.store.updateTask(task.id, { status: "queued" });
          this.options.onBlocked?.(task, unmetDeps);
          continue;
        }

        // Dependencies met — check concurrency
        if (started >= available) {
          continue;
        }

        // Dependencies met — clear status and move to in-progress
        console.log(
          `[scheduler] Starting ${task.id}: ${task.title || task.id} (deps satisfied)`,
        );
        await this.store.updateTask(task.id, { status: null });
        await this.store.moveTask(task.id, "in-progress");
        this.options.onSchedule?.(task);
        started++;
      }
    } catch (err) {
      console.error("[scheduler] Scheduling error:", err);
    }
  }
}
