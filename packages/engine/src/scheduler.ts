import { resolveDependencyOrder, type TaskStore, type Task, type MissionStore, type FeatureStatus } from "@fusion/core";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentSemaphore } from "./concurrency.js";
import { schedulerLog } from "./logger.js";
import type { PrMonitor } from "./pr-monitor.js";
import { getCurrentGitHubRepo } from "./github.js";

/**
 * Check whether two sets of file scope paths overlap.
 * Paths overlap if they are identical, or if one is a directory prefix of the other.
 * Glob patterns (ending with `/*`) are treated as directory prefixes.
 *
 * Exported for direct unit testing; used internally by {@link Scheduler}.
 */
export function pathsOverlap(a: string[], b: string[]): boolean {
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
        if (prefixA.startsWith(prefixB) || prefixB.startsWith(prefixA))
          return true;
      }

      // Exact file path match
      if (pa === pb) return true;
    }
  }
  return false;
}

export interface SchedulerOptions {
  /** Max concurrent in-progress tasks. Default: 2 */
  maxConcurrent?: number;
  /** Max worktrees for active (in-progress) tasks. Default: 4 */
  maxWorktrees?: number;
  /** Milliseconds between scheduling polls. Default: 15000 */
  pollIntervalMs?: number;
  /**
   * Shared concurrency semaphore. When provided, the scheduler uses
   * `semaphore.availableCount` to avoid scheduling more tasks than the
   * global concurrency limit allows (accounting for triage and merge
   * agents that also hold slots).
   */
  semaphore?: AgentSemaphore;
  /** Called when scheduler starts a task */
  onSchedule?: (task: Task) => void;
  /** Called when a task is blocked by deps */
  onBlocked?: (task: Task, blockedBy: string[]) => void;
  /** Optional PR monitor for tracking in-review PRs */
  prMonitor?: PrMonitor;
  /** Optional MissionStore for slice activation and auto-advance */
  missionStore?: MissionStore;
}

/**
 * Scheduler watches the "todo" column and moves tasks to "in-progress"
 * when their dependencies are satisfied and concurrency allows.
 *
 * It respects:
 * - Dependency ordering (tasks depending on others wait)
 * - Concurrency limits (max N tasks in-progress at once)
 *
 * **Dynamic settings reload:** On every `schedule()` call the scheduler
 * reads `maxConcurrent`, `maxWorktrees`, and `pollIntervalMs` from the
 * persisted store settings (`store.getSettings()`).  This means changes
 * made via the dashboard Settings modal (`PUT /settings`) take effect on
 * the very next poll cycle without an engine restart.  The poll interval
 * itself is also refreshed: if `pollIntervalMs` differs from the active
 * timer, the `setInterval` is transparently restarted.
 */
export class Scheduler {
  private running = false;
  private scheduling = false;
  private wasWorktreeLimited = false;
  private wasGlobalPaused = false;
  private wasEnginePaused = false;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  /** The interval (ms) of the currently active `setInterval` timer. */
  private activePollMs: number | null = null;

  constructor(
    private store: TaskStore,
    private options: SchedulerOptions = {},
  ) {
    /**
     * Immediate unpause resume: when `globalPause` transitions from `true`
     * to `false`, trigger a scheduling pass right away instead of waiting
     * for the next poll interval (up to 15 s). Only reacts to true→false
     * transitions — no-ops on false→false and true→true.
     *
     * The re-entrance guard (`this.scheduling`) inside `schedule()` safely
     * drops the call if a poll-based pass is already in flight.
     */
    this.store.on("settings:updated", ({ settings, previous }) => {
      if (previous.globalPause && !settings.globalPause && this.running) {
        this.schedule();
      }
    });

    /**
     * Immediate soft-unpause resume: when `enginePaused` transitions from
     * `true` to `false`, trigger a scheduling pass right away instead of
     * waiting for the next poll interval. Same pattern as the globalPause
     * unpause handler above.
     */
    this.store.on("settings:updated", ({ settings, previous }) => {
      if (previous.enginePaused && !settings.enginePaused && this.running) {
        this.schedule();
      }
    });

    /**
     * PR Monitoring: Start monitoring when a task moves to "in-review",
     * stop monitoring when it moves out.
     * 
     * Also handles mission auto-advance: when a linked task completes,
     * update feature status and potentially activate next pending slice.
     */
    this.store.on("task:moved", ({ task, to }) => {
      // PR Monitoring
      if (this.options.prMonitor) {
        if (to === "in-review" && task.prInfo) {
          // Start monitoring existing PR
          const repo = getCurrentGitHubRepo(this.store.getRootDir());
          if (repo) {
            this.options.prMonitor.startMonitoring(task.id, repo.owner, repo.repo, task.prInfo);
          }
        } else if (task.column === "in-review" && to !== "in-review") {
          // Task moved out of in-review, stop monitoring
          this.options.prMonitor.stopMonitoring(task.id);

          // If task has a closed/merged PR, check for unaddressed feedback
          if (task.prInfo && (task.prInfo.status === "closed" || task.prInfo.status === "merged")) {
            // This would need the tracked PR data - handled by PrMonitor/PrCommentHandler
          }
        }
      }

      // Mission progress tracking: when task with sliceId moves to "in-progress" or "done"
      if (task.sliceId && this.options.missionStore) {
        if (to === "in-progress") {
          void this.handleMissionTaskStart(task.id, task.sliceId);
        } else if (to === "done") {
          void this.handleMissionTaskCompletion(task.id, task.sliceId);
        }
      }
    });

    /**
     * PR Monitoring: Start monitoring when PR is linked to an in-review task.
     */
    this.store.on("task:updated", (task) => {
      if (!this.options.prMonitor) return;
      if (task.column !== "in-review") return;
      if (!task.prInfo) return;

      // Check if we're already monitoring this task
      const tracked = this.options.prMonitor.getTrackedPrs();
      if (tracked.has(task.id)) {
        this.options.prMonitor.updatePrInfo(task.id, task.prInfo);
        return;
      }

      const repo = getCurrentGitHubRepo(this.store.getRootDir());
      if (repo) {
        this.options.prMonitor.startMonitoring(task.id, repo.owner, repo.repo, task.prInfo);
      }
    });
  }

  /**
   * Validate that a task's filesystem state is intact.
   * Checks that the task directory exists and PROMPT.md is present and non-empty.
   * 
   * @param id - The task ID to validate
   * @returns Object with `valid: true` if checks pass, or `valid: false` with a `reason` string if they fail
   */
  private async validateTaskFilesystem(id: string): Promise<{ valid: boolean; reason?: string }> {
    const taskDir = join(this.store.getRootDir(), ".fusion", "tasks", id);
    
    // Check if task directory exists
    if (!existsSync(taskDir)) {
      return { valid: false, reason: "missing directory" };
    }
    
    // Check if PROMPT.md exists and has non-empty content
    const promptPath = join(taskDir, "PROMPT.md");
    if (!existsSync(promptPath)) {
      return { valid: false, reason: "missing or empty PROMPT.md" };
    }
    
    try {
      const content = await readFile(promptPath, "utf-8");
      if (!content || content.trim().length === 0) {
        return { valid: false, reason: "missing or empty PROMPT.md" };
      }
    } catch {
      return { valid: false, reason: "missing or empty PROMPT.md" };
    }
    
    return { valid: true };
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    const interval = this.options.pollIntervalMs ?? 15_000;
    this.activePollMs = interval;
    this.pollInterval = setInterval(() => this.schedule(), interval);
    this.schedule();
    schedulerLog.log(`Started (poll interval: ${interval}ms)`);
  }

  stop(): void {
    this.running = false;
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
      this.activePollMs = null;
    }
    // Stop all PR monitoring when scheduler shuts down
    if (this.options.prMonitor) {
      this.options.prMonitor.stopAll();
    }
    schedulerLog.log("Stopped");
  }

  /**
   * If `newIntervalMs` differs from the currently active timer, restart
   * the `setInterval` so the new cadence takes effect immediately.
   */
  private refreshPollInterval(newIntervalMs?: number): void {
    if (!this.running || !newIntervalMs) return;
    if (newIntervalMs === this.activePollMs) return;

    if (this.pollInterval) {
      clearInterval(this.pollInterval);
    }
    this.activePollMs = newIntervalMs;
    this.pollInterval = setInterval(() => this.schedule(), newIntervalMs);
    schedulerLog.log(`Poll interval updated to ${newIntervalMs}ms`);
  }

  /**
   * Resolve the base branch for a task being started.
   *
   * Checks explicit dependencies and implicit `blockedBy` for an in-review
   * task with an unmerged branch. Returns the git branch name to start from,
   * or `null` if the task should start from HEAD (default).
   *
   * Priority: explicit dep in-review (first with worktree) > blockedBy in-review.
   */
  private resolveBaseBranch(task: Task, allTasks: Task[]): string | null {
    // Check explicit dependencies for in-review tasks with worktrees
    for (const depId of task.dependencies) {
      const dep = allTasks.find((t) => t.id === depId);
      if (dep && dep.column === "in-review" && dep.worktree) {
        return `kb/${dep.id.toLowerCase()}`;
      }
    }

    // Check implicit blockedBy for in-review task with worktree
    if (task.blockedBy) {
      const blocker = allTasks.find((t) => t.id === task.blockedBy);
      if (blocker && blocker.column === "in-review" && blocker.worktree) {
        return `kb/${blocker.id.toLowerCase()}`;
      }
    }

    return null;
  }

  /**
   * Delegates to the module-level {@link pathsOverlap} for testability.
   */
  private pathsOverlap(a: string[], b: string[]): boolean {
    return pathsOverlap(a, b);
  }

  /**
   * Run one scheduling pass.
   *
   * Uses a re-entrance guard (`this.scheduling`) to prevent overlapping
   * passes. Because `schedule()` is async but triggered by `setInterval`,
   * a slow pass could still be running when the next interval fires.
   * Without the guard, two passes would snapshot the same task list and
   * both could start tasks whose file scopes overlap — defeating the
   * overlap detection that relies on `inProgressScopes` being accurate.
   */
  async schedule(): Promise<void> {
    if (!this.running) return;
    if (this.scheduling) return;
    this.scheduling = true;

    try {
      const tasks = await this.store.listTasks();
      const settings = await this.store.getSettings();
      const maxConcurrent = settings.maxConcurrent ?? this.options.maxConcurrent ?? 2;
      const maxWorktrees = settings.maxWorktrees ?? this.options.maxWorktrees ?? 4;

      // Refresh the poll interval if the persisted setting has changed
      this.refreshPollInterval(settings.pollIntervalMs);

      // Global pause (hard stop): halt all scheduling activity
      if (settings.globalPause) {
        if (!this.wasGlobalPaused) {
          schedulerLog.log("Global pause active — scheduling halted");
          this.wasGlobalPaused = true;
        }
        return;
      }
      this.wasGlobalPaused = false;

      // Engine paused (soft pause): halt new work dispatch, but let agents finish
      if (settings.enginePaused) {
        if (!this.wasEnginePaused) {
          schedulerLog.log("Engine paused — scheduling halted (in-flight agents continue)");
          this.wasEnginePaused = true;
        }
        return;
      }
      this.wasEnginePaused = false;

      // Count only in-progress tasks toward the worktree limit.
      // In-review tasks with worktrees are idle (waiting to merge) and
      // should not block new tasks from starting.
      const activeWorktrees = tasks.filter(
        (t) => t.column === "in-progress",
      ).length;

      if (activeWorktrees >= maxWorktrees) {
        if (!this.wasWorktreeLimited) {
          schedulerLog.log(`Worktree limit reached (${activeWorktrees}/${maxWorktrees})`);
          this.wasWorktreeLimited = true;
        }
        return;
      }

      this.wasWorktreeLimited = false;

      const inProgress = tasks.filter((t) => t.column === "in-progress");

      // Specifying tasks (triage column, status "specifying") run full PI
      // agent sessions that consume the same resources as execution agents,
      // so they must occupy concurrency slots alongside in-progress tasks.
      // Paused specifying tasks don't count toward slots.
      const specifying = tasks.filter(
        (t) => t.column === "triage" && t.status === "specifying" && !t.paused,
      );

      // When a semaphore is provided, it is the single source of truth for
      // global concurrency — its availableCount already accounts for ALL
      // slot holders (executors, specifiers, mergers). Counting specifying
      // tasks in agentSlots as well would double-count them. Without a
      // semaphore (fallback mode), count specifying tasks directly.
      const agentSlots = this.options.semaphore
        ? inProgress.length
        : inProgress.length + specifying.length;

      // When a semaphore is provided, factor in its available slots so we
      // don't schedule more tasks than the global limit allows. Triage and
      // merge agents also hold semaphore slots, so availableCount may be
      // lower than what maxConcurrent - inProgress.length would suggest.
      const semaphoreAvailable = this.options.semaphore
        ? this.options.semaphore.availableCount
        : Infinity;

      const available = Math.min(
        maxConcurrent - agentSlots,
        maxWorktrees - activeWorktrees,
        semaphoreAvailable,
      );
      if (available <= 0) return;

      const todo = tasks.filter((t) => t.column === "todo" && !t.paused);
      if (todo.length === 0) return;

      /**
       * Pre-compute file scopes for all currently active tasks (in-progress
       * AND in-review with unmerged worktrees) so that todo tasks are never
       * started when their files overlap with work already underway or
       * awaiting merge.
       *
       * Including in-review tasks prevents a blocked task from starting on
       * main HEAD when the blocker's changes haven't been merged yet.
       *
       * The re-entrance guard on this method ensures that this snapshot
       * stays consistent throughout the pass — without it, a concurrent
       * pass could read stale state and start conflicting tasks.
       *
       * Newly started tasks are appended to this map further below so that
       * subsequent todo tasks in the same pass also see them.
       */
      const activeScopes = new Map<string, string[]>();
      if (settings.groupOverlappingFiles) {
        // In-progress tasks
        for (const t of inProgress) {
          const scope = await this.store.parseFileScopeFromPrompt(t.id);
          if (scope.length > 0) activeScopes.set(t.id, scope);
        }
        // In-review tasks with unmerged worktrees
        const inReviewWithWorktree = tasks.filter(
          (t) => t.column === "in-review" && t.worktree,
        );
        for (const t of inReviewWithWorktree) {
          const scope = await this.store.parseFileScopeFromPrompt(t.id);
          if (scope.length > 0) activeScopes.set(t.id, scope);
        }
      }

      // Resolve dependency order among todo tasks
      const ordered = resolveDependencyOrder(todo);
      let started = 0;

      for (const taskId of ordered) {
        const task = tasks.find((t) => t.id === taskId)!;

        // Check all deps are satisfied (done, in-review, or archived)
        const unmetDeps = task.dependencies.filter((depId) => {
          const dep = tasks.find((t) => t.id === depId);
          return dep && dep.column !== "done" && dep.column !== "in-review" && dep.column !== "archived";
        });

        if (unmetDeps.length > 0) {
          await this.store.updateTask(task.id, { status: "queued" });
          this.options.onBlocked?.(task, unmetDeps);
          continue;
        }

        // Validate filesystem state before starting (only for tasks with satisfied deps)
        const validation = await this.validateTaskFilesystem(task.id);
        if (!validation.valid) {
          schedulerLog.warn(`Task ${task.id} filesystem validation failed: ${validation.reason}`);
          await this.store.moveTask(task.id, "triage");
          await this.store.logEntry(task.id, "Task moved to triage — filesystem validation failed", validation.reason);
          continue;
        }

        // Check file scope overlap when enabled
        if (settings.groupOverlappingFiles) {
          const taskScope = await this.store.parseFileScopeFromPrompt(task.id);
          if (taskScope.length > 0) {
            let overlappingTaskId: string | null = null;
            for (const [ipId, ipScope] of activeScopes) {
              if (this.pathsOverlap(taskScope, ipScope)) {
                overlappingTaskId = ipId;
                break;
              }
            }
            if (overlappingTaskId) {
              await this.store.updateTask(task.id, { status: "queued", blockedBy: overlappingTaskId });
              continue;
            }
          }
        }

        // Dependencies met — check concurrency
        if (started >= available) {
          continue;
        }

        // Dependencies met — resolve base branch from in-review deps
        const baseBranch = this.resolveBaseBranch(task, tasks);

        // Clear status and move to in-progress
        schedulerLog.log(`Starting ${task.id}: ${task.title || task.id} (deps satisfied)`);
        await this.store.updateTask(task.id, { status: null, blockedBy: null, baseBranch: baseBranch ?? undefined });
        await this.store.moveTask(task.id, "in-progress");
        this.options.onSchedule?.(task);
        started++;

        // Track newly started task's file scope for overlap with remaining todo tasks
        if (settings.groupOverlappingFiles) {
          const scope = await this.store.parseFileScopeFromPrompt(task.id);
          if (scope.length > 0) activeScopes.set(task.id, scope);
        }
      }
    } catch (err) {
      schedulerLog.error("Scheduling error:", err);
    } finally {
      this.scheduling = false;
    }
  }

  /**
   * Handle mission task start.
   * When a task with a sliceId moves to "in-progress", update the linked
   * feature status to "in-progress" to reflect active work.
   */
  private async handleMissionTaskStart(taskId: string, sliceId: string): Promise<void> {
    if (!this.options.missionStore) return;

    const missionStore = this.options.missionStore;

    try {
      // Find the feature linked to this task
      const feature = missionStore.getFeatureByTaskId(taskId);
      if (!feature) {
        schedulerLog.log(`Task ${taskId} has sliceId ${sliceId} but no linked feature found`);
        return;
      }

      // Only update if feature is still in "triaged" status
      if (feature.status === "triaged") {
        await missionStore.updateFeatureStatus(feature.id, "in-progress");
        schedulerLog.log(`Feature ${feature.id} marked in-progress (task ${taskId} started)`);
      }
    } catch (err) {
      schedulerLog.error(`Error handling mission task start for ${taskId}:`, err);
    }
  }

  /**
   * Handle mission task completion.
   * When a task with a sliceId moves to "done", update the linked feature
   * status and check if the slice is complete. If autoAdvance is enabled
   * on the mission, activate the next pending slice.
   */
  private async handleMissionTaskCompletion(taskId: string, sliceId: string): Promise<void> {
    if (!this.options.missionStore) return;

    const missionStore = this.options.missionStore;

    try {
      // Find the feature linked to this task
      const feature = missionStore.getFeatureByTaskId(taskId);
      if (!feature) {
        schedulerLog.log(`Task ${taskId} has sliceId ${sliceId} but no linked feature found`);
        return;
      }

      // Update feature status to done
      await missionStore.updateFeatureStatus(feature.id, "done");
      schedulerLog.log(`Feature ${feature.id} marked done (task ${taskId} completed)`);

      // Get the slice to check its status
      const slice = missionStore.getSlice(sliceId);
      if (!slice) {
        schedulerLog.warn(`Slice ${sliceId} not found for task ${taskId}`);
        return;
      }

      // Get the milestone to find the mission
      const milestone = missionStore.getMilestone(slice.milestoneId);
      if (!milestone) {
        schedulerLog.warn(`Milestone ${slice.milestoneId} not found for slice ${sliceId}`);
        return;
      }

      // Recompute and check if slice is now complete
      const newSliceStatus = missionStore.computeSliceStatus(sliceId);
      if (newSliceStatus === "complete") {
        schedulerLog.log(`Slice ${sliceId} completed (all features done)`);

        // Check if mission has autoAdvance enabled
        const mission = missionStore.getMission(milestone.missionId);
        if (mission?.autoAdvance) {
          // Activate next pending slice
          const nextSlice = await this.activateNextPendingSlice(mission.id);
          if (nextSlice) {
            schedulerLog.log(`Auto-advanced: activated slice ${nextSlice.id} for mission ${mission.id}`);
          }
        }
      }
    } catch (err) {
      schedulerLog.error(`Error handling mission task completion for ${taskId}:`, err);
    }
  }

  /**
   * Activate the next pending slice in a mission.
   * Finds the first milestone with pending slices and activates
   * the first pending slice in that milestone.
   *
   * @param missionId - Mission ID
   * @returns The activated slice, or null if no pending slices
   */
  async activateNextPendingSlice(missionId: string): Promise<import("@fusion/core").Slice | null> {
    if (!this.options.missionStore) return null;

    const missionStore = this.options.missionStore;

    try {
      const nextSlice = missionStore.findNextPendingSlice(missionId);
      if (!nextSlice) {
        schedulerLog.log(`Mission ${missionId}: no pending slices to activate`);
        return null;
      }

      const activated = missionStore.activateSlice(nextSlice.id);
      schedulerLog.log(`Activated slice ${activated.id} for mission ${missionId}`);
      return activated;
    } catch (err) {
      schedulerLog.error(`Error activating next slice for mission ${missionId}:`, err);
      return null;
    }
  }
}
