// @vitest-environment node

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore, type ArtifactType, type ArtifactWithTask } from "@fusion/core";
import { createArtifactRegisterTool } from "@fusion/engine";
import { createApiRoutes } from "../../routes.js";
import { request as REQUEST } from "../../test-request.js";


const ARTIFACT_TYPES: ArtifactType[] = ["document", "image", "video", "audio", "other"];
const PNG_IMAGE_BYTES = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=", "base64");
const BINARY_MEDIA_BY_TYPE: Record<ArtifactType, { mimeType: string; bytes: Buffer }> = {
  document: { mimeType: "application/pdf", bytes: Buffer.from("%PDF-1.4\n% FN-7764 document bytes\n") },
  image: { mimeType: "image/png", bytes: PNG_IMAGE_BYTES },
  video: { mimeType: "video/mp4", bytes: Buffer.from("\x00\x00\x00\x18ftypmp42FN7764-video") },
  audio: { mimeType: "audio/mpeg", bytes: Buffer.from("ID3\x03\x00\x00\x00\x00\x00\x0fFN7764-audio") },
  other: { mimeType: "application/octet-stream", bytes: Buffer.from("FN-7764 other binary payload") },
};

function contentMimeFor(type: ArtifactType): string {
  return type === "document" ? "text/markdown" : "text/plain";
}

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
    const imageBytes = PNG_IMAGE_BYTES;
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

  /*
   * FNXC:ArtifactRegistry 2026-07-10-00:00:
   * FN-7767 pins the real-server/default-scope invariant the in-memory FN-7693/FN-7764 tests missed: an image created through the agent fn_artifact_register tool must be visible through the dashboard route with no projectId query (single-project/default server scope) and stream as image/png.
   */
  it("an agent-tool image artifact is listed and streamed through the default server scope", async () => {
    const task = await store.createTask({
      title: "Agent screenshot",
      description: "Artifact should surface in the default Artifacts tab scope",
    });
    const registerTool = createArtifactRegisterTool(store, "agent-fn-7767");

    const registerResult = await registerTool.execute("call-register-fn-7767-image", {
      type: "image",
      title: "Agent-created screenshot",
      description: "Default-scope image artifact",
      mimeType: "image/png",
      dataBase64: PNG_IMAGE_BYTES.toString("base64"),
      taskId: task.id,
    });
    const artifactId = (registerResult.details as { artifactId?: string }).artifactId;
    expect(artifactId).toBeTruthy();

    const listRes = await REQUEST(app, "GET", "/api/artifacts");

    expect(listRes.status).toBe(200);
    const listed = (listRes.body as ArtifactWithTask[]).find((artifact) => artifact.id === artifactId);
    expect(listed).toMatchObject({
      id: artifactId,
      type: "image",
      title: "Agent-created screenshot",
      mimeType: "image/png",
      authorId: "agent-fn-7767",
      authorType: "agent",
      taskId: task.id,
      taskTitle: "Agent screenshot",
    });
    expect(listRes.body).toHaveLength(1);

    const mediaRes = await requestRawBuffer(app, `/api/artifacts/${artifactId}/media`);
    expect(mediaRes.status).toBe(200);
    expect(mediaRes.headers["content-type"]).toBe("image/png");
    expect(mediaRes.body).toEqual(PNG_IMAGE_BYTES);
  });

  /*
   * FNXC:ArtifactRegistry 2026-07-10-00:00:
   * FN-7791 pins the missing attachment-to-artifact bridge at the route/media boundary: a real PNG stored by TaskStore.addAttachment must list through GET /api/artifacts with task metadata and stream the original attachment bytes via /media.
   */
  it("an attachment-sourced image artifact lists and streams through the default server scope", async () => {
    const task = await store.createTask({
      title: "Task agent attachment",
      description: "A task agent attached a screenshot",
    });
    const attachment = await store.addAttachment(task.id, "agent-shot.png", PNG_IMAGE_BYTES, "image/png");
    await store.addAttachment(task.id, "agent-notes.txt", Buffer.from("not surfaced as an image artifact"), "text/plain");

    const listRes = await REQUEST(app, "GET", "/api/artifacts");

    expect(listRes.status).toBe(200);
    const body = listRes.body as ArtifactWithTask[];
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      type: "image",
      title: "agent-shot.png",
      mimeType: "image/png",
      sizeBytes: PNG_IMAGE_BYTES.length,
      uri: `attachments/${attachment.filename}`,
      authorId: "attachment",
      authorType: "system",
      taskId: task.id,
      taskTitle: "Task agent attachment",
    });

    const taskScopedRes = await REQUEST(app, "GET", `/api/artifacts?taskId=${encodeURIComponent(task.id)}&type=image`);
    expect(taskScopedRes.status).toBe(200);
    expect(taskScopedRes.body).toHaveLength(1);
    expect((taskScopedRes.body as ArtifactWithTask[])[0].id).toBe(body[0].id);

    const mediaRes = await requestRawBuffer(app, `/api/artifacts/${body[0].id}/media`);
    expect(mediaRes.status).toBe(200);
    expect(mediaRes.headers["content-type"]).toBe("image/png");
    expect(mediaRes.body).toEqual(PNG_IMAGE_BYTES);
  });

  it("a global image artifact still streams from the managed global artifacts directory", async () => {
    const imageBytes = PNG_IMAGE_BYTES;
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
   * FNXC:ArtifactRegistry 2026-07-09-17:35:
   * FN-7764 pins the route/media side of the same operator-facing invariant as the agent tools: every artifact type and payload class must be discoverable through GET /api/artifacts with task context, and binary or inline media must be viewable without broken image-only assumptions.
   */
  it("lists and serves every artifact type across inline, uri, binary, task, and registry-level states", async () => {
    const task = await store.createTask({
      title: "FN-7764 route artifact matrix",
      description: "Capture route-level artifact evidence",
    });
    const otherTask = await store.createTask({ title: "Other artifact task", description: "Must not leak through taskId filter" });
    const created: ArtifactWithTask[] = [];

    for (const type of ARTIFACT_TYPES) {
      created.push(await store.registerArtifact({
        type,
        title: `route ${type} inline content`,
        description: `inline ${type} route evidence`,
        mimeType: contentMimeFor(type),
        content: `Inline ${type} route evidence for FN-7764`,
        authorId: "agent-route-content",
        authorType: "agent",
        taskId: task.id,
      }) as ArtifactWithTask);

      created.push(await store.registerArtifact({
        type,
        title: `route ${type} uri reference`,
        description: `uri ${type} route evidence`,
        mimeType: BINARY_MEDIA_BY_TYPE[type].mimeType,
        uri: `artifacts/route-${type}-external.bin`,
        authorId: "agent-route-uri",
        authorType: "agent",
        taskId: task.id,
      }) as ArtifactWithTask);

      created.push(await store.registerArtifact({
        type,
        title: `route ${type} binary media`,
        description: `binary ${type} route evidence`,
        mimeType: BINARY_MEDIA_BY_TYPE[type].mimeType,
        data: BINARY_MEDIA_BY_TYPE[type].bytes,
        authorId: "agent-route-binary",
        authorType: "agent",
        taskId: task.id,
      }) as ArtifactWithTask);
    }

    const registryOnly = await store.registerArtifact({
      type: "other",
      title: "route registry-level other binary",
      description: "task-less registry evidence",
      mimeType: "application/octet-stream",
      data: Buffer.from("registry-level-other-bytes"),
      authorId: "agent-route-registry",
      authorType: "agent",
    });
    const otherTaskArtifact = await store.registerArtifact({
      type: "document",
      title: "other task hidden artifact",
      content: "This belongs to another task",
      authorId: "agent-route-content",
      authorType: "agent",
      taskId: otherTask.id,
    });

    const allRes = await REQUEST(app, "GET", "/api/artifacts?limit=100");
    expect(allRes.status).toBe(200);
    const allArtifacts = allRes.body as ArtifactWithTask[];
    for (const artifact of created) {
      const listed = allArtifacts.find((candidate) => candidate.id === artifact.id);
      expect(listed).toMatchObject({
        id: artifact.id,
        type: artifact.type,
        title: artifact.title,
        taskId: task.id,
        taskTitle: "route artifact matrix",
      });
      expect(listed?.taskColumn).toBeTruthy();
      expect(listed?.content).toBeUndefined();
    }
    const registryListed = allArtifacts.find((candidate) => candidate.id === registryOnly.id);
    expect(registryListed?.id).toBe(registryOnly.id);
    expect(registryListed?.taskId).toBeUndefined();
    expect(registryListed?.taskTitle).toBeUndefined();
    expect(registryListed?.taskColumn).toBeUndefined();

    const taskScopedRes = await REQUEST(app, "GET", `/api/artifacts?taskId=${encodeURIComponent(task.id)}&limit=100`);
    expect(taskScopedRes.status).toBe(200);
    const taskScopedIds = (taskScopedRes.body as ArtifactWithTask[]).map((artifact) => artifact.id);
    expect(taskScopedIds).toEqual(expect.arrayContaining(created.map((artifact) => artifact.id)));
    expect(taskScopedIds).not.toContain(registryOnly.id);
    expect(taskScopedIds).not.toContain(otherTaskArtifact.id);

    const audioFilter = await REQUEST(app, "GET", `/api/artifacts?taskId=${encodeURIComponent(task.id)}&type=audio&authorId=agent-route-binary&q=binary&limit=2&offset=0`);
    expect(audioFilter.status).toBe(200);
    expect(audioFilter.body).toHaveLength(1);
    expect((audioFilter.body as ArtifactWithTask[])[0]).toMatchObject({ type: "audio", authorId: "agent-route-binary", title: "route audio binary media" });

    const paged = await REQUEST(app, "GET", `/api/artifacts?taskId=${encodeURIComponent(task.id)}&limit=1&offset=1`);
    expect(paged.status).toBe(200);
    expect(paged.body).toHaveLength(1);

    for (const type of ARTIFACT_TYPES) {
      const inline = created.find((artifact) => artifact.type === type && artifact.title.endsWith("inline content"));
      expect(inline).toBeDefined();
      const inlineMedia = await requestRawBuffer(app, `/api/artifacts/${inline!.id}/media`);
      expect(inlineMedia.status).toBe(200);
      expect(inlineMedia.headers["content-type"]).toContain(contentMimeFor(type));
      expect(inlineMedia.body.toString()).toBe(`Inline ${type} route evidence for FN-7764`);

      const binary = created.find((artifact) => artifact.type === type && artifact.title.endsWith("binary media"));
      expect(binary).toBeDefined();
      const binaryMedia = await requestRawBuffer(app, `/api/artifacts/${binary!.id}/media`);
      expect(binaryMedia.status).toBe(200);
      expect(binaryMedia.headers["content-type"]).toBe(BINARY_MEDIA_BY_TYPE[type].mimeType);
      expect(binaryMedia.body).toEqual(BINARY_MEDIA_BY_TYPE[type].bytes);

      const uri = created.find((artifact) => artifact.type === type && artifact.title.endsWith("uri reference"));
      expect(uri).toBeDefined();
      const missingUriMedia = await REQUEST(app, "GET", `/api/artifacts/${uri!.id}/media`);
      expect(missingUriMedia.status).toBe(404);
    }

    const registryMedia = await requestRawBuffer(app, `/api/artifacts/${registryOnly.id}/media`);
    expect(registryMedia.status).toBe(200);
    expect(registryMedia.headers["content-type"]).toBe("application/octet-stream");
    expect(registryMedia.body).toEqual(Buffer.from("registry-level-other-bytes"));
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
