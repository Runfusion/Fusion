// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import { get as performGet, request as performRequest } from "./test-request.js";
import { createRoadmapRouter } from "./roadmap-routes.js";
import { ApiError } from "./api-error.js";
import type { Roadmap, RoadmapMilestone, RoadmapFeature, RoadmapStore } from "@fusion/core";

vi.mock("./roadmap-suggestions.js", () => ({
  generateMilestoneSuggestions: vi.fn().mockResolvedValue({ suggestions: [] }),
  validateSuggestionInput: vi.fn(),
  generateFeatureSuggestions: vi.fn().mockResolvedValue({ suggestions: [] }),
  validateFeatureSuggestionInput: vi.fn(),
  ValidationError: class extends Error { name = "ValidationError"; constructor(m: string) { super(m); } },
  ParseError: class extends Error { name = "ParseError"; constructor(m: string) { super(m); } },
  ServiceUnavailableError: class extends Error { name = "ServiceUnavailableError"; constructor(m: string) { super(m); } },
}));

const mockGetOrCreateProjectStore = vi.fn();
vi.mock("./project-store-resolver.js", () => ({
  getOrCreateProjectStore: (...args: unknown[]) => mockGetOrCreateProjectStore(...args),
}));

function createMockRoadmapStore(): RoadmapStore {
  const roadmaps = new Map<string, Roadmap>();
  const milestones = new Map<string, RoadmapMilestone>();
  const features = new Map<string, RoadmapFeature>();
  return {
    createRoadmap: vi.fn((input: { title: string; description?: string }) => {
      const id = "RM-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6).toUpperCase();
      const now = new Date().toISOString();
      const roadmap: Roadmap = { id, title: input.title, description: input.description, createdAt: now, updatedAt: now };
      roadmaps.set(id, roadmap);
      return roadmap;
    }),
    getRoadmap: vi.fn((id: string) => roadmaps.get(id)),
    listRoadmaps: vi.fn(() => Array.from(roadmaps.values())),
    updateRoadmap: vi.fn((id: string, updates: Partial<Roadmap>) => {
      const roadmap = roadmaps.get(id);
      if (!roadmap) throw new Error("Roadmap " + id + " not found");
      const updated = { ...roadmap, ...updates, updatedAt: new Date().toISOString() };
      roadmaps.set(id, updated);
      return updated;
    }),
    deleteRoadmap: vi.fn((id: string) => { roadmaps.delete(id); }),
    createMilestone: vi.fn((roadmapId: string, input: { title: string; description?: string }) => {
      const roadmap = roadmaps.get(roadmapId);
      if (!roadmap) throw new Error("Roadmap " + roadmapId + " not found");
      const id = "RMS-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6).toUpperCase();
      const now = new Date().toISOString();
      const existingMilestones = Array.from(milestones.values()).filter((m) => m.roadmapId === roadmapId);
      const orderIndex = existingMilestones.length > 0 ? Math.max(...existingMilestones.map((m) => m.orderIndex)) + 1 : 0;
      const milestone: RoadmapMilestone = { id, roadmapId, title: input.title, description: input.description, orderIndex, createdAt: now, updatedAt: now };
      milestones.set(id, milestone);
      return milestone;
    }),
    getMilestone: vi.fn((id: string) => milestones.get(id)),
    listMilestones: vi.fn((roadmapId: string) => Array.from(milestones.values()).filter((m) => m.roadmapId === roadmapId).sort((a, b) => a.orderIndex - b.orderIndex)),
    updateMilestone: vi.fn((id: string, updates: Partial<RoadmapMilestone>) => {
      const milestone = milestones.get(id);
      if (!milestone) throw new Error("Milestone " + id + " not found");
      const updated = { ...milestone, ...updates, updatedAt: new Date().toISOString() };
      milestones.set(id, updated);
      return updated;
    }),
    deleteMilestone: vi.fn((id: string) => { milestones.delete(id); }),
    createFeature: vi.fn((milestoneId: string, input: { title: string; description?: string }) => {
      const milestone = milestones.get(milestoneId);
      if (!milestone) throw new Error("Milestone " + milestoneId + " not found");
      const id = "RF-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6).toUpperCase();
      const now = new Date().toISOString();
      const existingFeatures = Array.from(features.values()).filter((f) => f.milestoneId === milestoneId);
      const orderIndex = existingFeatures.length > 0 ? Math.max(...existingFeatures.map((f) => f.orderIndex)) + 1 : 0;
      const feature: RoadmapFeature = { id, milestoneId, title: input.title, description: input.description, orderIndex, createdAt: now, updatedAt: now };
      features.set(id, feature);
      return feature;
    }),
    getFeature: vi.fn((id: string) => features.get(id)),
    listFeatures: vi.fn((milestoneId: string) => Array.from(features.values()).filter((f) => f.milestoneId === milestoneId).sort((a, b) => a.orderIndex - b.orderIndex)),
    updateFeature: vi.fn((id: string, updates: Partial<RoadmapFeature>) => {
      const feature = features.get(id);
      if (!feature) throw new Error("Feature " + id + " not found");
      const updated = { ...feature, ...updates, updatedAt: new Date().toISOString() };
      features.set(id, updated);
      return updated;
    }),
    deleteFeature: vi.fn((id: string) => { features.delete(id); }),
    reorderMilestones: vi.fn((input: { roadmapId: string; orderedMilestoneIds: string[] }) => {
      const { roadmapId, orderedMilestoneIds } = input;
      orderedMilestoneIds.forEach((id, index) => {
        const milestone = milestones.get(id);
        if (milestone) milestones.set(id, { ...milestone, orderIndex: index, updatedAt: new Date().toISOString() });
      });
      return Array.from(milestones.values()).filter((m) => m.roadmapId === roadmapId).sort((a, b) => a.orderIndex - b.orderIndex);
    }),
    reorderFeatures: vi.fn((input: { roadmapId: string; milestoneId: string; orderedFeatureIds: string[] }) => {
      const { milestoneId, orderedFeatureIds } = input;
      orderedFeatureIds.forEach((id, index) => {
        const feature = features.get(id);
        if (feature) features.set(id, { ...feature, orderIndex: index, updatedAt: new Date().toISOString() });
      });
      return Array.from(features.values()).filter((f) => f.milestoneId === milestoneId).sort((a, b) => a.orderIndex - b.orderIndex);
    }),
    moveFeature: vi.fn((input: { roadmapId: string; featureId: string; fromMilestoneId: string; toMilestoneId: string; targetOrderIndex: number }) => {
      const { featureId, toMilestoneId, targetOrderIndex } = input;
      const feature = features.get(featureId);
      if (!feature) throw new Error("Feature " + featureId + " not found");
      const updated: RoadmapFeature = { ...feature, milestoneId: toMilestoneId, orderIndex: targetOrderIndex, updatedAt: new Date().toISOString() };
      features.set(featureId, updated);
      return { movedFeature: updated, sourceMilestoneFeatures: [], targetMilestoneFeatures: [] };
    }),
    getMilestoneWithFeatures: vi.fn((id: string) => {
      const milestone = milestones.get(id);
      if (!milestone) return undefined;
      return { ...milestone, features: [] };
    }),
    getRoadmapWithHierarchy: vi.fn((id: string) => {
      const roadmap = roadmaps.get(id);
      if (!roadmap) return undefined;
      const ms = Array.from(milestones.values()).filter((m) => m.roadmapId === id).sort((a, b) => a.orderIndex - b.orderIndex);
      return { ...roadmap, milestones: ms.map((m) => ({ ...m, features: [] })) };
    }),
    getRoadmapExport: vi.fn((roadmapId: string) => {
      const roadmap = roadmaps.get(roadmapId);
      if (!roadmap) throw new ApiError(500, "Roadmap " + roadmapId + " not found");
      const ms = Array.from(milestones.values()).filter((m) => m.roadmapId === roadmapId).sort((a, b) => a.orderIndex - b.orderIndex);
      const allFeatures = ms.flatMap((m) => Array.from(features.values()).filter((f) => f.milestoneId === m.id).sort((a, b) => a.orderIndex - b.orderIndex));
      return { roadmap, milestones: ms, features: allFeatures };
    }),
    getRoadmapMissionHandoff: vi.fn((roadmapId: string) => {
      const roadmap = roadmaps.get(roadmapId);
      if (!roadmap) throw new ApiError(500, "Roadmap " + roadmapId + " not found");
      const ms = Array.from(milestones.values()).filter((m) => m.roadmapId === roadmapId).sort((a, b) => a.orderIndex - b.orderIndex);
      return {
        sourceRoadmapId: roadmap.id,
        title: roadmap.title,
        description: roadmap.description,
        milestones: ms.map((m) => {
          const fs = Array.from(features.values()).filter((f) => f.milestoneId === m.id).sort((a, b) => a.orderIndex - b.orderIndex);
          return {
            sourceMilestoneId: m.id,
            title: m.title,
            description: m.description,
            orderIndex: m.orderIndex,
            features: fs.map((f) => ({ sourceFeatureId: f.id, title: f.title, description: f.description, orderIndex: f.orderIndex })),
          };
        }),
      };
    }),
    getRoadmapFeatureHandoff: vi.fn((roadmapId: string, milestoneId: string, featureId: string) => {
      const roadmap = roadmaps.get(roadmapId);
      if (!roadmap) throw new ApiError(500, "Roadmap " + roadmapId + " not found");
      const milestone = milestones.get(milestoneId);
      if (!milestone) throw new ApiError(500, "Milestone " + milestoneId + " not found");
      if (milestone.roadmapId !== roadmapId) throw new ApiError(500, "Milestone " + milestoneId + " does not belong to roadmap " + roadmapId);
      const feature = features.get(featureId);
      if (!feature) throw new ApiError(500, "Feature " + featureId + " not found");
      if (feature.milestoneId !== milestoneId) throw new ApiError(500, "Feature " + featureId + " does not belong to milestone " + milestoneId);
      return {
        source: {
          roadmapId: roadmap.id,
          milestoneId: milestone.id,
          featureId: feature.id,
          roadmapTitle: roadmap.title,
          milestoneTitle: milestone.title,
          milestoneOrderIndex: milestone.orderIndex,
          featureOrderIndex: feature.orderIndex,
        },
        title: feature.title,
        description: feature.description,
      };
    }),
  } as unknown as RoadmapStore;
}

describe("Roadmap Routes", () => {
  let app: express.Express;
  let mockStore: { getRoadmapStore: ReturnType<typeof vi.fn>; getRootDir: ReturnType<typeof vi.fn> };
  let mockRoadmapStore: ReturnType<typeof createMockRoadmapStore>;

  beforeEach(() => {
    mockRoadmapStore = createMockRoadmapStore();
    mockStore = {
      getRoadmapStore: vi.fn(() => mockRoadmapStore),
      getRootDir: vi.fn(() => "/test/root"),
    };
    mockGetOrCreateProjectStore.mockResolvedValue(mockStore);

    app = express();
    app.use(express.json());
    app.use("/api/roadmaps", createRoadmapRouter(mockStore));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("GET /api/roadmaps", () => {
    it("returns empty list when no roadmaps exist", async () => {
      const response = await performGet(app, "/api/roadmaps");
      expect(response.status).toBe(200);
      expect(response.body).toEqual([]);
    });

    it("returns all roadmaps", async () => {
      mockRoadmapStore.createRoadmap({ title: "Roadmap 1" });
      mockRoadmapStore.createRoadmap({ title: "Roadmap 2" });
      const response = await performGet(app, "/api/roadmaps");
      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(2);
    });
  });

  describe("POST /api/roadmaps", () => {
    it("creates a new roadmap", async () => {
      const response = await performRequest(app, "POST", "/api/roadmaps", JSON.stringify({ title: "New Roadmap" }), { "Content-Type": "application/json" });
      expect(response.status).toBe(201);
      expect(response.body.title).toBe("New Roadmap");
    });
  });

  describe("GET /api/roadmaps/:roadmapId", () => {
    it("returns roadmap with hierarchy", async () => {
      const roadmap = mockRoadmapStore.createRoadmap({ title: "Test Roadmap" });
      const milestone = mockRoadmapStore.createMilestone(roadmap.id, { title: "Milestone 1" });
      mockRoadmapStore.createFeature(milestone.id, { title: "Feature 1" });
      const response = await performGet(app, "/api/roadmaps/" + roadmap.id);
      expect(response.status).toBe(200);
      expect(response.body.title).toBe("Test Roadmap");
      expect(response.body.milestones).toHaveLength(1);
    });
  });

  describe("PATCH /api/roadmaps/:roadmapId", () => {
    it("updates roadmap title", async () => {
      const roadmap = mockRoadmapStore.createRoadmap({ title: "Original Title" });
      const response = await performRequest(app, "PATCH", "/api/roadmaps/" + roadmap.id, JSON.stringify({ title: "Updated Title" }), { "Content-Type": "application/json" });
      expect(response.status).toBe(200);
      expect(response.body.title).toBe("Updated Title");
    });
  });

  describe("DELETE /api/roadmaps/:roadmapId", () => {
    it("deletes a roadmap", async () => {
      const roadmap = mockRoadmapStore.createRoadmap({ title: "To Delete" });
      const response = await performRequest(app, "DELETE", "/api/roadmaps/" + roadmap.id);
      expect(response.status).toBe(204);
    });
  });

  describe("POST /api/roadmaps/:roadmapId/milestones", () => {
    it("creates a milestone with auto orderIndex", async () => {
      const roadmap = mockRoadmapStore.createRoadmap({ title: "Test" });
      const response = await performRequest(app, "POST", "/api/roadmaps/" + roadmap.id + "/milestones", JSON.stringify({ title: "New Milestone" }), { "Content-Type": "application/json" });
      expect(response.status).toBe(201);
      expect(response.body.roadmapId).toBe(roadmap.id);
      expect(response.body.orderIndex).toBe(0);
    });
  });

  describe("POST /api/roadmaps/:roadmapId/milestones/reorder", () => {
    it("reorders milestones", async () => {
      const roadmap = mockRoadmapStore.createRoadmap({ title: "Test" });
      const m1 = mockRoadmapStore.createMilestone(roadmap.id, { title: "First" });
      const m2 = mockRoadmapStore.createMilestone(roadmap.id, { title: "Second" });
      const response = await performRequest(app, "POST", "/api/roadmaps/" + roadmap.id + "/milestones/reorder", JSON.stringify({ orderedMilestoneIds: [m2.id, m1.id] }), { "Content-Type": "application/json" });
      expect(response.status).toBe(204);
    });
  });

  describe("PATCH /api/roadmaps/milestones/:milestoneId", () => {
    it("updates a milestone", async () => {
      const roadmap = mockRoadmapStore.createRoadmap({ title: "Test" });
      const milestone = mockRoadmapStore.createMilestone(roadmap.id, { title: "Original" });
      const response = await performRequest(app, "PATCH", "/api/roadmaps/milestones/" + milestone.id, JSON.stringify({ title: "Updated" }), { "Content-Type": "application/json" });
      expect(response.status).toBe(200);
      expect(response.body.title).toBe("Updated");
    });
  });

  describe("DELETE /api/roadmaps/milestones/:milestoneId", () => {
    it("deletes a milestone", async () => {
      const roadmap = mockRoadmapStore.createRoadmap({ title: "Test" });
      const milestone = mockRoadmapStore.createMilestone(roadmap.id, { title: "To Delete" });
      const response = await performRequest(app, "DELETE", "/api/roadmaps/milestones/" + milestone.id);
      expect(response.status).toBe(204);
    });
  });

  describe("POST /api/roadmaps/milestones/:milestoneId/features", () => {
    it("creates a feature", async () => {
      const roadmap = mockRoadmapStore.createRoadmap({ title: "Test" });
      const milestone = mockRoadmapStore.createMilestone(roadmap.id, { title: "MS" });
      const response = await performRequest(app, "POST", "/api/roadmaps/milestones/" + milestone.id + "/features", JSON.stringify({ title: "New Feature" }), { "Content-Type": "application/json" });
      expect(response.status).toBe(201);
      expect(response.body.title).toBe("New Feature");
    });
  });

  describe("PATCH /api/roadmaps/features/:featureId", () => {
    it("updates a feature", async () => {
      const roadmap = mockRoadmapStore.createRoadmap({ title: "Test" });
      const milestone = mockRoadmapStore.createMilestone(roadmap.id, { title: "MS" });
      const feature = mockRoadmapStore.createFeature(milestone.id, { title: "Original" });
      const response = await performRequest(app, "PATCH", "/api/roadmaps/features/" + feature.id, JSON.stringify({ title: "Updated" }), { "Content-Type": "application/json" });
      expect(response.status).toBe(200);
      expect(response.body.title).toBe("Updated");
    });
  });

  describe("DELETE /api/roadmaps/features/:featureId", () => {
    it("deletes a feature", async () => {
      const roadmap = mockRoadmapStore.createRoadmap({ title: "Test" });
      const milestone = mockRoadmapStore.createMilestone(roadmap.id, { title: "MS" });
      const feature = mockRoadmapStore.createFeature(milestone.id, { title: "To Delete" });
      const response = await performRequest(app, "DELETE", "/api/roadmaps/features/" + feature.id);
      expect(response.status).toBe(204);
    });
  });

  describe("projectId scoping", () => {
    it("uses projectId from query param", async () => {
      mockRoadmapStore.createRoadmap({ title: "Project Roadmap" });
      const response = await performGet(app, "/api/roadmaps?projectId=test-project");
      expect(response.status).toBe(200);
      expect(mockGetOrCreateProjectStore).toHaveBeenCalledWith("test-project");
    });
  });

  describe("GET /api/roadmaps/:roadmapId/export", () => {
    it("returns export bundle with all entities", async () => {
      const roadmap = mockRoadmapStore.createRoadmap({ title: "Export Test", description: "Test desc" });
      const milestone = mockRoadmapStore.createMilestone(roadmap.id, { title: "MS1" });
      const feature = mockRoadmapStore.createFeature(milestone.id, { title: "F1" });

      const response = await performGet(app, "/api/roadmaps/" + roadmap.id + "/export");
      expect(response.status).toBe(200);
      expect(response.body.roadmap.id).toBe(roadmap.id);
      expect(response.body.roadmap.title).toBe("Export Test");
      expect(response.body.milestones.length).toBe(1);
      expect(response.body.features.length).toBe(1);
      expect(response.body.features[0].id).toBe(feature.id);
    });
  });

  describe("GET /api/roadmaps/:roadmapId/handoff/mission", () => {
    it("returns mission handoff payload", async () => {
      const roadmap = mockRoadmapStore.createRoadmap({ title: "Mission Handoff", description: "Mission desc" });
      const milestone = mockRoadmapStore.createMilestone(roadmap.id, { title: "Phase 1" });
      const feature = mockRoadmapStore.createFeature(milestone.id, { title: "Feature A" });

      const response = await performGet(app, "/api/roadmaps/" + roadmap.id + "/handoff/mission");
      expect(response.status).toBe(200);
      expect(response.body.sourceRoadmapId).toBe(roadmap.id);
      expect(response.body.title).toBe("Mission Handoff");
      expect(response.body.description).toBe("Mission desc");
      expect(response.body.milestones.length).toBe(1);
      expect(response.body.milestones[0].sourceMilestoneId).toBe(milestone.id);
      expect(response.body.milestones[0].features.length).toBe(1);
      expect(response.body.milestones[0].features[0].sourceFeatureId).toBe(feature.id);
    });
  });

  describe("GET /api/roadmaps/:roadmapId/milestones/:milestoneId/features/:featureId/handoff/task", () => {
    it("returns task handoff payload for feature", async () => {
      const roadmap = mockRoadmapStore.createRoadmap({ title: "Feature Handoff" });
      const milestone = mockRoadmapStore.createMilestone(roadmap.id, { title: "Phase 1" });
      const feature = mockRoadmapStore.createFeature(milestone.id, { title: "Feature A", description: "Feature desc" });

      const response = await performGet(app, "/api/roadmaps/" + roadmap.id + "/milestones/" + milestone.id + "/features/" + feature.id + "/handoff/task");
      expect(response.status).toBe(200);
      expect(response.body.source.roadmapId).toBe(roadmap.id);
      expect(response.body.source.milestoneId).toBe(milestone.id);
      expect(response.body.source.featureId).toBe(feature.id);
      expect(response.body.source.roadmapTitle).toBe("Feature Handoff");
      expect(response.body.source.milestoneTitle).toBe("Phase 1");
      expect(response.body.title).toBe("Feature A");
      expect(response.body.description).toBe("Feature desc");
    });
  });
});
