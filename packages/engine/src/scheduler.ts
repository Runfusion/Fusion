import { getCurrentRepo, resolveDependencyOrder, type TaskStore, type Task, type MissionStore, type PrInfo } from "@fusion/core";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentSemaphore } from "./concurrency.js";
import { generateReservedWorktreeName, slugify } from "./worktree-names.js";
import { schedulerLog } from "./logger.js";
import { type PrMonitor, type PrComment } from "./pr-monitor.js";

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
  /** Called when a mission-linked task fails and is queued for retry handling. */
  onTaskFailed?: (taskId: string) => void | Promise<void>;
  /** Optional PR monitor for tracking in-review PRs */
  prMonitor?: PrMonitor;
  /** Optional MissionStore for slice activation and auto-advance */
  missionStore?: MissionStore;
  /** Optional MissionAutopilot for autonomous mission progression */
  missionAutopilot?: import("./mission-autopilot.js").MissionAutopilot;
  /**
   * Called when a task with a closed/merged PR moves out of in-review
   * and the PrMonitor has buffered actionable comments.
   * The callback receives the task ID, PR info, and the drained comments.
   * If no comments were buffered, this callback is NOT invoked.
   */
  onClosedPrFeedback?: (
    taskId: string,
    prInfo: PrInfo,
    comments: PrComment[]
  ) => void | Promise<void>;
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
  /** Tracks which task IDs are currently paused, to detect unpause transitions. */
  private pausedTaskIds = new Set<string>();
  /** Tracks mission-linked tasks observed with status=failed before moveTask clears status/error. */
  private failedTaskIds = new Set<string>();

  /**
   * Async listener guard convention:
   * - Any async mission helper invoked from event listeners is wrapped in internal try/catch
   *   (`handleMissionTaskStart` / `handleMissionTaskCompletion`).
   * - Fire-and-forget Promise chains in listeners terminate with `.catch(...)`.
   * Keep this invariant when adding new async EventEmitter callbacks.
   */
  constructor(
    private store: TaskStore,
    private options: SchedulerOptions = {},
  ) {
    /**
     * Event-driven scheduling: when a task is created, trigger a scheduling
     * pass immediately instead of waiting for the next poll interval.
     * This reduces latency from up to 15 seconds to near-instant.
     */
    this.store.on("task:created", () => {
      schedulerLog.log("Task created — triggering scheduling");
      this.schedule();
    });

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
    this.store.on("task:moved", ({ task, from, to }) => {
      // PR Monitoring
      if (this.options.prMonitor) {
        if (to === "in-review" && task.prInfo) {
          // Start monitoring existing PR
          const repo = getCurrentRepo(this.store.getRootDir());
          if (repo) {
            this.options.prMonitor.startMonitoring(task.id, repo.owner, repo.repo, task.prInfo);
          }
        } else if (from === "in-review" && to !== "in-review") {
          // If task has a closed/merged PR, drain buffered comments before
          // stopping monitoring (drainComments needs the tracked PR to still exist)
          if (task.prInfo && (task.prInfo.status === "closed" || task.prInfo.status === "merged")) {
            const comments = this.options.prMonitor.drainComments(task.id);
            if (comments.length > 0 && this.options.onClosedPrFeedback) {
              void Promise.resolve(this.options.onClosedPrFeedback(task.id, task.prInfo, comments))
                .then(() => {
                  schedulerLog.log(`Invoked onClosedPrFeedback for ${task.id} with ${comments.length} comment(s)`);
                })
                .catch((err) => {
                  schedulerLog.error(`Error in onClosedPrFeedback for ${task.id}:`, err);
                });
            }
          }

          // Task moved out of in-review, stop monitoring
          this.options.prMonitor.stopMonitoring(task.id);
        }
      }

      // Mission progress tracking: when task with sliceId moves to in-progress
      if (task.sliceId && this.options.missionStore && to === "in-progress") {
        void this.handleMissionTaskStart(task.id, task.sliceId);
      }

      // Mission progress tracking: when task with sliceId moves to done
      if (task.sliceId && this.options.missionStore && to === "done") {
        void this.handleMissionTaskCompletion(task.id, task.sliceId);
      }

      // Mission failure tracking: status/error are cleared during moveTask(in-progress → todo),
      // so we pair this with failedTaskIds captured from task:updated events.
      if (task.sliceId && to === "todo" && this.options.onTaskFailed) {
        if (task.status === "failed" || this.failedTaskIds.has(task.id)) {
          this.failedTaskIds.delete(task.id);
          void Promise.resolve(this.options.onTaskFailed(task.id)).catch((err) => {
            schedulerLog.error(`Error in onTaskFailed for ${task.id}:`, err);
          });
        }
      }

      // Event-driven scheduling: when a task moves to "done" (completion) or "todo" (retry/manual move),
      // trigger scheduling immediately so waiting tasks can start without waiting
      // for the next poll interval (up to 15 seconds).
      if (to === "done" || to === "todo") {
        schedulerLog.log(`Task moved to ${to} — triggering scheduling`);
        this.schedule();
      }
    });

    /**
     * PR Monitoring: Start monitoring when PR is linked to an in-review task.
     * Also detects task-level unpause transitions and triggers immediate scheduling.
     */
    this.store.on("task:updated", (task) => {
      // Track mission failure signals before moveTask clears failure metadata.
      if (task.sliceId && task.column === "in-progress" && task.status === "failed") {
        this.failedTaskIds.add(task.id);
      } else if (task.status !== "failed") {
        this.failedTaskIds.delete(task.id);
      }

      // Track pause state transitions for event-driven scheduling on unpause.
      // When a previously-paused task is unpaused in a schedulable column,
      // trigger a scheduling pass immediately instead of waiting for the next
      // poll interval (up to 15 seconds).
      if (task.paused) {
        this.pausedTaskIds.add(task.id);
      } else if (this.pausedTaskIds.has(task.id)) {
        // Task was paused, now unpaused — trigger scheduling
        this.pausedTaskIds.delete(task.id);
        if (this.running && (task.column === "todo" || task.column === "triage")) {
          schedulerLog.log(`Task ${task.id} unpaused — triggering scheduling`);
          this.schedule();
        }
      }

      if (!this.options.prMonitor) return;
      if (task.column !== "in-review") return;
      if (!task.prInfo) return;

      // Check if we're already monitoring this task
      const tracked = this.options.prMonitor.getTrackedPrs();
      if (tracked.has(task.id)) {
        this.options.prMonitor.updatePrInfo(task.id, task.prInfo);
        return;
      }

      const repo = getCurrentRepo(this.store.getRootDir());
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
    const taskDir = join(this.store.getTasksDir(), id);
    
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

    // Wire up MissionAutopilot: set scheduler reference for lazy injection
    // and start watching all missions with autopilotEnabled: true
    if (this.options.missionAutopilot && this.options.missionStore) {
      this.options.missionAutopilot.setScheduler(this);
      const missions = this.options.missionStore.listMissions();
      for (const mission of missions) {
        if (mission.autopilotEnabled && mission.status !== "complete" && mission.status !== "archived") {
          this.options.missionAutopilot.watchMission(mission.id);
        }
      }
      this.options.missionAutopilot.start();
    }
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
    // Stop MissionAutopilot when scheduler shuts down
    if (this.options.missionAutopilot) {
      this.options.missionAutopilot.stop();
    }
    this.failedTaskIds.clear();
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

  getMissionAutopilot(): import("./mission-autopilot.js").MissionAutopilot | undefined {
    return this.options.missionAutopilot;
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
        return dep.branch || `fusion/${dep.id.toLowerCase()}`;
      }
    }

    // Check implicit blockedBy for in-review task with worktree
    if (task.blockedBy) {
      const blocker = allTasks.find((t) => t.id === task.blockedBy);
      if (blocker && blocker.column === "in-review" && blocker.worktree) {
        return blocker.branch || `fusion/${blocker.id.toLowerCase()}`;
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
   * Reserve the worktree path a task will use before it enters in-progress.
   * This prevents tasks from appearing active without an assigned worktree.
   */
  private planWorktreePath(
    task: Task,
    naming: string | undefined,
    reservedNames: Set<string>,
  ): string {
    if (task.worktree) {
      const existingName = task.worktree.split("/").pop();
      if (existingName) reservedNames.add(existingName);
      return task.worktree;
    }

    let worktreeName: string;
    switch (naming || "random") {
      case "task-id":
        worktreeName = task.id.toLowerCase();
        break;
      case "task-title":
        worktreeName = slugify(task.title || task.description.slice(0, 60));
        break;
      case "random":
      default:
        worktreeName = generateReservedWorktreeName(this.store.getRootDir(), reservedNames);
        break;
    }

    reservedNames.add(worktreeName);
    return join(this.store.getRootDir(), ".worktrees", worktreeName);
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
          schedulerLog.warn("⚠ Global pause active — scheduling halted. To resume: set globalPause to false in settings.");
          this.wasGlobalPaused = true;
        }
        return;
      }
      if (this.wasGlobalPaused) {
        schedulerLog.log("Global pause cleared — scheduling resumed");
      }
      this.wasGlobalPaused = false;

      // Engine paused (soft pause): halt new work dispatch, but let agents finish
      if (settings.enginePaused) {
        if (!this.wasEnginePaused) {
          schedulerLog.warn("⚠ Engine paused — scheduling halted (in-flight agents continue). To resume: set enginePaused to false.");
          this.wasEnginePaused = true;
        }
        return;
      }
      if (this.wasEnginePaused) {
        schedulerLog.log("Engine pause cleared — scheduling resumed");
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

      const now = Date.now();
      let todo = tasks.filter((t) => {
        if (t.column !== "todo" || t.paused) return false;
        // Skip tasks with a recovery backoff that hasn't elapsed yet
        if (t.nextRecoveryAt && new Date(t.nextRecoveryAt).getTime() > now) return false;
        return true;
      });

      // Filter out tasks belonging to blocked missions
      if (todo.length > 0 && this.options.missionStore) {
        const blockedSliceIds = new Set<string>();
        for (const t of todo) {
          if (t.sliceId && !blockedSliceIds.has(t.sliceId)) {
            try {
              const slice = this.options.missionStore.getSlice(t.sliceId);
              if (slice) {
                const milestone = this.options.missionStore.getMilestone(slice.milestoneId);
                if (milestone) {
                  const mission = this.options.missionStore.getMission(milestone.missionId);
                  if (mission && mission.status === "blocked") {
                    blockedSliceIds.add(t.sliceId);
                  }
                }
              }
            } catch {
              // If lookup fails, don't block the task
            }
          }
        }
        if (blockedSliceIds.size > 0) {
          todo = todo.filter((t) => !t.sliceId || !blockedSliceIds.has(t.sliceId));
        }
      }

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
      const reservedWorktreeNames = new Set(
        tasks
          .map((task) => task.worktree?.split("/").pop())
          .filter((name): name is string => Boolean(name)),
      );

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
        const plannedWorktree = this.planWorktreePath(
          task,
          settings.worktreeNaming,
          reservedWorktreeNames,
        );

        // Clear status, reserve worktree path, and then move to in-progress
        schedulerLog.log(`Starting ${task.id}: ${task.title || task.id} (deps satisfied)`);
        await this.store.updateTask(task.id, {
          status: null,
          blockedBy: null,
          baseBranch: baseBranch ?? undefined,
          worktree: plannedWorktree,
        });
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

      if (feature.sliceId !== sliceId) {
        schedulerLog.warn(
          `Task ${taskId} sliceId ${sliceId} does not match linked feature ${feature.id} sliceId ${feature.sliceId}; skipping mission start update`,
        );
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
   * When a task moves to "done", update the linked feature status to "done".
   * updateFeatureStatus cascades via recomputeSliceStatus — if all features
   * in the slice are done the slice status becomes "complete" automatically.
   *
   * If MissionAutopilot is configured, delegate slice advancement to it
   * (which tracks autopilot state and handles retries). Otherwise fall back
   * to the legacy onSliceComplete() path for non-autopilot missions.
   */
  private async handleMissionTaskCompletion(taskId: string, sliceId: string): Promise<void> {
    if (!this.options.missionStore) return;

    const missionStore = this.options.missionStore;

    try {
      const feature = missionStore.getFeatureByTaskId(taskId);
      if (!feature) return;

      if (feature.sliceId !== sliceId) {
        schedulerLog.warn(
          `Task ${taskId} sliceId ${sliceId} does not match linked feature ${feature.id} sliceId ${feature.sliceId}; skipping mission completion update`,
        );
        return;
      }

      const sliceIdBeforeUpdate = feature.sliceId;

      if (feature.status !== "done") {
        missionStore.updateFeatureStatus(feature.id, "done");
        schedulerLog.log(`Feature ${feature.id} marked done (task ${taskId} completed)`);
      }

      // Check if the slice became complete after the feature update
      const slice = missionStore.getSlice(sliceIdBeforeUpdate);
      if (slice && slice.status === "complete") {
        // If MissionAutopilot is available AND actively watching this mission,
        // delegate progression to it. The autopilot handles: watching missions,
        // autoAdvance guard, retry logic, and state tracking. The autopilot
        // will call back into scheduler.activateNextPendingSlice() when appropriate.
        //
        // If autopilot is not watching this mission (e.g., legacy missions with
        // autoAdvance=true but no autopilot instance, or autopilot unwatched),
        // fall back to onSliceComplete() which uses the compatibility rule.
        const autopilot = this.options.missionAutopilot;
        const milestone = missionStore.getMilestone(slice.milestoneId);
        const missionId = milestone?.missionId;
        const isWatching = autopilot && missionId ? autopilot.isWatching(missionId) : false;

        if (autopilot && isWatching) {
          schedulerLog.log(`Slice ${slice.id} is complete — delegating to autopilot`);
          await autopilot.handleTaskCompletion(taskId);
        } else {
          // Fallback path: onSliceComplete uses autopilotEnabled/autoAdvance compat
          schedulerLog.log(`Slice ${slice.id} is complete — triggering auto-advance`);
          await this.onSliceComplete(slice);
        }
      }
    } catch (err) {
      schedulerLog.error(`Error handling mission task completion for ${taskId}:`, err);
    }
  }

  async onSliceComplete(slice: import("@fusion/core").Slice): Promise<void> {
    if (!this.options.missionStore) return;

    const missionStore = this.options.missionStore;

    try {
      const milestone = missionStore.getMilestone(slice.milestoneId);
      if (!milestone) {
        schedulerLog.warn(`Milestone ${slice.milestoneId} not found for slice ${slice.id}`);
        return;
      }

      const mission = missionStore.getMission(milestone.missionId);
      // Use autopilotEnabled as canonical, fall back to autoAdvance for backward compat
      const shouldAutoAdvance =
        mission?.autopilotEnabled === true || mission?.autoAdvance === true;
      if (!mission || mission.status !== "active" || !shouldAutoAdvance) {
        return;
      }

      const missionHierarchy = missionStore.getMissionWithHierarchy(mission.id);
      const hasActiveSlice = missionHierarchy?.milestones.some((candidateMilestone) =>
        candidateMilestone.slices.some((candidateSlice) =>
          candidateSlice.id !== slice.id && candidateSlice.status === "active"
        )
      );
      if (hasActiveSlice) {
        schedulerLog.log(`Mission ${mission.id} already has an active slice; skipping auto-advance`);
        return;
      }

      const nextSlice = await this.activateNextPendingSlice(mission.id);
      if (nextSlice) {
        schedulerLog.log(`Auto-advanced: activated slice ${nextSlice.id} for mission ${mission.id}`);
      }
    } catch (err) {
      schedulerLog.error(`Error handling slice completion for ${slice.id}:`, err);
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
      const mission = missionStore.getMissionWithHierarchy(missionId);
      if (!mission || mission.status !== "active") {
        schedulerLog.log(`Mission ${missionId}: not active, skipping slice activation`);
        return null;
      }

      const sortedMilestones = [...mission.milestones].sort((a, b) => a.orderIndex - b.orderIndex);

      for (const milestone of sortedMilestones) {
        const dependenciesMet = milestone.dependencies.every((dependencyId) => {
          const dependency = mission.milestones.find((candidate) => candidate.id === dependencyId);
          return dependency?.status === "complete";
        });
        if (!dependenciesMet) {
          continue;
        }

        const pendingSlice = [...milestone.slices]
          .sort((a, b) => a.orderIndex - b.orderIndex)
          .find((slice) => slice.status === "pending");
        if (!pendingSlice) {
          continue;
        }

        const activated = await missionStore.activateSlice(pendingSlice.id);
        schedulerLog.log(`Activated slice ${activated.id} for mission ${missionId}`);
        return activated;
      }

      schedulerLog.log(`Mission ${missionId}: no pending slices to activate`);
      return null;
    } catch (err) {
      schedulerLog.error(`Error activating next slice for mission ${missionId}:`, err);
      return null;
    }
  }

  /**
   * Reconcile feature status for all active missions on startup.
   *
   * This ensures that feature statuses are in sync with their linked task
   * columns for all missions, not just autopilot-enabled ones. The
   * reconciliation logic mirrors MissionAutopilot.reconcileMissionConsistency()
   * but runs unconditionally on startup.
   *
   * @returns The total number of fixes applied across all missions
   */
  async reconcileAllMissionFeatures(): Promise<number> {
    if (!this.options.missionStore) {
      return 0;
    }

    const missionStore = this.options.missionStore;
    let totalFixed = 0;

    try {
      const missions = missionStore.listMissions();
      const activeMissions = missions.filter((m) => m.status === "active");

      for (const mission of activeMissions) {
        const hierarchy = missionStore.getMissionWithHierarchy(mission.id);
        if (!hierarchy) continue;

        const activeSlices = hierarchy.milestones
          .flatMap((milestone) => milestone.slices)
          .filter((slice) => slice.status === "active");

        for (const slice of activeSlices) {
          for (const feature of slice.features) {
            if (!feature.taskId) continue;

            const task = await this.store.getTask(feature.taskId);
            if (!task) continue;

            // Task done but feature not done -> update feature to done
            if (task.column === "done" && feature.status !== "done") {
              missionStore.updateFeatureStatus(feature.id, "done");
              totalFixed++;
              continue;
            }

            // Task in-progress and feature triaged/defined -> update to in-progress
            if (
              task.column === "in-progress"
              && (feature.status === "triaged" || feature.status === "defined")
            ) {
              missionStore.updateFeatureStatus(feature.id, "in-progress");
              totalFixed++;
              continue;
            }

            // Task in triage/todo and feature in-progress -> update to triaged
            if (
              (task.column === "triage" || task.column === "todo")
              && feature.status === "in-progress"
            ) {
              missionStore.updateFeatureStatus(feature.id, "triaged");
              totalFixed++;
            }
          }
        }
      }

      if (totalFixed > 0) {
        schedulerLog.log(`Mission feature reconciliation: fixed ${totalFixed} inconsistencies`);
      }
    } catch (err) {
      schedulerLog.error("Error during mission feature reconciliation:", err);
    }

    return totalFixed;
  }
}
