/**
 * Pure mapping helpers for converting roadmap hierarchy data into mission/task planning handoffs.
 *
 * These helpers are read-only transformations that preserve source lineage and deterministic
 * ordering without coupling to MissionStore or task persistence.
 *
 * @module roadmap-handoff
 */

import type {
  Roadmap,
  RoadmapMilestone,
  RoadmapFeature,
  RoadmapWithHierarchy,
  RoadmapFeatureTaskPlanningHandoff,
  RoadmapMissionPlanningHandoff,
  RoadmapFeatureSourceRef,
  RoadmapMissionPlanningMilestoneHandoff,
} from "./roadmap-types.js";

import {
  normalizeRoadmapMilestoneOrder,
  normalizeRoadmapFeatureOrder,
} from "./roadmap-ordering.js";

/**
 * Build a source reference for a roadmap feature.
 *
 * Includes roadmap and milestone context for downstream planning prompts.
 */
function buildFeatureSourceRef(
  roadmap: Roadmap,
  milestone: RoadmapMilestone,
  feature: RoadmapFeature,
): RoadmapFeatureSourceRef {
  return {
    roadmapId: roadmap.id,
    milestoneId: milestone.id,
    featureId: feature.id,
    roadmapTitle: roadmap.title,
    milestoneTitle: milestone.title,
    milestoneOrderIndex: milestone.orderIndex,
    featureOrderIndex: feature.orderIndex,
  };
}

/**
 * Convert a single roadmap feature into a task planning handoff payload.
 *
 * The handoff preserves source lineage for traceability and deterministic ordering
 * for consistent downstream processing.
 */
export function mapFeatureToTaskHandoff(
  roadmap: Roadmap,
  milestone: RoadmapMilestone,
  feature: RoadmapFeature,
): RoadmapFeatureTaskPlanningHandoff {
  return {
    source: buildFeatureSourceRef(roadmap, milestone, feature),
    title: feature.title,
    description: feature.description,
  };
}

/**
 * Convert a full roadmap hierarchy into a mission planning handoff payload.
 *
 * The handoff preserves deterministic ordering by normalizing milestone and feature
 * order indices before building the payload.
 *
 * @param roadmap - The roadmap to convert
 * @param milestones - Ordered milestones (will be re-normalized for deterministic output)
 * @param featuresByMilestoneId - Features grouped by milestone ID
 * @returns Mission planning handoff payload
 */
export function mapRoadmapToMissionHandoff(
  roadmap: Roadmap,
  milestones: readonly RoadmapMilestone[],
  featuresByMilestoneId: ReadonlyMap<string, readonly RoadmapFeature[]>,
): RoadmapMissionPlanningHandoff {
  // Normalize milestone ordering deterministically
  const normalizedMilestones = normalizeRoadmapMilestoneOrder(milestones);

  const milestoneHandoffs: RoadmapMissionPlanningMilestoneHandoff[] = normalizedMilestones.map((milestone) => {
    // Get features for this milestone and normalize their order
    const rawFeatures = featuresByMilestoneId.get(milestone.id) ?? [];
    const normalizedFeatures = normalizeRoadmapFeatureOrder(rawFeatures);

    return {
      sourceMilestoneId: milestone.id,
      title: milestone.title,
      description: milestone.description,
      orderIndex: milestone.orderIndex,
      features: normalizedFeatures.map((feature) => ({
        sourceFeatureId: feature.id,
        title: feature.title,
        description: feature.description,
        orderIndex: feature.orderIndex,
      })),
    };
  });

  return {
    sourceRoadmapId: roadmap.id,
    title: roadmap.title,
    description: roadmap.description,
    milestones: milestoneHandoffs,
  };
}

/**
 * Convert a roadmap with full hierarchy into a mission planning handoff payload.
 *
 * Convenience overload that accepts the composite RoadmapWithHierarchy type.
 */
export function mapRoadmapWithHierarchyToMissionHandoff(
  roadmapWithHierarchy: RoadmapWithHierarchy,
): RoadmapMissionPlanningHandoff {
  // Build features by milestone ID map
  const featuresByMilestoneId = new Map<string, readonly RoadmapFeature[]>();
  for (const milestone of roadmapWithHierarchy.milestones) {
    featuresByMilestoneId.set(milestone.id, milestone.features);
  }

  return mapRoadmapToMissionHandoff(
    roadmapWithHierarchy,
    roadmapWithHierarchy.milestones,
    featuresByMilestoneId,
  );
}

/**
 * Convert all features from a roadmap into task planning handoff payloads.
 *
 * Flattens the roadmap hierarchy into individual feature handoffs, each preserving
 * source lineage and deterministic ordering.
 *
 * @param roadmap - The parent roadmap
 * @param milestones - Ordered milestones (will be re-normalized for deterministic output)
 * @param featuresByMilestoneId - Features grouped by milestone ID
 * @returns Array of feature task planning handoffs, ordered by milestone order then feature order
 */
export function mapAllFeaturesToTaskHandoffs(
  roadmap: Roadmap,
  milestones: readonly RoadmapMilestone[],
  featuresByMilestoneId: ReadonlyMap<string, readonly RoadmapFeature[]>,
): RoadmapFeatureTaskPlanningHandoff[] {
  // Normalize milestone ordering deterministically
  const normalizedMilestones = normalizeRoadmapMilestoneOrder(milestones);

  const handoffs: RoadmapFeatureTaskPlanningHandoff[] = [];

  for (const milestone of normalizedMilestones) {
    const rawFeatures = featuresByMilestoneId.get(milestone.id) ?? [];
    const normalizedFeatures = normalizeRoadmapFeatureOrder(rawFeatures);

    for (const feature of normalizedFeatures) {
      handoffs.push(mapFeatureToTaskHandoff(roadmap, milestone, feature));
    }
  }

  return handoffs;
}
