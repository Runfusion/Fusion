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
import { fromJson, toJson } from "./db.js";
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
} from "./mission-types.js";

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
}

// ── MissionStore Class ──────────────────────────────────────────────

export class MissionStore extends EventEmitter<MissionStoreEvents> {
  /**
   * Creates a new MissionStore instance.
   *
   * @param kbDir - Path to the .kb directory (e.g., /path/to/project/.kb)
   * @param db - Shared Database instance (same instance used by TaskStore)
   */
  constructor(
    private kbDir: string,
    private db: Database,
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

  // ── Mission CRUD Operations ────────────────────────────────────────

  /**
   * Create a new mission.
   * The mission starts in "planning" status with "not_started" interview state.
   *
   * @param input - Mission creation input
   * @returns The created mission
   */
  createMission(input: MissionCreateInput): Mission {
    const now = new Date().toISOString();
    const id = this.generateMissionId();

    const mission: Mission = {
      id,
      title: input.title,
      description: input.description,
      status: "planning",
      interviewState: "not_started",
      createdAt: now,
      updatedAt: now,
    };

    this.db.prepare(`
      INSERT INTO missions (id, title, description, status, interviewState, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      mission.id,
      mission.title,
      mission.description ?? null,
      mission.status,
      mission.interviewState,
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
        updatedAt = ?
      WHERE id = ?
    `).run(
      updated.title,
      updated.description ?? null,
      updated.status,
      updated.interviewState,
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
   *
   * @param id - Slice ID
   * @returns The activated slice
   * @throws Error if slice not found
   */
  activateSlice(id: string): Slice {
    const now = new Date().toISOString();
    const updated = this.updateSlice(id, {
      status: "active",
      activatedAt: now,
    });

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

    const updated = this.updateFeature(featureId, {
      taskId,
      status: "triaged",
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

    const updated = this.updateFeature(featureId, {
      taskId: undefined,
      status: "defined",
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
}
