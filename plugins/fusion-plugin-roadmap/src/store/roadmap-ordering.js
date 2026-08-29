function compareOrderedEntities(a, b) {
    if (a.orderIndex !== b.orderIndex) {
        return a.orderIndex - b.orderIndex;
    }
    if (a.createdAt !== b.createdAt) {
        return a.createdAt.localeCompare(b.createdAt);
    }
    return a.id.localeCompare(b.id);
}
function clampInsertionIndex(targetIndex, length) {
    if (!Number.isFinite(targetIndex)) {
        return length;
    }
    const normalized = Math.trunc(targetIndex);
    if (normalized < 0) {
        return 0;
    }
    if (normalized > length) {
        return length;
    }
    return normalized;
}
function assertScopedRoadmapMilestones(milestones, roadmapId) {
    for (const milestone of milestones) {
        if (milestone.roadmapId !== roadmapId) {
            throw new Error(`Milestone ${milestone.id} does not belong to roadmap ${roadmapId}`);
        }
    }
}
function assertScopedMilestoneFeatures(features, milestoneId) {
    for (const feature of features) {
        if (feature.milestoneId !== milestoneId) {
            throw new Error(`Feature ${feature.id} does not belong to milestone ${milestoneId}`);
        }
    }
}
function assertScopedMoveFeatures(features, fromMilestoneId, toMilestoneId) {
    const validMilestoneIds = new Set([fromMilestoneId, toMilestoneId]);
    for (const feature of features) {
        if (!validMilestoneIds.has(feature.milestoneId)) {
            throw new Error(`Feature ${feature.id} is outside the affected milestone scope (${fromMilestoneId} → ${toMilestoneId})`);
        }
    }
}
function assertExactIdSet(entityLabel, actualIds, orderedIds) {
    const requestedIds = new Set();
    for (const id of orderedIds) {
        if (requestedIds.has(id)) {
            throw new Error(`Duplicate ${entityLabel} id in requested order: ${id}`);
        }
        requestedIds.add(id);
    }
    if (actualIds.length !== orderedIds.length) {
        throw new Error(`Expected ${actualIds.length} ${entityLabel} ids but received ${orderedIds.length}`);
    }
    const actualIdSet = new Set(actualIds);
    for (const id of orderedIds) {
        if (!actualIdSet.has(id)) {
            throw new Error(`${capitalize(entityLabel)} ${id} not found in scoped list`);
        }
    }
    for (const id of actualIds) {
        if (!requestedIds.has(id)) {
            throw new Error(`Missing ${entityLabel} id in requested order: ${id}`);
        }
    }
}
function capitalize(value) {
    return value.charAt(0).toUpperCase() + value.slice(1);
}
function assignContiguousOrder(items) {
    return items.map((item, orderIndex) => {
        if (item.orderIndex === orderIndex) {
            return { ...item };
        }
        return {
            ...item,
            orderIndex,
        };
    });
}
/**
 * Repairs milestone ordering for a single roadmap scope.
 *
 * Deterministic repair order is `orderIndex ASC`, `createdAt ASC`, then `id ASC`.
 */
export function normalizeRoadmapMilestoneOrder(milestones) {
    if (milestones.length === 0) {
        return [];
    }
    assertScopedRoadmapMilestones(milestones, milestones[0].roadmapId);
    return assignContiguousOrder([...milestones].sort(compareOrderedEntities));
}
/**
 * Applies an explicit milestone reorder for a single roadmap scope.
 *
 * The caller must provide the complete milestone ID set exactly once. Partial
 * or duplicate lists are rejected to keep reorders deterministic.
 */
export function applyRoadmapMilestoneReorder(milestones, input) {
    assertScopedRoadmapMilestones(milestones, input.roadmapId);
    const normalized = normalizeRoadmapMilestoneOrder(milestones);
    const ids = normalized.map((milestone) => milestone.id);
    assertExactIdSet("milestone", ids, input.orderedMilestoneIds);
    const byId = new Map(normalized.map((milestone) => [milestone.id, milestone]));
    return assignContiguousOrder(input.orderedMilestoneIds.map((id) => byId.get(id)));
}
/**
 * Repairs feature ordering for a single milestone scope.
 *
 * Deterministic repair order is `orderIndex ASC`, `createdAt ASC`, then `id ASC`.
 */
export function normalizeRoadmapFeatureOrder(features) {
    if (features.length === 0) {
        return [];
    }
    assertScopedMilestoneFeatures(features, features[0].milestoneId);
    return assignContiguousOrder([...features].sort(compareOrderedEntities));
}
/**
 * Applies an explicit feature reorder for a single milestone scope.
 *
 * The caller must provide the complete feature ID set exactly once. Partial or
 * duplicate lists are rejected to keep reorder behavior deterministic.
 */
export function applyRoadmapFeatureReorder(features, input) {
    assertScopedMilestoneFeatures(features, input.milestoneId);
    const normalized = normalizeRoadmapFeatureOrder(features);
    const ids = normalized.map((feature) => feature.id);
    assertExactIdSet("feature", ids, input.orderedFeatureIds);
    const byId = new Map(normalized.map((feature) => [feature.id, feature]));
    return assignContiguousOrder(input.orderedFeatureIds.map((id) => byId.get(id)));
}
/**
 * Moves a feature within the affected milestone scope and deterministically
 * normalizes both source and destination order.
 *
 * For cross-milestone moves, pass the combined feature list from the source and
 * target milestones. For within-milestone moves, pass the current milestone's
 * feature list. `targetOrderIndex` is clamped into the destination range.
 */
export function moveRoadmapFeature(features, input) {
    assertScopedMoveFeatures(features, input.fromMilestoneId, input.toMilestoneId);
    const existingFeature = features.find((feature) => feature.id === input.featureId);
    if (!existingFeature) {
        throw new Error(`Feature ${input.featureId} not found in affected milestone scope`);
    }
    if (existingFeature.milestoneId !== input.fromMilestoneId) {
        throw new Error(`Feature ${input.featureId} does not belong to milestone ${input.fromMilestoneId}`);
    }
    const sourceFeatures = normalizeRoadmapFeatureOrder(features.filter((feature) => feature.milestoneId === input.fromMilestoneId));
    const sourceWithoutFeature = sourceFeatures.filter((feature) => feature.id !== input.featureId);
    if (input.fromMilestoneId === input.toMilestoneId) {
        const insertionIndex = clampInsertionIndex(input.targetOrderIndex, sourceWithoutFeature.length);
        const reordered = [...sourceWithoutFeature];
        reordered.splice(insertionIndex, 0, {
            ...existingFeature,
            milestoneId: input.toMilestoneId,
            orderIndex: insertionIndex,
        });
        const normalized = assignContiguousOrder(reordered);
        const movedFeature = normalized.find((feature) => feature.id === input.featureId);
        return {
            movedFeature,
            affectedFeatures: normalized,
            sourceMilestoneFeatures: normalized,
            targetMilestoneFeatures: normalized,
        };
    }
    const targetFeatures = normalizeRoadmapFeatureOrder(features.filter((feature) => feature.milestoneId === input.toMilestoneId));
    const insertionIndex = clampInsertionIndex(input.targetOrderIndex, targetFeatures.length);
    const targetWithInsertedFeature = [...targetFeatures];
    targetWithInsertedFeature.splice(insertionIndex, 0, {
        ...existingFeature,
        milestoneId: input.toMilestoneId,
        orderIndex: insertionIndex,
    });
    const normalizedSource = assignContiguousOrder(sourceWithoutFeature);
    const normalizedTarget = assignContiguousOrder(targetWithInsertedFeature);
    const movedFeature = normalizedTarget.find((feature) => feature.id === input.featureId);
    return {
        movedFeature,
        affectedFeatures: [...normalizedSource, ...normalizedTarget],
        sourceMilestoneFeatures: normalizedSource,
        targetMilestoneFeatures: normalizedTarget,
    };
}
//# sourceMappingURL=roadmap-ordering.js.map