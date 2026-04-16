/**
 * Tests for roadmap handoff mapping helpers.
 */

import { describe, it, expect } from "vitest";
import {
  mapFeatureToTaskHandoff,
  mapRoadmapToMissionHandoff,
  mapRoadmapWithHierarchyToMissionHandoff,
  mapAllFeaturesToTaskHandoffs,
} from "./roadmap-handoff.js";
import { normalizeRoadmapMilestoneOrder } from "./roadmap-ordering.js";
import type {
  Roadmap,
  RoadmapMilestone,
  RoadmapFeature,
  RoadmapWithHierarchy,
  RoadmapFeatureTaskPlanningHandoff,
  RoadmapMissionPlanningHandoff,
} from "./roadmap-types.js";

// ── Test Fixtures ─────────────────────────────────────────────────────────────

function createRoadmap(overrides: Partial<Roadmap> = {}): Roadmap {
  return {
    id: "RM-001",
    title: "Test Roadmap",
    description: "A test roadmap",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function createMilestone(id: string, roadmapId: string, orderIndex: number, overrides: Partial<RoadmapMilestone> = {}): RoadmapMilestone {
  return {
    id,
    roadmapId,
    title: `Milestone ${id}`,
    description: `Description for ${id}`,
    orderIndex,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function createFeature(id: string, milestoneId: string, orderIndex: number, overrides: Partial<RoadmapFeature> = {}): RoadmapFeature {
  return {
    id,
    milestoneId,
    title: `Feature ${id}`,
    description: `Description for ${id}`,
    orderIndex,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// ── Tests for mapFeatureToTaskHandoff ─────────────────────────────────────────

describe("mapFeatureToTaskHandoff", () => {
  it("maps a feature to a task planning handoff with all fields", () => {
    const roadmap = createRoadmap();
    const milestone = createMilestone("MS-001", "RM-001", 0);
    const feature = createFeature("F-001", "MS-001", 0);

    const handoff = mapFeatureToTaskHandoff(roadmap, milestone, feature);

    expect(handoff.title).toBe("Feature F-001");
    expect(handoff.description).toBe("Description for F-001");
    expect(handoff.source.roadmapId).toBe("RM-001");
    expect(handoff.source.milestoneId).toBe("MS-001");
    expect(handoff.source.featureId).toBe("F-001");
    expect(handoff.source.roadmapTitle).toBe("Test Roadmap");
    expect(handoff.source.milestoneTitle).toBe("Milestone MS-001");
    expect(handoff.source.milestoneOrderIndex).toBe(0);
    expect(handoff.source.featureOrderIndex).toBe(0);
  });

  it("handles features without descriptions", () => {
    const roadmap = createRoadmap();
    const milestone = createMilestone("MS-001", "RM-001", 0);
    const feature = createFeature("F-001", "MS-001", 0, { description: undefined });

    const handoff = mapFeatureToTaskHandoff(roadmap, milestone, feature);

    expect(handoff.title).toBe("Feature F-001");
    expect(handoff.description).toBeUndefined();
  });

  it("preserves exact IDs from source entities", () => {
    const roadmap = createRoadmap({ id: "RM-SPECIAL-123" });
    const milestone = createMilestone("RMS-SPECIAL-456", "RM-SPECIAL-123", 5);
    const feature = createFeature("RF-SPECIAL-789", "RMS-SPECIAL-456", 3);

    const handoff = mapFeatureToTaskHandoff(roadmap, milestone, feature);

    expect(handoff.source.roadmapId).toBe("RM-SPECIAL-123");
    expect(handoff.source.milestoneId).toBe("RMS-SPECIAL-456");
    expect(handoff.source.featureId).toBe("RF-SPECIAL-789");
  });
});

// ── Tests for mapRoadmapToMissionHandoff ─────────────────────────────────────

describe("mapRoadmapToMissionHandoff", () => {
  it("maps a roadmap with milestones and features to mission handoff", () => {
    const roadmap = createRoadmap({ title: "Q1 Planning", description: "Quarterly goals" });
    const milestones = [
      createMilestone("MS-001", "RM-001", 0, { title: "Phase 1" }),
      createMilestone("MS-002", "RM-001", 1, { title: "Phase 2" }),
    ];
    const featuresByMilestoneId = new Map<string, readonly RoadmapFeature[]>([
      ["MS-001", [
        createFeature("F-001", "MS-001", 0, { title: "Auth Feature" }),
        createFeature("F-002", "MS-001", 1, { title: "Dashboard Feature" }),
      ]],
      ["MS-002", [
        createFeature("F-003", "MS-002", 0, { title: "Reporting Feature" }),
      ]],
    ]);

    const handoff = mapRoadmapToMissionHandoff(roadmap, milestones, featuresByMilestoneId);

    expect(handoff.sourceRoadmapId).toBe("RM-001");
    expect(handoff.title).toBe("Q1 Planning");
    expect(handoff.description).toBe("Quarterly goals");
    expect(handoff.milestones).toHaveLength(2);

    // Verify milestone ordering
    expect(handoff.milestones[0].title).toBe("Phase 1");
    expect(handoff.milestones[0].orderIndex).toBe(0);
    expect(handoff.milestones[1].title).toBe("Phase 2");
    expect(handoff.milestones[1].orderIndex).toBe(1);

    // Verify feature ordering within milestones
    expect(handoff.milestones[0].features).toHaveLength(2);
    expect(handoff.milestones[0].features[0].title).toBe("Auth Feature");
    expect(handoff.milestones[0].features[0].orderIndex).toBe(0);
    expect(handoff.milestones[0].features[1].title).toBe("Dashboard Feature");
    expect(handoff.milestones[0].features[1].orderIndex).toBe(1);

    expect(handoff.milestones[1].features).toHaveLength(1);
    expect(handoff.milestones[1].features[0].title).toBe("Reporting Feature");
  });

  it("handles empty milestones array", () => {
    const roadmap = createRoadmap();
    const featuresByMilestoneId = new Map<string, readonly RoadmapFeature[]>();

    const handoff = mapRoadmapToMissionHandoff(roadmap, [], featuresByMilestoneId);

    expect(handoff.sourceRoadmapId).toBe("RM-001");
    expect(handoff.milestones).toHaveLength(0);
  });

  it("handles milestones with empty features", () => {
    const roadmap = createRoadmap();
    const milestones = [
      createMilestone("MS-001", "RM-001", 0),
    ];
    const featuresByMilestoneId = new Map<string, readonly RoadmapFeature[]>();

    const handoff = mapRoadmapToMissionHandoff(roadmap, milestones, featuresByMilestoneId);

    expect(handoff.milestones).toHaveLength(1);
    expect(handoff.milestones[0].features).toHaveLength(0);
  });

  it("normalizes deterministic ordering when order indices are out of sequence", () => {
    const roadmap = createRoadmap();
    // Simulate out-of-sequence order indices
    const milestones = [
      createMilestone("MS-001", "RM-001", 10), // Out of sequence
      createMilestone("MS-002", "RM-001", 5),  // Out of sequence
      createMilestone("MS-003", "RM-001", 20), // Out of sequence
    ];
    const featuresByMilestoneId = new Map<string, readonly RoadmapFeature[]>();

    const handoff = mapRoadmapToMissionHandoff(roadmap, milestones, featuresByMilestoneId);

    // Should be normalized to 0, 1, 2
    expect(handoff.milestones[0].orderIndex).toBe(0);
    expect(handoff.milestones[1].orderIndex).toBe(1);
    expect(handoff.milestones[2].orderIndex).toBe(2);
  });
});

// ── Tests for mapRoadmapWithHierarchyToMissionHandoff ────────────────────────

describe("mapRoadmapWithHierarchyToMissionHandoff", () => {
  it("maps RoadmapWithHierarchy to mission handoff", () => {
    const roadmapWithHierarchy: RoadmapWithHierarchy = {
      id: "RM-001",
      title: "Hierarchy Roadmap",
      description: "With full hierarchy",
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
      milestones: [
        {
          ...createMilestone("MS-001", "RM-001", 0, { title: "Alpha Phase" }),
          features: [
            createFeature("F-001", "MS-001", 0, { title: "Alpha Feature 1" }),
            createFeature("F-002", "MS-001", 1, { title: "Alpha Feature 2" }),
          ],
        },
        {
          ...createMilestone("MS-002", "RM-001", 1, { title: "Beta Phase" }),
          features: [
            createFeature("F-003", "MS-002", 0, { title: "Beta Feature" }),
          ],
        },
      ],
    };

    const handoff = mapRoadmapWithHierarchyToMissionHandoff(roadmapWithHierarchy);

    expect(handoff.sourceRoadmapId).toBe("RM-001");
    expect(handoff.title).toBe("Hierarchy Roadmap");
    expect(handoff.milestones).toHaveLength(2);
    expect(handoff.milestones[0].title).toBe("Alpha Phase");
    expect(handoff.milestones[0].features).toHaveLength(2);
    expect(handoff.milestones[1].title).toBe("Beta Phase");
    expect(handoff.milestones[1].features).toHaveLength(1);
  });

  it("handles empty milestone hierarchy", () => {
    const roadmapWithHierarchy: RoadmapWithHierarchy = {
      ...createRoadmap(),
      milestones: [],
    };

    const handoff = mapRoadmapWithHierarchyToMissionHandoff(roadmapWithHierarchy);

    expect(handoff.milestones).toHaveLength(0);
  });
});

// ── Tests for mapAllFeaturesToTaskHandoffs ────────────────────────────────────

describe("mapAllFeaturesToTaskHandoffs", () => {
  it("flattens all features from a roadmap into individual handoffs", () => {
    const roadmap = createRoadmap();
    const milestones = [
      createMilestone("MS-001", "RM-001", 0),
      createMilestone("MS-002", "RM-001", 1),
    ];
    const featuresByMilestoneId = new Map<string, readonly RoadmapFeature[]>([
      ["MS-001", [
        createFeature("F-001", "MS-001", 0),
        createFeature("F-002", "MS-001", 1),
      ]],
      ["MS-002", [
        createFeature("F-003", "MS-002", 0),
      ]],
    ]);

    const handoffs = mapAllFeaturesToTaskHandoffs(roadmap, milestones, featuresByMilestoneId);

    expect(handoffs).toHaveLength(3);
    expect(handoffs[0].source.featureId).toBe("F-001");
    expect(handoffs[0].source.milestoneOrderIndex).toBe(0);
    expect(handoffs[0].source.featureOrderIndex).toBe(0);
    expect(handoffs[1].source.featureId).toBe("F-002");
    expect(handoffs[1].source.milestoneOrderIndex).toBe(0);
    expect(handoffs[1].source.featureOrderIndex).toBe(1);
    expect(handoffs[2].source.featureId).toBe("F-003");
    expect(handoffs[2].source.milestoneOrderIndex).toBe(1);
    expect(handoffs[2].source.featureOrderIndex).toBe(0);
  });

  it("returns empty array when no milestones exist", () => {
    const roadmap = createRoadmap();
    const featuresByMilestoneId = new Map<string, readonly RoadmapFeature[]>();

    const handoffs = mapAllFeaturesToTaskHandoffs(roadmap, [], featuresByMilestoneId);

    expect(handoffs).toHaveLength(0);
  });

  it("returns empty array when milestones have no features", () => {
    const roadmap = createRoadmap();
    const milestones = [createMilestone("MS-001", "RM-001", 0)];
    const featuresByMilestoneId = new Map<string, readonly RoadmapFeature[]>();

    const handoffs = mapAllFeaturesToTaskHandoffs(roadmap, milestones, featuresByMilestoneId);

    expect(handoffs).toHaveLength(0);
  });

  it("preserves feature titles and descriptions", () => {
    const roadmap = createRoadmap();
    const milestones = [createMilestone("MS-001", "RM-001", 0)];
    const featuresByMilestoneId = new Map<string, readonly RoadmapFeature[]>([
      ["MS-001", [
        createFeature("F-001", "MS-001", 0, { title: "Core Feature", description: "Main functionality" }),
        createFeature("F-002", "MS-001", 1, { title: "Secondary Feature", description: undefined }),
      ]],
    ]);

    const handoffs = mapAllFeaturesToTaskHandoffs(roadmap, milestones, featuresByMilestoneId);

    expect(handoffs[0].title).toBe("Core Feature");
    expect(handoffs[0].description).toBe("Main functionality");
    expect(handoffs[1].title).toBe("Secondary Feature");
    expect(handoffs[1].description).toBeUndefined();
  });

  it("normalizes ordering when feature order indices are out of sequence", () => {
    const roadmap = createRoadmap();
    const milestones = [createMilestone("MS-001", "RM-001", 0)];
    // Simulate out-of-sequence feature order indices
    const featuresByMilestoneId = new Map<string, readonly RoadmapFeature[]>([
      ["MS-001", [
        createFeature("F-001", "MS-001", 100),
        createFeature("F-002", "MS-001", 50),
        createFeature("F-003", "MS-001", 75),
      ]],
    ]);

    const handoffs = mapAllFeaturesToTaskHandoffs(roadmap, milestones, featuresByMilestoneId);

    expect(handoffs).toHaveLength(3);
    // Should be normalized to 0, 1, 2
    expect(handoffs[0].source.featureOrderIndex).toBe(0);
    expect(handoffs[1].source.featureOrderIndex).toBe(1);
    expect(handoffs[2].source.featureOrderIndex).toBe(2);
  });

  it("skips features from unknown milestone IDs", () => {
    const roadmap = createRoadmap();
    const milestones = [createMilestone("MS-001", "RM-001", 0)];
    const featuresByMilestoneId = new Map<string, readonly RoadmapFeature[]>([
      ["MS-001", [createFeature("F-001", "MS-001", 0)]],
      // MS-999 is not in milestones, so its features should be ignored
      ["MS-999", [createFeature("F-999", "MS-999", 0)]],
    ]);

    const handoffs = mapAllFeaturesToTaskHandoffs(roadmap, milestones, featuresByMilestoneId);

    expect(handoffs).toHaveLength(1);
    expect(handoffs[0].source.featureId).toBe("F-001");
  });
});

// ── Deterministic Ordering Tests ───────────────────────────────────────────────

describe("deterministic ordering", () => {
  it("uses stable ordering when order indices are equal", () => {
    const roadmap = createRoadmap();
    // Same order index for all milestones - should sort by createdAt then id
    const rawMilestones = [
      createMilestone("MS-001", "RM-001", 0, { createdAt: "2024-01-01T00:00:00.000Z" }),
      createMilestone("MS-002", "RM-001", 0, { createdAt: "2024-01-01T00:00:00.000Z" }),
      createMilestone("MS-003", "RM-001", 0, { createdAt: "2024-01-02T00:00:00.000Z" }),
    ];
    // Normalize before passing to handoff function (mirrors store behavior)
    const milestones = normalizeRoadmapMilestoneOrder(rawMilestones);
    const featuresByMilestoneId = new Map<string, readonly RoadmapFeature[]>();

    const handoff = mapRoadmapToMissionHandoff(roadmap, milestones, featuresByMilestoneId);

    // MS-001 and MS-002 have same orderIndex and createdAt, so should sort by id
    // MS-003 has later createdAt
    expect(handoff.milestones[0].sourceMilestoneId).toBe("MS-001");
    expect(handoff.milestones[1].sourceMilestoneId).toBe("MS-002");
    expect(handoff.milestones[2].sourceMilestoneId).toBe("MS-003");
  });

  it("produces consistent output across multiple calls with same input", () => {
    const roadmap = createRoadmap({ id: "RM-STABLE" });
    const milestones = [
      createMilestone("MS-001", "RM-STABLE", 1),
      createMilestone("MS-002", "RM-STABLE", 0),
    ];
    const featuresByMilestoneId = new Map<string, readonly RoadmapFeature[]>([
      ["MS-001", [createFeature("F-001", "MS-001", 1)]],
      ["MS-002", [createFeature("F-002", "MS-002", 0)]],
    ]);

    const first = mapRoadmapToMissionHandoff(roadmap, milestones, featuresByMilestoneId);
    const second = mapRoadmapToMissionHandoff(roadmap, milestones, featuresByMilestoneId);

    expect(first).toEqual(second);
    expect(first.milestones[0].sourceMilestoneId).toBe(second.milestones[0].sourceMilestoneId);
    expect(first.milestones[1].sourceMilestoneId).toBe(second.milestones[1].sourceMilestoneId);
  });
});

// ── Source Lineage Preservation Tests ─────────────────────────────────────────

describe("source lineage preservation", () => {
  it("preserves roadmap context in all feature handoffs", () => {
    const roadmap = createRoadmap({ id: "RM-LINEAGE", title: "Lineage Test" });
    const milestones = [createMilestone("MS-LINEAGE", "RM-LINEAGE", 0)];
    const featuresByMilestoneId = new Map<string, readonly RoadmapFeature[]>([
      ["MS-LINEAGE", [createFeature("F-LINEAGE", "MS-LINEAGE", 0)]],
    ]);

    const handoffs = mapAllFeaturesToTaskHandoffs(roadmap, milestones, featuresByMilestoneId);

    expect(handoffs[0].source.roadmapId).toBe("RM-LINEAGE");
    expect(handoffs[0].source.roadmapTitle).toBe("Lineage Test");
  });

  it("preserves milestone context in all feature handoffs", () => {
    const roadmap = createRoadmap();
    const milestones = [
      createMilestone("MS-ALPHA", "RM-001", 0, { title: "Alpha Milestone" }),
      createMilestone("MS-BETA", "RM-001", 1, { title: "Beta Milestone" }),
    ];
    const featuresByMilestoneId = new Map<string, readonly RoadmapFeature[]>([
      ["MS-ALPHA", [createFeature("F-001", "MS-ALPHA", 0)]],
      ["MS-BETA", [createFeature("F-002", "MS-BETA", 0)]],
    ]);

    const handoffs = mapAllFeaturesToTaskHandoffs(roadmap, milestones, featuresByMilestoneId);

    expect(handoffs).toHaveLength(2);
    expect(handoffs[0].source.milestoneId).toBe("MS-ALPHA");
    expect(handoffs[0].source.milestoneTitle).toBe("Alpha Milestone");
    expect(handoffs[1].source.milestoneId).toBe("MS-BETA");
    expect(handoffs[1].source.milestoneTitle).toBe("Beta Milestone");
  });

  it("mission handoff preserves source IDs on all entities", () => {
    const roadmap = createRoadmap({ id: "RM-MISSION" });
    const milestones = [
      createMilestone("MS-MISSION-1", "RM-MISSION", 0, { title: "First Phase" }),
    ];
    const featuresByMilestoneId = new Map<string, readonly RoadmapFeature[]>([
      ["MS-MISSION-1", [
        createFeature("RF-MISSION-1", "MS-MISSION-1", 0, { title: "Mission Feature" }),
      ]],
    ]);

    const handoff = mapRoadmapToMissionHandoff(roadmap, milestones, featuresByMilestoneId);

    expect(handoff.sourceRoadmapId).toBe("RM-MISSION");
    expect(handoff.milestones[0].sourceMilestoneId).toBe("MS-MISSION-1");
    expect(handoff.milestones[0].features[0].sourceFeatureId).toBe("RF-MISSION-1");
  });
});
