import type { MissionStore, Task, TaskStore } from "@fusion/core";
import { createLogger } from "./logger.js";
import { filterPathsByIgnoreList, pathsOverlap } from "./scheduler.js";

const gridlockLog = createLogger("gridlock-detector");

export interface GridlockEvent {
  blockedTaskCount: number;
  reasons: Record<string, "dependency" | "overlap">;
  blockedTaskIds: string[];
  blockingTaskIds: string[];
}

export interface GridlockDetectorOptions {
  pollIntervalMs?: number;
  missionStore?: MissionStore;
  onGridlock?: (event: GridlockEvent) => void;
}

export class GridlockDetector {
  private interval: ReturnType<typeof setInterval> | null = null;
  private readonly pollIntervalMs: number;
  private readonly missionStore?: MissionStore;
  private readonly onGridlock?: (event: GridlockEvent) => void;
  private lastGridlockKey: string | null = null;

  constructor(
    private readonly store: TaskStore,
    options: GridlockDetectorOptions = {},
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? 30_000;
    this.missionStore = options.missionStore;
    this.onGridlock = options.onGridlock;
  }

  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => {
      this.detectGridlock().catch((error) => {
        gridlockLog.error("Failed gridlock detection cycle:", error);
      });
    }, this.pollIntervalMs);
    gridlockLog.log(`Started (poll interval: ${this.pollIntervalMs}ms)`);
  }

  stop(): void {
    if (!this.interval) return;
    clearInterval(this.interval);
    this.interval = null;
    gridlockLog.log("Stopped");
  }

  async detectGridlock(): Promise<GridlockEvent | null> {
    const [tasks, settings] = await Promise.all([
      this.store.listTasks({ slim: true, includeArchived: false }),
      this.store.getSettings(),
    ]);

    const now = Date.now();
    const schedulable = tasks.filter((task) => {
      if (task.column !== "todo" || task.paused) return false;
      if (task.nextRecoveryAt && new Date(task.nextRecoveryAt).getTime() > now) return false;
      if (this.isMissionBlocked(task)) return false;
      return true;
    });

    if (schedulable.length === 0) {
      this.lastGridlockKey = null;
      return null;
    }

    const active = tasks.filter((task) => task.column === "in-progress" || (task.column === "in-review" && Boolean(task.worktree)));
    if (active.length === 0) {
      this.lastGridlockKey = null;
      return null;
    }

    const overlapIgnorePaths = settings.overlapIgnorePaths ?? [];
    const activeScopes = new Map<string, string[]>();
    if (settings.groupOverlappingFiles) {
      for (const task of active) {
        const scope = filterPathsByIgnoreList(await this.store.parseFileScopeFromPrompt(task.id), overlapIgnorePaths);
        if (scope.length > 0) {
          activeScopes.set(task.id, scope);
        }
      }
    }

    const reasons: Record<string, "dependency" | "overlap"> = {};
    const blockingTaskIds = new Set<string>();

    for (const task of schedulable) {
      const unmetDeps = task.dependencies.filter((depId) => {
        const dep = tasks.find((candidate) => candidate.id === depId);
        return dep && dep.column !== "done" && dep.column !== "in-review" && dep.column !== "archived";
      });

      if (unmetDeps.length > 0) {
        reasons[task.id] = "dependency";
        for (const depId of unmetDeps) blockingTaskIds.add(depId);
        continue;
      }

      if (!settings.groupOverlappingFiles) continue;

      const taskScope = filterPathsByIgnoreList(await this.store.parseFileScopeFromPrompt(task.id), overlapIgnorePaths);
      if (taskScope.length === 0) continue;

      for (const [activeId, activeScope] of activeScopes) {
        if (pathsOverlap(taskScope, activeScope)) {
          reasons[task.id] = "overlap";
          blockingTaskIds.add(activeId);
          break;
        }
      }
    }

    const blockedTaskIds = Object.keys(reasons).sort();
    if (blockedTaskIds.length !== schedulable.length) {
      this.lastGridlockKey = null;
      return null;
    }

    const gridlockKey = blockedTaskIds.join(",");
    const event: GridlockEvent = {
      blockedTaskCount: blockedTaskIds.length,
      reasons,
      blockedTaskIds,
      blockingTaskIds: Array.from(blockingTaskIds).sort(),
    };

    if (this.lastGridlockKey !== gridlockKey) {
      this.lastGridlockKey = gridlockKey;
      gridlockLog.warn(`Gridlock detected: blocked=${event.blockedTaskIds.join(",")}; blocking=${event.blockingTaskIds.join(",")}`);
      this.onGridlock?.(event);
    }

    return event;
  }

  private isMissionBlocked(task: Task): boolean {
    if (!this.missionStore || !task.sliceId) return false;
    try {
      const slice = this.missionStore.getSlice(task.sliceId);
      if (!slice) return false;
      const milestone = this.missionStore.getMilestone(slice.milestoneId);
      if (!milestone) return false;
      const mission = this.missionStore.getMission(milestone.missionId);
      return mission?.status === "blocked";
    } catch (error) {
      gridlockLog.warn(`Mission lookup failed for ${task.id}:`, error);
      return false;
    }
  }
}
