/**
 * Standalone roadmap planning types.
 *
 * This model is intentionally separate from the mission hierarchy so roadmap
 * work can evolve independently of `MissionStore`/`MissionManager`.
 *
 * Core ordering invariants:
 * - milestone ordering is scoped to a single roadmap and must be contiguous + 0-based
 * - feature ordering is scoped to a single milestone and must be contiguous + 0-based
 * - cross-milestone feature moves must renumber both the source and target
 *   milestone deterministically after the move
 * - whenever stored order data is incomplete or conflicting, consumers should
 *   repair it using a stable tie-breaker (`createdAt`, then `id`, both ASC)
 *
 * These contracts are persistence-agnostic and UI-agnostic. They define the
 * canonical domain surface that downstream storage, API, and dashboard work use.
 *
 * @module roadmap-types
 */

/**
 * A standalone roadmap container.
 *
 * Roadmaps do not reuse mission lifecycle or mission status concepts. They are
 * lightweight planning artifacts that own ordered milestones.
 */
export interface Roadmap {
  /** Unique identifier (for example `RM-01HXYZ...`) */
  id: string;
  /** Display title shown in roadmap lists and detail views */
  title: string;
  /** Optional long-form planning context for the roadmap */
  description?: string;
  /** ISO-8601 timestamp of creation */
  createdAt: string;
  /** ISO-8601 timestamp of last update */
  updatedAt: string;
}

/**
 * A milestone within a roadmap.
 *
 * `orderIndex` is the canonical persisted ordering field. It is always scoped to
 * the parent roadmap and must remain contiguous + 0-based after reorder flows.
 */
export interface RoadmapMilestone {
  /** Unique identifier (for example `RMS-01HXYZ...`) */
  id: string;
  /** Parent roadmap ID */
  roadmapId: string;
  /** Display title for the milestone */
  title: string;
  /** Optional description of the milestone's goals */
  description?: string;
  /** 0-based contiguous ordering within the roadmap */
  orderIndex: number;
  /** ISO-8601 timestamp of creation */
  createdAt: string;
  /** ISO-8601 timestamp of last update */
  updatedAt: string;
}

/**
 * A feature within a roadmap milestone.
 *
 * `orderIndex` is scoped to the parent milestone. Cross-milestone moves must
 * update `milestoneId` and then normalize both affected milestone lists back to
 * contiguous 0-based order.
 */
export interface RoadmapFeature {
  /** Unique identifier (for example `RF-01HXYZ...`) */
  id: string;
  /** Parent milestone ID */
  milestoneId: string;
  /** Display title for the feature */
  title: string;
  /** Optional description of the feature's intent */
  description?: string;
  /** 0-based contiguous ordering within the parent milestone */
  orderIndex: number;
  /** ISO-8601 timestamp of creation */
  createdAt: string;
  /** ISO-8601 timestamp of last update */
  updatedAt: string;
}

// ── CRUD Input Types ────────────────────────────────────────────────

/** Input for creating a roadmap. */
export interface RoadmapCreateInput {
  /** Display title of the roadmap (required) */
  title: string;
  /** Optional roadmap description */
  description?: string;
}

/** Input for updating roadmap metadata. Ordering is handled by dedicated move/reorder DTOs. */
export interface RoadmapUpdateInput {
  /** Updated display title */
  title?: string;
  /** Updated roadmap description */
  description?: string;
}

/** Input for creating a milestone inside a roadmap. */
export interface RoadmapMilestoneCreateInput {
  /** Display title of the milestone (required) */
  title: string;
  /** Optional milestone description */
  description?: string;
}

/** Input for updating milestone metadata. Ordering is handled separately. */
export interface RoadmapMilestoneUpdateInput {
  /** Updated milestone title */
  title?: string;
  /** Updated milestone description */
  description?: string;
}

/** Input for creating a feature inside a milestone. */
export interface RoadmapFeatureCreateInput {
  /** Display title of the feature (required) */
  title: string;
  /** Optional feature description */
  description?: string;
}

/** Input for updating feature metadata. Ordering is handled separately. */
export interface RoadmapFeatureUpdateInput {
  /** Updated feature title */
  title?: string;
  /** Updated feature description */
  description?: string;
}

// ── Ordering / Move Payload Types ───────────────────────────────────

/**
 * Explicit reorder payload for milestones within a roadmap.
 *
 * `orderedMilestoneIds` must contain the full set of milestone IDs for the
 * roadmap exactly once. Consumers should reject partial or duplicate lists.
 */
export interface RoadmapMilestoneReorderInput {
  /** Roadmap whose milestone sequence is being rewritten */
  roadmapId: string;
  /** Complete milestone ID sequence in final order */
  orderedMilestoneIds: string[];
}

/**
 * Explicit reorder payload for features within a single milestone.
 *
 * `orderedFeatureIds` must contain the full set of feature IDs for the milestone
 * exactly once. The resulting `orderIndex` values must be normalized to 0-based
 * contiguous order.
 */
export interface RoadmapFeatureReorderInput {
  /** Parent roadmap for integrity validation */
  roadmapId: string;
  /** Milestone whose internal feature ordering is being rewritten */
  milestoneId: string;
  /** Complete feature ID sequence in final order */
  orderedFeatureIds: string[];
}

/**
 * Explicit move payload for relocating a feature, including cross-milestone moves.
 *
 * `targetOrderIndex` is the desired insertion position in the destination
 * milestone before final normalization. Consumers should clamp out-of-range
 * values and must deterministically renumber both source and destination
 * milestones after the move.
 */
export interface RoadmapFeatureMoveInput {
  /** Parent roadmap for integrity validation */
  roadmapId: string;
  /** Feature being moved */
  featureId: string;
  /** Current milestone that owns the feature */
  fromMilestoneId: string;
  /** Destination milestone after the move */
  toMilestoneId: string;
  /** Requested insertion index in the destination milestone */
  targetOrderIndex: number;
}

/**
 * Result of a feature move operation after deterministic renumbering.
 *
 * `affectedFeatures` contains the canonical post-move feature records for the
 * source and target milestones. When a feature is moved within the same
 * milestone, `sourceMilestoneFeatures` and `targetMilestoneFeatures` will be
 * the same normalized list.
 */
export interface RoadmapFeatureMoveResult {
  /** The moved feature after `milestoneId` and `orderIndex` updates */
  movedFeature: RoadmapFeature;
  /** Canonical post-move features for the affected milestone scope */
  affectedFeatures: RoadmapFeature[];
  /** Canonical feature list for the source milestone after the move */
  sourceMilestoneFeatures: RoadmapFeature[];
  /** Canonical feature list for the destination milestone after the move */
  targetMilestoneFeatures: RoadmapFeature[];
}

// ── Composite Read Models ───────────────────────────────────────────

/** Milestone with all of its ordered features loaded. */
export interface RoadmapMilestoneWithFeatures extends RoadmapMilestone {
  /** Features belonging to this milestone */
  features: RoadmapFeature[];
}

/** Full roadmap hierarchy loaded in roadmap → milestone → feature order. */
export interface RoadmapWithHierarchy extends Roadmap {
  /** Ordered milestones with ordered features */
  milestones: RoadmapMilestoneWithFeatures[];
}

// ── Export / Handoff Contracts ──────────────────────────────────────

/**
 * Flat export payload for persistence, APIs, import/export, and sync jobs.
 *
 * This shape intentionally keeps entities separate so downstream persistence
 * layers can upsert by table/collection without first denormalizing a nested
 * hierarchy.
 */
export interface RoadmapExportBundle {
  /** Roadmap being exported */
  roadmap: Roadmap;
  /** Ordered milestones for the roadmap */
  milestones: RoadmapMilestone[];
  /** Ordered features for the roadmap's milestones */
  features: RoadmapFeature[];
}

/**
 * Source metadata carried forward when a roadmap feature is converted into a
 * task-planning input or other downstream artifact.
 */
export interface RoadmapFeatureSourceRef {
  /** Source roadmap ID */
  roadmapId: string;
  /** Source milestone ID */
  milestoneId: string;
  /** Source feature ID */
  featureId: string;
  /** Human-readable roadmap title for prompt context */
  roadmapTitle: string;
  /** Human-readable milestone title for prompt context */
  milestoneTitle: string;
  /** Canonical milestone order at handoff time */
  milestoneOrderIndex: number;
  /** Canonical feature order at handoff time */
  featureOrderIndex: number;
}

/**
 * Handoff payload for converting a single roadmap feature into task planning
 * flows without coupling the task system to roadmap persistence details.
 */
export interface RoadmapFeatureTaskPlanningHandoff {
  /** Source lineage and ordering context */
  source: RoadmapFeatureSourceRef;
  /** Title to seed the downstream task or planning prompt */
  title: string;
  /** Optional description to seed the downstream task or planning prompt */
  description?: string;
}

/** Source-preserving milestone payload used for mission conversion handoffs. */
export interface RoadmapMissionPlanningMilestoneHandoff {
  /** Source roadmap milestone ID */
  sourceMilestoneId: string;
  /** Canonical milestone title */
  title: string;
  /** Optional milestone description */
  description?: string;
  /** Canonical milestone ordering within the roadmap */
  orderIndex: number;
  /** Ordered roadmap features that belong to this milestone */
  features: Array<{
    /** Source roadmap feature ID */
    sourceFeatureId: string;
    /** Canonical feature title */
    title: string;
    /** Optional feature description */
    description?: string;
    /** Canonical feature ordering within the milestone */
    orderIndex: number;
  }>;
}

/**
 * Handoff payload for converting a standalone roadmap into mission planning
 * structures while preserving source IDs and deterministic order.
 */
export interface RoadmapMissionPlanningHandoff {
  /** Source roadmap ID */
  sourceRoadmapId: string;
  /** Canonical roadmap title */
  title: string;
  /** Optional roadmap description */
  description?: string;
  /** Ordered milestone breakdown captured at handoff time */
  milestones: RoadmapMissionPlanningMilestoneHandoff[];
}
