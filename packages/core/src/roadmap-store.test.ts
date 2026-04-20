import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Database, createDatabase } from "./db.js";
import { RoadmapStore } from "./roadmap-store.js";
import type {
  RoadmapCreateInput,
  RoadmapUpdateInput,
  RoadmapMilestoneCreateInput,
  RoadmapMilestoneUpdateInput,
  RoadmapFeatureCreateInput,
  RoadmapFeatureUpdateInput,
  RoadmapMilestoneReorderInput,
  RoadmapFeatureReorderInput,
  RoadmapFeatureMoveInput,
} from "./roadmap-types.js";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rm } from "node:fs/promises";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "roadmap-store-test-"));
}

describe("RoadmapStore", () => {
  let tmpDir: string;
  let db: Database;
  let store: RoadmapStore;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    db = new Database(join(tmpDir, ".fusion"));
    db.init();
    store = new RoadmapStore(db);
  });

  afterEach(async () => {
    db.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("roadmap CRUD", () => {
    it("creates a roadmap", () => {
      const input: RoadmapCreateInput = { title: "Test Roadmap" };
      const roadmap = store.createRoadmap(input);

      expect(roadmap.id).toMatch(/^RM-/);
      expect(roadmap.title).toBe("Test Roadmap");
      expect(roadmap.description).toBeUndefined();
      expect(roadmap.createdAt).toBeTruthy();
      expect(roadmap.updatedAt).toBeTruthy();
    });

    it("creates a roadmap with description", () => {
      const input: RoadmapCreateInput = {
        title: "Test Roadmap",
        description: "A detailed description",
      };
      const roadmap = store.createRoadmap(input);

      expect(roadmap.title).toBe("Test Roadmap");
      expect(roadmap.description).toBe("A detailed description");
    });

    it("gets a roadmap by id", () => {
      const created = store.createRoadmap({ title: "Test" });
      const retrieved = store.getRoadmap(created.id);

      expect(retrieved).toEqual(created);
    });

    it("returns undefined for non-existent roadmap", () => {
      const retrieved = store.getRoadmap("RM-nonexistent");
      expect(retrieved).toBeUndefined();
    });

    it("lists all roadmaps", () => {
      const r1 = store.createRoadmap({ title: "Roadmap 1" });
      const r2 = store.createRoadmap({ title: "Roadmap 2" });
      const r3 = store.createRoadmap({ title: "Roadmap 3" });

      const roadmaps = store.listRoadmaps();

      expect(roadmaps.length).toBe(3);
      // Should contain all three (order depends on createdAt timestamps)
      const titles = roadmaps.map((r) => r.title);
      expect(titles).toContain("Roadmap 1");
      expect(titles).toContain("Roadmap 2");
      expect(titles).toContain("Roadmap 3");
    });

    it("updates a roadmap", () => {
      const created = store.createRoadmap({ title: "Original" });
      const updated = store.updateRoadmap(created.id, { title: "Updated" } as RoadmapUpdateInput);

      expect(updated.id).toBe(created.id);
      expect(updated.title).toBe("Updated");
      expect(updated.createdAt).toBe(created.createdAt);
    });

    it("throws when updating non-existent roadmap", () => {
      expect(() => store.updateRoadmap("RM-nonexistent", { title: "Test" } as RoadmapUpdateInput))
        .toThrow("Roadmap RM-nonexistent not found");
    });

    it("deletes a roadmap", () => {
      const created = store.createRoadmap({ title: "Test" });
      store.deleteRoadmap(created.id);

      expect(store.getRoadmap(created.id)).toBeUndefined();
    });

    it("throws when deleting non-existent roadmap", () => {
      expect(() => store.deleteRoadmap("RM-nonexistent"))
        .toThrow("Roadmap RM-nonexistent not found");
    });

    it("emits roadmap:created event", () => {
      const listener = vi.fn();
      store.on("roadmap:created", listener);

      const roadmap = store.createRoadmap({ title: "Test" });

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(roadmap);
    });

    it("emits roadmap:updated event", () => {
      const created = store.createRoadmap({ title: "Original" });
      const listener = vi.fn();
      store.on("roadmap:updated", listener);

      store.updateRoadmap(created.id, { title: "Updated" } as RoadmapUpdateInput);

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(expect.objectContaining({ title: "Updated" }));
    });

    it("emits roadmap:deleted event", () => {
      const created = store.createRoadmap({ title: "Test" });
      const listener = vi.fn();
      store.on("roadmap:deleted", listener);

      store.deleteRoadmap(created.id);

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(created.id);
    });
  });

  describe("milestone CRUD", () => {
    let roadmapId: string;

    beforeEach(() => {
      roadmapId = store.createRoadmap({ title: "Test Roadmap" }).id;
    });

    it("creates a milestone with auto-computed orderIndex", () => {
      const m1 = store.createMilestone(roadmapId, { title: "Milestone 1" });
      const m2 = store.createMilestone(roadmapId, { title: "Milestone 2" });
      const m3 = store.createMilestone(roadmapId, { title: "Milestone 3" });

      expect(m1.orderIndex).toBe(0);
      expect(m2.orderIndex).toBe(1);
      expect(m3.orderIndex).toBe(2);
    });

    it("creates a milestone with description", () => {
      const milestone = store.createMilestone(roadmapId, {
        title: "Milestone",
        description: "A detailed description",
      });

      expect(milestone.title).toBe("Milestone");
      expect(milestone.description).toBe("A detailed description");
      expect(milestone.roadmapId).toBe(roadmapId);
    });

    it("throws when creating milestone for non-existent roadmap", () => {
      expect(() => store.createMilestone("RM-nonexistent", { title: "Test" }))
        .toThrow("Roadmap RM-nonexistent not found");
    });

    it("gets a milestone by id", () => {
      const created = store.createMilestone(roadmapId, { title: "Test" });
      const retrieved = store.getMilestone(created.id);

      expect(retrieved).toEqual(created);
    });

    it("lists milestones with deterministic ordering", () => {
      store.createMilestone(roadmapId, { title: "First" });
      store.createMilestone(roadmapId, { title: "Second" });
      store.createMilestone(roadmapId, { title: "Third" });

      const milestones = store.listMilestones(roadmapId);

      expect(milestones.length).toBe(3);
      expect(milestones[0].title).toBe("First");
      expect(milestones[1].title).toBe("Second");
      expect(milestones[2].title).toBe("Third");
      expect(milestones[0].orderIndex).toBe(0);
      expect(milestones[1].orderIndex).toBe(1);
      expect(milestones[2].orderIndex).toBe(2);
    });

    it("updates a milestone", () => {
      const created = store.createMilestone(roadmapId, { title: "Original" });
      const updated = store.updateMilestone(created.id, { title: "Updated" } as RoadmapMilestoneUpdateInput);

      expect(updated.id).toBe(created.id);
      expect(updated.title).toBe("Updated");
      expect(updated.roadmapId).toBe(roadmapId);
    });

    it("throws when updating non-existent milestone", () => {
      expect(() => store.updateMilestone("RMS-nonexistent", { title: "Test" } as RoadmapMilestoneUpdateInput))
        .toThrow("Milestone RMS-nonexistent not found");
    });

    it("deletes a milestone", () => {
      const created = store.createMilestone(roadmapId, { title: "Test" });
      store.deleteMilestone(created.id);

      expect(store.getMilestone(created.id)).toBeUndefined();
    });

    it("cascade-deletes features when deleting milestone", () => {
      const milestone = store.createMilestone(roadmapId, { title: "Test" });
      const feature = store.createFeature(milestone.id, { title: "Feature" });

      store.deleteMilestone(milestone.id);

      expect(store.getFeature(feature.id)).toBeUndefined();
    });

    it("cascade-deletes milestones when deleting roadmap", () => {
      const m1 = store.createMilestone(roadmapId, { title: "Milestone 1" });
      const m2 = store.createMilestone(roadmapId, { title: "Milestone 2" });

      store.deleteRoadmap(roadmapId);

      expect(store.getMilestone(m1.id)).toBeUndefined();
      expect(store.getMilestone(m2.id)).toBeUndefined();
    });
  });

  describe("feature CRUD", () => {
    let milestoneId: string;

    beforeEach(() => {
      const roadmapId = store.createRoadmap({ title: "Test Roadmap" }).id;
      milestoneId = store.createMilestone(roadmapId, { title: "Test Milestone" }).id;
    });

    it("creates a feature with auto-computed orderIndex", () => {
      const f1 = store.createFeature(milestoneId, { title: "Feature 1" });
      const f2 = store.createFeature(milestoneId, { title: "Feature 2" });
      const f3 = store.createFeature(milestoneId, { title: "Feature 3" });

      expect(f1.orderIndex).toBe(0);
      expect(f2.orderIndex).toBe(1);
      expect(f3.orderIndex).toBe(2);
    });

    it("creates a feature with description", () => {
      const feature = store.createFeature(milestoneId, {
        title: "Feature",
        description: "A detailed description",
      });

      expect(feature.title).toBe("Feature");
      expect(feature.description).toBe("A detailed description");
      expect(feature.milestoneId).toBe(milestoneId);
    });

    it("throws when creating feature for non-existent milestone", () => {
      expect(() => store.createFeature("RMS-nonexistent", { title: "Test" }))
        .toThrow("Milestone RMS-nonexistent not found");
    });

    it("gets a feature by id", () => {
      const created = store.createFeature(milestoneId, { title: "Test" });
      const retrieved = store.getFeature(created.id);

      expect(retrieved).toEqual(created);
    });

    it("lists features with deterministic ordering", () => {
      store.createFeature(milestoneId, { title: "First" });
      store.createFeature(milestoneId, { title: "Second" });
      store.createFeature(milestoneId, { title: "Third" });

      const features = store.listFeatures(milestoneId);

      expect(features.length).toBe(3);
      expect(features[0].title).toBe("First");
      expect(features[1].title).toBe("Second");
      expect(features[2].title).toBe("Third");
      expect(features[0].orderIndex).toBe(0);
      expect(features[1].orderIndex).toBe(1);
      expect(features[2].orderIndex).toBe(2);
    });

    it("updates a feature", () => {
      const created = store.createFeature(milestoneId, { title: "Original" });
      const updated = store.updateFeature(created.id, { title: "Updated" } as RoadmapFeatureUpdateInput);

      expect(updated.id).toBe(created.id);
      expect(updated.title).toBe("Updated");
      expect(updated.milestoneId).toBe(milestoneId);
    });

    it("throws when updating non-existent feature", () => {
      expect(() => store.updateFeature("RF-nonexistent", { title: "Test" } as RoadmapFeatureUpdateInput))
        .toThrow("Feature RF-nonexistent not found");
    });

    it("deletes a feature", () => {
      const created = store.createFeature(milestoneId, { title: "Test" });
      store.deleteFeature(created.id);

      expect(store.getFeature(created.id)).toBeUndefined();
    });
  });

  describe("milestone reorder", () => {
    let roadmapId: string;
    let milestoneIds: string[];

    beforeEach(() => {
      roadmapId = store.createRoadmap({ title: "Test Roadmap" }).id;
      milestoneIds = [
        store.createMilestone(roadmapId, { title: "M1" }).id,
        store.createMilestone(roadmapId, { title: "M2" }).id,
        store.createMilestone(roadmapId, { title: "M3" }).id,
      ];
    });

    it("reorders milestones with complete list", () => {
      const input: RoadmapMilestoneReorderInput = {
        roadmapId,
        orderedMilestoneIds: [milestoneIds[2], milestoneIds[0], milestoneIds[1]],
      };

      const reordered = store.reorderMilestones(input);

      expect(reordered.length).toBe(3);
      expect(reordered[0].id).toBe(milestoneIds[2]);
      expect(reordered[0].orderIndex).toBe(0);
      expect(reordered[1].id).toBe(milestoneIds[0]);
      expect(reordered[1].orderIndex).toBe(1);
      expect(reordered[2].id).toBe(milestoneIds[1]);
      expect(reordered[2].orderIndex).toBe(2);
    });

    it("rejects partial reorder list", () => {
      const input: RoadmapMilestoneReorderInput = {
        roadmapId,
        orderedMilestoneIds: [milestoneIds[2], milestoneIds[0]], // Missing milestoneIds[1]
      };

      expect(() => store.reorderMilestones(input))
        .toThrow("Expected 3 milestone ids but received 2");
    });

    it("rejects duplicate reorder list", () => {
      const input: RoadmapMilestoneReorderInput = {
        roadmapId,
        orderedMilestoneIds: [milestoneIds[0], milestoneIds[0], milestoneIds[1]], // Duplicate
      };

      expect(() => store.reorderMilestones(input))
        .toThrow("Duplicate milestone id in requested order");
    });

    it("rejects non-existent milestone in reorder list", () => {
      const input: RoadmapMilestoneReorderInput = {
        roadmapId,
        orderedMilestoneIds: [milestoneIds[0], milestoneIds[1], "RMS-nonexistent"],
      };

      expect(() => store.reorderMilestones(input))
        .toThrow("Milestone RMS-nonexistent not found");
    });

    it("emits milestone:reordered event", () => {
      const listener = vi.fn();
      store.on("milestone:reordered", listener);

      const input: RoadmapMilestoneReorderInput = {
        roadmapId,
        orderedMilestoneIds: [milestoneIds[1], milestoneIds[0], milestoneIds[2]],
      };

      store.reorderMilestones(input);

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith({
        roadmapId,
        milestones: expect.any(Array),
      });
    });
  });

  describe("feature reorder", () => {
    let roadmapId: string;
    let milestoneId: string;
    let featureIds: string[];

    beforeEach(() => {
      roadmapId = store.createRoadmap({ title: "Test Roadmap" }).id;
      milestoneId = store.createMilestone(roadmapId, { title: "Test Milestone" }).id;
      featureIds = [
        store.createFeature(milestoneId, { title: "F1" }).id,
        store.createFeature(milestoneId, { title: "F2" }).id,
        store.createFeature(milestoneId, { title: "F3" }).id,
      ];
    });

    it("reorders features with complete list", () => {
      const input: RoadmapFeatureReorderInput = {
        roadmapId,
        milestoneId,
        orderedFeatureIds: [featureIds[2], featureIds[0], featureIds[1]],
      };

      const reordered = store.reorderFeatures(input);

      expect(reordered.length).toBe(3);
      expect(reordered[0].id).toBe(featureIds[2]);
      expect(reordered[0].orderIndex).toBe(0);
      expect(reordered[1].id).toBe(featureIds[0]);
      expect(reordered[1].orderIndex).toBe(1);
      expect(reordered[2].id).toBe(featureIds[1]);
      expect(reordered[2].orderIndex).toBe(2);
    });

    it("rejects partial reorder list", () => {
      const input: RoadmapFeatureReorderInput = {
        roadmapId,
        milestoneId,
        orderedFeatureIds: [featureIds[2], featureIds[0]], // Missing featureIds[1]
      };

      expect(() => store.reorderFeatures(input))
        .toThrow("Expected 3 feature ids but received 2");
    });

    it("rejects duplicate reorder list", () => {
      const input: RoadmapFeatureReorderInput = {
        roadmapId,
        milestoneId,
        orderedFeatureIds: [featureIds[0], featureIds[0], featureIds[1]], // Duplicate
      };

      expect(() => store.reorderFeatures(input))
        .toThrow("Duplicate feature id in requested order");
    });

    it("rejects feature from wrong milestone", () => {
      const m2 = store.createMilestone(roadmapId, { title: "M2" });
      const fWrongMilestone = store.createFeature(m2.id, { title: "Wrong" });

      const input: RoadmapFeatureReorderInput = {
        roadmapId,
        milestoneId,
        orderedFeatureIds: [featureIds[0], featureIds[1], fWrongMilestone.id],
      };

      expect(() => store.reorderFeatures(input))
        .toThrow(`Feature ${fWrongMilestone.id} not found in scoped list`);
    });

    it("emits feature:reordered event", () => {
      const listener = vi.fn();
      store.on("feature:reordered", listener);

      const input: RoadmapFeatureReorderInput = {
        roadmapId,
        milestoneId,
        orderedFeatureIds: [featureIds[1], featureIds[0], featureIds[2]],
      };

      store.reorderFeatures(input);

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith({
        milestoneId,
        features: expect.any(Array),
      });
    });
  });

  describe("feature move", () => {
    let roadmapId: string;
    let milestoneA: string;
    let milestoneB: string;
    let featureA1: string;
    let featureA2: string;
    let featureB1: string;

    beforeEach(() => {
      roadmapId = store.createRoadmap({ title: "Test Roadmap" }).id;
      milestoneA = store.createMilestone(roadmapId, { title: "Milestone A" }).id;
      milestoneB = store.createMilestone(roadmapId, { title: "Milestone B" }).id;
      featureA1 = store.createFeature(milestoneA, { title: "A1" }).id;
      featureA2 = store.createFeature(milestoneA, { title: "A2" }).id;
      featureB1 = store.createFeature(milestoneB, { title: "B1" }).id;
    });

    it("moves feature within same milestone", () => {
      const input: RoadmapFeatureMoveInput = {
        roadmapId,
        featureId: featureA1,
        fromMilestoneId: milestoneA,
        toMilestoneId: milestoneA,
        targetOrderIndex: 1,
      };

      const result = store.moveFeature(input);

      expect(result.movedFeature.id).toBe(featureA1);
      expect(result.movedFeature.milestoneId).toBe(milestoneA);
      // Same milestone move: source and target are the same list
      expect(result.sourceMilestoneFeatures.length).toBe(2);
      expect(result.targetMilestoneFeatures.length).toBe(2);
      expect(result.sourceMilestoneFeatures).toEqual(result.targetMilestoneFeatures);

      // featureA1 should now be at index 1 (A2 at 0, A1 at 1)
      const moved = result.sourceMilestoneFeatures.find((f) => f.id === featureA1);
      expect(moved?.orderIndex).toBe(1);
    });

    it("moves feature across milestones", () => {
      const input: RoadmapFeatureMoveInput = {
        roadmapId,
        featureId: featureA1,
        fromMilestoneId: milestoneA,
        toMilestoneId: milestoneB,
        targetOrderIndex: 1,
      };

      const result = store.moveFeature(input);

      expect(result.movedFeature.id).toBe(featureA1);
      expect(result.movedFeature.milestoneId).toBe(milestoneB);
      expect(result.movedFeature.orderIndex).toBe(1);

      // Source milestone should have featureA2 only
      expect(result.sourceMilestoneFeatures.length).toBe(1);
      expect(result.sourceMilestoneFeatures[0].id).toBe(featureA2);

      // Target milestone should have B1 and A1
      expect(result.targetMilestoneFeatures.length).toBe(2);
      expect(result.targetMilestoneFeatures[0].id).toBe(featureB1);
      expect(result.targetMilestoneFeatures[1].id).toBe(featureA1);
    });

    it("atomically renumbers both milestones on cross-milestone move", () => {
      const input: RoadmapFeatureMoveInput = {
        roadmapId,
        featureId: featureA1,
        fromMilestoneId: milestoneA,
        toMilestoneId: milestoneB,
        targetOrderIndex: 0,
      };

      const result = store.moveFeature(input);

      // Verify source milestone renumbered
      const sourceOrder = result.sourceMilestoneFeatures.map((f) => f.orderIndex);
      expect(sourceOrder).toEqual([0]); // Only A2 remains, should be 0

      // Verify target milestone renumbered
      const targetOrder = result.targetMilestoneFeatures.map((f) => f.orderIndex);
      expect(targetOrder).toEqual([0, 1]); // A1 at 0, B1 at 1
    });

    it("rejects move of non-existent feature", () => {
      const input: RoadmapFeatureMoveInput = {
        roadmapId,
        featureId: "RF-nonexistent",
        fromMilestoneId: milestoneA,
        toMilestoneId: milestoneB,
        targetOrderIndex: 0,
      };

      expect(() => store.moveFeature(input))
        .toThrow("Feature RF-nonexistent not found in affected milestone scope");
    });

    it("rejects move from non-existent milestone", () => {
      const input: RoadmapFeatureMoveInput = {
        roadmapId,
        featureId: featureA1,
        fromMilestoneId: "RMS-nonexistent",
        toMilestoneId: milestoneB,
        targetOrderIndex: 0,
      };

      expect(() => store.moveFeature(input))
        .toThrow("Source milestone RMS-nonexistent not found");
    });

    it("rejects move to non-existent milestone", () => {
      const input: RoadmapFeatureMoveInput = {
        roadmapId,
        featureId: featureA1,
        fromMilestoneId: milestoneA,
        toMilestoneId: "RMS-nonexistent",
        targetOrderIndex: 0,
      };

      expect(() => store.moveFeature(input))
        .toThrow("Destination milestone RMS-nonexistent not found");
    });

    it("rejects move to milestone in different roadmap", () => {
      const otherRoadmap = store.createRoadmap({ title: "Other" }).id;
      const otherMilestone = store.createMilestone(otherRoadmap, { title: "Other M" }).id;

      const input: RoadmapFeatureMoveInput = {
        roadmapId,
        featureId: featureA1,
        fromMilestoneId: milestoneA,
        toMilestoneId: otherMilestone,
        targetOrderIndex: 0,
      };

      expect(() => store.moveFeature(input))
        .toThrow(`Destination milestone ${otherMilestone} does not belong to roadmap ${roadmapId}`);
    });

    it("emits feature:moved event", () => {
      const listener = vi.fn();
      store.on("feature:moved", listener);

      const input: RoadmapFeatureMoveInput = {
        roadmapId,
        featureId: featureA1,
        fromMilestoneId: milestoneA,
        toMilestoneId: milestoneB,
        targetOrderIndex: 0,
      };

      store.moveFeature(input);

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith({
        feature: expect.objectContaining({ id: featureA1, milestoneId: milestoneB }),
        fromMilestoneId: milestoneA,
        toMilestoneId: milestoneB,
      });
    });
  });

  describe("hierarchy operations", () => {
    let roadmapId: string;
    let milestoneId1: string;
    let milestoneId2: string;

    beforeEach(() => {
      roadmapId = store.createRoadmap({ title: "Test Roadmap" }).id;
      milestoneId1 = store.createMilestone(roadmapId, { title: "M1" }).id;
      milestoneId2 = store.createMilestone(roadmapId, { title: "M2" }).id;
      store.createFeature(milestoneId1, { title: "F1" });
      store.createFeature(milestoneId1, { title: "F2" });
      store.createFeature(milestoneId2, { title: "F3" });
    });

    it("gets milestone with features", () => {
      const result = store.getMilestoneWithFeatures(milestoneId1);

      expect(result).toBeDefined();
      expect(result!.id).toBe(milestoneId1);
      expect(result!.features.length).toBe(2);
      expect(result!.features[0].title).toBe("F1");
      expect(result!.features[1].title).toBe("F2");
    });

    it("returns undefined for non-existent milestone in getMilestoneWithFeatures", () => {
      const result = store.getMilestoneWithFeatures("RMS-nonexistent");
      expect(result).toBeUndefined();
    });

    it("gets roadmap with full hierarchy", () => {
      const result = store.getRoadmapWithHierarchy(roadmapId);

      expect(result).toBeDefined();
      expect(result!.id).toBe(roadmapId);
      expect(result!.title).toBe("Test Roadmap");
      expect(result!.milestones.length).toBe(2);

      // Milestones should be in order
      expect(result!.milestones[0].id).toBe(milestoneId1);
      expect(result!.milestones[1].id).toBe(milestoneId2);

      // Features should be in order
      expect(result!.milestones[0].features.length).toBe(2);
      expect(result!.milestones[1].features.length).toBe(1);
    });

    it("returns undefined for non-existent roadmap in getRoadmapWithHierarchy", () => {
      const result = store.getRoadmapWithHierarchy("RM-nonexistent");
      expect(result).toBeUndefined();
    });
  });

  describe("deterministic ordering", () => {
    it("orders by orderIndex, createdAt, id when orderIndex values are equal", () => {
      const roadmapId = store.createRoadmap({ title: "Test" }).id;
      const milestoneId = store.createMilestone(roadmapId, { title: "M1" }).id;

      // Create features rapidly (same millisecond timestamps possible)
      const f1 = store.createFeature(milestoneId, { title: "Alpha" });
      const f2 = store.createFeature(milestoneId, { title: "Beta" });
      const f3 = store.createFeature(milestoneId, { title: "Gamma" });

      // Verify deterministic ordering
      const features = store.listFeatures(milestoneId);
      expect(features.map((f) => f.id)).toEqual([f1.id, f2.id, f3.id]);
    });

    it("handles gap in orderIndex values", () => {
      const roadmapId = store.createRoadmap({ title: "Test" }).id;
      const milestoneId = store.createMilestone(roadmapId, { title: "M" }).id;

      // Manually create gaps
      db.prepare("UPDATE roadmap_milestones SET orderIndex = 10 WHERE id = ?").run(milestoneId);
      db.prepare("UPDATE roadmap_milestones SET orderIndex = 20 WHERE id = ?").run(
        store.createMilestone(roadmapId, { title: "Second" }).id
      );

      const milestones = store.listMilestones(roadmapId);
      expect(milestones[0].orderIndex).toBe(10);
      expect(milestones[1].orderIndex).toBe(20);
    });
  });

  describe("schema version", () => {
    it("schema version is 40 after init", () => {
      expect(db.getSchemaVersion()).toBe(41);
    });
  });

  describe("export / handoff", () => {
    describe("getRoadmapExport", () => {
      it("returns flat export bundle with all entities", () => {
        const roadmap = store.createRoadmap({ title: "Export Test", description: "Test description" });
        const m1 = store.createMilestone(roadmap.id, { title: "Milestone 1" });
        const m2 = store.createMilestone(roadmap.id, { title: "Milestone 2" });
        const f1 = store.createFeature(m1.id, { title: "Feature 1" });
        const f2 = store.createFeature(m1.id, { title: "Feature 2" });
        const f3 = store.createFeature(m2.id, { title: "Feature 3" });

        const export_ = store.getRoadmapExport(roadmap.id);

        expect(export_.roadmap.id).toBe(roadmap.id);
        expect(export_.roadmap.title).toBe("Export Test");
        expect(export_.milestones.length).toBe(2);
        expect(export_.features.length).toBe(3);
        expect(export_.features.map((f) => f.id)).toEqual([f1.id, f2.id, f3.id]);
      });

      it("returns milestones in deterministic order", () => {
        const roadmap = store.createRoadmap({ title: "Order Test" });
        // Create in reverse order to test deterministic sorting
        const m2 = store.createMilestone(roadmap.id, { title: "Second" });
        const m1 = store.createMilestone(roadmap.id, { title: "First" });

        // m2 was created first (orderIndex 0), m1 was created second (orderIndex 1)
        // Deterministic order: orderIndex ASC → m2 comes first
        const export_ = store.getRoadmapExport(roadmap.id);

        expect(export_.milestones[0].id).toBe(m2.id);
        expect(export_.milestones[1].id).toBe(m1.id);
      });

      it("returns features grouped by milestone in deterministic order", () => {
        const roadmap = store.createRoadmap({ title: "Features Order" });
        const m1 = store.createMilestone(roadmap.id, { title: "M1" });
        // Create in reverse order to test deterministic sorting
        const f2 = store.createFeature(m1.id, { title: "F2" });
        const f1 = store.createFeature(m1.id, { title: "F1" });

        // f2 was created first (orderIndex 0), f1 was created second (orderIndex 1)
        // Deterministic order: orderIndex ASC → f2 comes first
        const export_ = store.getRoadmapExport(roadmap.id);

        expect(export_.features.length).toBe(2);
        expect(export_.features[0].id).toBe(f2.id);
        expect(export_.features[1].id).toBe(f1.id);
      });

      it("throws for non-existent roadmap", () => {
        expect(() => store.getRoadmapExport("RM-nonexistent")).toThrow("Roadmap RM-nonexistent not found");
      });

      it("returns empty arrays when roadmap has no milestones", () => {
        const roadmap = store.createRoadmap({ title: "Empty" });
        const export_ = store.getRoadmapExport(roadmap.id);

        expect(export_.milestones).toEqual([]);
        expect(export_.features).toEqual([]);
      });
    });

    describe("getRoadmapMissionHandoff", () => {
      it("returns mission planning handoff with source IDs preserved", () => {
        const roadmap = store.createRoadmap({ title: "Mission Handoff", description: "Mission desc" });
        const m1 = store.createMilestone(roadmap.id, { title: "Phase 1", description: "Phase 1 desc" });
        const m2 = store.createMilestone(roadmap.id, { title: "Phase 2" });
        const f1 = store.createFeature(m1.id, { title: "Task A", description: "Task A desc" });
        const f2 = store.createFeature(m2.id, { title: "Task B" });

        const handoff = store.getRoadmapMissionHandoff(roadmap.id);

        expect(handoff.sourceRoadmapId).toBe(roadmap.id);
        expect(handoff.title).toBe("Mission Handoff");
        expect(handoff.description).toBe("Mission desc");
        expect(handoff.milestones.length).toBe(2);
        expect(handoff.milestones[0].sourceMilestoneId).toBe(m1.id);
        expect(handoff.milestones[0].title).toBe("Phase 1");
        expect(handoff.milestones[0].description).toBe("Phase 1 desc");
        expect(handoff.milestones[0].features.length).toBe(1);
        expect(handoff.milestones[0].features[0].sourceFeatureId).toBe(f1.id);
        expect(handoff.milestones[0].features[0].title).toBe("Task A");
        expect(handoff.milestones[1].features.length).toBe(1);
        expect(handoff.milestones[1].features[0].sourceFeatureId).toBe(f2.id);
      });

      it("preserves deterministic ordering in handoff", () => {
        const roadmap = store.createRoadmap({ title: "Order Check" });
        const m1 = store.createMilestone(roadmap.id, { title: "M1" });
        const f1 = store.createFeature(m1.id, { title: "First" });
        const f2 = store.createFeature(m1.id, { title: "Second" });
        const f3 = store.createFeature(m1.id, { title: "Third" });

        const handoff = store.getRoadmapMissionHandoff(roadmap.id);

        expect(handoff.milestones[0].features[0].sourceFeatureId).toBe(f1.id);
        expect(handoff.milestones[0].features[1].sourceFeatureId).toBe(f2.id);
        expect(handoff.milestones[0].features[2].sourceFeatureId).toBe(f3.id);
      });

      it("throws for non-existent roadmap", () => {
        expect(() => store.getRoadmapMissionHandoff("RM-nonexistent")).toThrow("Roadmap RM-nonexistent not found");
      });

      it("includes orderIndex for milestones and features", () => {
        const roadmap = store.createRoadmap({ title: "Index Test" });
        const m1 = store.createMilestone(roadmap.id, { title: "First" });
        const m2 = store.createMilestone(roadmap.id, { title: "Second" });
        const f1 = store.createFeature(m1.id, { title: "F1" });
        const f2 = store.createFeature(m2.id, { title: "F2" });

        const handoff = store.getRoadmapMissionHandoff(roadmap.id);

        // Milestones should be in deterministic order (m1 created first, so orderIndex 0)
        expect(handoff.milestones[0].sourceMilestoneId).toBe(m1.id);
        expect(handoff.milestones[0].orderIndex).toBeDefined();
        expect(handoff.milestones[1].sourceMilestoneId).toBe(m2.id);
        expect(handoff.milestones[1].orderIndex).toBeDefined();
        // Features should be in deterministic order
        expect(handoff.milestones[0].features[0].sourceFeatureId).toBe(f1.id);
        expect(handoff.milestones[0].features[0].orderIndex).toBeDefined();
        expect(handoff.milestones[1].features[0].sourceFeatureId).toBe(f2.id);
        expect(handoff.milestones[1].features[0].orderIndex).toBeDefined();
      });
    });

    describe("getRoadmapFeatureHandoff", () => {
      it("returns task planning handoff for a feature", () => {
        const roadmap = store.createRoadmap({ title: "Feature Handoff" });
        const m1 = store.createMilestone(roadmap.id, { title: "Phase 1" });
        const f1 = store.createFeature(m1.id, { title: "Feature A", description: "Feature A desc" });

        const handoff = store.getRoadmapFeatureHandoff(roadmap.id, m1.id, f1.id);

        expect(handoff.source.roadmapId).toBe(roadmap.id);
        expect(handoff.source.milestoneId).toBe(m1.id);
        expect(handoff.source.featureId).toBe(f1.id);
        expect(handoff.source.roadmapTitle).toBe("Feature Handoff");
        expect(handoff.source.milestoneTitle).toBe("Phase 1");
        expect(handoff.source.milestoneOrderIndex).toBeDefined();
        expect(handoff.source.featureOrderIndex).toBeDefined();
        expect(handoff.title).toBe("Feature A");
        expect(handoff.description).toBe("Feature A desc");
      });

      it("throws for non-existent roadmap", () => {
        const roadmap = store.createRoadmap({ title: "Test" });
        const m1 = store.createMilestone(roadmap.id, { title: "M1" });
        const f1 = store.createFeature(m1.id, { title: "F1" });

        expect(() => store.getRoadmapFeatureHandoff("RM-nonexistent", m1.id, f1.id)).toThrow("Roadmap RM-nonexistent not found");
      });

      it("throws for non-existent milestone", () => {
        const roadmap = store.createRoadmap({ title: "Test" });

        expect(() => store.getRoadmapFeatureHandoff(roadmap.id, "RMS-nonexistent", "RF-nonexistent")).toThrow("Milestone RMS-nonexistent not found");
      });

      it("throws when milestone does not belong to roadmap", () => {
        const roadmap1 = store.createRoadmap({ title: "Roadmap 1" });
        const roadmap2 = store.createRoadmap({ title: "Roadmap 2" });
        const m2 = store.createMilestone(roadmap2.id, { title: "M2" });
        const f2 = store.createFeature(m2.id, { title: "F2" });

        expect(() => store.getRoadmapFeatureHandoff(roadmap1.id, m2.id, f2.id)).toThrow(`Milestone ${m2.id} does not belong to roadmap ${roadmap1.id}`);
      });

      it("throws for non-existent feature", () => {
        const roadmap = store.createRoadmap({ title: "Test" });
        const m1 = store.createMilestone(roadmap.id, { title: "M1" });

        expect(() => store.getRoadmapFeatureHandoff(roadmap.id, m1.id, "RF-nonexistent")).toThrow("Feature RF-nonexistent not found");
      });

      it("throws when feature does not belong to milestone", () => {
        const roadmap = store.createRoadmap({ title: "Test" });
        const m1 = store.createMilestone(roadmap.id, { title: "M1" });
        const m2 = store.createMilestone(roadmap.id, { title: "M2" });
        const f2 = store.createFeature(m2.id, { title: "F2" });

        expect(() => store.getRoadmapFeatureHandoff(roadmap.id, m1.id, f2.id)).toThrow(`Feature ${f2.id} does not belong to milestone ${m1.id}`);
      });

      it("includes order indices in source reference", () => {
        const roadmap = store.createRoadmap({ title: "Order Test" });
        const m1 = store.createMilestone(roadmap.id, { title: "First" });
        const m2 = store.createMilestone(roadmap.id, { title: "Second" });
        const f1 = store.createFeature(m1.id, { title: "F1" });
        const f2 = store.createFeature(m2.id, { title: "F2" });

        // M1 is created first so has orderIndex 0, M2 has orderIndex 1
        const handoff1 = store.getRoadmapFeatureHandoff(roadmap.id, m1.id, f1.id);
        const handoff2 = store.getRoadmapFeatureHandoff(roadmap.id, m2.id, f2.id);

        // m1 was created first so it has lower orderIndex
        expect(handoff1.source.milestoneOrderIndex).toBeLessThan(handoff2.source.milestoneOrderIndex);
      });
    });

    describe("getMissionPlanningHandoff", () => {
      it("is an alias for getRoadmapMissionHandoff with same behavior", () => {
        const roadmap = store.createRoadmap({ title: "Alias Test" });
        const m1 = store.createMilestone(roadmap.id, { title: "M1" });
        const f1 = store.createFeature(m1.id, { title: "F1" });

        const result1 = store.getRoadmapMissionHandoff(roadmap.id);
        const result2 = store.getMissionPlanningHandoff(roadmap.id);

        // Both should return equivalent results
        expect(result1.sourceRoadmapId).toBe(result2.sourceRoadmapId);
        expect(result1.title).toBe(result2.title);
        expect(result1.description).toBe(result2.description);
        expect(result1.milestones.length).toBe(result2.milestones.length);
        expect(result1.milestones[0].sourceMilestoneId).toBe(result2.milestones[0].sourceMilestoneId);
      });
    });

    describe("listFeatureTaskPlanningHandoffs", () => {
      it("returns empty array for roadmap with no milestones", () => {
        const roadmap = store.createRoadmap({ title: "Empty" });
        const handoffs = store.listFeatureTaskPlanningHandoffs(roadmap.id);
        expect(handoffs).toEqual([]);
      });

      it("returns empty array for roadmap with milestones but no features", () => {
        const roadmap = store.createRoadmap({ title: "No Features" });
        store.createMilestone(roadmap.id, { title: "M1" });
        store.createMilestone(roadmap.id, { title: "M2" });

        const handoffs = store.listFeatureTaskPlanningHandoffs(roadmap.id);
        expect(handoffs).toEqual([]);
      });

      it("returns flattened feature handoffs in deterministic order", () => {
        const roadmap = store.createRoadmap({ title: "Flat Test" });
        const m1 = store.createMilestone(roadmap.id, { title: "M1" });
        const m2 = store.createMilestone(roadmap.id, { title: "M2" });
        const f1 = store.createFeature(m1.id, { title: "F1", description: "Desc 1" });
        const f2 = store.createFeature(m1.id, { title: "F2", description: "Desc 2" });
        const f3 = store.createFeature(m2.id, { title: "F3" });

        const handoffs = store.listFeatureTaskPlanningHandoffs(roadmap.id);

        expect(handoffs).toHaveLength(3);
        // Milestone order: m1 (orderIndex 0), m2 (orderIndex 1)
        // Feature order within milestone: f1 (orderIndex 0), f2 (orderIndex 1)
        // Flattened: f1, f2, f3
        expect(handoffs[0].source.featureId).toBe(f1.id);
        expect(handoffs[0].title).toBe("F1");
        expect(handoffs[0].description).toBe("Desc 1");
        expect(handoffs[1].source.featureId).toBe(f2.id);
        expect(handoffs[1].title).toBe("F2");
        expect(handoffs[2].source.featureId).toBe(f3.id);
      });

      it("preserves source lineage in each handoff", () => {
        const roadmap = store.createRoadmap({ title: "Lineage Test", description: "Roadmap desc" });
        const m1 = store.createMilestone(roadmap.id, { title: "Milestone Title" });
        const f1 = store.createFeature(m1.id, { title: "Feature Title", description: "Feature desc" });

        const handoffs = store.listFeatureTaskPlanningHandoffs(roadmap.id);

        expect(handoffs).toHaveLength(1);
        expect(handoffs[0].source.roadmapId).toBe(roadmap.id);
        expect(handoffs[0].source.roadmapTitle).toBe("Lineage Test");
        expect(handoffs[0].source.milestoneId).toBe(m1.id);
        expect(handoffs[0].source.milestoneTitle).toBe("Milestone Title");
        expect(handoffs[0].source.featureId).toBe(f1.id);
        expect(handoffs[0].source.milestoneOrderIndex).toBe(0);
        expect(handoffs[0].source.featureOrderIndex).toBe(0);
      });

      it("throws for non-existent roadmap", () => {
        expect(() => store.listFeatureTaskPlanningHandoffs("RM-nonexistent")).toThrow("Roadmap RM-nonexistent not found");
      });
    });
  });

  describe("persistence re-instantiation", () => {
    // These tests manage their own setup/teardown to avoid conflicts with shared afterEach
    it("survives store re-instantiation with all entities intact", async () => {
      // Create own temp directory for this test
      const persistTmpDir = makeTmpDir();
      try {
        const persistDb = new Database(join(persistTmpDir, ".fusion"));
        persistDb.init();
        const persistStore = new RoadmapStore(persistDb);

        // Create a roadmap, milestones, and features
        const roadmap = persistStore.createRoadmap({ title: "Persistence Test", description: "Test description" });
        const m1 = persistStore.createMilestone(roadmap.id, { title: "Milestone 1", description: "M1 desc" });
        const m2 = persistStore.createMilestone(roadmap.id, { title: "Milestone 2" });
        const f1 = persistStore.createFeature(m1.id, { title: "Feature 1", description: "F1 desc" });
        const f2 = persistStore.createFeature(m1.id, { title: "Feature 2" });
        const f3 = persistStore.createFeature(m2.id, { title: "Feature 3" });

        // Close and reopen the store from the same database
        persistDb.close();

        const reopenedDb = new Database(join(persistTmpDir, ".fusion"));
        reopenedDb.init();
        const reopenedStore = new RoadmapStore(reopenedDb);

        // Verify all data persisted correctly
        const persistedRoadmap = reopenedStore.getRoadmap(roadmap.id);
        expect(persistedRoadmap).toBeDefined();
        expect(persistedRoadmap!.title).toBe("Persistence Test");
        expect(persistedRoadmap!.description).toBe("Test description");

        const persistedMilestones = reopenedStore.listMilestones(roadmap.id);
        expect(persistedMilestones).toHaveLength(2);
        expect(persistedMilestones[0].title).toBe("Milestone 1");
        expect(persistedMilestones[1].title).toBe("Milestone 2");

        const persistedFeaturesM1 = reopenedStore.listFeatures(m1.id);
        expect(persistedFeaturesM1).toHaveLength(2);
        expect(persistedFeaturesM1[0].title).toBe("Feature 1");

        const persistedFeaturesM2 = reopenedStore.listFeatures(m2.id);
        expect(persistedFeaturesM2).toHaveLength(1);
        expect(persistedFeaturesM2[0].title).toBe("Feature 3");

        reopenedDb.close();
      } finally {
        await rm(persistTmpDir, { recursive: true, force: true });
      }
    });

    it("survives re-instantiation with reordered entities", async () => {
      const persistTmpDir = makeTmpDir();
      try {
        const persistDb = new Database(join(persistTmpDir, ".fusion"));
        persistDb.init();
        const persistStore = new RoadmapStore(persistDb);

        const roadmap = persistStore.createRoadmap({ title: "Reorder Persistence" });
        const m1 = persistStore.createMilestone(roadmap.id, { title: "M1" });
        const m2 = persistStore.createMilestone(roadmap.id, { title: "M2" });
        const m3 = persistStore.createMilestone(roadmap.id, { title: "M3" });
        const f1 = persistStore.createFeature(m1.id, { title: "F1" });
        const f2 = persistStore.createFeature(m1.id, { title: "F2" });

        // Reorder milestones
        persistStore.reorderMilestones({
          roadmapId: roadmap.id,
          orderedMilestoneIds: [m3.id, m1.id, m2.id],
        });

        // Reorder features
        persistStore.reorderFeatures({
          roadmapId: roadmap.id,
          milestoneId: m1.id,
          orderedFeatureIds: [f2.id, f1.id],
        });

        // Close and reopen
        persistDb.close();

        const reopenedDb = new Database(join(persistTmpDir, ".fusion"));
        reopenedDb.init();
        const reopenedStore = new RoadmapStore(reopenedDb);

        // Verify reorder persisted
        const milestones = reopenedStore.listMilestones(roadmap.id);
        expect(milestones.map((m) => m.id)).toEqual([m3.id, m1.id, m2.id]);
        expect(milestones.map((m) => m.orderIndex)).toEqual([0, 1, 2]); // Contiguous

        const features = reopenedStore.listFeatures(m1.id);
        expect(features.map((f) => f.id)).toEqual([f2.id, f1.id]);
        expect(features.map((f) => f.orderIndex)).toEqual([0, 1]); // Contiguous

        reopenedDb.close();
      } finally {
        await rm(persistTmpDir, { recursive: true, force: true });
      }
    });

    it("survives re-instantiation with cross-milestone moves", async () => {
      const persistTmpDir = makeTmpDir();
      try {
        const persistDb = new Database(join(persistTmpDir, ".fusion"));
        persistDb.init();
        const persistStore = new RoadmapStore(persistDb);

        const roadmap = persistStore.createRoadmap({ title: "Move Persistence" });
        const m1 = persistStore.createMilestone(roadmap.id, { title: "M1" });
        const m2 = persistStore.createMilestone(roadmap.id, { title: "M2" });
        const f1 = persistStore.createFeature(m1.id, { title: "F1" });
        const f2 = persistStore.createFeature(m1.id, { title: "F2" });
        const f3 = persistStore.createFeature(m2.id, { title: "F3" });

        // Move f2 from m1 to m2
        persistStore.moveFeature({
          roadmapId: roadmap.id,
          featureId: f2.id,
          fromMilestoneId: m1.id,
          toMilestoneId: m2.id,
          targetOrderIndex: 0,
        });

        // Close and reopen
        persistDb.close();

        const reopenedDb = new Database(join(persistTmpDir, ".fusion"));
        reopenedDb.init();
        const reopenedStore = new RoadmapStore(reopenedDb);

        // Verify move persisted
        const f2Persisted = reopenedStore.getFeature(f2.id);
        expect(f2Persisted!.milestoneId).toBe(m2.id);
        expect(f2Persisted!.orderIndex).toBe(0);

        // Verify m1 renumbered correctly
        const m1Features = reopenedStore.listFeatures(m1.id);
        expect(m1Features).toHaveLength(1);
        expect(m1Features[0].id).toBe(f1.id);
        expect(m1Features[0].orderIndex).toBe(0);

        // Verify m2 renumbered correctly
        const m2Features = reopenedStore.listFeatures(m2.id);
        expect(m2Features).toHaveLength(2);
        expect(m2Features[0].id).toBe(f2.id);
        expect(m2Features[0].orderIndex).toBe(0);
        expect(m2Features[1].id).toBe(f3.id);
        expect(m2Features[1].orderIndex).toBe(1);

        reopenedDb.close();
      } finally {
        await rm(persistTmpDir, { recursive: true, force: true });
      }
    });

    it("cascade-deletes persist after re-instantiation", async () => {
      const persistTmpDir = makeTmpDir();
      try {
        const persistDb = new Database(join(persistTmpDir, ".fusion"));
        persistDb.init();
        const persistStore = new RoadmapStore(persistDb);

        const roadmap = persistStore.createRoadmap({ title: "Cascade Test" });
        const m1 = persistStore.createMilestone(roadmap.id, { title: "M1" });
        const m2 = persistStore.createMilestone(roadmap.id, { title: "M2" });
        const f1 = persistStore.createFeature(m1.id, { title: "F1" });
        const f2 = persistStore.createFeature(m2.id, { title: "F2" });

        // Delete m1 (should cascade delete f1)
        persistStore.deleteMilestone(m1.id);

        // Close and reopen
        persistDb.close();

        const reopenedDb = new Database(join(persistTmpDir, ".fusion"));
        reopenedDb.init();
        const reopenedStore = new RoadmapStore(reopenedDb);

        // Verify cascade delete persisted
        expect(reopenedStore.getMilestone(m1.id)).toBeUndefined();
        expect(reopenedStore.getFeature(f1.id)).toBeUndefined();

        // Verify other data intact
        expect(reopenedStore.getMilestone(m2.id)).toBeDefined();
        expect(reopenedStore.getFeature(f2.id)).toBeDefined();

        reopenedDb.close();
      } finally {
        await rm(persistTmpDir, { recursive: true, force: true });
      }
    });
  });

  describe("negative ordering tests", () => {
    it("rejects reorder milestones with wrong roadmapId", () => {
      const roadmap1 = store.createRoadmap({ title: "R1" });
      const roadmap2 = store.createRoadmap({ title: "R2" });
      const m1 = store.createMilestone(roadmap1.id, { title: "M1" });
      const m2 = store.createMilestone(roadmap1.id, { title: "M2" });

      // Try to reorder with wrong roadmapId
      expect(() =>
        store.reorderMilestones({
          roadmapId: roadmap2.id, // Wrong roadmap!
          orderedMilestoneIds: [m2.id, m1.id],
        }),
      ).toThrow(); // Should fail because m1 and m2 belong to roadmap1
    });

    it("rejects reorder features with wrong roadmapId", () => {
      const roadmap = store.createRoadmap({ title: "R1" });
      const m1 = store.createMilestone(roadmap.id, { title: "M1" });
      const f1 = store.createFeature(m1.id, { title: "F1" });
      const f2 = store.createFeature(m1.id, { title: "F2" });

      // Try to reorder with wrong roadmapId
      expect(() =>
        store.reorderFeatures({
          roadmapId: "RM-wrong", // Wrong roadmap!
          milestoneId: m1.id,
          orderedFeatureIds: [f2.id, f1.id],
        }),
      ).toThrow();
    });

    it("rejects move feature with wrong fromMilestoneId", () => {
      const roadmap = store.createRoadmap({ title: "R1" });
      const m1 = store.createMilestone(roadmap.id, { title: "M1" });
      const m2 = store.createMilestone(roadmap.id, { title: "M2" });
      const f1 = store.createFeature(m1.id, { title: "F1" });

      // Try to move with wrong fromMilestoneId
      expect(() =>
        store.moveFeature({
          roadmapId: roadmap.id,
          featureId: f1.id,
          fromMilestoneId: m2.id, // Wrong! f1 belongs to m1
          toMilestoneId: m2.id,
          targetOrderIndex: 0,
        }),
      ).toThrow(); // The feature is not found in the affected scope
    });

    it("produces contiguous orderIndex after milestone reorder", () => {
      const roadmap = store.createRoadmap({ title: "Contiguous Test" });
      const m1 = store.createMilestone(roadmap.id, { title: "M1" });
      const m2 = store.createMilestone(roadmap.id, { title: "M2" });
      const m3 = store.createMilestone(roadmap.id, { title: "M3" });

      // Reorder to different positions
      store.reorderMilestones({
        roadmapId: roadmap.id,
        orderedMilestoneIds: [m2.id, m3.id, m1.id],
      });

      const milestones = store.listMilestones(roadmap.id);
      const orderIndices = milestones.map((m) => m.orderIndex);

      // Verify contiguous [0, 1, 2]
      expect(orderIndices).toEqual([0, 1, 2]);
      // Verify no gaps or duplicates
      const uniqueIndices = new Set(orderIndices);
      expect(uniqueIndices.size).toBe(orderIndices.length);
    });

    it("produces contiguous orderIndex after feature reorder", () => {
      const roadmap = store.createRoadmap({ title: "Contiguous Feature" });
      const m1 = store.createMilestone(roadmap.id, { title: "M1" });
      const f1 = store.createFeature(m1.id, { title: "F1" });
      const f2 = store.createFeature(m1.id, { title: "F2" });
      const f3 = store.createFeature(m1.id, { title: "F3" });

      // Reorder to different positions
      store.reorderFeatures({
        roadmapId: roadmap.id,
        milestoneId: m1.id,
        orderedFeatureIds: [f3.id, f1.id, f2.id],
      });

      const features = store.listFeatures(m1.id);
      const orderIndices = features.map((f) => f.orderIndex);

      // Verify contiguous [0, 1, 2]
      expect(orderIndices).toEqual([0, 1, 2]);
      // Verify no gaps or duplicates
      const uniqueIndices = new Set(orderIndices);
      expect(uniqueIndices.size).toBe(orderIndices.length);
    });
  });
});
