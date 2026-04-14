import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Database, createDatabase } from "./db.js";
import { RoadmapStore } from "./roadmap-store.js";
import type {
  RoadmapCreateInput,
  RoadmapUpdateInput,
  RoadmapMilestoneCreateInput,
  RoadmapFeatureCreateInput,
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
    it("schema version is 32 after init", () => {
      expect(db.getSchemaVersion()).toBe(32);
    });
  });
});
