/**
 * RoadmapStore - Data layer for standalone roadmap persistence.
 *
 * Manages CRUD operations for roadmaps, milestones, and features.
 * Provides deterministic ordering via covering indexes and atomic reorder/move operations.
 *
 * Ordering invariants:
 * - milestone ordering is scoped to a single roadmap and must be contiguous + 0-based
 * - feature ordering is scoped to a single milestone and must be contiguous + 0-based
 * - all list/read queries use deterministic ordering: ORDER BY orderIndex ASC, createdAt ASC, id ASC
 * - cross-milestone feature moves atomically renumber both affected milestone scopes
 */

import { EventEmitter } from "node:events";
import type { Database } from "./db.js";
import { toJsonNullable } from "./db.js";
import type {
  Roadmap,
  RoadmapMilestone,
  RoadmapFeature,
  RoadmapCreateInput,
  RoadmapUpdateInput,
  RoadmapMilestoneCreateInput,
  RoadmapMilestoneUpdateInput,
  RoadmapFeatureCreateInput,
  RoadmapFeatureUpdateInput,
  RoadmapMilestoneReorderInput,
  RoadmapFeatureReorderInput,
  RoadmapFeatureMoveInput,
  RoadmapMilestoneWithFeatures,
  RoadmapWithHierarchy,
} from "./roadmap-types.js";
import {
  normalizeRoadmapMilestoneOrder,
  applyRoadmapMilestoneReorder,
  normalizeRoadmapFeatureOrder,
  applyRoadmapFeatureReorder,
  moveRoadmapFeature,
} from "./roadmap-ordering.js";

// ── Event Types ─────────────────────────────────────────────────────

export interface RoadmapStoreEvents {
  /** Emitted when a roadmap is created */
  "roadmap:created": [Roadmap];
  /** Emitted when a roadmap is updated */
  "roadmap:updated": [Roadmap];
  /** Emitted when a roadmap is deleted */
  "roadmap:deleted": [string];
  /** Emitted when a milestone is created */
  "milestone:created": [RoadmapMilestone];
  /** Emitted when a milestone is updated */
  "milestone:updated": [RoadmapMilestone];
  /** Emitted when a milestone is deleted */
  "milestone:deleted": [string];
  /** Emitted when a milestone is reordered */
  "milestone:reordered": [{ roadmapId: string; milestones: RoadmapMilestone[] }];
  /** Emitted when a feature is created */
  "feature:created": [RoadmapFeature];
  /** Emitted when a feature is updated */
  "feature:updated": [RoadmapFeature];
  /** Emitted when a feature is deleted */
  "feature:deleted": [RoadmapFeature];
  /** Emitted when features are reordered within a milestone */
  "feature:reordered": [{ milestoneId: string; features: RoadmapFeature[] }];
  /** Emitted when a feature is moved (including cross-milestone moves) */
  "feature:moved": [{ feature: RoadmapFeature; fromMilestoneId: string; toMilestoneId: string }];
}

// ── RoadmapStore Class ──────────────────────────────────────────────

export class RoadmapStore extends EventEmitter<RoadmapStoreEvents> {
  /**
   * Creates a new RoadmapStore instance.
   *
   * @param db - Shared Database instance (same instance used by TaskStore)
   */
  constructor(private db: Database) {
    super();
    this.setMaxListeners(50);
  }

  // ── ID Generators ───────────────────────────────────────────────────

  private generateRoadmapId(): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 6).toUpperCase();
    return `RM-${timestamp.toString(36).toUpperCase()}-${random}`;
  }

  private generateMilestoneId(): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 6).toUpperCase();
    return `RMS-${timestamp.toString(36).toUpperCase()}-${random}`;
  }

  private generateFeatureId(): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 6).toUpperCase();
    return `RF-${timestamp.toString(36).toUpperCase()}-${random}`;
  }

  // ── Row-to-Object Converters ───────────────────────────────────────

  private rowToRoadmap(row: any): Roadmap {
    return {
      id: row.id,
      title: row.title,
      description: row.description || undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private rowToMilestone(row: any): RoadmapMilestone {
    return {
      id: row.id,
      roadmapId: row.roadmapId,
      title: row.title,
      description: row.description || undefined,
      orderIndex: row.orderIndex,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private rowToFeature(row: any): RoadmapFeature {
    return {
      id: row.id,
      milestoneId: row.milestoneId,
      title: row.title,
      description: row.description || undefined,
      orderIndex: row.orderIndex,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  // ── Roadmap CRUD ─────────────────────────────────────────────────

  /**
   * Create a new roadmap.
   *
   * @param input - Roadmap creation input
   * @returns The created roadmap
   */
  createRoadmap(input: RoadmapCreateInput): Roadmap {
    const now = new Date().toISOString();
    const id = this.generateRoadmapId();

    const roadmap: Roadmap = {
      id,
      title: input.title,
      description: input.description,
      createdAt: now,
      updatedAt: now,
    };

    this.db.prepare(`
      INSERT INTO roadmaps (id, title, description, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      roadmap.id,
      roadmap.title,
      roadmap.description ?? null,
      roadmap.createdAt,
      roadmap.updatedAt,
    );

    this.db.bumpLastModified();
    this.emit("roadmap:created", roadmap);
    return roadmap;
  }

  /**
   * Get a roadmap by ID.
   *
   * @param id - Roadmap ID
   * @returns The roadmap, or undefined if not found
   */
  getRoadmap(id: string): Roadmap | undefined {
    const row = this.db.prepare("SELECT * FROM roadmaps WHERE id = ?").get(id);
    if (!row) return undefined;
    return this.rowToRoadmap(row);
  }

  /**
   * List all roadmaps, ordered by creation date (newest first).
   *
   * @returns Array of roadmaps
   */
  listRoadmaps(): Roadmap[] {
    const rows = this.db.prepare(
      "SELECT * FROM roadmaps ORDER BY createdAt DESC"
    ).all();
    return (rows as any[]).map((row) => this.rowToRoadmap(row));
  }

  /**
   * Update a roadmap.
   *
   * @param id - Roadmap ID
   * @param updates - Partial roadmap updates
   * @returns The updated roadmap
   * @throws Error if roadmap not found
   */
  updateRoadmap(id: string, updates: RoadmapUpdateInput): Roadmap {
    const roadmap = this.getRoadmap(id);
    if (!roadmap) {
      throw new Error(`Roadmap ${id} not found`);
    }

    const updated: Roadmap = {
      ...roadmap,
      ...updates,
      id, // Prevent changing ID
      createdAt: roadmap.createdAt, // Prevent changing creation time
      updatedAt: new Date().toISOString(),
    };

    this.db.prepare(`
      UPDATE roadmaps SET
        title = ?,
        description = ?,
        updatedAt = ?
      WHERE id = ?
    `).run(
      updated.title,
      updated.description ?? null,
      updated.updatedAt,
      updated.id,
    );

    this.db.bumpLastModified();
    this.emit("roadmap:updated", updated);
    return updated;
  }

  /**
   * Delete a roadmap and all its milestones/features (cascading).
   *
   * @param id - Roadmap ID
   * @throws Error if roadmap not found
   */
  deleteRoadmap(id: string): void {
    const roadmap = this.getRoadmap(id);
    if (!roadmap) {
      throw new Error(`Roadmap ${id} not found`);
    }

    // SQLite FK cascade will handle milestones and features
    this.db.prepare("DELETE FROM roadmaps WHERE id = ?").run(id);
    this.db.bumpLastModified();

    this.emit("roadmap:deleted", id);
  }

  // ── Milestone CRUD ────────────────────────────────────────────────

  /**
   * Add a milestone to a roadmap.
   * Automatically computes the orderIndex (max + 1).
   *
   * @param roadmapId - Parent roadmap ID
   * @param input - Milestone creation input
   * @returns The created milestone
   * @throws Error if roadmap not found
   */
  createMilestone(roadmapId: string, input: RoadmapMilestoneCreateInput): RoadmapMilestone {
    const roadmap = this.getRoadmap(roadmapId);
    if (!roadmap) {
      throw new Error(`Roadmap ${roadmapId} not found`);
    }

    const now = new Date().toISOString();
    const id = this.generateMilestoneId();

    // Compute next orderIndex
    const existingMilestones = this.listMilestones(roadmapId);
    const orderIndex = existingMilestones.length > 0
      ? Math.max(...existingMilestones.map((m) => m.orderIndex)) + 1
      : 0;

    const milestone: RoadmapMilestone = {
      id,
      roadmapId,
      title: input.title,
      description: input.description,
      orderIndex,
      createdAt: now,
      updatedAt: now,
    };

    this.db.prepare(`
      INSERT INTO roadmap_milestones (id, roadmapId, title, description, orderIndex, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      milestone.id,
      milestone.roadmapId,
      milestone.title,
      milestone.description ?? null,
      milestone.orderIndex,
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
  getMilestone(id: string): RoadmapMilestone | undefined {
    const row = this.db.prepare("SELECT * FROM roadmap_milestones WHERE id = ?").get(id);
    if (!row) return undefined;
    return this.rowToMilestone(row);
  }

  /**
   * List milestones for a roadmap, ordered deterministically.
   *
   * Uses deterministic ordering: ORDER BY orderIndex ASC, createdAt ASC, id ASC
   * to ensure consistent results when stored order data is incomplete or conflicting.
   *
   * @param roadmapId - Roadmap ID
   * @returns Array of milestones in deterministic order
   */
  listMilestones(roadmapId: string): RoadmapMilestone[] {
    const rows = this.db.prepare(
      "SELECT * FROM roadmap_milestones WHERE roadmapId = ? ORDER BY orderIndex ASC, createdAt ASC, id ASC"
    ).all(roadmapId);
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
  updateMilestone(id: string, updates: RoadmapMilestoneUpdateInput): RoadmapMilestone {
    const milestone = this.getMilestone(id);
    if (!milestone) {
      throw new Error(`Milestone ${id} not found`);
    }

    const updated: RoadmapMilestone = {
      ...milestone,
      ...updates,
      id, // Prevent changing ID
      roadmapId: milestone.roadmapId, // Prevent moving to different roadmap
      createdAt: milestone.createdAt, // Prevent changing creation time
      updatedAt: new Date().toISOString(),
    };

    this.db.prepare(`
      UPDATE roadmap_milestones SET
        title = ?,
        description = ?,
        updatedAt = ?
      WHERE id = ?
    `).run(
      updated.title,
      updated.description ?? null,
      updated.updatedAt,
      updated.id,
    );

    this.db.bumpLastModified();
    this.emit("milestone:updated", updated);
    return updated;
  }

  /**
   * Delete a milestone and all its features (cascading).
   *
   * @param id - Milestone ID
   * @throws Error if milestone not found
   */
  deleteMilestone(id: string): void {
    const milestone = this.getMilestone(id);
    if (!milestone) {
      throw new Error(`Milestone ${id} not found`);
    }

    const roadmapId = milestone.roadmapId;

    // SQLite FK cascade will handle features
    this.db.prepare("DELETE FROM roadmap_milestones WHERE id = ?").run(id);
    this.db.bumpLastModified();

    this.emit("milestone:deleted", id);
  }

  // ── Feature CRUD ─────────────────────────────────────────────────

  /**
   * Add a feature to a milestone.
   * Automatically computes the orderIndex (max + 1).
   *
   * @param milestoneId - Parent milestone ID
   * @param input - Feature creation input
   * @returns The created feature
   * @throws Error if milestone not found
   */
  createFeature(milestoneId: string, input: RoadmapFeatureCreateInput): RoadmapFeature {
    const milestone = this.getMilestone(milestoneId);
    if (!milestone) {
      throw new Error(`Milestone ${milestoneId} not found`);
    }

    const now = new Date().toISOString();
    const id = this.generateFeatureId();

    // Compute next orderIndex
    const existingFeatures = this.listFeatures(milestoneId);
    const orderIndex = existingFeatures.length > 0
      ? Math.max(...existingFeatures.map((f) => f.orderIndex)) + 1
      : 0;

    const feature: RoadmapFeature = {
      id,
      milestoneId,
      title: input.title,
      description: input.description,
      orderIndex,
      createdAt: now,
      updatedAt: now,
    };

    this.db.prepare(`
      INSERT INTO roadmap_features (id, milestoneId, title, description, orderIndex, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      feature.id,
      feature.milestoneId,
      feature.title,
      feature.description ?? null,
      feature.orderIndex,
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
  getFeature(id: string): RoadmapFeature | undefined {
    const row = this.db.prepare("SELECT * FROM roadmap_features WHERE id = ?").get(id);
    if (!row) return undefined;
    return this.rowToFeature(row);
  }

  /**
   * List features for a milestone, ordered deterministically.
   *
   * Uses deterministic ordering: ORDER BY orderIndex ASC, createdAt ASC, id ASC
   * to ensure consistent results when stored order data is incomplete or conflicting.
   *
   * @param milestoneId - Milestone ID
   * @returns Array of features in deterministic order
   */
  listFeatures(milestoneId: string): RoadmapFeature[] {
    const rows = this.db.prepare(
      "SELECT * FROM roadmap_features WHERE milestoneId = ? ORDER BY orderIndex ASC, createdAt ASC, id ASC"
    ).all(milestoneId);
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
  updateFeature(id: string, updates: RoadmapFeatureUpdateInput): RoadmapFeature {
    const feature = this.getFeature(id);
    if (!feature) {
      throw new Error(`Feature ${id} not found`);
    }

    const updated: RoadmapFeature = {
      ...feature,
      ...updates,
      id, // Prevent changing ID
      milestoneId: feature.milestoneId, // Prevent moving via update (use moveFeature instead)
      createdAt: feature.createdAt, // Prevent changing creation time
      updatedAt: new Date().toISOString(),
    };

    this.db.prepare(`
      UPDATE roadmap_features SET
        title = ?,
        description = ?,
        updatedAt = ?
      WHERE id = ?
    `).run(
      updated.title,
      updated.description ?? null,
      updated.updatedAt,
      updated.id,
    );

    this.db.bumpLastModified();
    this.emit("feature:updated", updated);
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

    this.db.prepare("DELETE FROM roadmap_features WHERE id = ?").run(id);
    this.db.bumpLastModified();

    this.emit("feature:deleted", feature);
  }

  // ── Reorder Operations ────────────────────────────────────────────

  /**
   * Reorder milestones within a roadmap.
   *
   * Applies an explicit reorder input and persists the full normalized order.
   * The input must contain all milestone IDs exactly once.
   *
   * @param input - Reorder input with complete milestone ID list
   * @returns The reordered milestones in their new order
   * @throws Error if milestone set is incomplete, duplicate, or not found
   */
  reorderMilestones(input: RoadmapMilestoneReorderInput): RoadmapMilestone[] {
    // Validate roadmap exists
    const roadmap = this.getRoadmap(input.roadmapId);
    if (!roadmap) {
      throw new Error(`Roadmap ${input.roadmapId} not found`);
    }

    // Load current milestones with deterministic ordering
    const milestones = this.listMilestones(input.roadmapId);

    // Apply the reorder using the pure ordering helper
    const reordered = applyRoadmapMilestoneReorder(milestones, input);

    // Persist in a transaction
    this.db.transaction(() => {
      for (const milestone of reordered) {
        this.db.prepare(`
          UPDATE roadmap_milestones SET orderIndex = ?, updatedAt = ? WHERE id = ?
        `).run(milestone.orderIndex, new Date().toISOString(), milestone.id);
      }
    });

    this.db.bumpLastModified();
    this.emit("milestone:reordered", { roadmapId: input.roadmapId, milestones: reordered });

    return reordered;
  }

  /**
   * Reorder features within a milestone.
   *
   * Applies an explicit reorder input and persists the full normalized order.
   * The input must contain all feature IDs for the milestone exactly once.
   *
   * @param input - Reorder input with complete feature ID list
   * @returns The reordered features in their new order
   * @throws Error if feature set is incomplete, duplicate, or not found
   */
  reorderFeatures(input: RoadmapFeatureReorderInput): RoadmapFeature[] {
    // Validate milestone exists and belongs to the roadmap
    const milestone = this.getMilestone(input.milestoneId);
    if (!milestone) {
      throw new Error(`Milestone ${input.milestoneId} not found`);
    }
    if (milestone.roadmapId !== input.roadmapId) {
      throw new Error(`Milestone ${input.milestoneId} does not belong to roadmap ${input.roadmapId}`);
    }

    // Load current features with deterministic ordering
    const features = this.listFeatures(input.milestoneId);

    // Apply the reorder using the pure ordering helper
    const reordered = applyRoadmapFeatureReorder(features, input);

    // Persist in a transaction
    this.db.transaction(() => {
      for (const feature of reordered) {
        this.db.prepare(`
          UPDATE roadmap_features SET orderIndex = ?, updatedAt = ? WHERE id = ?
        `).run(feature.orderIndex, new Date().toISOString(), feature.id);
      }
    });

    this.db.bumpLastModified();
    this.emit("feature:reordered", { milestoneId: input.milestoneId, features: reordered });

    return reordered;
  }

  /**
   * Move a feature, including cross-milestone moves.
   *
   * Atomically renumbers both the source and destination milestone scopes.
   *
   * @param input - Move input with source/destination milestone info
   * @returns The moved feature and both affected milestone feature lists
   * @throws Error if feature or milestone not found, or scope validation fails
   */
  moveFeature(input: RoadmapFeatureMoveInput): {
    movedFeature: RoadmapFeature;
    sourceMilestoneFeatures: RoadmapFeature[];
    targetMilestoneFeatures: RoadmapFeature[];
  } {
    // Validate roadmap exists
    const roadmap = this.getRoadmap(input.roadmapId);
    if (!roadmap) {
      throw new Error(`Roadmap ${input.roadmapId} not found`);
    }

    // Validate both milestones exist and belong to the roadmap
    const fromMilestone = this.getMilestone(input.fromMilestoneId);
    const toMilestone = this.getMilestone(input.toMilestoneId);

    if (!fromMilestone) {
      throw new Error(`Source milestone ${input.fromMilestoneId} not found`);
    }
    if (!toMilestone) {
      throw new Error(`Destination milestone ${input.toMilestoneId} not found`);
    }
    if (fromMilestone.roadmapId !== input.roadmapId) {
      throw new Error(`Source milestone ${input.fromMilestoneId} does not belong to roadmap ${input.roadmapId}`);
    }
    if (toMilestone.roadmapId !== input.roadmapId) {
      throw new Error(`Destination milestone ${input.toMilestoneId} does not belong to roadmap ${input.roadmapId}`);
    }

    // Load features from both milestones with deterministic ordering
    const sourceFeatures = this.listFeatures(input.fromMilestoneId);
    const targetFeatures = this.listFeatures(input.toMilestoneId);

    // For same-milestone moves, pass only one list to avoid duplication
    // For cross-milestone moves, pass the combined list
    const allFeatures = input.fromMilestoneId === input.toMilestoneId
      ? sourceFeatures
      : [...sourceFeatures, ...targetFeatures];

    // Apply the move using the pure ordering helper
    const result = moveRoadmapFeature(allFeatures, input);

    // Persist in a transaction
    this.db.transaction(() => {
      // Update all affected features
      for (const feature of result.affectedFeatures) {
        this.db.prepare(`
          UPDATE roadmap_features SET milestoneId = ?, orderIndex = ?, updatedAt = ? WHERE id = ?
        `).run(feature.milestoneId, feature.orderIndex, new Date().toISOString(), feature.id);
      }
    });

    this.db.bumpLastModified();
    this.emit("feature:moved", {
      feature: result.movedFeature,
      fromMilestoneId: input.fromMilestoneId,
      toMilestoneId: input.toMilestoneId,
    });

    return {
      movedFeature: result.movedFeature,
      sourceMilestoneFeatures: result.sourceMilestoneFeatures,
      targetMilestoneFeatures: result.targetMilestoneFeatures,
    };
  }

  // ── Hierarchy Operations ───────────────────────────────────────────

  /**
   * Get a milestone with all of its features in deterministic order.
   *
   * @param id - Milestone ID
   * @returns The milestone with features, or undefined if not found
   */
  getMilestoneWithFeatures(id: string): RoadmapMilestoneWithFeatures | undefined {
    const milestone = this.getMilestone(id);
    if (!milestone) return undefined;

    return {
      ...milestone,
      features: this.listFeatures(id),
    };
  }

  /**
   * Get a roadmap with its full hierarchy (milestones → features).
   *
   * @param id - Roadmap ID
   * @returns The roadmap with hierarchy, or undefined if not found
   */
  getRoadmapWithHierarchy(id: string): RoadmapWithHierarchy | undefined {
    const roadmap = this.getRoadmap(id);
    if (!roadmap) return undefined;

    return {
      ...roadmap,
      milestones: this.listMilestones(id).map((milestone) => ({
        ...milestone,
        features: this.listFeatures(milestone.id),
      })),
    };
  }
}
