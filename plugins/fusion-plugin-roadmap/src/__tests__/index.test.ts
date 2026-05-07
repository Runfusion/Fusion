import { describe, expect, it } from "vitest";
import { RoadmapStore as CoreRoadmapStore } from "@fusion/core";
import plugin, {
  RoadmapStore,
  applyRoadmapFeatureReorder,
  applyRoadmapMilestoneReorder,
  mapAllFeaturesToTaskHandoffs,
  mapFeatureToTaskHandoff,
  mapRoadmapToMissionHandoff,
  mapRoadmapWithHierarchyToMissionHandoff,
  moveRoadmapFeature,
  normalizeRoadmapFeatureOrder,
  normalizeRoadmapMilestoneOrder,
} from "../index.js";

describe("fusion-plugin-roadmap package surface", () => {
  it("exports plugin manifest with roadmap id", () => {
    expect(plugin.manifest.id).toBe("fusion-plugin-roadmap");
  });

  it("re-exports roadmap domain symbols", () => {
    expect(RoadmapStore).toBe(CoreRoadmapStore);
    expect(typeof normalizeRoadmapMilestoneOrder).toBe("function");
    expect(typeof applyRoadmapMilestoneReorder).toBe("function");
    expect(typeof normalizeRoadmapFeatureOrder).toBe("function");
    expect(typeof applyRoadmapFeatureReorder).toBe("function");
    expect(typeof moveRoadmapFeature).toBe("function");
    expect(typeof mapFeatureToTaskHandoff).toBe("function");
    expect(typeof mapRoadmapToMissionHandoff).toBe("function");
    expect(typeof mapRoadmapWithHierarchyToMissionHandoff).toBe("function");
    expect(typeof mapAllFeaturesToTaskHandoffs).toBe("function");
    expect(typeof RoadmapStore).toBe("function");
  });
});
