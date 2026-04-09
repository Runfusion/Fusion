/**
 * MissionStore - Data layer for the Missions hierarchy system.
 *
 * Manages CRUD operations for missions, milestones, slices, and features.
 * Provides status rollup logic and emits events for dashboard reactivity.
 *
 * Follows the same patterns as TaskStore for consistency:
 * - EventEmitter for change notifications
 * - SQLite for structured data storage
 * - JSON columns for nested arrays
 * - Transaction handling for atomic operations
 */

import { EventEmitter } from "node:events";
import type { Database } from "./db.js";
import { fromJson, toJson, toJsonNullable } from "./db.js";
import type {
  Mission,
  Milestone,
  Slice,
  MissionFeature,
  MissionCreateInput,
  MilestoneCreateInput,
  SliceCreateInput,
  FeatureCreateInput,
  MissionWithHierarchy,
  MissionStatus,
  MilestoneStatus,
  SliceStatus,
  FeatureStatus,
  InterviewState,
  AutopilotState,
  MissionEvent,
  MissionEventType,
  MissionHealth,
} from "./mission-types.js";

// ── Mission Summary Type ─────────────────────────────────────────────

/** Status summary for a mission, computed from its hierarchy. */
export interface MissionSummary {
  /** Total number of milestones in the mission */
  totalMilestones: number;
  /** Number of milestones with status "complete" */
  completedMilestones: number;
  /** Total number of features across all slices */
  totalFeatures: number;
  /** Number of features with status "done" */
  completedFeatures: number;
  /** Computed progress percentage (0–100), based on features or milestones */
  progressPercent: number;
}

// ── Event Types ─────────────────────────────────────────────────────

export interface MissionStoreEvents {
  /** Emitted when a mission is created */
  "mission:created": [Mission];
  /** Emitted when a mission is updated */
  "mission:updated": [Mission];
  /** Emitted when a mission is deleted */
  "mission:deleted": [string];
  /** Emitted when a milestone is created */
  "milestone:created": [Milestone];
  /** Emitted when a milestone is updated */
  "milestone:updated": [Milestone];
  /** Emitted when a milestone is deleted */
  "milestone:deleted": [string];
  /** Emitted when a slice is created */
  "slice:created": [Slice];
  /** Emitted when a slice is updated */
  "slice:updated": [Slice];
  /** Emitted when a slice is deleted */
  "slice:deleted": [string];
  /** Emitted when a slice is activated for work */
  "slice:activated": [Slice];
  /** Emitted when a feature is created */
  "feature:created": [MissionFeature];
  /** Emitted when a feature is updated */
  "feature:updated": [MissionFeature];
  /** Emitted when a feature is deleted */
  "feature:deleted": [string];
  /** Emitted when a feature is linked to a task */
  "feature:linked": [{ feature: MissionFeature; taskId: string }];
  /** Emitted when a mission lifecycle event is persisted */
  "mission:event": [MissionEvent];
}

// ── MissionStore Class ──────────────────────────────────────────────

export class MissionStore extends EventEmitter<MissionStoreEvents> {
  /**
   * Creates a new MissionStore instance.
   *
   * @param kbDir - Path to the .fusion directory (e.g., /path/to/project/.fusion)
   * @param db - Shared Database instance (same instance used by TaskStore)
   * @param taskStore - Optional TaskStore reference for triage operations that create tasks
   */
  constructor(
    private kbDir: string,
    private db: Database,
    private taskStore?: import("./store.js").TaskStore,
  ) {
    super();
    this.setMaxListeners(100);
  }

  // ── Row-to-Object Converters ───────────────────────────────────────

  /**
   * Convert a database row to a Mission object.
   */
  private rowToMission(row: any): Mission {
    return {
      id: row.id,
      title: row.title,
      description: row.description || undefined,
      status: row.status as MissionStatus,
      interviewState: row.interviewState as InterviewState,
      autoAdvance: Boolean(row.autoAdvance),
      autopilotEnabled: Boolean(row.autopilotEnabled),
      autopilotState: (row.autopilotState as AutopilotState) || "inactive",
      lastAutopilotActivityAt: row.lastAutopilotActivityAt || undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /**
   * Convert a database row to a Milestone object.
   */
  private rowToMilestone(row: any): Milestone {
    return {
      id: row.id,
      missionId: row.missionId,
      title: row.title,
      description: row.description || undefined,
      status: row.status as MilestoneStatus,
      orderIndex: row.orderIndex,
      interviewState: row.interviewState as InterviewState,
      dependencies: fromJson<string[]>(row.dependencies) || [],
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /**
   * Convert a database row to a Slice object.
   */
  private rowToSlice(row: any): Slice {
    return {
      id: row.id,
      milestoneId: row.milestoneId,
      title: row.title,
      description: row.description || undefined,
      status: row.status as SliceStatus,
      orderIndex: row.orderIndex,
      activatedAt: row.activatedAt || undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /**
   * Convert a database row to a MissionFeature object.
   */
  private rowToFeature(row: any): MissionFeature {
    return {
      id: row.id,
      sliceId: row.sliceId,
      taskId: row.taskId || undefined,
      title: row.title,
      description: row.description || undefined,
      acceptanceCriteria: row.acceptanceCriteria || undefined,
      status: row.status as FeatureStatus,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /**
   * Convert a database row to a MissionEvent object.
   */
  private rowToMissionEvent(row: any): MissionEvent {
    return {
      id: row.id,
      missionId: row.missionId,
      eventType: row.eventType as MissionEventType,
      description: row.description,
      metadata: fromJson<Record<string, unknown>>(row.metadata) ?? null,
      timestamp: row.timestamp,
    };
  }

  // ── Mission CRUD Operations ────────────────────────────────────────

  /**
   * Create a new mission.
   * The mission starts in "planning" status with "not_started" interview state.
   *
   * @param input - Mission creation input
   * @returns The created mission
   */
  createMission(input: MissionCreateInput & { autopilotEnabled?: boolean }): Mission {
    const now = new Date().toISOString();
    const id = this.generateMissionId();

    const mission: Mission = {
      id,
      title: input.title,
      description: input.description,
      status: "planning",
      interviewState: "not_started",
      autoAdvance: false,
      autopilotEnabled: input.autopilotEnabled ?? false,
      autopilotState: "inactive",
      createdAt: now,
      updatedAt: now,
    };

    this.db.prepare(`
      INSERT INTO missions (id, title, description, status, interviewState, autoAdvance, autopilotEnabled, autopilotState, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      mission.id,
      mission.title,
      mission.description ?? null,
      mission.status,
      mission.interviewState,
      mission.autoAdvance ? 1 : 0,
      mission.autopilotEnabled ? 1 : 0,
      mission.autopilotState ?? "inactive",
      mission.createdAt,
      mission.updatedAt,
    );

    this.db.bumpLastModified();
    this.emit("mission:created", mission);
    return mission;
  }

  /**
   * Get a mission by ID.
   *
   * @param id - Mission ID
   * @returns The mission, or undefined if not found
   */
  getMission(id: string): Mission | undefined {
    const row = this.db.prepare("SELECT * FROM missions WHERE id = ?").get(id);
    if (!row) return undefined;
    return this.rowToMission(row);
  }

  /**
   * Get a mission with its full hierarchy (milestones → slices → features).
   *
   * @param id - Mission ID
   * @returns The mission with hierarchy, or undefined if not found
   */
  getMissionWithHierarchy(id: string): MissionWithHierarchy | undefined {
    const mission = this.getMission(id);
    if (!mission) return undefined;

    const milestones = this.listMilestones(id);
    const milestonesWithSlices = milestones.map((milestone) => {
      const slices = this.listSlices(milestone.id);
      const slicesWithFeatures = slices.map((slice) => ({
        ...slice,
        features: this.listFeatures(slice.id),
      }));
      return {
        ...milestone,
        slices: slicesWithFeatures,
      };
    });

    return {
      ...mission,
      milestones: milestonesWithSlices,
    };
  }

  /**
   * List all missions, ordered by creation date (newest first).
   *
   * @returns Array of missions
   */
  listMissions(): Mission[] {
    const rows = this.db.prepare("SELECT * FROM missions ORDER BY createdAt DESC").all();
    return (rows as any[]).map((row) => this.rowToMission(row));
  }

  /**
   * Get a status summary for a mission, computing milestone and feature counts
   * and progress percentage from the hierarchy.
   *
   * Progress is calculated as:
   * - (completedFeatures / totalFeatures) * 100 if there are features
   * - (completedMilestones / totalMilestones) * 100 if there are milestones but no features
   * - 0 otherwise
   *
   * @param missionId - Mission ID
   * @returns MissionSummary with counts and progress
   */
  getMissionSummary(missionId: string): MissionSummary {
    const milestones = this.listMilestones(missionId);
    const totalMilestones = milestones.length;
    const completedMilestones = milestones.filter((m) => m.status === "complete").length;

    let totalFeatures = 0;
    let completedFeatures = 0;

    for (const milestone of milestones) {
      const slices = this.listSlices(milestone.id);
      for (const slice of slices) {
        const features = this.listFeatures(slice.id);
        totalFeatures += features.length;
        completedFeatures += features.filter((f) => f.status === "done").length;
      }
    }

    let progressPercent = 0;
    if (totalFeatures > 0) {
      progressPercent = Math.round((completedFeatures / totalFeatures) * 100);
    } else if (totalMilestones > 0) {
      progressPercent = Math.round((completedMilestones / totalMilestones) * 100);
    }

    return {
      totalMilestones,
      completedMilestones,
      totalFeatures,
      completedFeatures,
      progressPercent,
    };
  }

  /**
   * List all missions with computed summaries in a single batch of queries.
   *
   * Instead of N×(1 + M×(1 + S×1)) queries (one per mission, then per-milestone,
   * per-slice, per-feature), this method fires 4 batch queries total and groups
   * the data in-memory for summary computation.
   *
   * @returns Array of missions with summary, sorted by createdAt DESC
   */
  listMissionsWithSummaries(): Array<Mission & { summary: MissionSummary }> {
    // 1. Fetch all missions
    const missions = this.listMissions();
    if (missions.length === 0) return [];

    // 2. Batch query all milestones
    const milestoneRows = this.db.prepare(
      "SELECT * FROM milestones ORDER BY orderIndex ASC"
    ).all() as any[];
    const allMilestones = milestoneRows.map((row) => this.rowToMilestone(row));

    // 3. Batch query all slices
    const sliceRows = this.db.prepare(
      "SELECT * FROM slices ORDER BY orderIndex ASC"
    ).all() as any[];
    const allSlices = sliceRows.map((row) => this.rowToSlice(row));

    // 4. Batch query all features
    const featureRows = this.db.prepare(
      "SELECT * FROM mission_features ORDER BY createdAt ASC"
    ).all() as any[];
    const allFeatures = featureRows.map((row) => this.rowToFeature(row));

    // 5. Group in-memory: slices by milestoneId, features by sliceId
    const slicesByMilestoneId = new Map<string, Slice[]>();
    for (const slice of allSlices) {
      const list = slicesByMilestoneId.get(slice.milestoneId) || [];
      list.push(slice);
      slicesByMilestoneId.set(slice.milestoneId, list);
    }

    const featuresBySliceId = new Map<string, MissionFeature[]>();
    for (const feature of allFeatures) {
      const list = featuresBySliceId.get(feature.sliceId) || [];
      list.push(feature);
      featuresBySliceId.set(feature.sliceId, list);
    }

    // 6. Group milestones by missionId
    const milestonesByMissionId = new Map<string, Milestone[]>();
    for (const milestone of allMilestones) {
      const list = milestonesByMissionId.get(milestone.missionId) || [];
      list.push(milestone);
      milestonesByMissionId.set(milestone.missionId, list);
    }

    // 7. Compute summary for each mission using grouped data
    return missions.map((mission) => {
      const milestones = milestonesByMissionId.get(mission.id) || [];
      const totalMilestones = milestones.length;
      const completedMilestones = milestones.filter((m) => m.status === "complete").length;

      let totalFeatures = 0;
      let completedFeatures = 0;

      for (const milestone of milestones) {
        const slices = slicesByMilestoneId.get(milestone.id) || [];
        for (const slice of slices) {
          const features = featuresBySliceId.get(slice.id) || [];
          totalFeatures += features.length;
          completedFeatures += features.filter((f) => f.status === "done").length;
        }
      }

      let progressPercent = 0;
      if (totalFeatures > 0) {
        progressPercent = Math.round((completedFeatures / totalFeatures) * 100);
      } else if (totalMilestones > 0) {
        progressPercent = Math.round((completedMilestones / totalMilestones) * 100);
      }

      return {
        ...mission,
        summary: {
          totalMilestones,
          completedMilestones,
          totalFeatures,
          completedFeatures,
          progressPercent,
        },
      };
    });
  }

  /**
   * Compute health for ALL missions in a single batch of queries.
   *
   * Instead of N × (1 + M + S + F + failedTasks + lastError) individual queries,
   * this method fires a fixed number of batch queries and groups in-memory.
   *
   * @returns Map of mission ID → MissionHealth
   */
  listMissionsHealth(): Map<string, MissionHealth> {
    const missions = this.listMissions();
    if (missions.length === 0) return new Map();

    // 1. Batch query all milestones
    const milestoneRows = this.db.prepare(
      "SELECT * FROM milestones ORDER BY orderIndex ASC"
    ).all() as any[];
    const allMilestones = milestoneRows.map((row) => this.rowToMilestone(row));

    // 2. Batch query all slices
    const sliceRows = this.db.prepare(
      "SELECT * FROM slices ORDER BY orderIndex ASC"
    ).all() as any[];
    const allSlices = sliceRows.map((row) => this.rowToSlice(row));

    // 3. Batch query all features
    const featureRows = this.db.prepare(
      "SELECT * FROM mission_features ORDER BY createdAt ASC"
    ).all() as any[];
    const allFeatures = featureRows.map((row) => this.rowToFeature(row));

    // 4. Batch query all failed task IDs
    const failedTaskRows = this.db.prepare(
      "SELECT id FROM tasks WHERE status = 'failed'"
    ).all() as Array<{ id: string }>;
    const failedTaskIds = new Set(failedTaskRows.map((row) => row.id));

    // 5. Batch query last error event per mission
    const lastErrorRows = this.db.prepare(`
      SELECT missionId, timestamp, description
      FROM mission_events
      WHERE eventType = 'error'
      ORDER BY timestamp DESC, id DESC
    `).all() as Array<{ missionId: string; timestamp: string; description: string }>;
    // Only keep the first (latest) error per missionId
    const lastErrorByMission = new Map<string, { timestamp: string; description: string }>();
    for (const row of lastErrorRows) {
      if (!lastErrorByMission.has(row.missionId)) {
        lastErrorByMission.set(row.missionId, { timestamp: row.timestamp, description: row.description });
      }
    }

    // 6. Group hierarchy in-memory
    const milestonesByMissionId = new Map<string, Milestone[]>();
    for (const milestone of allMilestones) {
      const list = milestonesByMissionId.get(milestone.missionId) || [];
      list.push(milestone);
      milestonesByMissionId.set(milestone.missionId, list);
    }

    const slicesByMilestoneId = new Map<string, Slice[]>();
    for (const slice of allSlices) {
      const list = slicesByMilestoneId.get(slice.milestoneId) || [];
      list.push(slice);
      slicesByMilestoneId.set(slice.milestoneId, list);
    }

    const featuresBySliceId = new Map<string, MissionFeature[]>();
    for (const feature of allFeatures) {
      const list = featuresBySliceId.get(feature.sliceId) || [];
      list.push(feature);
      featuresBySliceId.set(feature.sliceId, list);
    }

    // 7. Compute health for each mission
    const result = new Map<string, MissionHealth>();

    for (const mission of missions) {
      const milestones = milestonesByMissionId.get(mission.id) || [];

      let totalTasks = 0;
      let tasksCompleted = 0;
      let tasksInFlight = 0;
      let tasksFailed = 0;
      let currentSliceId: string | undefined;
      let currentMilestoneId: string | undefined;

      let totalMilestones = milestones.length;
      let completedMilestones = 0;
      let totalFeatures = 0;
      let completedFeatures = 0;

      for (const milestone of milestones) {
        if (milestone.status === "complete") {
          completedMilestones++;
        }
        if (!currentMilestoneId && milestone.status === "active") {
          currentMilestoneId = milestone.id;
        }

        const slices = slicesByMilestoneId.get(milestone.id) || [];
        for (const slice of slices) {
          if (!currentSliceId && slice.status === "active") {
            currentSliceId = slice.id;
            currentMilestoneId ??= milestone.id;
          }

          const features = featuresBySliceId.get(slice.id) || [];
          for (const feature of features) {
            totalFeatures++;
            totalTasks += 1;
            if (feature.status === "done") {
              tasksCompleted += 1;
              completedFeatures++;
            }
            if (feature.status === "triaged" || feature.status === "in-progress") {
              tasksInFlight += 1;
            }
            if (feature.taskId && failedTaskIds.has(feature.taskId)) {
              tasksFailed++;
            }
          }
        }
      }

      let progressPercent = 0;
      if (totalFeatures > 0) {
        progressPercent = Math.round((completedFeatures / totalFeatures) * 100);
      } else if (totalMilestones > 0) {
        progressPercent = Math.round((completedMilestones / totalMilestones) * 100);
      }

      const lastError = lastErrorByMission.get(mission.id);

      result.set(mission.id, {
        missionId: mission.id,
        status: mission.status,
        tasksCompleted,
        tasksFailed,
        tasksInFlight,
        totalTasks,
        currentSliceId,
        currentMilestoneId,
        estimatedCompletionPercent: progressPercent,
        lastErrorAt: lastError?.timestamp,
        lastErrorDescription: lastError?.description,
        autopilotState: mission.autopilotState ?? "inactive",
        autopilotEnabled: mission.autopilotEnabled ?? false,
        lastActivityAt: mission.lastAutopilotActivityAt,
      });
    }

    return result;
  }

  /**
   * Persist a mission lifecycle event for observability and auditing.
   */
  logMissionEvent(
    missionId: string,
    eventType: MissionEventType,
    description: string,
    metadata?: Record<string, unknown>,
  ): MissionEvent {
    const mission = this.getMission(missionId);
    if (!mission) {
      throw new Error(`Mission ${missionId} not found`);
    }

    const event: MissionEvent = {
      id: this.generateMissionEventId(),
      missionId,
      eventType,
      description,
      metadata: metadata ?? null,
      timestamp: new Date().toISOString(),
    };

    this.db.prepare(`
      INSERT INTO mission_events (id, missionId, eventType, description, metadata, timestamp)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      event.id,
      event.missionId,
      event.eventType,
      event.description,
      toJsonNullable(event.metadata),
      event.timestamp,
    );

    this.db.bumpLastModified();
    this.emit("mission:event", event);
    return event;
  }

  /**
   * List mission lifecycle events with pagination/filtering.
   */
  getMissionEvents(
    missionId: string,
    options?: { limit?: number; offset?: number; eventType?: string },
  ): { events: MissionEvent[]; total: number } {
    const limit = Math.max(0, options?.limit ?? 50);
    const offset = Math.max(0, options?.offset ?? 0);
    const eventType = options?.eventType;

    const whereClauses = ["missionId = ?"];
    const params: string[] = [missionId];

    if (eventType) {
      whereClauses.push("eventType = ?");
      params.push(eventType);
    }

    const whereSql = whereClauses.join(" AND ");
    const totalRow = this.db.prepare(`
      SELECT COUNT(*) as count
      FROM mission_events
      WHERE ${whereSql}
    `).get(...params) as { count: number };

    const rows = this.db.prepare(`
      SELECT *
      FROM mission_events
      WHERE ${whereSql}
      ORDER BY timestamp DESC, id DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as any[];

    return {
      events: rows.map((row) => this.rowToMissionEvent(row)),
      total: totalRow?.count ?? 0,
    };
  }

  /**
   * Compute a mission health snapshot for observability endpoints.
   */
  getMissionHealth(missionId: string): MissionHealth | undefined {
    const mission = this.getMission(missionId);
    if (!mission) {
      return undefined;
    }

    const milestones = this.listMilestones(missionId);
    const summary = this.getMissionSummary(missionId);

    let totalTasks = 0;
    let tasksCompleted = 0;
    let tasksInFlight = 0;
    let currentSliceId: string | undefined;
    let currentMilestoneId: string | undefined;
    const featureTaskIds: string[] = [];

    for (const milestone of milestones) {
      if (!currentMilestoneId && milestone.status === "active") {
        currentMilestoneId = milestone.id;
      }

      const slices = this.listSlices(milestone.id);
      for (const slice of slices) {
        if (!currentSliceId && slice.status === "active") {
          currentSliceId = slice.id;
          currentMilestoneId ??= milestone.id;
        }

        const features = this.listFeatures(slice.id);
        for (const feature of features) {
          totalTasks += 1;
          if (feature.status === "done") {
            tasksCompleted += 1;
          }
          if (feature.status === "triaged" || feature.status === "in-progress") {
            tasksInFlight += 1;
          }
          if (feature.taskId) {
            featureTaskIds.push(feature.taskId);
          }
        }
      }
    }

    let tasksFailed = 0;
    if (featureTaskIds.length > 0) {
      const uniqueTaskIds = [...new Set(featureTaskIds)];
      const placeholders = uniqueTaskIds.map(() => "?").join(", ");
      const failedTaskRows = this.db.prepare(`
        SELECT id
        FROM tasks
        WHERE status = 'failed' AND id IN (${placeholders})
      `).all(...uniqueTaskIds) as Array<{ id: string }>;
      const failedTaskIds = new Set(failedTaskRows.map((row) => row.id));
      tasksFailed = featureTaskIds.filter((taskId) => failedTaskIds.has(taskId)).length;
    }

    const lastErrorRow = this.db.prepare(`
      SELECT timestamp, description
      FROM mission_events
      WHERE missionId = ? AND eventType = 'error'
      ORDER BY timestamp DESC, id DESC
      LIMIT 1
    `).get(missionId) as { timestamp: string; description: string } | undefined;

    return {
      missionId,
      status: mission.status,
      tasksCompleted,
      tasksFailed,
      tasksInFlight,
      totalTasks,
      currentSliceId,
      currentMilestoneId,
      estimatedCompletionPercent: summary.progressPercent,
      lastErrorAt: lastErrorRow?.timestamp,
      lastErrorDescription: lastErrorRow?.description,
      autopilotState: mission.autopilotState ?? "inactive",
      autopilotEnabled: mission.autopilotEnabled ?? false,
      lastActivityAt: mission.lastAutopilotActivityAt,
    };
  }

  /**
   * Update a mission.
   *
   * @param id - Mission ID
   * @param updates - Partial mission updates (cannot update id or createdAt)
   * @returns The updated mission
   * @throws Error if mission not found
   */
  updateMission(id: string, updates: Partial<Mission>): Mission {
    const mission = this.getMission(id);
    if (!mission) {
      throw new Error(`Mission ${id} not found`);
    }

    const updated: Mission = {
      ...mission,
      ...updates,
      id, // Prevent changing ID
      createdAt: mission.createdAt, // Prevent changing creation time
      updatedAt: new Date().toISOString(),
    };

    this.db.prepare(`
      UPDATE missions SET
        title = ?,
        description = ?,
        status = ?,
        interviewState = ?,
        autoAdvance = ?,
        autopilotEnabled = ?,
        autopilotState = ?,
        lastAutopilotActivityAt = ?,
        updatedAt = ?
      WHERE id = ?
    `).run(
      updated.title,
      updated.description ?? null,
      updated.status,
      updated.interviewState,
      updated.autoAdvance ? 1 : 0,
      updated.autopilotEnabled ? 1 : 0,
      updated.autopilotState ?? "inactive",
      updated.lastAutopilotActivityAt ?? null,
      updated.updatedAt,
      updated.id,
    );

    this.db.bumpLastModified();
    this.emit("mission:updated", updated);
    return updated;
  }

  /**
   * Delete a mission.
   * Cascades to delete all milestones, slices, and features.
   *
   * @param id - Mission ID
   * @throws Error if mission not found
   */
  deleteMission(id: string): void {
    const mission = this.getMission(id);
    if (!mission) {
      throw new Error(`Mission ${id} not found`);
    }

    this.db.prepare("DELETE FROM missions WHERE id = ?").run(id);
    this.db.bumpLastModified();

    this.emit("mission:deleted", id);
  }

  /**
   * Update the interview state for a mission.
   * Convenience method for the specification workflow.
   *
   * @param id - Mission ID
   * @param state - New interview state
   * @returns The updated mission
   */
  updateMissionInterviewState(id: string, state: InterviewState): Mission {
    return this.updateMission(id, { interviewState: state });
  }

  // ── Milestone Operations ───────────────────────────────────────────

  /**
   * Add a milestone to a mission.
   * Automatically computes the orderIndex (max + 1).
   *
   * @param missionId - Parent mission ID
   * @param input - Milestone creation input
   * @returns The created milestone
   * @throws Error if mission not found
   */
  addMilestone(missionId: string, input: MilestoneCreateInput): Milestone {
    const mission = this.getMission(missionId);
    if (!mission) {
      throw new Error(`Mission ${missionId} not found`);
    }

    const now = new Date().toISOString();
    const id = this.generateMilestoneId();

    // Compute next orderIndex
    const existingMilestones = this.listMilestones(missionId);
    const orderIndex = existingMilestones.length > 0
      ? Math.max(...existingMilestones.map((m) => m.orderIndex)) + 1
      : 0;

    const milestone: Milestone = {
      id,
      missionId,
      title: input.title,
      description: input.description,
      status: "planning",
      orderIndex,
      interviewState: "not_started",
      dependencies: input.dependencies || [],
      createdAt: now,
      updatedAt: now,
    };

    this.db.prepare(`
      INSERT INTO milestones (id, missionId, title, description, status, orderIndex, interviewState, dependencies, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      milestone.id,
      milestone.missionId,
      milestone.title,
      milestone.description ?? null,
      milestone.status,
      milestone.orderIndex,
      milestone.interviewState,
      toJson(milestone.dependencies),
      milestone.createdAt,
      milestone.updatedAt,
    );

    this.db.bumpLastModified();
    this.emit("milestone:created", milestone);
    return milestone;
  }

  /**
   * Get a milestone by ID.
   *
   * @param id - Milestone ID
   * @returns The milestone, or undefined if not found
   */
  getMilestone(id: string): Milestone | undefined {
    const row = this.db.prepare("SELECT * FROM milestones WHERE id = ?").get(id);
    if (!row) return undefined;
    return this.rowToMilestone(row);
  }

  /**
   * List milestones for a mission, ordered by orderIndex.
   *
   * @param missionId - Mission ID
   * @returns Array of milestones
   */
  listMilestones(missionId: string): Milestone[] {
    const rows = this.db.prepare(
      "SELECT * FROM milestones WHERE missionId = ? ORDER BY orderIndex ASC"
    ).all(missionId);
    return (rows as any[]).map((row) => this.rowToMilestone(row));
  }

  /**
   * Update a milestone.
   *
   * @param id - Milestone ID
   * @param updates - Partial milestone updates
   * @returns The updated milestone
   * @throws Error if milestone not found
   */
  updateMilestone(id: string, updates: Partial<Milestone>): Milestone {
    const milestone = this.getMilestone(id);
    if (!milestone) {
      throw new Error(`Milestone ${id} not found`);
    }

    const updated: Milestone = {
      ...milestone,
      ...updates,
      id,
      missionId: milestone.missionId, // Prevent moving to different mission
      createdAt: milestone.createdAt,
      updatedAt: new Date().toISOString(),
    };

    this.db.prepare(`
      UPDATE milestones SET
        title = ?,
        description = ?,
        status = ?,
        orderIndex = ?,
        interviewState = ?,
        dependencies = ?,
        updatedAt = ?
      WHERE id = ?
    `).run(
      updated.title,
      updated.description ?? null,
      updated.status,
      updated.orderIndex,
      updated.interviewState,
      toJson(updated.dependencies),
      updated.updatedAt,
      updated.id,
    );

    this.db.bumpLastModified();
    this.emit("milestone:updated", updated);

    // Recompute mission status after milestone update
    this.recomputeMissionStatus(updated.missionId);

    return updated;
  }

  /**
   * Delete a milestone.
   * Cascades to delete all slices and features.
   *
   * @param id - Milestone ID
   * @throws Error if milestone not found
   */
  deleteMilestone(id: string): void {
    const milestone = this.getMilestone(id);
    if (!milestone) {
      throw new Error(`Milestone ${id} not found`);
    }

    const missionId = milestone.missionId;

    this.db.prepare("DELETE FROM milestones WHERE id = ?").run(id);
    this.db.bumpLastModified();

    this.emit("milestone:deleted", id);

    // Recompute mission status after deletion
    this.recomputeMissionStatus(missionId);
  }

  /**
   * Reorder milestones within a mission.
   * Updates the orderIndex for each milestone in the provided order.
   *
   * @param missionId - Mission ID
   * @param orderedIds - Milestone IDs in the desired order
   * @throws Error if any milestone is not found or belongs to a different mission
   */
  reorderMilestones(missionId: string, orderedIds: string[]): void {
    this.db.transaction(() => {
      for (let i = 0; i < orderedIds.length; i++) {
        const id = orderedIds[i];
        const milestone = this.getMilestone(id);

        if (!milestone) {
          throw new Error(`Milestone ${id} not found`);
        }
        if (milestone.missionId !== missionId) {
          throw new Error(`Milestone ${id} does not belong to mission ${missionId}`);
        }

        this.db.prepare(
          "UPDATE milestones SET orderIndex = ?, updatedAt = ? WHERE id = ?"
        ).run(i, new Date().toISOString(), id);
      }
    });

    this.db.bumpLastModified();
  }

  /**
   * Update the interview state for a milestone.
   *
   * @param id - Milestone ID
   * @param state - New interview state
   * @returns The updated milestone
   */
  updateMilestoneInterviewState(id: string, state: InterviewState): Milestone {
    return this.updateMilestone(id, { interviewState: state });
  }

  // ── Slice Operations ───────────────────────────────────────────────

  /**
   * Add a slice to a milestone.
   * Automatically computes the orderIndex (max + 1).
   * Initial status is "pending".
   *
   * @param milestoneId - Parent milestone ID
   * @param input - Slice creation input
   * @returns The created slice
   * @throws Error if milestone not found
   */
  addSlice(milestoneId: string, input: SliceCreateInput): Slice {
    const milestone = this.getMilestone(milestoneId);
    if (!milestone) {
      throw new Error(`Milestone ${milestoneId} not found`);
    }

    const now = new Date().toISOString();
    const id = this.generateSliceId();

    // Compute next orderIndex
    const existingSlices = this.listSlices(milestoneId);
    const orderIndex = existingSlices.length > 0
      ? Math.max(...existingSlices.map((s) => s.orderIndex)) + 1
      : 0;

    const slice: Slice = {
      id,
      milestoneId,
      title: input.title,
      description: input.description,
      status: "pending",
      orderIndex,
      createdAt: now,
      updatedAt: now,
    };

    this.db.prepare(`
      INSERT INTO slices (id, milestoneId, title, description, status, orderIndex, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      slice.id,
      slice.milestoneId,
      slice.title,
      slice.description ?? null,
      slice.status,
      slice.orderIndex,
      slice.createdAt,
      slice.updatedAt,
    );

    this.db.bumpLastModified();
    this.emit("slice:created", slice);
    return slice;
  }

  /**
   * Get a slice by ID.
   *
   * @param id - Slice ID
   * @returns The slice, or undefined if not found
   */
  getSlice(id: string): Slice | undefined {
    const row = this.db.prepare("SELECT * FROM slices WHERE id = ?").get(id);
    if (!row) return undefined;
    return this.rowToSlice(row);
  }

  /**
   * List slices for a milestone, ordered by orderIndex.
   *
   * @param milestoneId - Milestone ID
   * @returns Array of slices
   */
  listSlices(milestoneId: string): Slice[] {
    const rows = this.db.prepare(
      "SELECT * FROM slices WHERE milestoneId = ? ORDER BY orderIndex ASC"
    ).all(milestoneId);
    return (rows as any[]).map((row) => this.rowToSlice(row));
  }

  /**
   * Update a slice.
   *
   * @param id - Slice ID
   * @param updates - Partial slice updates
   * @returns The updated slice
   * @throws Error if slice not found
   */
  updateSlice(id: string, updates: Partial<Slice>): Slice {
    const slice = this.getSlice(id);
    if (!slice) {
      throw new Error(`Slice ${id} not found`);
    }

    const updated: Slice = {
      ...slice,
      ...updates,
      id,
      milestoneId: slice.milestoneId,
      createdAt: slice.createdAt,
      updatedAt: new Date().toISOString(),
    };

    this.db.prepare(`
      UPDATE slices SET
        title = ?,
        description = ?,
        status = ?,
        orderIndex = ?,
        activatedAt = ?,
        updatedAt = ?
      WHERE id = ?
    `).run(
      updated.title,
      updated.description ?? null,
      updated.status,
      updated.orderIndex,
      updated.activatedAt ?? null,
      updated.updatedAt,
      updated.id,
    );

    this.db.bumpLastModified();
    this.emit("slice:updated", updated);

    // Recompute milestone status after slice update
    this.recomputeMilestoneStatus(updated.milestoneId);

    return updated;
  }

  /**
   * Delete a slice.
   * Cascades to delete all features.
   *
   * @param id - Slice ID
   * @throws Error if slice not found
   */
  deleteSlice(id: string): void {
    const slice = this.getSlice(id);
    if (!slice) {
      throw new Error(`Slice ${id} not found`);
    }

    const milestoneId = slice.milestoneId;

    this.db.prepare("DELETE FROM slices WHERE id = ?").run(id);
    this.db.bumpLastModified();

    this.emit("slice:deleted", id);

    // Recompute milestone status after deletion
    this.recomputeMilestoneStatus(milestoneId);
  }

  /**
   * Reorder slices within a milestone.
   *
   * @param milestoneId - Milestone ID
   * @param orderedIds - Slice IDs in the desired order
   * @throws Error if any slice is not found or belongs to a different milestone
   */
  reorderSlices(milestoneId: string, orderedIds: string[]): void {
    this.db.transaction(() => {
      for (let i = 0; i < orderedIds.length; i++) {
        const id = orderedIds[i];
        const slice = this.getSlice(id);

        if (!slice) {
          throw new Error(`Slice ${id} not found`);
        }
        if (slice.milestoneId !== milestoneId) {
          throw new Error(`Slice ${id} does not belong to milestone ${milestoneId}`);
        }

        this.db.prepare(
          "UPDATE slices SET orderIndex = ?, updatedAt = ? WHERE id = ?"
        ).run(i, new Date().toISOString(), id);
      }
    });

    this.db.bumpLastModified();
  }

  /**
   * Activate a slice for implementation.
   * Sets status to "active" and records activation time.
   * When the parent mission has `autoAdvance: true`, all "defined" features
   * in the slice are automatically triaged (converted to tasks and linked).
   *
   * @param id - Slice ID
   * @returns The activated slice
   * @throws Error if slice not found
   */
  async activateSlice(id: string): Promise<Slice> {
    const slice = this.getSlice(id);
    if (!slice) {
      throw new Error(`Slice ${id} not found`);
    }

    const milestone = this.getMilestone(slice.milestoneId);
    const mission = milestone ? this.getMission(milestone.missionId) : undefined;

    const shouldAutoTriage = mission?.autoAdvance === true;

    const now = new Date().toISOString();
    const updated = this.updateSlice(id, {
      status: "active",
      activatedAt: now,
    });

    // Auto-triage features if autoAdvance is enabled
    if (shouldAutoTriage) {
      try {
        await this.triageSlice(id);
      } catch (err) {
        // Log but don't fail — triage failures shouldn't block slice activation
        console.error(`[MissionStore] Auto-triage failed for slice ${id}:`, err);
      }
    }

    this.emit("slice:activated", updated);
    return updated;
  }

  /**
   * Find the next pending slice in a mission.
   * Iterates milestones by orderIndex, then slices by orderIndex,
   * and returns the first slice with status "pending".
   *
   * @param missionId - Mission ID
   * @returns The next pending slice, or undefined if none found
   */
  findNextPendingSlice(missionId: string): Slice | undefined {
    const milestones = this.listMilestones(missionId);

    for (const milestone of milestones) {
      const slices = this.listSlices(milestone.id);
      for (const slice of slices) {
        if (slice.status === "pending") {
          return slice;
        }
      }
    }

    return undefined;
  }

  // ── Feature Operations ─────────────────────────────────────────────

  /**
   * Add a feature to a slice.
   * Initial status is "defined".
   *
   * @param sliceId - Parent slice ID
   * @param input - Feature creation input
   * @returns The created feature
   * @throws Error if slice not found
   */
  addFeature(sliceId: string, input: FeatureCreateInput): MissionFeature {
    const slice = this.getSlice(sliceId);
    if (!slice) {
      throw new Error(`Slice ${sliceId} not found`);
    }

    const now = new Date().toISOString();
    const id = this.generateFeatureId();

    const feature: MissionFeature = {
      id,
      sliceId,
      title: input.title,
      description: input.description,
      acceptanceCriteria: input.acceptanceCriteria,
      status: "defined",
      createdAt: now,
      updatedAt: now,
    };

    this.db.prepare(`
      INSERT INTO mission_features (id, sliceId, title, description, acceptanceCriteria, status, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      feature.id,
      feature.sliceId,
      feature.title,
      feature.description ?? null,
      feature.acceptanceCriteria ?? null,
      feature.status,
      feature.createdAt,
      feature.updatedAt,
    );

    this.db.bumpLastModified();
    this.emit("feature:created", feature);
    return feature;
  }

  /**
   * Get a feature by ID.
   *
   * @param id - Feature ID
   * @returns The feature, or undefined if not found
   */
  getFeature(id: string): MissionFeature | undefined {
    const row = this.db.prepare("SELECT * FROM mission_features WHERE id = ?").get(id);
    if (!row) return undefined;
    return this.rowToFeature(row);
  }

  /**
   * List features for a slice, ordered by creation date.
   *
   * @param sliceId - Slice ID
   * @returns Array of features
   */
  listFeatures(sliceId: string): MissionFeature[] {
    const rows = this.db.prepare(
      "SELECT * FROM mission_features WHERE sliceId = ? ORDER BY createdAt ASC"
    ).all(sliceId);
    return (rows as any[]).map((row) => this.rowToFeature(row));
  }

  /**
   * Update a feature.
   *
   * @param id - Feature ID
   * @param updates - Partial feature updates
   * @returns The updated feature
   * @throws Error if feature not found
   */
  updateFeature(id: string, updates: Partial<MissionFeature>): MissionFeature {
    const feature = this.getFeature(id);
    if (!feature) {
      throw new Error(`Feature ${id} not found`);
    }

    const updated: MissionFeature = {
      ...feature,
      ...updates,
      id,
      sliceId: feature.sliceId,
      createdAt: feature.createdAt,
      updatedAt: new Date().toISOString(),
    };

    this.db.prepare(`
      UPDATE mission_features SET
        title = ?,
        description = ?,
        acceptanceCriteria = ?,
        status = ?,
        taskId = ?,
        updatedAt = ?
      WHERE id = ?
    `).run(
      updated.title,
      updated.description ?? null,
      updated.acceptanceCriteria ?? null,
      updated.status,
      updated.taskId ?? null,
      updated.updatedAt,
      updated.id,
    );

    this.db.bumpLastModified();
    this.emit("feature:updated", updated);

    // Recompute slice status if task linkage changed
    if (updates.taskId !== undefined && updates.taskId !== feature.taskId) {
      this.recomputeSliceStatus(updated.sliceId);
    }

    return updated;
  }

  /**
   * Delete a feature.
   *
   * @param id - Feature ID
   * @throws Error if feature not found
   */
  deleteFeature(id: string): void {
    const feature = this.getFeature(id);
    if (!feature) {
      throw new Error(`Feature ${id} not found`);
    }

    const sliceId = feature.sliceId;

    this.db.prepare("DELETE FROM mission_features WHERE id = ?").run(id);
    this.db.bumpLastModified();

    this.emit("feature:deleted", id);

    // Recompute slice status after deletion
    this.recomputeSliceStatus(sliceId);
  }

  /**
   * Resolve the mission hierarchy for a slice.
   *
   * @param sliceId - Slice ID
   * @returns The slice, milestone, and mission IDs for the hierarchy
   * @throws Error if the hierarchy is incomplete
   */
  private resolveTaskLinkage(sliceId: string): { sliceId: string; missionId: string } {
    const slice = this.getSlice(sliceId);
    if (!slice) {
      throw new Error(`Slice ${sliceId} not found`);
    }

    const milestone = this.getMilestone(slice.milestoneId);
    if (!milestone) {
      throw new Error(`Milestone ${slice.milestoneId} not found for slice ${sliceId}`);
    }

    const mission = this.getMission(milestone.missionId);
    if (!mission) {
      throw new Error(`Mission ${milestone.missionId} not found for slice ${sliceId}`);
    }

    return {
      sliceId: slice.id,
      missionId: mission.id,
    };
  }

  /**
   * Link a feature to a task.
   * Updates the feature's taskId and emits feature:linked event.
   *
   * @param featureId - Feature ID
   * @param taskId - Task ID to link to
   * @returns The updated feature
   * @throws Error if feature not found
   */
  linkFeatureToTask(featureId: string, taskId: string): MissionFeature {
    const feature = this.getFeature(featureId);
    if (!feature) {
      throw new Error(`Feature ${featureId} not found`);
    }

    const linkage = this.resolveTaskLinkage(feature.sliceId);

    const updated = this.db.transaction(() => {
      const featureUpdate = this.updateFeature(featureId, {
        taskId,
        status: "triaged",
      });

      // Also update the task's mission/slice linkage for bidirectional linking.
      this.db.prepare(`
        UPDATE tasks SET missionId = ?, sliceId = ? WHERE id = ?
      `).run(linkage.missionId, linkage.sliceId, taskId);
      this.db.bumpLastModified();

      return featureUpdate;
    });

    this.emit("feature:linked", { feature: updated, taskId });

    // Recompute slice status
    this.recomputeSliceStatus(updated.sliceId);

    return updated;
  }

  /**
   * Unlink a feature from its task.
   * Clears the feature's taskId.
   *
   * @param featureId - Feature ID
   * @returns The updated feature
   * @throws Error if feature not found
   */
  unlinkFeatureFromTask(featureId: string): MissionFeature {
    const feature = this.getFeature(featureId);
    if (!feature) {
      throw new Error(`Feature ${featureId} not found`);
    }

    // Get the taskId before clearing it
    const { taskId } = feature;

    const updated = this.db.transaction(() => {
      const featureUpdate = this.updateFeature(featureId, {
        taskId: undefined,
        status: "defined",
      });

      // Clear the task's mission/slice linkage together.
      if (taskId) {
        this.db.prepare(`
          UPDATE tasks SET missionId = NULL, sliceId = NULL WHERE id = ?
        `).run(taskId);
        this.db.bumpLastModified();
      }

      return featureUpdate;
    });

    // Recompute slice status
    this.recomputeSliceStatus(updated.sliceId);

    return updated;
  }

  /**
   * Update a feature's status.
   * Recomputes slice status after update.
   *
   * @param featureId - Feature ID
   * @param status - New status
   * @returns The updated feature
   * @throws Error if feature not found
   */
  updateFeatureStatus(featureId: string, status: FeatureStatus): MissionFeature {
    const feature = this.getFeature(featureId);
    if (!feature) {
      throw new Error(`Feature ${featureId} not found`);
    }

    const updated = this.updateFeature(featureId, { status });

    // Recompute slice status
    this.recomputeSliceStatus(updated.sliceId);

    return updated;
  }

  /**
   * Find a feature by its linked task ID.
   *
   * @param taskId - Task ID
   * @returns The feature, or undefined if no feature is linked to this task
   */
  getFeatureByTaskId(taskId: string): MissionFeature | undefined {
    const row = this.db.prepare("SELECT * FROM mission_features WHERE taskId = ?").get(taskId);
    if (!row) return undefined;
    return this.rowToFeature(row);
  }

  // ── Triage Operations ────────────────────────────────────────────────

  /**
   * Triage a feature by creating a new task and linking it.
   *
   * Creates a fn task from the feature's title and description, then links
   * the feature to the newly created task using `linkFeatureToTask()`.
   * The feature status transitions from "defined" to "triaged".
   *
   * Requires MissionStore to have been constructed with a TaskStore reference.
   *
   * @param featureId - Feature ID to triage
   * @param taskTitle - Optional title override (defaults to feature title)
   * @param taskDescription - Optional description override (defaults to feature description + acceptance criteria)
   * @returns The updated feature with taskId set
   * @throws Error if feature not found, already triaged, or TaskStore not available
   */
  async triageFeature(
    featureId: string,
    taskTitle?: string,
    taskDescription?: string,
  ): Promise<MissionFeature> {
    if (!this.taskStore) {
      throw new Error("TaskStore reference is required for triage operations");
    }

    const feature = this.getFeature(featureId);
    if (!feature) {
      throw new Error(`Feature ${featureId} not found`);
    }

    if (feature.status !== "defined") {
      throw new Error(`Feature ${featureId} is already ${feature.status} (status must be "defined" to triage)`);
    }

    // Build description from feature + acceptance criteria
    const description = taskDescription || [
      feature.description,
      feature.acceptanceCriteria ? `\n**Acceptance Criteria:**\n${feature.acceptanceCriteria}` : "",
    ].filter(Boolean).join("\n\n") || feature.title;

    // Create the task
    const task = await this.taskStore.createTask({
      title: taskTitle || feature.title,
      description,
    });

    // Link the feature to the new task (this also updates feature status to "triaged")
    const updated = this.linkFeatureToTask(featureId, task.id);

    return updated;
  }

  /**
   * Triage all "defined" features in a slice.
   *
   * Convenience method that iterates over all features in a slice with
   * status "defined" and triages each one, creating a task and linking it.
   * Features that are already triaged or in-progress are skipped.
   *
   * @param sliceId - Slice ID whose features should be triaged
   * @returns Array of updated features that were triaged
   * @throws Error if slice not found or TaskStore not available
   */
  async triageSlice(sliceId: string): Promise<MissionFeature[]> {
    if (!this.taskStore) {
      throw new Error("TaskStore reference is required for triage operations");
    }

    const slice = this.getSlice(sliceId);
    if (!slice) {
      throw new Error(`Slice ${sliceId} not found`);
    }

    const features = this.listFeatures(sliceId);
    const definedFeatures = features.filter((f) => f.status === "defined");

    const triaged: MissionFeature[] = [];
    for (const feature of definedFeatures) {
      const updated = await this.triageFeature(feature.id);
      triaged.push(updated);
    }

    return triaged;
  }

  // ── Status Rollup Logic ───────────────────────────────────────────

  /**
   * Compute the status of a slice based on its features.
   * - If no features: "pending"
   * - If all features linked to done tasks: "complete"
   * - If any feature linked to in-progress task: "active"
   * - If any feature linked to triaged (ready) task: "active"
   * - Otherwise: "pending"
   *
   * @param sliceId - Slice ID
   * @returns The computed slice status
   */
  computeSliceStatus(sliceId: string): SliceStatus {
    const features = this.listFeatures(sliceId);

    if (features.length === 0) {
      return "pending";
    }

    // Check if all features are done (linked to done tasks)
    const allDone = features.every((f) => f.status === "done");
    if (allDone) {
      return "complete";
    }

    // Check if any feature is in-progress or triaged (has a task link)
    const anyActive = features.some((f) =>
      f.status === "in-progress" || f.status === "triaged" || f.taskId !== undefined
    );
    if (anyActive) {
      return "active";
    }

    return "pending";
  }

  /**
   * Compute the status of a milestone based on its slices.
   * - If any slice "active": "active"
   * - If all slices "complete": "complete"
   * - If any slice "active" or "complete" but not all complete: "active"
   * - Otherwise: "planning"
   * Note: "blocked" is manually set, not auto-computed.
   *
   * @param milestoneId - Milestone ID
   * @returns The computed milestone status
   */
  computeMilestoneStatus(milestoneId: string): MilestoneStatus {
    const slices = this.listSlices(milestoneId);

    if (slices.length === 0) {
      return "planning";
    }

    const hasActive = slices.some((s) => s.status === "active");
    const allComplete = slices.every((s) => s.status === "complete");

    if (allComplete) {
      return "complete";
    }

    if (hasActive) {
      return "active";
    }

    const hasProgress = slices.some((s) => s.status === "active" || s.status === "complete");
    if (hasProgress) {
      return "active";
    }

    return "planning";
  }

  /**
   * Compute the status of a mission based on its milestones.
   * - If any milestone "active": "active"
   * - If all milestones "complete": "complete"
   * - If any milestone "active" or "complete" but not all complete: "active"
   * - Otherwise: "planning"
   * Note: "blocked" and "archived" are manually set.
   *
   * @param missionId - Mission ID
   * @returns The computed mission status
   */
  computeMissionStatus(missionId: string): MissionStatus {
    const milestones = this.listMilestones(missionId);

    if (milestones.length === 0) {
      return "planning";
    }

    const hasActive = milestones.some((m) => m.status === "active");
    const allComplete = milestones.every((m) => m.status === "complete");

    if (allComplete) {
      return "complete";
    }

    if (hasActive) {
      return "active";
    }

    const hasProgress = milestones.some((m) => m.status === "active" || m.status === "complete");
    if (hasProgress) {
      return "active";
    }

    return "planning";
  }

  /**
   * Recompute and update the slice status.
   * Called automatically after feature changes.
   */
  private recomputeSliceStatus(sliceId: string): void {
    const newStatus = this.computeSliceStatus(sliceId);
    const slice = this.getSlice(sliceId);

    if (slice && slice.status !== newStatus) {
      this.updateSlice(sliceId, { status: newStatus });
      // Don't emit here - updateSlice already emits and triggers milestone recompute
    }
  }

  /**
   * Recompute and update the milestone status.
   * Called automatically after slice changes.
   */
  private recomputeMilestoneStatus(milestoneId: string): void {
    const newStatus = this.computeMilestoneStatus(milestoneId);
    const milestone = this.getMilestone(milestoneId);

    if (milestone && milestone.status !== newStatus) {
      this.updateMilestone(milestoneId, { status: newStatus });
      // Don't emit here - updateMilestone already emits and triggers mission recompute
    }
  }

  /**
   * Recompute and update the mission status.
   * Called automatically after milestone changes.
   */
  private recomputeMissionStatus(missionId: string): void {
    const newStatus = this.computeMissionStatus(missionId);
    const mission = this.getMission(missionId);

    if (mission && mission.status !== newStatus) {
      this.updateMission(missionId, { status: newStatus });
      // Don't emit here - updateMission already emits
    }
  }

  // ── ID Generators ───────────────────────────────────────────────────

  private generateMissionId(): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 6).toUpperCase();
    return `M-${timestamp.toString(36).toUpperCase()}-${random}`;
  }

  private generateMilestoneId(): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 6).toUpperCase();
    return `MS-${timestamp.toString(36).toUpperCase()}-${random}`;
  }

  private generateSliceId(): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 6).toUpperCase();
    return `SL-${timestamp.toString(36).toUpperCase()}-${random}`;
  }

  private generateFeatureId(): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 6).toUpperCase();
    return `F-${timestamp.toString(36).toUpperCase()}-${random}`;
  }

  private generateMissionEventId(): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 6).toUpperCase();
    return `ME-${timestamp.toString(36).toUpperCase()}-${random}`;
  }
}
