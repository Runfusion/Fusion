// @vitest-environment node

import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { request } from "../test-request.js";
import { createDevServerRouter, destroyAllDevServerManagers } from "../dev-server-routes.js";

function createProjectRoot(): string {
  return mkdtempSync(join(os.tmpdir(), "fn-dev-server-config-routes-"));
}

function buildApp(projectRoot: string): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api/dev-server", createDevServerRouter({ projectRoot }));
  return app;
}

describe("dev-server config routes", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await destroyAllDevServerManagers();

    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("GET /api/dev-server/config returns defaults when config file is missing", async () => {
    const root = createProjectRoot();
    tempDirs.push(root);

    const app = buildApp(root);
    const res = await request(app, "GET", "/api/dev-server/config");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      selectedScript: null,
      selectedSource: null,
      selectedCommand: null,
      previewUrlOverride: null,
      detectedPreviewUrl: null,
      selectedAt: null,
    });
  });

  it("PUT /api/dev-server/config saves a valid partial update", async () => {
    const root = createProjectRoot();
    tempDirs.push(root);

    const app = buildApp(root);
    const res = await request(
      app,
      "PUT",
      "/api/dev-server/config",
      JSON.stringify({
        selectedScript: "dev",
        selectedSource: "root",
        selectedCommand: "vite",
        selectedAt: "2026-04-19T15:00:00.000Z",
      }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      selectedScript: "dev",
      selectedSource: "root",
      selectedCommand: "vite",
      selectedAt: "2026-04-19T15:00:00.000Z",
    });
  });

  it("PUT /api/dev-server/config returns 400 for empty body", async () => {
    const root = createProjectRoot();
    tempDirs.push(root);

    const app = buildApp(root);
    const res = await request(
      app,
      "PUT",
      "/api/dev-server/config",
      JSON.stringify({}),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(400);
  });

  it("PUT /api/dev-server/config returns 400 for invalid previewUrlOverride", async () => {
    const root = createProjectRoot();
    tempDirs.push(root);

    const app = buildApp(root);
    const res = await request(
      app,
      "PUT",
      "/api/dev-server/config",
      JSON.stringify({ previewUrlOverride: "localhost:3000" }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(400);
  });
});
