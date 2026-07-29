import type { MissionStore, Task, TaskStore, WorkflowIr } from "@fusion/core";
import { resolveTaskLifecycleColumns } from "@fusion/core";
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
  onGridlockCleared?: () => void;
}

export class GridlockDetector {
  private interval: ReturnType<typeof setInterval> | null = null;
  private readonly pollIntervalMs: number;
  private readonly missionStore?: MissionStore;
  private readonly onGridlock?: (event: GridlockEvent) => void;
  private readonly onGridlockCleared?: () => void;
  private lastGridlockKey: string | null = null;

  constructor(
    private readonly store: TaskStore,
    options: GridlockDetectorOptions = {},
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? 30_000;
    this.missionStore = options.missionStore;
    this.onGridlock = options.onGridlock;
    this.onGridlockCleared = options.onGridlockCleared;
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
    /*
    FNXC:UnownedHoldColumnGates 2026-07-29-13:20 (U7 / R3):
    "Schedulable" is the HOLD role, not the id `todo`. Keyed on the literal, a
    renamed workflow produced an EMPTY schedulable set, and the detector returns
    early on empty — so it reported "no gridlock" on precisely the boards where
    every card was stuck. A detector that goes quiet on the boards it cannot parse
    is worse than one that is absent, because its silence reads as health.

    One IR cache for the pass, so N cards on M workflows cost M resolutions (the
    shape `runHoldReleaseSweep` and triage discovery both use). A card whose
    workflow will not resolve is NOT schedulable — this decides whether to raise an
    alarm, and inventing candidates would raise false ones.
    */
    const irCache = new Map<string, WorkflowIr>();
    const holdByTask = new Map<string, string | undefined>();
    for (const task of tasks) {
      holdByTask.set(task.id, (await resolveTaskLifecycleColumns(this.store, task.id, irCache))?.hold);
    }
    const schedulable = tasks.filter((task) => {
      const hold = holdByTask.get(task.id);
      if (hold === undefined || task.column !== hold || task.paused) return false;
      if (task.nextRecoveryAt && new Date(task.nextRecoveryAt).getTime() > now) return false;
      if (this.isMissionBlocked(task)) return false;
      return true;
    });

    if (schedulable.length === 0) {
      this.clearGridlockState();
      return null;
    }

    /*
    FNXC:UnownedHoldColumnGates 2026-07-29-13:45 (U7 / R3):
    The ACTIVE filter is the same bug as the schedulable one above, and converting
    only the `todo` half would have left the detector just as blind: `active` is
    empty on a renamed board, and an empty active set is ALSO an early return. Two
    literals, one silence — which is why this is converted in the same change rather
    than counted as out of scope because `in-progress` is not `todo`.
    */
    const rolesByTask = new Map<string, { wip?: string; review?: string }>();
    for (const task of tasks) {
      const roles = await resolveTaskLifecycleColumns(this.store, task.id, irCache);
      rolesByTask.set(task.id, { wip: roles?.wip, review: roles?.review });
    }
    const active = tasks.filter((task) => {
      const roles = rolesByTask.get(task.id);
      if (!roles) return false;
      if (roles.wip !== undefined && task.column === roles.wip) return true;
      return roles.review !== undefined && task.column === roles.review && Boolean(task.worktree);
    });
    if (active.length === 0) {
      this.clearGridlockState();
      return null;
    }

    const overlapIgnorePaths = settings.overlapIgnorePaths ?? [];
    const filterOptions = { ignoreHiddenOverlapPaths: settings.ignoreHiddenOverlapPaths };
    const activeScopes = new Map<string, string[]>();
    if (settings.groupOverlappingFiles) {
      for (const task of active) {
        const scope = filterPathsByIgnoreList(await this.store.parseFileScopeFromPrompt(task.id), overlapIgnorePaths, filterOptions);
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

      const taskScope = filterPathsByIgnoreList(await this.store.parseFileScopeFromPrompt(task.id), overlapIgnorePaths, filterOptions);
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
      this.clearGridlockState();
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

  private clearGridlockState(): void {
    if (this.lastGridlockKey !== null) {
      this.lastGridlockKey = null;
      this.onGridlockCleared?.();
    }
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
