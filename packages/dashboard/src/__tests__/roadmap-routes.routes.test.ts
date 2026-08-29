// @vitest-environment node

import { describe, it, expect } from "vitest";
import express from "express";
import { registerIntegratedRouters } from "../routes/register-integrated-routers.js";

describe("integrated roadmap routes compatibility", () => {
  it("registers a legacy /roadmaps mount that delegates to plugin routes", () => {
    const router = express.Router();
    registerIntegratedRouters({
      router,
      store: {} as never,
    });

    const stack = (router as unknown as { stack?: Array<{ regexp?: { source?: string }; handle?: { stack?: Array<{ route?: { path?: string } }> } }> }).stack ?? [];

    const hasRoadmapMount = stack.some((layer) => {
      if (layer.regexp?.source?.includes("roadmaps")) return true;
      return layer.handle?.stack?.some((nested) => typeof nested.route?.path === "string" && nested.route.path.startsWith("/roadmaps")) ?? false;
    });

    expect(hasRoadmapMount).toBe(true);
  });
});
