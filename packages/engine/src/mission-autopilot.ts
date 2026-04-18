/**
 * MissionAutopilot — Background monitoring for autonomous mission progression.
 *
 * Watches missions with `autopilotEnabled: true` and automatically:
 * - Activates slices when previous ones complete
 * - Tracks overall mission health and state
 * - Detects and recovers from failures
 *
 * **Integration pattern:** The Scheduler handles low-level task scheduling
 * and calls `missionAutopilot.handleTaskCompletion()` after updating feature
 * status. MissionAutopilot does NOT register its own event listeners.
 *
 * **State machine:**
 * - `inactive` → `watching`: User enables autopilot
 * - `watching` → `activating`: Task completes, autopilot progresses
 * - `activating` → `watching`: Slice activated successfully
 * - `watching/activating` → `inactive`: User disables or engine stops
 * - `activating` → `completing`: All slices done, mission wrapping up
 * - `completing` → `inactive`: Mission complete
 */

import type {
  TaskStore,
  MissionStore,
  AutopilotState,
  AutopilotStatus,
  MissionWithHierarchy,
  Slice,
  SliceWithFeatures,
  MissionEventType,
} from "@fusion/core";
import { autopilotLog } from "./logger.js";
import { reconcileMissionFeatureState } from "./mission-feature-sync.js";

/** Maximum retry attempts for slice activation failures. */
const MAX_RETRY_ATTEMPTS = 3;

/** Base delay for exponential backoff between retries (ms). */
const RETRY_BASE_DELAY_MS = 1000;

/** Background poll interval for checking mission health (ms). */
const POLL_INTERVAL_MS = 60_000;

/** Default time after which a mission activation is considered stale (10 minutes). */
const DEFAULT_STALE_THRESHOLD_MS = 10 * 60 * 1000;

/** Default per-task retry budget before a feature is marked blocked. */
const DEFAULT_MAX_TASK_RETRIES = 3;

/** Default cadence for mission consistency sweeps (5 minutes). */
const DEFAULT_HEALTH_CHECK_INTERVAL_MS = 5 * 60 * 1000;

/** Per-mission tracking state. */
interface WatchedMissionState {
  missionId: string;
  retryCount: number;
}

export interface MissionAutopilotOptions {
  /** Optional Scheduler instance for slice activation. Can also be set via setScheduler(). */
  scheduler?: {
    activateNextPendingSlice(missionId: string): Promise<Slice | null>;
  };
}

/**
 * MissionAutopilot monitors missions with `autopilotEnabled: true` and
 * autonomously progresses through slices as tasks complete.
 *
 * It does NOT register event listeners on TaskStore or MissionStore.
 * Instead, the Scheduler calls `handleTaskCompletion()` after performing
 * its own feature status updates. This avoids duplicate event handling.
 */
export class MissionAutopilot {
  private watchedMissions = new Map<string, WatchedMissionState>();
  private perMissionTaskRetries = new Map<string, Map<string, number>>();
  private running = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private scheduler: MissionAutopilotOptions["scheduler"];

  constructor(
    private taskStore: TaskStore,
    private missionStore: MissionStore,
    options: MissionAutopilotOptions = {},
  ) {
    this.scheduler = options.scheduler;
  }

  /**
   * Set the scheduler instance after construction.
   * Used to break circular dependency: Scheduler is constructed with
   * MissionAutopilot, then calls setScheduler(this) after both are created.
   */
  setScheduler(scheduler: MissionAutopilotOptions["scheduler"]): void {
    this.scheduler = scheduler;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────

  /**
   * Start the autopilot background service.
   * Begins periodic polling for mission health checks.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.pollTimer = setInterval(() => {
      void this.poll().catch((err) => {
        autopilotLog.error("Error during autopilot poll:", err);
      });
    }, POLL_INTERVAL_MS);
    void this.startHealthCheck();
    autopilotLog.log("Started");
  }

  /**
   * Stop the autopilot background service.
   * Unwatches all missions and clears state.
   */
  stop(): void {
    if (!this.running) return;
    this.running = false;

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.stopHealthCheck();

    // Unwatch all missions
    for (const [missionId] of this.watchedMissions) {
      try {
        this.setAutopilotState(missionId, "inactive");
      } catch {
        // Best effort — mission may have been deleted
      }
    }
    this.watchedMissions.clear();
    this.perMissionTaskRetries.clear();
    autopilotLog.log("Stopped");
  }

  // ── Mission Watching ───────────────────────────────────────────────

  /**
   * Start watching a mission.
   * Sets `autopilotState` to `watching` and adds to watched set.
   *
   * @param missionId - Mission ID to watch
   */
  watchMission(missionId: string): void {
    if (this.watchedMissions.has(missionId)) {
      autopilotLog.log(`Already watching mission ${missionId}`);
      return;
    }

    const mission = this.missionStore.getMission(missionId);
    if (!mission) {
      autopilotLog.warn(`Mission ${missionId} not found — cannot watch`);
      return;
    }

    if (!mission.autopilotEnabled) {
      autopilotLog.warn(`Mission ${missionId} does not have autopilot enabled — skipping`);
      return;
    }

    this.watchedMissions.set(missionId, { missionId, retryCount: 0 });
    this.setAutopilotState(missionId, "watching");
    this.logMissionEventSafe(
      missionId,
      "autopilot_enabled",
      `Autopilot enabled for mission ${mission.title}`,
      {
        source: "watchMission",
        missionStatus: mission.status,
      },
    );
    autopilotLog.log(`Watching mission ${missionId} (${mission.title})`);
  }

  /**
   * Stop watching a mission.
   * Sets `autopilotState` to `inactive` and removes from watched set.
   *
   * @param missionId - Mission ID to unwatch
   */
  unwatchMission(missionId: string): void {
    if (!this.watchedMissions.has(missionId)) {
      return;
    }

    this.watchedMissions.delete(missionId);
    this.perMissionTaskRetries.delete(missionId);
    try {
      this.setAutopilotState(missionId, "inactive");
    } catch {
      // Mission may have been deleted
    }
    this.logMissionEventSafe(
      missionId,
      "autopilot_disabled",
      `Autopilot disabled for mission ${missionId}`,
      { source: "unwatchMission" },
    );
    autopilotLog.log(`Unwatched mission ${missionId}`);
  }

  /**
   * Check if a mission is currently being watched.
   */
  isWatching(missionId: string): boolean {
    return this.watchedMissions.has(missionId);
  }

  /**
   * Get all currently watched mission IDs.
   */
  getWatchedMissionIds(): string[] {
    return [...this.watchedMissions.keys()];
  }

  /**
   * Get the current autopilot status for a mission.
   */
  getAutopilotStatus(missionId: string): AutopilotStatus {
    const mission = this.missionStore.getMission(missionId);
    const watched = this.watchedMissions.has(missionId);

    return {
      enabled: mission?.autopilotEnabled ?? false,
      state: mission?.autopilotState ?? "inactive",
      watched,
      lastActivityAt: mission?.lastAutopilotActivityAt,
    };
  }

  // ── Progression Logic ──────────────────────────────────────────────

  /**
   * Called by the Scheduler after a task with a sliceId completes.
   *
   * 1. Finds the feature linked to the task
   * 2. Checks if the slice is now complete (all features done)
   * 3. If so, advances to the next slice
   *
   * @param taskId - The completed task ID
   */
  async handleTaskCompletion(taskId: string): Promise<void> {
    try {
      const feature = this.missionStore.getFeatureByTaskId(taskId);
      if (!feature) {
        // Task is not linked to any feature — not a mission task
        return;
      }

      const slice = this.missionStore.getSlice(feature.sliceId);
      if (!slice) {
        autopilotLog.warn(`Slice ${feature.sliceId} not found for feature ${feature.id}`);
        return;
      }

      // Resolve mission ID for this slice
      const milestone = this.missionStore.getMilestone(slice.milestoneId);
      if (!milestone) return;
      const missionId = milestone.missionId;

      // Only proceed if we're watching this mission
      if (!this.isWatching(missionId)) return;

      // Successful completion resets retry budget for this specific task.
      this.perMissionTaskRetries.get(missionId)?.delete(taskId);

      // Check if all features in the slice are done
      const features = this.missionStore.listFeatures(slice.id);
      const allDone = features.length > 0 && features.every((f) => f.status === "done");

      if (allDone) {
        autopilotLog.log(`Slice ${slice.id} is complete — advancing mission ${missionId}`);
        await this.advanceToNextSlice(missionId);
      }
    } catch (err) {
      autopilotLog.error(`Error handling task completion for ${taskId}:`, err);
    }
  }

  /**
   * Called when a mission-linked task fails execution.
   * Applies retry budgets per mission/task and blocks features that exceed the budget.
   */
  async handleTaskFailure(taskId: string): Promise<void> {
    try {
      const feature = this.missionStore.getFeatureByTaskId(taskId);
      if (!feature) {
        return;
      }

      const slice = this.missionStore.getSlice(feature.sliceId);
      if (!slice) {
        autopilotLog.warn(`Task failure ${taskId}: slice ${feature.sliceId} not found`);
        return;
      }

      const milestone = this.missionStore.getMilestone(slice.milestoneId);
      if (!milestone) {
        autopilotLog.warn(`Task failure ${taskId}: milestone ${slice.milestoneId} not found`);
        return;
      }

      const missionId = milestone.missionId;
      if (!this.isWatching(missionId)) {
        return;
      }

      const settings = await this.taskStore.getSettings();
      const maxRetries = settings.missionMaxTaskRetries ?? DEFAULT_MAX_TASK_RETRIES;
      const missionRetries = this.perMissionTaskRetries.get(missionId) ?? new Map<string, number>();
      this.perMissionTaskRetries.set(missionId, missionRetries);

      const retryCount = (missionRetries.get(taskId) ?? 0) + 1;
      missionRetries.set(taskId, retryCount);

      if (retryCount > maxRetries) {
        this.missionStore.updateFeatureStatus(feature.id, "blocked");
        await this.taskStore.updateTask(taskId, { status: "failed", paused: true });
        this.logMissionEventSafe(
          missionId,
          "error",
          `Feature ${feature.id} blocked after max retries (${retryCount}/${maxRetries})`,
          { taskId, featureId: feature.id, retryCount, maxRetries },
        );
        return;
      }

      this.logMissionEventSafe(
        missionId,
        "autopilot_retry",
        `Retrying failed mission task ${taskId} (${retryCount}/${maxRetries})`,
        { taskId, featureId: feature.id, retryCount, maxRetries },
      );

      const task = await this.taskStore.getTask(taskId);
      if (task?.column !== "todo") {
        await this.taskStore.moveTask(taskId, "todo");
      }

      await this.taskStore.updateTask(taskId, { error: null, status: null, paused: false });
    } catch (err) {
      autopilotLog.error(`Error handling task failure for ${taskId}:`, err);
    }
  }

  /**
   * Activate the next pending slice in a mission.
   * Uses the scheduler's `activateNextPendingSlice()` method.
   *
   * @param missionId - Mission ID to advance
   */
  async advanceToNextSlice(missionId: string): Promise<void> {
    const state = this.watchedMissions.get(missionId);
    if (!state) return;

    try {
      this.setAutopilotState(missionId, "activating");

      if (this.scheduler) {
        const activated = await this.scheduler.activateNextPendingSlice(missionId);
        if (activated) {
          autopilotLog.log(`Activated slice ${activated.id} for mission ${missionId}`);
          this.updateActivity(missionId);
          // Reset retry count on success
          state.retryCount = 0;
        } else {
          // No pending slice — check for mission completion
          const complete = await this.checkMissionCompletion(missionId);
          if (complete) {
            return; // already transitions state
          }
        }
      }

      this.setAutopilotState(missionId, "watching");
    } catch (err) {
      autopilotLog.error(`Error advancing slice for mission ${missionId}:`, err);

      // Retry with exponential backoff
      state.retryCount++;
      if (state.retryCount <= MAX_RETRY_ATTEMPTS) {
        const delay = RETRY_BASE_DELAY_MS * Math.pow(3, state.retryCount - 1);
        this.logMissionEventSafe(
          missionId,
          "autopilot_retry",
          `Retrying slice activation after error (attempt ${state.retryCount}/${MAX_RETRY_ATTEMPTS})`,
          { retryCount: state.retryCount, maxRetries: MAX_RETRY_ATTEMPTS, delayMs: delay },
        );
        autopilotLog.log(`Retrying slice activation for mission ${missionId} (attempt ${state.retryCount}/${MAX_RETRY_ATTEMPTS}, delay ${delay}ms)`);
        setTimeout(() => {
          if (this.isWatching(missionId)) {
            void this.advanceToNextSlice(missionId);
          }
        }, delay);
      } else {
        this.logMissionEventSafe(
          missionId,
          "error",
          `Autopilot exceeded max slice-activation retries (${MAX_RETRY_ATTEMPTS})`,
          { retryCount: state.retryCount, maxRetries: MAX_RETRY_ATTEMPTS },
        );
        autopilotLog.error(`Max retries exceeded for mission ${missionId} — pausing autopilot`);
        this.setAutopilotState(missionId, "watching");
        state.retryCount = 0;
      }
    }
  }

  /**
   * Check if a mission is in planning and should be started.
   * If mission is `planning` and `autopilotEnabled: true`, transitions to `active`
   * and activates the first pending slice.
   *
   * @param missionId - Mission ID to check and start
   */
  async checkAndStartMission(missionId: string): Promise<void> {
    const mission = this.missionStore.getMission(missionId);
    if (!mission) return;

    if (mission.status === "planning" && mission.autopilotEnabled) {
      autopilotLog.log(`Starting mission ${missionId} (transitioning from planning to active)`);

      this.missionStore.updateMission(missionId, { status: "active" });
      this.logMissionEventSafe(
        missionId,
        "mission_started",
        `Mission ${mission.title} started by autopilot`,
        { source: "checkAndStartMission" },
      );
      this.updateActivity(missionId);

      // Activate first pending slice
      if (this.scheduler) {
        const activated = await this.scheduler.activateNextPendingSlice(missionId);
        if (activated) {
          autopilotLog.log(`Activated first slice ${activated.id} for mission ${missionId}`);
        }
      }
    }
  }

  /**
   * Check if all milestones in a mission are complete AND all features are done.
   * The milestone-level check alone is insufficient — if features were added after
   * all milestones appeared complete, the milestone/slice statuses may be stale.
   * This method performs a secondary verification that ALL features across ALL
   * slices are status "done" before marking the mission complete.
   *
   * If milestones appear complete but some features are not done, this method
   * recomputes the status chain (cascading fixes to slices, milestones, and mission)
   * and returns false.
   *
   * @param missionId - Mission ID to check
   * @returns true if mission is complete, false otherwise
   */
  async checkMissionCompletion(missionId: string): Promise<boolean> {
    const mission = this.missionStore.getMission(missionId);
    if (!mission) return false;

    const milestones = this.missionStore.listMilestones(missionId);
    if (milestones.length === 0) return false;

    const allComplete = milestones.every((m) => m.status === "complete");
    if (allComplete) {
      // Secondary check: verify all features are actually done.
      // This guards against stale milestone statuses caused by the addFeature
      // gap (where features were added after milestones appeared complete).
      const hierarchy = this.missionStore.getMissionWithHierarchy(missionId);
      if (hierarchy) {
        const allFeaturesDone = hierarchy.milestones.every((milestone) =>
          milestone.slices.every((slice) => {
            const features = (slice as import("@fusion/core").SliceWithFeatures).features;
            return features.every((feature) => feature.status === "done");
          }),
        );

        if (!allFeaturesDone) {
          // Milestones appear complete but some features are not done.
          // Recompute the full status chain to fix stale slice/milestone statuses.
          await this.recomputeMissionStatusChain(missionId);
          autopilotLog.warn(
            `Mission ${missionId} milestones appear complete but some features are not done; recomputing status chain`,
          );
          this.logMissionEventSafe(
            missionId,
            "error",
            `Mission ${missionId} has stale milestone/slice status; status chain recomputed`,
            { source: "checkMissionCompletion" },
          );
          return false;
        }
      }

      autopilotLog.log(`Mission ${missionId} is complete!`);
      this.setAutopilotState(missionId, "completing");
      this.missionStore.updateMission(missionId, { status: "complete" });
      this.logMissionEventSafe(
        missionId,
        "mission_completed",
        `Mission ${mission.title} marked complete`,
        { milestoneCount: milestones.length },
      );
      this.updateActivity(missionId);
      this.setAutopilotState(missionId, "inactive");
      this.watchedMissions.delete(missionId);
      this.perMissionTaskRetries.delete(missionId);
      return true;
    }

    return false;
  }

  /**
   * Recompute the status chain for every slice in a mission.
   *
   * Iterates all slices in the mission and calls missionStore.recomputeSliceStatus
   * for each. Since updateSlice internally calls recomputeMilestoneStatus (which
   * internally calls recomputeMissionStatus), calling this for each slice ensures
   * the full mission → milestone → slice → feature chain is synchronized.
   *
   * Used to fix stale statuses when inconsistencies are detected.
   *
   * @param missionId - Mission ID whose slices should be recomputed
   */
  private async recomputeMissionStatusChain(missionId: string): Promise<void> {
    const hierarchy = this.missionStore.getMissionWithHierarchy(missionId);
    if (!hierarchy) return;

    for (const milestone of hierarchy.milestones) {
      for (const slice of milestone.slices) {
        // recomputeSliceStatus is private on missionStore; use the public updateSlice
        // with the computed status to trigger the cascade.
        const computed = this.missionStore.computeSliceStatus(slice.id);
        if (slice.status !== computed) {
          this.missionStore.updateSlice(slice.id, { status: computed });
        }
      }
    }
  }

  // ── Background Poll ────────────────────────────────────────────────

  /**
   * Periodic health check for watched missions.
   * - Re-watches missions with `autopilotEnabled: true` that aren't being tracked
   * - Starts missions in `planning` with autopilot enabled
   * - Recovers stale missions stuck in `activating`
   */
  private async poll(): Promise<void> {
    if (!this.running) return;

    try {
      const missions = this.missionStore.listMissions();

      for (const mission of missions) {
        // Auto-watch missions with autopilot enabled that aren't being watched
        if (mission.autopilotEnabled && !this.isWatching(mission.id) && mission.status !== "complete" && mission.status !== "archived") {
          autopilotLog.log(`Poll: auto-watching mission ${mission.id}`);
          this.watchMission(mission.id);
        }

        // Start planning missions with autopilot
        if (mission.autopilotEnabled && mission.status === "planning" && this.isWatching(mission.id)) {
          await this.checkAndStartMission(mission.id);
        }
      }

      const settings = await this.taskStore.getSettings();
      const staleThresholdMs = settings.missionStaleThresholdMs ?? DEFAULT_STALE_THRESHOLD_MS;

      // Check for stale missions
      const now = Date.now();
      for (const [missionId, state] of this.watchedMissions) {
        const mission = this.missionStore.getMission(missionId);
        if (!mission) {
          // Mission deleted — unwatch
          this.watchedMissions.delete(missionId);
          this.perMissionTaskRetries.delete(missionId);
          continue;
        }

        if (!mission.lastAutopilotActivityAt || mission.autopilotState !== "activating") {
          continue;
        }

        const lastActivity = new Date(mission.lastAutopilotActivityAt).getTime();
        if (now - lastActivity <= staleThresholdMs) {
          continue;
        }

        const staleMinutes = Math.round((now - lastActivity) / 60_000);
        this.logMissionEventSafe(
          missionId,
          "autopilot_stale",
          `Mission autopilot is stale and will be recovered (${staleMinutes} minutes inactive)` ,
          {
            staleMinutes,
            staleThresholdMs,
            lastActivityAt: mission.lastAutopilotActivityAt,
            retryCount: state.retryCount,
            previousState: mission.autopilotState,
          },
        );
        autopilotLog.warn(`Mission ${missionId} stale while activating (inactive ${staleMinutes}m) — recovering`);

        this.setAutopilotState(missionId, "watching");
        state.retryCount = 0;
        await this.recoverStaleMission(missionId);
        this.updateActivity(missionId);
      }
    } catch (err) {
      autopilotLog.error("Error during autopilot poll:", err);
    }
  }

  /**
   * Attempt to recover a mission that appears stalled in the activating state.
   * First reconciles any task/feature inconsistencies, then re-evaluates
   * active/pending slices and advances when progression is possible.
   */
  async recoverStaleMission(missionId: string): Promise<void> {
    try {
      const mission = this.missionStore.getMissionWithHierarchy(missionId);
      if (!mission) {
        autopilotLog.warn(`recoverStaleMission: mission ${missionId} not found`);
        return;
      }

      // Reconcile task/feature inconsistencies before making progression decisions.
      // This fixes drifted states (e.g., feature still "in-progress" but task is done)
      // so that completion checks are accurate.
      await this.reconcileMissionConsistency(mission);

      // Re-fetch hierarchy after reconciliation to get accurate slice statuses
      const refreshedMission = this.missionStore.getMissionWithHierarchy(missionId);
      if (!refreshedMission) {
        return;
      }

      const activeSlices = refreshedMission.milestones.flatMap((milestone) => milestone.slices)
        .filter((slice) => slice.status === "active");

      let advanced = false;

      if (activeSlices.length > 0) {
        const hasCompletedActiveSlice = activeSlices.some((slice) =>
          slice.features.length > 0 && slice.features.every((feature) => feature.status === "done"),
        );

        if (hasCompletedActiveSlice) {
          await this.advanceToNextSlice(missionId);
          advanced = true;
        }
      } else {
        const hasPendingSlice = refreshedMission.milestones.some((milestone) =>
          milestone.slices.some((slice) => slice.status === "pending"),
        );

        if (hasPendingSlice) {
          await this.advanceToNextSlice(missionId);
          advanced = true;
        }
      }

      this.logMissionEventSafe(
        missionId,
        "autopilot_stale",
        advanced
          ? `Recovered stale mission ${missionId} and resumed slice progression`
          : `Recovered stale mission ${missionId}; no immediate slice progression needed`,
        {
          source: "recoverStaleMission",
          activeSliceCount: activeSlices.length,
          advanced,
        },
      );
    } catch (err) {
      autopilotLog.error(`recoverStaleMission failed for ${missionId}:`, err);
    }
  }

  private async startHealthCheck(): Promise<void> {
    this.stopHealthCheck();

    let intervalMs = DEFAULT_HEALTH_CHECK_INTERVAL_MS;
    try {
      const settings = await this.taskStore.getSettings();
      intervalMs = settings.missionHealthCheckIntervalMs ?? DEFAULT_HEALTH_CHECK_INTERVAL_MS;
    } catch (err) {
      autopilotLog.warn("Failed to read mission health check settings; using defaults", err);
    }

    if (!this.running) {
      return;
    }

    if (intervalMs <= 0) {
      autopilotLog.log("Mission health checks disabled (missionHealthCheckIntervalMs=0)");
      return;
    }

    this.healthCheckTimer = setInterval(() => {
      void this.runHealthCheck();
    }, intervalMs);
    autopilotLog.log(`Mission health checks started (every ${intervalMs}ms)`);
  }

  private stopHealthCheck(): void {
    if (!this.healthCheckTimer) {
      return;
    }

    clearInterval(this.healthCheckTimer);
    this.healthCheckTimer = null;
  }

  private async runHealthCheck(): Promise<void> {
    if (!this.running || this.watchedMissions.size === 0) {
      return;
    }

    try {
      let fixedCount = 0;

      for (const missionId of this.watchedMissions.keys()) {
        const mission = this.missionStore.getMissionWithHierarchy(missionId);
        if (!mission) {
          continue;
        }

        fixedCount += await this.reconcileMissionConsistency(mission);
      }

      autopilotLog.log(`Mission health check complete: fixed ${fixedCount} inconsistenc${fixedCount === 1 ? "y" : "ies"}`);
    } catch (err) {
      autopilotLog.error("Mission health check failed:", err);
    }
  }

  /**
   * Recover autopilot state after process restart.
   * Watches active missions and performs a one-time consistency sweep.
   */
  async recoverMissions(missionStore: MissionStore): Promise<void> {
    try {
      const missions = missionStore.listMissions();
      let watchedCount = 0;
      let recoveredActivatingCount = 0;
      let inconsistencyFixes = 0;

      for (const mission of missions) {
        if (!mission.autopilotEnabled || mission.status === "complete" || mission.status === "archived") {
          continue;
        }

        if (!this.isWatching(mission.id)) {
          this.watchMission(mission.id);
          watchedCount++;
        }

        if (mission.autopilotState === "activating") {
          await this.recoverStaleMission(mission.id);
          recoveredActivatingCount++;
        }

        const hierarchy = missionStore.getMissionWithHierarchy(mission.id);
        if (!hierarchy) {
          continue;
        }

        inconsistencyFixes += await this.reconcileMissionConsistency(hierarchy);

        const refreshedHierarchy = missionStore.getMissionWithHierarchy(mission.id);
        if (!refreshedHierarchy) {
          continue;
        }

        const hasCompletedActiveSlice = refreshedHierarchy.milestones
          .flatMap((milestone) => milestone.slices)
          .filter((slice) => slice.status === "active")
          .some((slice) => slice.features.length > 0 && slice.features.every((feature) => feature.status === "done"));

        if (hasCompletedActiveSlice) {
          await this.advanceToNextSlice(mission.id);
        }
      }

      autopilotLog.log(
        `Mission recovery complete: watched ${watchedCount}, recovered ${recoveredActivatingCount} activating missions, fixed ${inconsistencyFixes} inconsistenc${inconsistencyFixes === 1 ? "y" : "ies"}`,
      );
    } catch (err) {
      autopilotLog.error("Mission recovery failed:", err);
    }
  }

  private async reconcileMissionConsistency(
    mission: MissionWithHierarchy,
  ): Promise<number> {
    if (!mission) {
      return 0;
    }

    const activeSlices = mission.milestones
      .flatMap((milestone) => milestone.slices)
      .filter((slice) => slice.status === "active");

    const completeSlices = mission.milestones
      .flatMap((milestone) => milestone.slices)
      .filter((slice) => slice.status === "complete");

    // Process complete slices: check for stale "defined" features.
    // Features with status "defined" should never exist in a "complete" slice.
    // If found, recompute the status chain to fix the stale state.
    if (completeSlices.length > 0) {
      for (const slice of completeSlices) {
        const definedFeatures = slice.features.filter((f) => f.status !== "done");
        if (definedFeatures.length > 0) {
          autopilotLog.warn(
            `Slice ${slice.id} is marked complete but has ${definedFeatures.length} feature(s) not done; recomputing status chain`,
            {
              missionId: mission.id,
              sliceId: slice.id,
              definedFeatureIds: definedFeatures.map((f) => f.id),
            },
          );
          this.logMissionEventSafe(
            mission.id,
            "error",
            `Slice ${slice.id} has stale "complete" status (${definedFeatures.length} feature(s) not done); recomputing status chain`,
            { source: "reconcileMissionConsistency" },
          );
          await this.recomputeMissionStatusChain(mission.id);
          // One recompute is sufficient for all complete slices; break after first hit
          return 1;
        }
      }
    }

    if (activeSlices.length === 0) {
      return 0;
    }

    let fixedCount = 0;

    for (const slice of activeSlices) {
      for (const feature of slice.features) {
        if (!feature.taskId) {
          continue;
        }

        const task = await this.taskStore.getTask(feature.taskId);
        if (!task) {
          continue;
        }

        const reconciliation = await reconcileMissionFeatureState(this.taskStore, task, feature);

        if (reconciliation.kind === "failure") {
          await this.handleTaskFailure(feature.taskId);
          fixedCount++;
          continue;
        }

        if (reconciliation.kind === "blocked") {
          autopilotLog.warn(`Skipping feature ${feature.id} reconciliation — ${reconciliation.reason}`);
          continue;
        }

        if (reconciliation.kind === "update") {
          this.missionStore.updateFeatureStatus(feature.id, reconciliation.status);
          fixedCount++;
        }
      }
    }

    return fixedCount;
  }

  // ── Helpers ────────────────────────────────────────────────────────

  /**
   * Best-effort mission event logging that must never break autopilot control flow.
   */
  private logMissionEventSafe(
    missionId: string,
    eventType: MissionEventType,
    description: string,
    metadata?: Record<string, unknown>,
  ): void {
    const missionStoreWithEvents = this.missionStore as MissionStore & {
      logMissionEvent?: (
        missionId: string,
        eventType: MissionEventType,
        description: string,
        metadata?: Record<string, unknown>,
      ) => unknown;
    };

    if (typeof missionStoreWithEvents.logMissionEvent !== "function") {
      autopilotLog.warn(
        `[${eventType}] ${missionId}: ${description}`,
        metadata ?? {},
      );
      return;
    }

    try {
      missionStoreWithEvents.logMissionEvent(missionId, eventType, description, metadata);
    } catch (err) {
      autopilotLog.error(
        `Failed to persist mission event (${eventType}) for ${missionId}:`,
        err,
      );
    }
  }

  /**
   * Update the `autopilotState` on a mission in the store.
   */
  private setAutopilotState(missionId: string, state: AutopilotState): void {
    try {
      const mission = this.missionStore.getMission(missionId);
      if (!mission) {
        return;
      }

      const previousState = mission.autopilotState ?? "inactive";
      if (previousState !== state) {
        this.missionStore.updateMission(missionId, { autopilotState: state });
        this.logMissionEventSafe(
          missionId,
          "autopilot_state_changed",
          `Autopilot state changed from ${previousState} to ${state}`,
          { fromState: previousState, toState: state },
        );
      }
    } catch (err) {
      autopilotLog.error(`Error setting autopilot state for mission ${missionId}:`, err);
    }
  }

  /**
   * Update the `lastAutopilotActivityAt` timestamp on a mission.
   */
  private updateActivity(missionId: string): void {
    try {
      this.missionStore.updateMission(missionId, {
        lastAutopilotActivityAt: new Date().toISOString(),
      });
    } catch (err) {
      autopilotLog.error(`Error updating activity for mission ${missionId}:`, err);
    }
  }
}
