import { describe, it, expect, vi } from "vitest";
import { createRoadmapPluginRoutes } from "../roadmap-routes.js";

function createCtx() {
  return {
    pluginId: "fusion-plugin-roadmap",
    taskStore: {
      getDatabase: () => ({}),
      getRootDir: () => "/tmp/project",
      getRoadmapStore: () => ({
        getRoadmap: vi.fn(() => ({ id: "RM-1", title: "R" })),
        getMilestone: vi.fn(() => ({ id: "MS-1", roadmapId: "RM-1", title: "M" })),
        listFeatures: vi.fn(() => []),
      }),
    },
    settings: {},
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    emitEvent: vi.fn(),
  } as any;
}

describe("createRoadmapPluginRoutes", () => {
  it("includes PATCH roadmap routes", () => {
    const routes = createRoadmapPluginRoutes();
    expect(routes.some((r) => r.method === "PATCH" && r.path === "/roadmaps/:roadmapId")).toBe(true);
  });

  it("returns 400 for invalid milestone suggestions body", async () => {
    const route = createRoadmapPluginRoutes().find((r) => r.path === "/roadmaps/:roadmapId/suggestions/milestones");
    const result = await route!.handler({ params: { roadmapId: "RM-1" }, body: {} }, createCtx());
    expect(result).toMatchObject({ status: 400 });
  });

  it("returns 404 for milestone suggestions when roadmap is missing", async () => {
    const route = createRoadmapPluginRoutes().find((r) => r.path === "/roadmaps/:roadmapId/suggestions/milestones");
    const ctx = createCtx();
    const store = ctx.taskStore.getRoadmapStore();
    ctx.taskStore.getRoadmapStore = () => ({ ...store, getRoadmap: vi.fn(() => null) });
    const result = await route!.handler({ params: { roadmapId: "RM-404" }, body: { goalPrompt: "goal" } }, ctx);
    expect(result).toMatchObject({ status: 404 });
  });

  it("returns 503 for suggestions when createAiSession is unavailable", async () => {
    const route = createRoadmapPluginRoutes().find((r) => r.path === "/roadmaps/:roadmapId/suggestions/milestones");
    const result = await route!.handler({ params: { roadmapId: "RM-1" }, body: { goalPrompt: "goal" } }, createCtx());
    expect(result).toMatchObject({ status: 503 });
  });
});
