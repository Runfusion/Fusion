// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import express from "express";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskStore } from "@fusion/core";
import { createApiRoutes } from "../routes.js";
import { request } from "../test-request.js";

vi.mock("@fusion/core", async (importOriginal) => {
  const { createCoreMock } = await import("../test/mockCoreEngine.js");
  return createCoreMock(() => importOriginal<typeof import("@fusion/core")>(), {
    resolveGlobalDir: vi.fn().mockReturnValue("/tmp/fusion-test"),
    CentralCore: vi.fn().mockImplementation(function () {
      return {
        init: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        listProjects: vi.fn().mockResolvedValue([]),
      };
    }),
  });
});

vi.mock("@fusion/engine", async () => {
  const { createEngineMock } = await import("../test/mockCoreEngine.js");
  return createEngineMock();
});

function createProjectDiscoveryStore(): TaskStore {
  return {
    getAsyncLayer: vi.fn().mockReturnValue(null),
    getRootDir: vi.fn().mockReturnValue("/fake/root"),
    getSettings: vi.fn().mockResolvedValue({}),
    getSettingsFast: vi.fn().mockResolvedValue({}),
    getSettingsByScope: vi.fn().mockResolvedValue({ global: {}, project: {} }),
    getSettingsByScopeFast: vi.fn().mockResolvedValue({ global: {}, project: {} }),
    listTasks: vi.fn().mockResolvedValue([]),
    listWorkflowSteps: vi.fn().mockResolvedValue([]),
  } as unknown as TaskStore;
}

describe("PostgreSQL project marker discovery", () => {
  /**
   * FNXC:PostgresProjectDiscovery 2026-07-14-19:15:
   * Project-marker discovery is isolated from the broad system-route suite so
   * its filesystem contract stays focused and that suite remains reviewable.
   */
  it("detects a project.json-only child directory", async () => {
    const basePath = mkdtempSync(join(tmpdir(), "fusion-dashboard-detect-"));
    const projectPath = join(basePath, "marker-project");
    mkdirSync(join(projectPath, ".fusion"), { recursive: true });
    writeFileSync(join(projectPath, ".fusion", "project.json"), JSON.stringify({
      id: "proj_0123456789abcdef",
      createdAt: "2026-07-14T17:30:00.000Z",
    }));

    try {
      const app = express();
      app.use(express.json());
      app.use("/api", createApiRoutes(createProjectDiscoveryStore()));
      const res = await request(
        app,
        "POST",
        "/api/projects/detect",
        JSON.stringify({ basePath }),
        { "content-type": "application/json" },
      );

      expect(res.status).toBe(200);
      expect(res.body.projects).toEqual([
        { path: projectPath, suggestedName: "marker-project", existing: false },
      ]);
    } finally {
      rmSync(basePath, { recursive: true, force: true });
    }
  });
});
