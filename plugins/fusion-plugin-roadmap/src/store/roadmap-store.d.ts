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
import type { Database } from "@fusion/core";
import type { Roadmap, RoadmapMilestone, RoadmapFeature, RoadmapCreateInput, RoadmapUpdateInput, RoadmapMilestoneCreateInput, RoadmapMilestoneUpdateInput, RoadmapFeatureCreateInput, RoadmapFeatureUpdateInput, RoadmapMilestoneReorderInput, RoadmapFeatureReorderInput, RoadmapFeatureMoveInput, RoadmapMilestoneWithFeatures, RoadmapWithHierarchy, RoadmapExportBundle, RoadmapMissionPlanningHandoff, RoadmapFeatureTaskPlanningHandoff } from "../roadmap-types.js";
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
    "milestone:reordered": [{
        roadmapId: string;
        milestones: RoadmapMilestone[];
    }];
    /** Emitted when a feature is created */
    "feature:created": [RoadmapFeature];
    /** Emitted when a feature is updated */
    "feature:updated": [RoadmapFeature];
    /** Emitted when a feature is deleted */
    "feature:deleted": [RoadmapFeature];
    /** Emitted when features are reordered within a milestone */
    "feature:reordered": [{
        milestoneId: string;
        features: RoadmapFeature[];
    }];
    /** Emitted when a feature is moved (including cross-milestone moves) */
    "feature:moved": [{
        feature: RoadmapFeature;
        fromMilestoneId: string;
        toMilestoneId: string;
    }];
}
export declare class RoadmapStore extends EventEmitter<RoadmapStoreEvents> {
    private db;
    /**
     * Creates a new RoadmapStore instance.
     *
     * @param db - Shared Database instance (same instance used by TaskStore)
     */
    constructor(db: Database);
    private ensureSchema;
    private generateRoadmapId;
    private generateMilestoneId;
    private generateFeatureId;
    private rowToRoadmap;
    private rowToMilestone;
    private rowToFeature;
    /**
     * Create a new roadmap.
     *
     * @param input - Roadmap creation input
     * @returns The created roadmap
     */
    createRoadmap(input: RoadmapCreateInput): Roadmap;
    /**
     * Get a roadmap by ID.
     *
     * @param id - Roadmap ID
     * @returns The roadmap, or undefined if not found
     */
    getRoadmap(id: string): Roadmap | undefined;
    /**
     * List all roadmaps, ordered by creation date (newest first).
     *
     * @returns Array of roadmaps
     */
    listRoadmaps(): Roadmap[];
    /**
     * Update a roadmap.
     *
     * @param id - Roadmap ID
     * @param updates - Partial roadmap updates
     * @returns The updated roadmap
     * @throws Error if roadmap not found
     */
    updateRoadmap(id: string, updates: RoadmapUpdateInput): Roadmap;
    /**
     * Delete a roadmap and all its milestones/features (cascading).
     *
     * @param id - Roadmap ID
     * @throws Error if roadmap not found
     */
    deleteRoadmap(id: string): void;
    /**
     * Add a milestone to a roadmap.
     * Automatically computes the orderIndex (max + 1).
     *
     * @param roadmapId - Parent roadmap ID
     * @param input - Milestone creation input
     * @returns The created milestone
     * @throws Error if roadmap not found
     */
    createMilestone(roadmapId: string, input: RoadmapMilestoneCreateInput): RoadmapMilestone;
    /**
     * Get a milestone by ID.
     *
     * @param id - Milestone ID
     * @returns The milestone, or undefined if not found
     */
    getMilestone(id: string): RoadmapMilestone | undefined;
    /**
     * List milestones for a roadmap, ordered deterministically.
     *
     * Uses deterministic ordering: ORDER BY orderIndex ASC, createdAt ASC, id ASC
     * to ensure consistent results when stored order data is incomplete or conflicting.
     *
     * @param roadmapId - Roadmap ID
     * @returns Array of milestones in deterministic order
     */
    listMilestones(roadmapId: string): RoadmapMilestone[];
    /**
     * Update a milestone.
     *
     * @param id - Milestone ID
     * @param updates - Partial milestone updates
     * @returns The updated milestone
     * @throws Error if milestone not found
     */
    updateMilestone(id: string, updates: RoadmapMilestoneUpdateInput): RoadmapMilestone;
    /**
     * Delete a milestone and all its features (cascading).
     *
     * @param id - Milestone ID
     * @throws Error if milestone not found
     */
    deleteMilestone(id: string): void;
    /**
     * Add a feature to a milestone.
     * Automatically computes the orderIndex (max + 1).
     *
     * @param milestoneId - Parent milestone ID
     * @param input - Feature creation input
     * @returns The created feature
     * @throws Error if milestone not found
     */
    createFeature(milestoneId: string, input: RoadmapFeatureCreateInput): RoadmapFeature;
    /**
     * Get a feature by ID.
     *
     * @param id - Feature ID
     * @returns The feature, or undefined if not found
     */
    getFeature(id: string): RoadmapFeature | undefined;
    /**
     * List features for a milestone, ordered deterministically.
     *
     * Uses deterministic ordering: ORDER BY orderIndex ASC, createdAt ASC, id ASC
     * to ensure consistent results when stored order data is incomplete or conflicting.
     *
     * @param milestoneId - Milestone ID
     * @returns Array of features in deterministic order
     */
    listFeatures(milestoneId: string): RoadmapFeature[];
    /**
     * Update a feature.
     *
     * @param id - Feature ID
     * @param updates - Partial feature updates
     * @returns The updated feature
     * @throws Error if feature not found
     */
    updateFeature(id: string, updates: RoadmapFeatureUpdateInput): RoadmapFeature;
    /**
     * Delete a feature.
     *
     * @param id - Feature ID
     * @throws Error if feature not found
     */
    deleteFeature(id: string): void;
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
    reorderMilestones(input: RoadmapMilestoneReorderInput): RoadmapMilestone[];
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
    reorderFeatures(input: RoadmapFeatureReorderInput): RoadmapFeature[];
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
    };
    /**
     * Get a milestone with all of its features in deterministic order.
     *
     * @param id - Milestone ID
     * @returns The milestone with features, or undefined if not found
     */
    getMilestoneWithFeatures(id: string): RoadmapMilestoneWithFeatures | undefined;
    /**
     * Get a roadmap with its full hierarchy (milestones → features).
     *
     * @param id - Roadmap ID
     * @returns The roadmap with hierarchy, or undefined if not found
     */
    getRoadmapWithHierarchy(id: string): RoadmapWithHierarchy | undefined;
    /**
     * Get a flat export bundle for a roadmap.
     *
     * Returns all roadmap data in a flat structure suitable for persistence,
     * APIs, import/export, and sync jobs. Entities are separated so downstream
     * persistence layers can upsert by table/collection.
     *
     * @param roadmapId - Roadmap ID
     * @returns The export bundle with ordered entities
     * @throws Error if roadmap not found
     */
    getRoadmapExport(roadmapId: string): RoadmapExportBundle;
    /**
     * Get a mission planning handoff payload for a roadmap.
     *
     * Converts the roadmap into a mission planning structure while preserving
     * source IDs and deterministic order. Does not couple to MissionStore internals.
     *
     * @param roadmapId - Roadmap ID
     * @returns The mission planning handoff payload
     * @throws Error if roadmap not found
     */
    getRoadmapMissionHandoff(roadmapId: string): RoadmapMissionPlanningHandoff;
    /**
     * Get a task planning handoff payload for a single roadmap feature.
     *
     * Returns a self-contained handoff payload for converting a roadmap feature
     * into task planning flows without coupling to MissionStore internals.
     *
     * @param roadmapId - Parent roadmap ID (for validation)
     * @param milestoneId - Parent milestone ID (for validation)
     * @param featureId - Feature ID to generate handoff for
     * @returns The task planning handoff payload
     * @throws Error if any entity is not found or if ownership validation fails
     */
    getRoadmapFeatureHandoff(roadmapId: string, milestoneId: string, featureId: string): RoadmapFeatureTaskPlanningHandoff;
    /**
     * Get a mission planning handoff payload for a roadmap.
     *
     * Alias for getRoadmapMissionHandoff() for API consistency.
     * Converts the roadmap into a mission planning structure while preserving
     * source IDs and deterministic order.
     *
     * @param roadmapId - Roadmap ID
     * @returns The mission planning handoff payload
     * @throws Error if roadmap not found
     */
    getMissionPlanningHandoff(roadmapId: string): RoadmapMissionPlanningHandoff;
    /**
     * List all task planning handoff payloads for a roadmap.
     *
     * Returns a flat list of all feature handoffs in deterministic order
     * (milestone order index, then feature order index).
     *
     * @param roadmapId - Roadmap ID
     * @returns Array of task planning handoff payloads for all features
     * @throws Error if roadmap not found
     */
    listFeatureTaskPlanningHandoffs(roadmapId: string): RoadmapFeatureTaskPlanningHandoff[];
}
//# sourceMappingURL=roadmap-store.d.ts.map