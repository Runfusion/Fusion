// @vitest-environment node

import express from "express";
import http from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import type { Socket } from "node:net";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { request } from "../test-request.js";
import {
  createDevServerRouter,
  destroyAllDevServerManagers,
  getActiveProcessManagers,
} from "../dev-server-routes.js";
import { loadDevServerStore } from "../dev-server-store.js";
import * as detectModule from "../dev-server-detect.js";

function createProjectRoot(): string {
  return mkdtempSync(join(os.tmpdir(), "fn-dev-server-routes-"));
}

function buildApp(projectRoot: string): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api/dev-server", createDevServerRouter({ projectRoot }));
  return app;
}

async function waitFor(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

class MockSocket extends PassThrough {
  public writable = true;
  public readable = true;
  public remoteAddress = "127.0.0.1";
  public encrypted = false;

  setTimeout(): this {
    return this;
  }

  setNoDelay(): this {
    return this;
  }

  setKeepAlive(): this {
    return this;
  }

  destroySoon(): void {
    this.destroy();
  }
}

async function openSseStream(app: express.Express, path: string) {
  const socket = new MockSocket();
  const req = new http.IncomingMessage(socket as unknown as Socket);
  const res = new http.ServerResponse(req);
  const chunks: Buffer[] = [];

  req.method = "GET";
  req.url = path;
  req.httpVersion = "1.1";
  req.headers = { host: "127.0.0.1" };

  res.assignSocket(socket as unknown as Socket);

  const originalWrite = res.write.bind(res);
  res.write = ((chunk: string | Buffer, encoding?: BufferEncoding | ((error?: Error | null) => void), cb?: (error?: Error | null) => void) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === "string" ? encoding : undefined));
    return originalWrite(chunk as never, encoding as never, cb);
  }) as typeof res.write;

  app(req, res);
  await new Promise((resolve) => process.nextTick(resolve));
  req.complete = true;
  req.emit("end");

  return {
    status: res.statusCode,
    headers: res.getHeaders(),
    readText() {
      return Buffer.concat(chunks).toString("utf8");
    },
    close() {
      req.emit("close");
      res.emit("close");
      socket.destroy();
    },
  };
}

describe("createDevServerRouter", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await destroyAllDevServerManagers();

    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("GET /api/dev-server/detect returns candidates", async () => {
    const root = createProjectRoot();
    tempDirs.push(root);

    vi.spyOn(detectModule, "detectDevServerScripts").mockResolvedValue({
      candidates: [
        {
          name: "dev",
          command: "vite",
          source: "root",
          confidence: 0.9,
        },
      ],
    });

    const app = buildApp(root);
    const res = await request(app, "GET", "/api/dev-server/detect");

    expect(res.status).toBe(200);
    expect((res.body as { candidates: unknown[] }).candidates).toHaveLength(1);
  });

  it("GET /api/dev-server/status returns default state", async () => {
    const root = createProjectRoot();
    tempDirs.push(root);

    const app = buildApp(root);
    const res = await request(app, "GET", "/api/dev-server/status");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "stopped",
      command: "",
      cwd: "",
      logHistory: [],
      previewUrl: null,
      detectedPort: null,
      manualPreviewUrl: null,
      isRunning: false,
    });
  });

  it("GET /api/dev-server/status exposes previewUrl, detectedPort, and manualPreviewUrl", async () => {
    const root = createProjectRoot();
    tempDirs.push(root);

    const store = await loadDevServerStore(root);
    await store.updateState({
      detectedUrl: "http://localhost:5173",
      detectedPort: 5173,
      manualUrl: "https://localhost:3000",
    });

    const app = buildApp(root);
    const res = await request(app, "GET", "/api/dev-server/status");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      previewUrl: "https://localhost:3000",
      detectedPort: 5173,
      manualPreviewUrl: "https://localhost:3000",
    });
  });

  it("GET /api/dev-server/status falls back to detected URL when no manual override exists", async () => {
    const root = createProjectRoot();
    tempDirs.push(root);

    const store = await loadDevServerStore(root);
    await store.updateState({
      detectedUrl: "http://localhost:4321",
      detectedPort: 4321,
      manualUrl: undefined,
    });

    const app = buildApp(root);
    const res = await request(app, "GET", "/api/dev-server/status");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      previewUrl: "http://localhost:4321",
      detectedPort: 4321,
      manualPreviewUrl: null,
    });
  });

  it("POST /api/dev-server/start validates required command", async () => {
    const root = createProjectRoot();
    tempDirs.push(root);

    const app = buildApp(root);
    const res = await request(
      app,
      "POST",
      "/api/dev-server/start",
      JSON.stringify({ cwd: root }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(400);
  });

  it("POST /api/dev-server/start validates required cwd", async () => {
    const root = createProjectRoot();
    tempDirs.push(root);

    const app = buildApp(root);
    const res = await request(
      app,
      "POST",
      "/api/dev-server/start",
      JSON.stringify({ command: "node -e \"process.stdin.resume();process.stdin.on('end',()=>process.exit(0))\"" }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(400);
  });

  it("POST /api/dev-server/start starts process and returns running state", async () => {
    const root = createProjectRoot();
    tempDirs.push(root);

    const app = buildApp(root);
    const res = await request(
      app,
      "POST",
      "/api/dev-server/start",
      JSON.stringify({ command: "node -e \"process.stdin.resume();process.stdin.on('end',()=>process.exit(0))\"", cwd: root }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "running",
      cwd: root,
    });
  });

  it("POST /api/dev-server/start returns 409 when already running", async () => {
    const root = createProjectRoot();
    tempDirs.push(root);

    const app = buildApp(root);
    await request(
      app,
      "POST",
      "/api/dev-server/start",
      JSON.stringify({ command: "node -e \"process.stdin.resume();process.stdin.on('end',()=>process.exit(0))\"", cwd: root }),
      { "Content-Type": "application/json" },
    );

    const secondStart = await request(
      app,
      "POST",
      "/api/dev-server/start",
      JSON.stringify({ command: "node -e \"process.stdin.resume();process.stdin.on('end',()=>process.exit(0))\"", cwd: root }),
      { "Content-Type": "application/json" },
    );

    expect(secondStart.status).toBe(409);
  });

  it("POST /api/dev-server/stop stops a running process", async () => {
    const root = createProjectRoot();
    tempDirs.push(root);

    const app = buildApp(root);
    await request(
      app,
      "POST",
      "/api/dev-server/start",
      JSON.stringify({ command: "node -e \"process.stdin.resume();process.stdin.on('end',()=>process.exit(0))\"", cwd: root }),
      { "Content-Type": "application/json" },
    );

    const stopRes = await request(app, "POST", "/api/dev-server/stop");
    expect(stopRes.status).toBe(200);
    expect(stopRes.body).toMatchObject({ status: "stopped" });
  });

  it("POST /api/dev-server/stop returns current state when nothing is running", async () => {
    const root = createProjectRoot();
    tempDirs.push(root);

    const app = buildApp(root);
    const stopRes = await request(app, "POST", "/api/dev-server/stop");

    expect(stopRes.status).toBe(200);
    expect(stopRes.body).toMatchObject({ status: "stopped" });
  });

  it("POST /api/dev-server/restart restarts with stored command", async () => {
    const root = createProjectRoot();
    tempDirs.push(root);

    const app = buildApp(root);
    await request(
      app,
      "POST",
      "/api/dev-server/start",
      JSON.stringify({ command: "node -e \"process.stdin.resume();process.stdin.on('end',()=>process.exit(0))\"", cwd: root, scriptId: "dev" }),
      { "Content-Type": "application/json" },
    );

    const restartRes = await request(app, "POST", "/api/dev-server/restart");
    expect(restartRes.status).toBe(200);
    expect(restartRes.body).toMatchObject({
      status: "running",
      command: "node -e \"process.stdin.resume();process.stdin.on('end',()=>process.exit(0))\"",
      scriptId: "dev",
    });
  });

  it("POST /api/dev-server/restart returns 400 without stored command", async () => {
    const root = createProjectRoot();
    tempDirs.push(root);

    const app = buildApp(root);
    const restartRes = await request(app, "POST", "/api/dev-server/restart");
    expect(restartRes.status).toBe(400);
  });

  it("PUT /api/dev-server/preview-url sets manual URL", async () => {
    const root = createProjectRoot();
    tempDirs.push(root);

    const app = buildApp(root);
    const res = await request(
      app,
      "PUT",
      "/api/dev-server/preview-url",
      JSON.stringify({ url: "https://localhost:5173" }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ manualUrl: "https://localhost:5173" });
  });

  it("PUT /api/dev-server/preview-url validates URL format", async () => {
    const root = createProjectRoot();
    tempDirs.push(root);

    const app = buildApp(root);
    const res = await request(
      app,
      "PUT",
      "/api/dev-server/preview-url",
      JSON.stringify({ url: "localhost:5173" }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(400);
  });

  it("PUT /api/dev-server/preview-url clears override with empty string", async () => {
    const root = createProjectRoot();
    tempDirs.push(root);

    const app = buildApp(root);
    await request(
      app,
      "PUT",
      "/api/dev-server/preview-url",
      JSON.stringify({ url: "https://localhost:5173" }),
      { "Content-Type": "application/json" },
    );

    const cleared = await request(
      app,
      "PUT",
      "/api/dev-server/preview-url",
      JSON.stringify({ url: "" }),
      { "Content-Type": "application/json" },
    );

    expect(cleared.status).toBe(200);
    expect(cleared.body).not.toHaveProperty("manualUrl");
  });

  it("GET /api/dev-server/logs/stream returns SSE headers and initial history", async () => {
    const root = createProjectRoot();
    tempDirs.push(root);

    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "demo" }), "utf-8");
    const store = await loadDevServerStore(root);
    await store.appendLog("history line");

    const app = buildApp(root);

    const stream = await openSseStream(app, "/api/dev-server/logs/stream");
    expect(stream.status).toBe(200);
    expect(String(stream.headers["content-type"])).toContain("text/event-stream");

    const chunkText = stream.readText();
    expect(chunkText).toContain(": connected");
    expect(chunkText).toContain("event: history");
    expect(chunkText).toContain("history line");

    stream.close();
  });

  it("SSE stream receives new log events when process outputs", async () => {
    const root = createProjectRoot();
    tempDirs.push(root);
    const app = buildApp(root);

    const stream = await openSseStream(app, "/api/dev-server/logs/stream");
    await waitFor(() => getActiveProcessManagers().length > 0);
    const manager = getActiveProcessManagers()[0];
    expect(manager).toBeDefined();

    manager.emit("output", {
      line: "stream-line",
      stream: "stdout",
      timestamp: new Date().toISOString(),
    });

    await waitFor(() => stream.readText().includes("stream-line"));
    const buffered = stream.readText();

    expect(buffered).toContain("event: log");
    expect(buffered).toContain("stream-line");

    stream.close();
  });

  it("SSE stream forwards url-detected events with the documented payload", async () => {
    const root = createProjectRoot();
    tempDirs.push(root);
    const app = buildApp(root);

    const stream = await openSseStream(app, "/api/dev-server/logs/stream");
    await waitFor(() => getActiveProcessManagers().length > 0);
    const manager = getActiveProcessManagers()[0];
    expect(manager).toBeDefined();

    manager.emit("url-detected", {
      url: "http://localhost:5173",
      port: 5173,
      source: "generic-url",
      detectedAt: new Date().toISOString(),
    });

    await waitFor(() => stream.readText().includes("event: dev-server:url-detected"));
    const buffered = stream.readText();

    expect(buffered).toContain("event: dev-server:url-detected");
    const payloadMatch = buffered.match(/event: dev-server:url-detected\ndata: (.+)/);
    expect(payloadMatch).toBeTruthy();
    const payload = JSON.parse(payloadMatch?.[1] ?? "{}");
    expect(payload).toMatchObject({
      url: "http://localhost:5173",
      port: 5173,
      source: "generic-url",
    });
    expect(typeof payload.detectedAt).toBe("string");
    expect(Number.isNaN(Date.parse(payload.detectedAt))).toBe(false);
    expect(Object.keys(payload).sort()).toEqual(["detectedAt", "port", "source", "url"]);

    stream.close();
  });

  it("SSE stream cleans up listeners on client disconnect", async () => {
    const root = createProjectRoot();
    tempDirs.push(root);
    const app = buildApp(root);

    const stream = await openSseStream(app, "/api/dev-server/logs/stream");
    await waitFor(() => getActiveProcessManagers().length > 0);

    await waitFor(() => {
      const manager = getActiveProcessManagers()[0];
      return (manager?.listenerCount("output") ?? 0) > 0
        && (manager?.listenerCount("url-detected") ?? 0) > 0;
    });

    stream.close();

    await waitFor(() => {
      const manager = getActiveProcessManagers()[0];
      return (manager?.listenerCount("output") ?? 0) === 0
        && (manager?.listenerCount("url-detected") ?? 0) === 0;
    });
  });
});
