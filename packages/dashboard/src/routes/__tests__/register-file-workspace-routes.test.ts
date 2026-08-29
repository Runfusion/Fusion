// @vitest-environment node

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import type { TaskStore } from "@fusion/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerFileWorkspaceRoutes } from "../register-file-workspace-routes.js";
import type { ApiRoutesContext } from "../types.js";
import { request as REQUEST } from "../../test-request.js";

const tempRoots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "fusion-file-workspace-routes-"));
  tempRoots.push(root);
  return root;
}

function makeApp(store: Partial<TaskStore>) {
  const router = express.Router();
  const app = express();
  registerFileWorkspaceRoutes({
    router,
    store: store as TaskStore,
    runtimeLogger: {} as never,
    planningLogger: {} as never,
    chatLogger: {} as never,
    getProjectIdFromRequest: vi.fn(),
    getScopedStore: vi.fn(async () => store as TaskStore),
    getProjectContext: vi.fn(async () => ({ store: store as TaskStore, engine: undefined, projectId: undefined })),
    prioritizeProjectsForCurrentDirectory: vi.fn((projects) => projects),
    emitRemoteRouteDiagnostic: vi.fn(),
    emitAuthSyncAuditLog: vi.fn(),
    parseScopeParam: vi.fn(),
    resolveAutomationStore: vi.fn(),
    resolveRoutineStore: vi.fn(),
    resolveRoutineRunner: vi.fn(),
    registerDispose: vi.fn(),
    dispose: vi.fn(),
    rethrowAsApiError(error: unknown, fallbackMessage?: string): never {
      throw error instanceof Error ? error : new Error(fallbackMessage ?? String(error));
    },
  } as ApiRoutesContext);
  app.use("/api", router);
  return app;
}

async function writeFixture(root: string, filePath: string, content = "fixture-bytes"): Promise<void> {
  const pathParts = filePath.split("/");
  const fileName = pathParts.pop();
  if (!fileName) {
    throw new Error(`Fixture path must include a file name: ${filePath}`);
  }
  const directoryPath = join(root, ...pathParts);
  await mkdir(directoryPath, { recursive: true });
  await writeFile(join(directoryPath, fileName), Buffer.from(content));
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("file workspace download route", () => {
  it.each([
    ["assets/logo.png", "image/png"],
    ["icons/mark.svg", "image/svg+xml"],
    ["media/demo.mp4", "video/mp4"],
    ["audio/theme.mp3", "audio/mpeg"],
    ["docs/spec.pdf", "application/pdf"],
    ["nested/CAPTURE.PNG", "image/png"],
  ])("serves previewable file %s inline with renderable headers", async (filePath, expectedContentType) => {
    const root = await makeRoot();
    await writeFixture(root, filePath);
    const app = makeApp({ getRootDir: vi.fn(() => root) });

    const res = await REQUEST(app, "GET", `/api/files/${encodeURIComponent(filePath)}/download?workspace=project&inline=1`);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe(expectedContentType);
    expect(res.headers["content-disposition"]).toBe(`inline; filename="${filePath.split("/").at(-1)}"`);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toBe("sandbox");
    expect(res.body).toBe("fixture-bytes");
  });

  it.each([
    "assets/logo.png",
    "icons/mark.svg",
    "media/demo.mp4",
    "audio/theme.mp3",
    "docs/spec.pdf",
  ])("keeps the default download contract for %s as attachment octet-stream", async (filePath) => {
    const root = await makeRoot();
    await writeFixture(root, filePath);
    const app = makeApp({ getRootDir: vi.fn(() => root) });

    const res = await REQUEST(app, "GET", `/api/files/${encodeURIComponent(filePath)}/download?workspace=project`);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/octet-stream");
    expect(res.headers["content-disposition"]).toBe(`attachment; filename="${filePath.split("/").at(-1)}"`);
    expect(res.headers["x-content-type-options"]).toBeUndefined();
    expect(res.headers["content-security-policy"]).toBeUndefined();
    expect(res.body).toBe("fixture-bytes");
  });

  it("falls back to attachment for inline requests with unknown binary extensions", async () => {
    const root = await makeRoot();
    await writeFixture(root, "archives/build.zip");
    const app = makeApp({ getRootDir: vi.fn(() => root) });

    const res = await REQUEST(app, "GET", `/api/files/${encodeURIComponent("archives/build.zip")}/download?workspace=project&inline=1`);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/octet-stream");
    expect(res.headers["content-disposition"]).toBe("attachment; filename=\"build.zip\"");
    expect(res.headers["x-content-type-options"]).toBeUndefined();
    expect(res.headers["content-security-policy"]).toBeUndefined();
  });

  it("serves task workspace preview files inline while preserving projectId query propagation", async () => {
    const root = await makeRoot();
    const taskDir = join(root, ".fusion", "tasks", "FN-123");
    await writeFixture(taskDir, "screens/shot.JPG");
    const store = {
      getRootDir: vi.fn(() => root),
      getTask: vi.fn(async () => ({ id: "FN-123", title: "Task" })),
      getTaskDir: vi.fn(() => taskDir),
    };
    const app = makeApp(store);

    const res = await REQUEST(app, "GET", `/api/files/${encodeURIComponent("screens/shot.JPG")}/download?workspace=FN-123&projectId=project-a&inline=true`);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("image/jpeg");
    expect(res.headers["content-disposition"]).toBe("inline; filename=\"shot.JPG\"");
    expect(store.getTask).toHaveBeenCalledWith("FN-123");
  });
});
