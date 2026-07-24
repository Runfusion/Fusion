// @vitest-environment node

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Artifact, ArtifactWithTask, TaskStore } from "@fusion/core";
import { createApiRoutes } from "../../routes.js";
import { request as REQUEST } from "../../test-request.js";

const tempRoots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "fusion-artifacts-routes-"));
  tempRoots.push(root);
  return root;
}

function makeArtifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: "artifact-1",
    type: "image",
    title: "Screenshot",
    mimeType: "image/png",
    uri: "artifacts/screenshot.png",
    authorId: "agent-1",
    authorType: "agent",
    taskId: "FN-1",
    createdAt: "2026-06-21T00:00:00.000Z",
    updatedAt: "2026-06-21T00:00:00.000Z",
    ...overrides,
  };
}

function makeApp(store: Partial<TaskStore>) {
  const app = express();
  /*
  FNXC:PluginMcpServers 2026-07-24-01:25:
  FN-8491 (3cd023fa4) binds a project-scoped plugin-MCP provider on every getProjectContext.
  Exposing getProjectScopedPluginMcpServers marks these partial mocks as runtime-owned so the
  binder short-circuits instead of calling getPluginStore().
  */
  const boundStore = {
    getProjectScopedPluginMcpServers: async () => [],
    ...store,
  };
  app.use("/api", createApiRoutes(boundStore as TaskStore));
  return app;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("artifacts routes", () => {
  it("lists artifacts with parsed filters and clamped pagination", async () => {
    const artifact: ArtifactWithTask = { ...makeArtifact(), taskTitle: "Task" };
    const listArtifacts = vi.fn().mockResolvedValue([artifact]);
    const app = makeApp({
      getRootDir: vi.fn(() => process.cwd()),
      listArtifacts,
    });

    const res = await REQUEST(app, "GET", "/api/artifacts?type=image&authorId=agent-1&taskId=FN-1&q=screen&limit=5000&offset=2");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([artifact]);
    expect(listArtifacts).toHaveBeenCalledWith({
      type: "image",
      authorId: "agent-1",
      taskId: "FN-1",
      search: "screen",
      limit: 1000,
      offset: 2,
    });
  });

  it.each([
    ["/api/artifacts?type=bogus", "type"],
    ["/api/artifacts?limit=0", "limit"],
    ["/api/artifacts?limit=abc", "limit"],
    ["/api/artifacts?offset=-1", "offset"],
    ["/api/artifacts?offset=abc", "offset"],
  ])("rejects invalid list query %s", async (path, expectedMessage) => {
    const listArtifacts = vi.fn();
    const app = makeApp({
      getRootDir: vi.fn(() => process.cwd()),
      listArtifacts,
    });

    const res = await REQUEST(app, "GET", path);

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain(expectedMessage);
    expect(listArtifacts).not.toHaveBeenCalled();
  });

  it("streams task-scoped artifact media with its content type", async () => {
    const root = await makeRoot();
    const taskDir = join(root, ".fusion", "tasks", "FN-1");
    await mkdir(join(taskDir, "artifacts"), { recursive: true });
    await writeFile(join(taskDir, "artifacts", "screenshot.png"), Buffer.from("image-bytes"));

    const artifact = makeArtifact();
    const app = makeApp({
      getRootDir: vi.fn(() => root),
      getTaskDir: vi.fn(() => taskDir),
      getFusionDir: vi.fn(() => join(root, ".fusion")),
      getArtifact: vi.fn().mockResolvedValue(artifact),
    });

    const res = await REQUEST(app, "GET", "/api/artifacts/artifact-1/media");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.body).toBe("image-bytes");
  });

  it("streams task-less registry artifact media from the fusion artifacts directory", async () => {
    const root = await makeRoot();
    const fusionDir = join(root, ".fusion");
    await mkdir(join(fusionDir, "artifacts"), { recursive: true });
    await writeFile(join(fusionDir, "artifacts", "registry.bin"), Buffer.from("registry-bytes"));

    const artifact = makeArtifact({ taskId: undefined, uri: "artifacts/registry.bin", mimeType: "application/octet-stream" });
    const app = makeApp({
      getRootDir: vi.fn(() => root),
      getTaskDir: vi.fn(() => join(root, ".fusion", "tasks", "FN-1")),
      getFusionDir: vi.fn(() => fusionDir),
      getArtifact: vi.fn().mockResolvedValue(artifact),
    });

    const res = await REQUEST(app, "GET", "/api/artifacts/artifact-1/media");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/octet-stream");
    expect(res.body).toBe("registry-bytes");
  });

  it("returns inline text artifact content when no uri exists", async () => {
    const artifact = makeArtifact({ uri: undefined, content: "inline text", mimeType: "text/plain" });
    const app = makeApp({
      getRootDir: vi.fn(() => process.cwd()),
      getTaskDir: vi.fn(() => process.cwd()),
      getFusionDir: vi.fn(() => process.cwd()),
      getArtifact: vi.fn().mockResolvedValue(artifact),
    });

    const res = await REQUEST(app, "GET", "/api/artifacts/artifact-1/media");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.body).toBe("inline text");
  });

  it("returns 404 for missing artifact or missing file", async () => {
    const root = await makeRoot();
    const taskDir = join(root, ".fusion", "tasks", "FN-1");
    const missingApp = makeApp({
      getRootDir: vi.fn(() => root),
      getArtifact: vi.fn().mockResolvedValue(null),
    });

    expect((await REQUEST(missingApp, "GET", "/api/artifacts/missing/media")).status).toBe(404);

    const missingFileApp = makeApp({
      getRootDir: vi.fn(() => root),
      getTaskDir: vi.fn(() => taskDir),
      getFusionDir: vi.fn(() => join(root, ".fusion")),
      getArtifact: vi.fn().mockResolvedValue(makeArtifact()),
    });

    expect((await REQUEST(missingFileApp, "GET", "/api/artifacts/artifact-1/media")).status).toBe(404);
  });

  it("rejects artifact uri path traversal before streaming", async () => {
    const root = await makeRoot();
    const taskDir = join(root, ".fusion", "tasks", "FN-1");
    const app = makeApp({
      getRootDir: vi.fn(() => root),
      getTaskDir: vi.fn(() => taskDir),
      getFusionDir: vi.fn(() => join(root, ".fusion")),
      getArtifact: vi.fn().mockResolvedValue(makeArtifact({ uri: "artifacts/../secret.txt" })),
    });

    const res = await REQUEST(app, "GET", "/api/artifacts/artifact-1/media");

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain("Invalid artifact media path");
  });
});
