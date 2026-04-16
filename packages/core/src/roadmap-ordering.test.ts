import { describe, expect, it } from "vitest";
import {
  applyRoadmapFeatureReorder,
  applyRoadmapMilestoneReorder,
  moveRoadmapFeature,
  normalizeRoadmapFeatureOrder,
  normalizeRoadmapMilestoneOrder,
} from "./roadmap-ordering.js";
import type { RoadmapFeature, RoadmapMilestone } from "./roadmap-types.js";

function createMilestone(
  id: string,
  roadmapId: string,
  orderIndex: number,
  createdAt: string,
): RoadmapMilestone {
  return {
    id,
    roadmapId,
    title: id,
    description: `${id} description`,
    orderIndex,
    createdAt,
    updatedAt: createdAt,
  };
}

function createFeature(
  id: string,
  milestoneId: string,
  orderIndex: number,
  createdAt: string,
): RoadmapFeature {
  return {
    id,
    milestoneId,
    title: id,
    description: `${id} description`,
    orderIndex,
    createdAt,
    updatedAt: createdAt,
  };
}

describe("roadmap-ordering", () => {
  describe("normalizeRoadmapMilestoneOrder", () => {
    it("repairs milestone ordering deterministically using createdAt and id tiebreakers", () => {
      const milestones = [
        createMilestone("RMS-C", "RM-1", 2, "2026-04-13T00:00:02.000Z"),
        createMilestone("RMS-B", "RM-1", 1, "2026-04-13T00:00:01.000Z"),
        createMilestone("RMS-A", "RM-1", 1, "2026-04-13T00:00:01.000Z"),
      ];

      const normalized = normalizeRoadmapMilestoneOrder(milestones);

      expect(normalized.map((milestone) => milestone.id)).toEqual([
        "RMS-A",
        "RMS-B",
        "RMS-C",
      ]);
      expect(normalized.map((milestone) => milestone.orderIndex)).toEqual([0, 1, 2]);
      expect(milestones.map((milestone) => milestone.orderIndex)).toEqual([2, 1, 1]);
    });

    it("rejects mixed-roadmap milestone scopes", () => {
      const milestones = [
        createMilestone("RMS-1", "RM-1", 0, "2026-04-13T00:00:00.000Z"),
        createMilestone("RMS-2", "RM-2", 1, "2026-04-13T00:00:01.000Z"),
      ];

      expect(() => normalizeRoadmapMilestoneOrder(milestones)).toThrow(
        "Milestone RMS-2 does not belong to roadmap RM-1",
      );
    });
  });

  describe("applyRoadmapMilestoneReorder", () => {
    it("reorders milestones and rewrites contiguous order indexes", () => {
      const milestones = [
        createMilestone("RMS-1", "RM-1", 0, "2026-04-13T00:00:00.000Z"),
        createMilestone("RMS-2", "RM-1", 1, "2026-04-13T00:00:01.000Z"),
        createMilestone("RMS-3", "RM-1", 2, "2026-04-13T00:00:02.000Z"),
      ];

      const reordered = applyRoadmapMilestoneReorder(milestones, {
        roadmapId: "RM-1",
        orderedMilestoneIds: ["RMS-3", "RMS-1", "RMS-2"],
      });

      expect(reordered.map((milestone) => milestone.id)).toEqual([
        "RMS-3",
        "RMS-1",
        "RMS-2",
      ]);
      expect(reordered.map((milestone) => milestone.orderIndex)).toEqual([0, 1, 2]);
    });

    it("rejects duplicate milestone ids in reorder input", () => {
      const milestones = [
        createMilestone("RMS-1", "RM-1", 0, "2026-04-13T00:00:00.000Z"),
        createMilestone("RMS-2", "RM-1", 1, "2026-04-13T00:00:01.000Z"),
      ];

      expect(() =>
        applyRoadmapMilestoneReorder(milestones, {
          roadmapId: "RM-1",
          orderedMilestoneIds: ["RMS-2", "RMS-2"],
        }),
      ).toThrow("Duplicate milestone id in requested order: RMS-2");
    });
  });

  describe("normalizeRoadmapFeatureOrder", () => {
    it("repairs feature ordering deterministically using createdAt and id tiebreakers", () => {
      const features = [
        createFeature("RF-C", "RMS-1", 3, "2026-04-13T00:00:03.000Z"),
        createFeature("RF-B", "RMS-1", 1, "2026-04-13T00:00:01.000Z"),
        createFeature("RF-A", "RMS-1", 1, "2026-04-13T00:00:01.000Z"),
      ];

      const normalized = normalizeRoadmapFeatureOrder(features);

      expect(normalized.map((feature) => feature.id)).toEqual([
        "RF-A",
        "RF-B",
        "RF-C",
      ]);
      expect(normalized.map((feature) => feature.orderIndex)).toEqual([0, 1, 2]);
    });
  });

  describe("applyRoadmapFeatureReorder", () => {
    it("reorders features within a milestone and rewrites contiguous order indexes", () => {
      const features = [
        createFeature("RF-1", "RMS-1", 0, "2026-04-13T00:00:00.000Z"),
        createFeature("RF-2", "RMS-1", 1, "2026-04-13T00:00:01.000Z"),
        createFeature("RF-3", "RMS-1", 2, "2026-04-13T00:00:02.000Z"),
      ];

      const reordered = applyRoadmapFeatureReorder(features, {
        roadmapId: "RM-1",
        milestoneId: "RMS-1",
        orderedFeatureIds: ["RF-2", "RF-3", "RF-1"],
      });

      expect(reordered.map((feature) => feature.id)).toEqual([
        "RF-2",
        "RF-3",
        "RF-1",
      ]);
      expect(reordered.map((feature) => feature.orderIndex)).toEqual([0, 1, 2]);
    });

    it("rejects partial feature reorder payloads", () => {
      const features = [
        createFeature("RF-1", "RMS-1", 0, "2026-04-13T00:00:00.000Z"),
        createFeature("RF-2", "RMS-1", 1, "2026-04-13T00:00:01.000Z"),
      ];

      expect(() =>
        applyRoadmapFeatureReorder(features, {
          roadmapId: "RM-1",
          milestoneId: "RMS-1",
          orderedFeatureIds: ["RF-2"],
        }),
      ).toThrow("Expected 2 feature ids but received 1");
    });
  });

  describe("moveRoadmapFeature", () => {
    it("moves a feature across milestones and normalizes both milestone orders", () => {
      const features = [
        createFeature("RF-1", "RMS-SOURCE", 0, "2026-04-13T00:00:00.000Z"),
        createFeature("RF-2", "RMS-SOURCE", 1, "2026-04-13T00:00:01.000Z"),
        createFeature("RF-3", "RMS-TARGET", 0, "2026-04-13T00:00:02.000Z"),
        createFeature("RF-4", "RMS-TARGET", 1, "2026-04-13T00:00:03.000Z"),
      ];

      const result = moveRoadmapFeature(features, {
        roadmapId: "RM-1",
        featureId: "RF-2",
        fromMilestoneId: "RMS-SOURCE",
        toMilestoneId: "RMS-TARGET",
        targetOrderIndex: 1,
      });

      expect(result.movedFeature).toMatchObject({
        id: "RF-2",
        milestoneId: "RMS-TARGET",
        orderIndex: 1,
      });
      expect(result.sourceMilestoneFeatures.map((feature) => feature.id)).toEqual([
        "RF-1",
      ]);
      expect(result.sourceMilestoneFeatures.map((feature) => feature.orderIndex)).toEqual([0]);
      expect(result.targetMilestoneFeatures.map((feature) => feature.id)).toEqual([
        "RF-3",
        "RF-2",
        "RF-4",
      ]);
      expect(result.targetMilestoneFeatures.map((feature) => feature.orderIndex)).toEqual([
        0,
        1,
        2,
      ]);
      expect(result.affectedFeatures).toHaveLength(4);
    });

    it("clamps same-milestone moves into range and returns a single normalized list", () => {
      const features = [
        createFeature("RF-1", "RMS-1", 0, "2026-04-13T00:00:00.000Z"),
        createFeature("RF-2", "RMS-1", 1, "2026-04-13T00:00:01.000Z"),
        createFeature("RF-3", "RMS-1", 2, "2026-04-13T00:00:02.000Z"),
      ];

      const result = moveRoadmapFeature(features, {
        roadmapId: "RM-1",
        featureId: "RF-1",
        fromMilestoneId: "RMS-1",
        toMilestoneId: "RMS-1",
        targetOrderIndex: 99,
      });

      expect(result.sourceMilestoneFeatures.map((feature) => feature.id)).toEqual([
        "RF-2",
        "RF-3",
        "RF-1",
      ]);
      expect(result.targetMilestoneFeatures).toEqual(result.sourceMilestoneFeatures);
      expect(result.movedFeature.orderIndex).toBe(2);
    });

    it("rejects features outside the affected milestone scope", () => {
      const features = [
        createFeature("RF-1", "RMS-SOURCE", 0, "2026-04-13T00:00:00.000Z"),
        createFeature("RF-2", "RMS-OTHER", 0, "2026-04-13T00:00:01.000Z"),
      ];

      expect(() =>
        moveRoadmapFeature(features, {
          roadmapId: "RM-1",
          featureId: "RF-1",
          fromMilestoneId: "RMS-SOURCE",
          toMilestoneId: "RMS-TARGET",
          targetOrderIndex: 0,
        }),
      ).toThrow(
        "Feature RF-2 is outside the affected milestone scope (RMS-SOURCE → RMS-TARGET)",
      );
    });

    it("clamps negative targetOrderIndex to 0", () => {
      const features = [
        createFeature("RF-1", "RMS-1", 0, "2026-04-13T00:00:00.000Z"),
        createFeature("RF-2", "RMS-1", 1, "2026-04-13T00:00:01.000Z"),
      ];

      const result = moveRoadmapFeature(features, {
        roadmapId: "RM-1",
        featureId: "RF-2",
        fromMilestoneId: "RMS-1",
        toMilestoneId: "RMS-1",
        targetOrderIndex: -5,
      });

      // RF-2 should be moved to index 0, RF-1 to index 1
      expect(result.movedFeature.orderIndex).toBe(0);
      expect(result.sourceMilestoneFeatures.map((f) => f.id)).toEqual(["RF-2", "RF-1"]);
    });

    it("clamps NaN targetOrderIndex to end", () => {
      const features = [
        createFeature("RF-1", "RMS-1", 0, "2026-04-13T00:00:00.000Z"),
        createFeature("RF-2", "RMS-1", 1, "2026-04-13T00:00:01.000Z"),
      ];

      const result = moveRoadmapFeature(features, {
        roadmapId: "RM-1",
        featureId: "RF-1",
        fromMilestoneId: "RMS-1",
        toMilestoneId: "RMS-1",
        targetOrderIndex: NaN,
      });

      // NaN is clamped to the end (length of the remaining list)
      expect(result.movedFeature.orderIndex).toBe(1);
    });

    it("clamps Infinity targetOrderIndex to end", () => {
      const features = [
        createFeature("RF-1", "RMS-1", 0, "2026-04-13T00:00:00.000Z"),
        createFeature("RF-2", "RMS-1", 1, "2026-04-13T00:00:01.000Z"),
      ];

      const result = moveRoadmapFeature(features, {
        roadmapId: "RM-1",
        featureId: "RF-1",
        fromMilestoneId: "RMS-1",
        toMilestoneId: "RMS-1",
        targetOrderIndex: Infinity,
      });

      // Infinity is clamped to the end
      expect(result.movedFeature.orderIndex).toBe(1);
    });

    it("produces strictly contiguous orderIndex values after move", () => {
      const features = [
        createFeature("RF-1", "RMS-SOURCE", 0, "2026-04-13T00:00:00.000Z"),
        createFeature("RF-2", "RMS-SOURCE", 1, "2026-04-13T00:00:01.000Z"),
        createFeature("RF-3", "RMS-SOURCE", 2, "2026-04-13T00:00:02.000Z"),
        createFeature("RF-4", "RMS-TARGET", 0, "2026-04-13T00:00:03.000Z"),
      ];

      const result = moveRoadmapFeature(features, {
        roadmapId: "RM-1",
        featureId: "RF-2",
        fromMilestoneId: "RMS-SOURCE",
        toMilestoneId: "RMS-TARGET",
        targetOrderIndex: 0,
      });

      // Verify contiguous orderIndex for source
      const sourceOrderIndices = result.sourceMilestoneFeatures.map((f) => f.orderIndex);
      expect(sourceOrderIndices).toEqual([0, 1]);
      expect(new Set(sourceOrderIndices).size).toBe(sourceOrderIndices.length);

      // Verify contiguous orderIndex for target
      const targetOrderIndices = result.targetMilestoneFeatures.map((f) => f.orderIndex);
      expect(targetOrderIndices).toEqual([0, 1]);
      expect(new Set(targetOrderIndices).size).toBe(targetOrderIndices.length);
    });
  });
});
