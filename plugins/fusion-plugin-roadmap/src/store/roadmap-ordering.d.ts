import type { RoadmapFeature, RoadmapFeatureMoveInput, RoadmapFeatureMoveResult, RoadmapFeatureReorderInput, RoadmapMilestone, RoadmapMilestoneReorderInput } from "../roadmap-types.js";
/**
 * Repairs milestone ordering for a single roadmap scope.
 *
 * Deterministic repair order is `orderIndex ASC`, `createdAt ASC`, then `id ASC`.
 */
export declare function normalizeRoadmapMilestoneOrder(milestones: readonly RoadmapMilestone[]): RoadmapMilestone[];
/**
 * Applies an explicit milestone reorder for a single roadmap scope.
 *
 * The caller must provide the complete milestone ID set exactly once. Partial
 * or duplicate lists are rejected to keep reorders deterministic.
 */
export declare function applyRoadmapMilestoneReorder(milestones: readonly RoadmapMilestone[], input: RoadmapMilestoneReorderInput): RoadmapMilestone[];
/**
 * Repairs feature ordering for a single milestone scope.
 *
 * Deterministic repair order is `orderIndex ASC`, `createdAt ASC`, then `id ASC`.
 */
export declare function normalizeRoadmapFeatureOrder(features: readonly RoadmapFeature[]): RoadmapFeature[];
/**
 * Applies an explicit feature reorder for a single milestone scope.
 *
 * The caller must provide the complete feature ID set exactly once. Partial or
 * duplicate lists are rejected to keep reorder behavior deterministic.
 */
export declare function applyRoadmapFeatureReorder(features: readonly RoadmapFeature[], input: RoadmapFeatureReorderInput): RoadmapFeature[];
/**
 * Moves a feature within the affected milestone scope and deterministically
 * normalizes both source and destination order.
 *
 * For cross-milestone moves, pass the combined feature list from the source and
 * target milestones. For within-milestone moves, pass the current milestone's
 * feature list. `targetOrderIndex` is clamped into the destination range.
 */
export declare function moveRoadmapFeature(features: readonly RoadmapFeature[], input: RoadmapFeatureMoveInput): RoadmapFeatureMoveResult;
//# sourceMappingURL=roadmap-ordering.d.ts.map