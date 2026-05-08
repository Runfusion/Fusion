import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
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
  it("keeps manifest and plugin entry metadata aligned", () => {
    const manifest = JSON.parse(readFileSync(resolve(process.cwd(), "manifest.json"), "utf8")) as {
      id: string;
      version: string;
      dashboardViews?: Array<{ viewId: string }>;
    };

    expect(plugin.manifest.id).toBe(manifest.id);
    expect(plugin.manifest.version).toBe(manifest.version);
    expect(plugin.dashboardViews?.[0]?.viewId).toBe(manifest.dashboardViews?.[0]?.viewId);
  });

  it("declares expected package exports", () => {
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8")) as {
      exports: Record<string, unknown>;
    };

    expect(pkg.exports).toHaveProperty(".");
    expect(pkg.exports).toHaveProperty("./server");
    expect(pkg.exports).toHaveProperty("./dashboard-view");
  });

  it("exports plugin manifest with roadmap id", () => {
    expect(plugin.manifest.id).toBe("fusion-plugin-roadmap");
  });

  it("re-exports roadmap domain symbols", () => {
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
