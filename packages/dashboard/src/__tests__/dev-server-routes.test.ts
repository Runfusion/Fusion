// @vitest-environment node

import express from "express";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
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

async function withHttpServer<T>(app: express.Express, fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = await new Promise<import("node:http").Server>((resolve) => {
    const started = app.listen(0, "127.0.0.1", () => resolve(started));
  });

  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    return await fn(baseUrl);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
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
      isRunning: false,
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
      JSON.stringify({ command: "node -e \"setInterval(() => {}, 1000)\"" }),
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
      JSON.stringify({ command: "node -e \"setInterval(() => {}, 1000)\"", cwd: root }),
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
      JSON.stringify({ command: "node -e \"setInterval(() => {}, 1000)\"", cwd: root }),
      { "Content-Type": "application/json" },
    );

    const secondStart = await request(
      app,
      "POST",
      "/api/dev-server/start",
      JSON.stringify({ command: "node -e \"setInterval(() => {}, 1000)\"", cwd: root }),
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
      JSON.stringify({ command: "node -e \"setInterval(() => {}, 1000)\"", cwd: root }),
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
      JSON.stringify({ command: "node -e \"setInterval(() => {}, 1000)\"", cwd: root, scriptId: "dev" }),
      { "Content-Type": "application/json" },
    );

    const restartRes = await request(app, "POST", "/api/dev-server/restart");
    expect(restartRes.status).toBe(200);
    expect(restartRes.body).toMatchObject({
      status: "running",
      command: "node -e \"setInterval(() => {}, 1000)\"",
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

    await withHttpServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/dev-server/logs/stream`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");

      const reader = response.body?.getReader();
      expect(reader).toBeDefined();
      const firstChunk = await reader?.read();
      const chunkText = new TextDecoder().decode(firstChunk?.value ?? new Uint8Array());

      expect(chunkText).toContain(": connected");
      expect(chunkText).toContain("event: history");
      expect(chunkText).toContain("history line");

      await reader?.cancel();
    });
  });

  it("SSE stream receives new log events when process outputs", async () => {
    const root = createProjectRoot();
    tempDirs.push(root);
    const app = buildApp(root);

    await withHttpServer(app, async (baseUrl) => {
      const streamResponse = await fetch(`${baseUrl}/api/dev-server/logs/stream`);
      const reader = streamResponse.body?.getReader();
      expect(reader).toBeDefined();

      const startResponse = await fetch(`${baseUrl}/api/dev-server/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          command: "node -e \"console.log('stream-line'); setInterval(() => {}, 1000)\"",
          cwd: root,
        }),
      });
      expect(startResponse.status).toBe(200);

      let buffered = "";
      const start = Date.now();
      while (!buffered.includes("stream-line")) {
        if (Date.now() - start > 5_000) {
          throw new Error(`Timed out waiting for stream line. Current payload: ${buffered}`);
        }
        const chunk = await reader?.read();
        if (!chunk || chunk.done) {
          break;
        }
        buffered += new TextDecoder().decode(chunk.value);
      }

      expect(buffered).toContain("event: log");
      expect(buffered).toContain("stream-line");

      await fetch(`${baseUrl}/api/dev-server/stop`, { method: "POST" });
      await reader?.cancel();
    });
  });

  it("SSE stream cleans up listeners on client disconnect", async () => {
    const root = createProjectRoot();
    tempDirs.push(root);
    const app = buildApp(root);

    await withHttpServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/dev-server/logs/stream`);
      const reader = response.body?.getReader();
      expect(reader).toBeDefined();

      await waitFor(() => {
        const manager = getActiveProcessManagers()[0];
        return (manager?.listenerCount("output") ?? 0) > 0;
      });

      await reader?.cancel();

      await waitFor(() => {
        const manager = getActiveProcessManagers()[0];
        return (manager?.listenerCount("output") ?? 0) === 0;
      });
    });
  });
});
