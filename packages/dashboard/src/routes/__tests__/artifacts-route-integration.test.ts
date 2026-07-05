// @vitest-environment node

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore, type ArtifactWithTask } from "@fusion/core";
import { createApiRoutes } from "../../routes.js";
import { request as REQUEST } from "../../test-request.js";

/*
 * FNXC:ArtifactRegistry 2026-06-27-00:00:
 * The mocked artifacts route tests skip the real listArtifacts LEFT JOIN and hand-write media files. This integration test uses a real TaskStore so the Documents Artifacts view contract is pinned end-to-end: registered image artifacts list with task metadata and stream from the real disk write path.
 */
describe("artifacts route integration", () => {
  let store: TaskStore;
  let rootDir: string;
  let globalDir: string;
  let app: express.Express;

  beforeEach(async () => {
    rootDir = mkdtempSync(join(tmpdir(), "artifacts-route-root-"));
    globalDir = mkdtempSync(join(tmpdir(), "artifacts-route-global-"));
    store = new TaskStore(rootDir, globalDir, { inMemoryDb: true });
    await store.init();

    app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));
  });

  afterEach(() => {
    store.close();
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(globalDir, { recursive: true, force: true });
  });

  async function createTaskImageArtifact() {
    const task = await store.createTask({
      title: "Render screenshot",
      description: "Capture dashboard artifact rendering evidence",
    });
    const imageBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=", "base64");
    const artifact = await store.registerArtifact({
      type: "image",
      title: "Dashboard screenshot",
      mimeType: "image/png",
      data: imageBytes,
      authorId: "agent-7125",
      authorType: "agent",
      taskId: task.id,
    });
    return { task, artifact, imageBytes };
  }

  async function requestRawBuffer(app: express.Express, path: string) {
    /*
     * FNXC:ArtifactRegistry 2026-06-29-17:11:
     * Media route verification must compare the raw streamed bytes, not a UTF-8 string re-encoding, so binary image corruption fails the integration test.
     */
    const server = http.createServer(app);
    return await new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("Expected an ephemeral TCP address for raw media request"));
          return;
        }

        const req = http.get({ host: "127.0.0.1", port: address.port, path }, (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            server.close();
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) });
          });
        });
        req.on("error", (error) => {
          server.close();
          reject(error);
        });
      });
    });
  }

  it("an image artifact created on a task appears in the artifacts listing with task association", async () => {
    const { task, artifact } = await createTaskImageArtifact();

    const res = await REQUEST(app, "GET", "/api/artifacts");

    expect(res.status).toBe(200);
    const body = res.body as ArtifactWithTask[];
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      id: artifact.id,
      type: "image",
      mimeType: "image/png",
      title: "Dashboard screenshot",
      authorId: "agent-7125",
      taskId: task.id,
      taskTitle: "Render screenshot",
    });
    expect(body[0].taskColumn).toBeTruthy();
  });

  it("the image artifact streams its real bytes with the correct content type", async () => {
    const { artifact, imageBytes } = await createTaskImageArtifact();

    const res = await requestRawBuffer(app, `/api/artifacts/${artifact.id}/media`);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.body).toEqual(imageBytes);
  });

  it("a global image artifact still streams from the managed global artifacts directory", async () => {
    const imageBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=", "base64");
    const artifact = await store.registerArtifact({
      type: "image",
      title: "Global screenshot",
      mimeType: "image/png",
      data: imageBytes,
      authorId: "agent-7143",
      authorType: "agent",
    });

    const res = await requestRawBuffer(app, `/api/artifacts/${artifact.id}/media`);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.body).toEqual(imageBytes);
  });

  it("a URI-only image artifact whose file is missing still returns 404", async () => {
    const task = await store.createTask({
      title: "Missing screenshot",
      description: "Preserve existing missing media semantics",
    });
    const artifact = await store.registerArtifact({
      type: "image",
      title: "Missing screenshot",
      mimeType: "image/png",
      uri: "artifacts/missing.png",
      authorId: "agent-7143",
      authorType: "agent",
      taskId: task.id,
    });

    const res = await REQUEST(app, "GET", `/api/artifacts/${artifact.id}/media`);

    expect(res.status).toBe(404);
  });

  it("a task with no artifacts lists as empty", async () => {
    const task = await store.createTask({
      title: "Render screenshot",
      description: "Capture dashboard artifact rendering evidence",
    });

    const res = await REQUEST(app, "GET", `/api/artifacts?taskId=${encodeURIComponent(task.id)}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  /*
   * FNXC:ArtifactRegistry 2026-07-04-20:10:
   * FN-7544 surface enumeration: a task-less agent-authored registry artifact (no taskId) must appear
   * in the global GET /api/artifacts listing exactly like task-scoped ones.
   */
  it("a task-less agent-authored artifact appears in the global artifacts listing", async () => {
    const artifact = await store.registerArtifact({
      type: "document",
      title: "Registry-only note",
      content: "# Task-less artifact",
      authorId: "agent-registry",
      authorType: "agent",
    });

    const res = await REQUEST(app, "GET", "/api/artifacts");

    expect(res.status).toBe(200);
    const body = res.body as ArtifactWithTask[];
    expect(body.map((a) => a.id)).toContain(artifact.id);
    const found = body.find((a) => a.id === artifact.id);
    expect(found?.authorType).toBe("agent");
    expect(found?.taskId).toBeFalsy();
  });

  /*
   * FNXC:ArtifactRegistry 2026-07-04-20:10:
   * FN-7544 surface enumeration: GET /api/artifacts?taskId= must scope strictly to the requested task —
   * artifacts from a different task or task-less registry rows must not leak in (project/task-scope
   * isolation), while multiple artifacts for the SAME task must all be returned.
   */
  it("?taskId= scopes strictly to the requested task and returns all of its artifacts", async () => {
    const { task: taskA, artifact: artifactA } = await createTaskImageArtifact();
    const taskB = await store.createTask({ title: "Other task", description: "A different task" });
    const artifactB = await store.registerArtifact({
      type: "document",
      title: "Other task note",
      content: "# Belongs to task B",
      authorId: "agent-7125",
      authorType: "agent",
      taskId: taskB.id,
    });
    const registryArtifact = await store.registerArtifact({
      type: "document",
      title: "Task-less note",
      content: "# No task",
      authorId: "agent-7125",
      authorType: "agent",
    });
    const artifactA2 = await store.registerArtifact({
      type: "document",
      title: "Second note for task A",
      content: "# Also task A",
      authorId: "agent-7125",
      authorType: "agent",
      taskId: taskA.id,
    });

    const res = await REQUEST(app, "GET", `/api/artifacts?taskId=${encodeURIComponent(taskA.id)}`);

    expect(res.status).toBe(200);
    const ids = (res.body as ArtifactWithTask[]).map((a) => a.id).sort();
    expect(ids).toEqual([artifactA.id, artifactA2.id].sort());
    expect(ids).not.toContain(artifactB.id);
    expect(ids).not.toContain(registryArtifact.id);
  });

  /*
   * FNXC:ArtifactRegistry 2026-07-04-20:10:
   * FN-7544: a SECOND TaskStore instance against the same DB (mirroring the dashboard-vs-engine or
   * two-process scenario) must observe artifact:registered for a write it did not perform once its poll
   * cycle runs, and must serve the row through its own listArtifacts/GET /api/artifacts — not just the
   * originating instance. This is the store-level fix under test, exercised through the HTTP route.
   */
  it("a live-registered artifact is served by a second polling store instance's route", async () => {
    /*
     * FNXC:ArtifactRegistry 2026-07-04-20:10:
     * The beforeEach `store` uses inMemoryDb:true, which cannot be shared across two TaskStore
     * instances, so this scenario needs its own file-backed pair of stores against the same rootDir to
     * reproduce two real processes polling the same on-disk DB.
     */
    const crossRootDir = mkdtempSync(join(tmpdir(), "artifacts-route-cross-root-"));
    const crossGlobalDir = mkdtempSync(join(tmpdir(), "artifacts-route-cross-global-"));
    const writerStore = new TaskStore(crossRootDir, crossGlobalDir);
    await writerStore.init();
    const observerStore = new TaskStore(crossRootDir, crossGlobalDir);
    await observerStore.init();
    await observerStore.watch();
    const observerApp = express();
    observerApp.use(express.json());
    observerApp.use("/api", createApiRoutes(observerStore));

    try {
      const registered = vi.fn();
      observerStore.on("artifact:registered", registered);

      const artifact = await writerStore.registerArtifact({
        type: "document",
        title: "Cross-instance route artifact",
        content: "# Cross-instance",
        authorId: "agent-cross-instance",
        authorType: "agent",
      });

      await (observerStore as unknown as { checkForChanges: () => Promise<void> }).checkForChanges();

      expect(registered).toHaveBeenCalledTimes(1);

      const res = await REQUEST(observerApp, "GET", "/api/artifacts");
      expect(res.status).toBe(200);
      expect((res.body as ArtifactWithTask[]).map((a) => a.id)).toContain(artifact.id);
    } finally {
      observerStore.close();
      writerStore.close();
      rmSync(crossRootDir, { recursive: true, force: true });
      rmSync(crossGlobalDir, { recursive: true, force: true });
    }
  });
});
