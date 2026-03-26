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

  /**
   * Check whether two sets of file scope paths overlap.
   * Paths overlap if they are identical, or if one is a directory prefix of the other.
   * Glob patterns (ending with /*) are treated as directory prefixes.
   */
  private pathsOverlap(a: string[], b: string[]): boolean {
    for (const pa of a) {
      const prefixA = pa.endsWith("/*") ? pa.slice(0, -1) : null;
      for (const pb of b) {
        const prefixB = pb.endsWith("/*") ? pb.slice(0, -1) : null;

        // Exact match (ignoring glob suffix)
        const cleanA = prefixA ? pa.slice(0, -2) : pa;
        const cleanB = prefixB ? pb.slice(0, -2) : pb;
        if (cleanA === cleanB) return true;

        // Check prefix overlap
        if (prefixA && pb.startsWith(prefixA)) return true;
        if (prefixB && pa.startsWith(prefixB)) return true;
        if (prefixA && prefixB) {
          if (prefixA.startsWith(prefixB) || prefixB.startsWith(prefixA)) return true;
        }

        // Exact file path match
        if (pa === pb) return true;
      }
    }
    return false;
  }

  /** Run one scheduling pass. */
  async schedule(): Promise<void> {
    if (!this.running) return;

    try {
      const tasks = await this.store.listTasks();
      const settings = await this.store.getSettings();
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

      // Pre-compute file scopes for in-progress tasks when overlap detection is enabled
      const inProgressScopes = new Map<string, string[]>();
      if (settings.groupOverlappingFiles) {
        for (const t of inProgress) {
          const scope = await this.store.parseFileScopeFromPrompt(t.id);
          if (scope.length > 0) inProgressScopes.set(t.id, scope);
        }
      }

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

        // Check file scope overlap when enabled
        if (settings.groupOverlappingFiles) {
          const taskScope = await this.store.parseFileScopeFromPrompt(task.id);
          if (taskScope.length > 0) {
            let overlappingTaskId: string | null = null;
            for (const [ipId, ipScope] of inProgressScopes) {
              if (this.pathsOverlap(taskScope, ipScope)) {
                overlappingTaskId = ipId;
                break;
              }
            }
            if (overlappingTaskId) {
              console.log(
                `[scheduler] Deferring ${task.id}: file overlap with ${overlappingTaskId}`,
              );
              continue;
            }
          }
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

        // Track newly started task's file scope for overlap with remaining todo tasks
        if (settings.groupOverlappingFiles) {
          const scope = await this.store.parseFileScopeFromPrompt(task.id);
          if (scope.length > 0) inProgressScopes.set(task.id, scope);
        }
      }
    } catch (err) {
      console.error("[scheduler] Scheduling error:", err);
    }
  }
}
