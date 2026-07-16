// @vitest-environment node

import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiRoutes } from "../../routes.js";
import { request } from "../../test-request.js";

const state = {
  agents: new Map<string, { id: string; name: string; imageUrl?: string; updatedAt: string; createdAt: string; role: string; state: string; metadata: Record<string, unknown> }>(),
};

vi.mock("@fusion/core", async () => {
  const actual = await vi.importActual<typeof import("@fusion/core")>("@fusion/core");
  class MockAgentStore {
    async init() {}
    async getAgent(id: string) {
      return state.agents.get(id) ?? null;
    }
    async getAgentDetail(id: string) {
      return state.agents.get(id) ?? null;
    }
    async updateAgent(id: string, updates: { imageUrl?: string }) {
      const existing = state.agents.get(id);
      if (!existing) {
        throw new Error("not found");
      }
      const updated = {
        ...existing,
        imageUrl: updates.imageUrl,
        updatedAt: new Date().toISOString(),
      };
      state.agents.set(id, updated);
      return updated;
    }
    async listAgents() { return []; }
    async getRecentRuns() { return []; }
  }

  return {
    ...actual,
    AgentStore: MockAgentStore,
    isGhAvailable: vi.fn(),
    isGhAuthenticated: vi.fn(),
    isQmdAvailable: vi.fn().mockResolvedValue(false),
  };
});

vi.mock("@fusion/engine", () => ({
  listCliAdapterDescriptors: () => [],
  createFnAgent: vi.fn(async () => ({ session: { state: { messages: [] }, prompt: vi.fn(), dispose: vi.fn() } })),
  createResolvedAgentSession: vi.fn(async () => ({
    session: { state: { messages: [] }, prompt: vi.fn(), dispose: vi.fn() },
    runtimeModel: undefined,
  })),
  ExperimentFinalizeService: class {
    async finalize() {
      return { keptRuns: [], droppedRuns: [], branches: [] };
    }
  },
  defaultGitOps: vi.fn(() => ({})),
  promptWithFallback: vi.fn(),
}));

function buildMultipartBody(fileName: string, mimeType: string, buffer: Buffer): { body: Buffer; contentType: string } {
  const boundary = "----fusion-test-boundary";
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"${fileName}\"\r\nContent-Type: ${mimeType}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    body: Buffer.concat([head, buffer, tail]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function createMockStore(fusionDir: string) {
  return {
    getRootDir: vi.fn().mockReturnValue(path.dirname(fusionDir)),
    getFusionDir: vi.fn().mockReturnValue(fusionDir),
    // FNXC:PostgresCutover 2026-07-16-06:30: avatar routes construct their
    // AgentStore through the backend accessor, so doubles retain that shape.
    getAsyncLayer: vi.fn().mockReturnValue(undefined),
    listTasks: vi.fn().mockResolvedValue([]),
    searchTasks: vi.fn().mockResolvedValue([]),
    getSettings: vi.fn().mockResolvedValue({}),
    getSettingsFast: vi.fn().mockResolvedValue({}),
    getSettingsByScope: vi.fn().mockResolvedValue({ global: {}, project: {} }),
    getSettingsByScopeFast: vi.fn().mockResolvedValue({ global: {}, project: {} }),
    getGlobalSettingsStore: vi.fn(),
    getAgentLogs: vi.fn().mockResolvedValue([]),
    getAgentLogCount: vi.fn().mockResolvedValue(0),
    getAgentLogsByTimeRange: vi.fn().mockResolvedValue([]),
    getTaskDocuments: vi.fn().mockResolvedValue([]),
    getTaskDocument: vi.fn().mockResolvedValue(null),
    getTaskDocumentRevisions: vi.fn().mockResolvedValue([]),
    getAllDocuments: vi.fn().mockResolvedValue([]),
    listWorkflowSteps: vi.fn().mockResolvedValue([]),
    getMissionStore: vi.fn(),
  } as any;
}

describe("agent avatar routes", () => {
  let fusionDir: string;
  let app: express.Express;

  beforeEach(async () => {
    state.agents.clear();
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "fn-3118-"));
    fusionDir = path.join(rootDir, ".fusion");
    await mkdir(fusionDir, { recursive: true });

    state.agents.set("agent-1", {
      id: "agent-1",
      name: "Agent One",
      role: "engineer",
      state: "idle",
      metadata: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(createMockStore(fusionDir)));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("uploads valid png and sets imageUrl", async () => {
    const { body, contentType } = buildMultipartBody("avatar.png", "image/png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const res = await request(app, "POST", "/api/agents/agent-1/avatar", body, { "content-type": contentType });
    expect(res.status).toBe(200);
    expect((res.body as any).imageUrl).toBe("/api/agents/agent-1/avatar");
  });

  it("rejects non-image mime type", async () => {
    const { body, contentType } = buildMultipartBody("note.txt", "text/plain", Buffer.from("hello"));
    const res = await request(app, "POST", "/api/agents/agent-1/avatar", body, { "content-type": contentType });
    expect(res.status).toBe(400);
  });

  it("rejects oversized file", async () => {
    const oversize = Buffer.alloc(2 * 1024 * 1024 + 1, 1);
    const { body, contentType } = buildMultipartBody("avatar.png", "image/png", oversize);
    const res = await request(app, "POST", "/api/agents/agent-1/avatar", body, { "content-type": contentType });
    expect(res.status).toBe(400);
  });

  it("serves stored avatar with content type", async () => {
    const dir = path.join(fusionDir, "agents", "agent-1");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "avatar.png"), Buffer.from([1, 2, 3, 4]));

    const res = await request(app, "GET", "/api/agents/agent-1/avatar");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.body).toBe("\u0001\u0002\u0003\u0004");
  });

  it("returns 404 when agent has no avatar", async () => {
    const res = await request(app, "GET", "/api/agents/agent-1/avatar");
    expect(res.status).toBe(404);
  });

  it("deletes avatar file and clears imageUrl", async () => {
    state.agents.set("agent-1", { ...state.agents.get("agent-1")!, imageUrl: "/api/agents/agent-1/avatar" });
    const dir = path.join(fusionDir, "agents", "agent-1");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "avatar.png"), Buffer.from([1, 2, 3, 4]));

    const res = await request(app, "DELETE", "/api/agents/agent-1/avatar");
    expect(res.status).toBe(200);
    expect((res.body as any).imageUrl).toBeUndefined();

    await expect(readFile(path.join(dir, "avatar.png"))).rejects.toThrow();
  });

  it("returns 404 for non-existent agent on all avatar endpoints", async () => {
    const { body, contentType } = buildMultipartBody("avatar.png", "image/png", Buffer.from([1]));
    const postRes = await request(app, "POST", "/api/agents/nope/avatar", body, { "content-type": contentType });
    const getRes = await request(app, "GET", "/api/agents/nope/avatar");
    const delRes = await request(app, "DELETE", "/api/agents/nope/avatar");

    expect(postRes.status).toBe(404);
    expect(getRes.status).toBe(404);
    expect(delRes.status).toBe(404);
  });
});
