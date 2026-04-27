import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PluginLoader, PluginStore, type TaskStore } from "@fusion/core";
import { PluginRunner } from "../plugin-runner.js";
import { resolveRuntime } from "../runtime-resolution.js";
import { createResolvedAgentSession } from "../agent-session-helpers.js";

const { mockCreateFnAgent, mockPromptWithFallback, mockDescribeModel } = vi.hoisted(() => ({
  mockCreateFnAgent: vi.fn(),
  mockPromptWithFallback: vi.fn(),
  mockDescribeModel: vi.fn(),
}));

vi.mock("../logger.js", () => ({
  createLogger: vi.fn(() => ({
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
  executorLog: {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../pi.js", () => ({
  createFnAgent: mockCreateFnAgent,
  promptWithFallback: mockPromptWithFallback,
  describeModel: mockDescribeModel,
}));

function createTaskStoreMock(rootDir: string): TaskStore {
  return {
    getRootDir: () => rootDir,
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as TaskStore;
}

function paperclipPluginModulePath(): string {
  return fileURLToPath(
    new URL("../../../../plugins/fusion-plugin-paperclip-runtime/src/index.ts", import.meta.url),
  );
}

async function preloadPaperclipPluginModule(): Promise<void> {
  await import(pathToFileURL(paperclipPluginModulePath()).href);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Paperclip runtime E2E pipeline", () => {
  const originalEnv = { ...process.env };
  let testRoot: string;

  beforeEach(async () => {
    testRoot = mkdtempSync(join(tmpdir(), "fn-paperclip-e2e-"));
    vi.clearAllMocks();

    process.env = {
      ...originalEnv,
      PAPERCLIP_API_URL: "http://localhost:3100",
      PAPERCLIP_API_KEY: "test-key",
      PAPERCLIP_AGENT_ID: "paperclip-agent",
      PAPERCLIP_COMPANY_ID: "COMP-1",
    };

    mockCreateFnAgent.mockResolvedValue({
      session: { id: "fallback-session", dispose: vi.fn() },
      sessionFile: "/tmp/fallback.session.json",
    });
    mockPromptWithFallback.mockResolvedValue(undefined);
    mockDescribeModel.mockReturnValue("pi/default");

    const fetchMock = vi.fn().mockImplementation(async (input: string | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method ?? "GET").toUpperCase();

      if (method === "GET" && url === "http://localhost:3100/api/health") {
        return jsonResponse({ status: "ok", deploymentMode: "local_trusted" });
      }

      if (method === "POST" && url === "http://localhost:3100/api/companies/COMP-1/issues") {
        return jsonResponse({ id: "ISS-1", status: "backlog" });
      }

      if (method === "POST" && url === "http://localhost:3100/api/issues/ISS-1/checkout") {
        return jsonResponse({ id: "ISS-1", status: "in_progress" });
      }

      if (method === "POST" && url === "http://localhost:3100/api/agents/paperclip-agent/heartbeat/invoke") {
        return jsonResponse({ id: "RUN-1", status: "queued" });
      }

      if (method === "GET" && url === "http://localhost:3100/api/issues/ISS-1") {
        return jsonResponse({ id: "ISS-1", status: "done" });
      }

      if (method === "GET" && url === "http://localhost:3100/api/issues/ISS-1/comments") {
        return jsonResponse([{ id: "C1", body: "Paperclip result" }]);
      }

      return jsonResponse({ error: `Unexpected request: ${method} ${url}` }, 500);
    });

    vi.stubGlobal("fetch", fetchMock);

    await preloadPaperclipPluginModule();
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    vi.unstubAllGlobals();
    await rm(testRoot, { recursive: true, force: true });
  });

  it("loads Paperclip plugin and executes through Paperclip runtime", async () => {
    const pluginStore = new PluginStore(testRoot, { inMemoryDb: true });
    await pluginStore.init();

    await pluginStore.registerPlugin({
      manifest: {
        id: "fusion-plugin-paperclip-runtime",
        name: "Paperclip Runtime Plugin",
        version: "1.0.0",
        description: "Provides Paperclip runtime for Fusion AI agents",
        runtime: {
          runtimeId: "paperclip",
          name: "Paperclip Runtime",
          description: "Paperclip-backed AI session via Paperclip REST API",
          version: "1.0.0",
        },
      },
      path: paperclipPluginModulePath(),
    });

    const taskStore = createTaskStoreMock(testRoot);
    const pluginLoader = new PluginLoader({ pluginStore, taskStore });
    const loadResult = await pluginLoader.loadAllPlugins();
    expect(loadResult).toEqual({ loaded: 1, errors: 0 });

    const pluginRunner = new PluginRunner({
      pluginLoader,
      pluginStore,
      taskStore,
      rootDir: testRoot,
    });

    const resolved = await resolveRuntime({
      sessionPurpose: "executor",
      runtimeHint: "paperclip",
      pluginRunner,
    });

    expect(resolved.runtimeId).toBe("paperclip");
    expect(resolved.wasConfigured).toBe(true);
    expect(resolved.runtime.id).toBe("paperclip");
    expect(resolved.runtime.name).toBe("Paperclip Runtime");

    const created = await createResolvedAgentSession({
      sessionPurpose: "executor",
      runtimeHint: "paperclip",
      pluginRunner,
      cwd: testRoot,
      systemPrompt: "You are helpful",
      tools: "coding",
      skills: ["bash"],
    });

    expect(created.runtimeId).toBe("paperclip");
    expect(created.wasConfigured).toBe(true);
    expect(created.session).toBeTruthy();

    await expect(resolved.runtime.promptWithFallback(created.session, "Hello from e2e")).resolves.toBeUndefined();
    expect(resolved.runtime.describeModel(created.session)).toBe("paperclip/paperclip-agent");
    expect(mockCreateFnAgent).not.toHaveBeenCalled();
  });

  it("falls back to default pi runtime when Paperclip plugin is not installed", async () => {
    const pluginStore = new PluginStore(testRoot, { inMemoryDb: true });
    await pluginStore.init();

    const taskStore = createTaskStoreMock(testRoot);
    const pluginLoader = new PluginLoader({ pluginStore, taskStore });
    await pluginLoader.loadAllPlugins();

    const pluginRunner = new PluginRunner({
      pluginLoader,
      pluginStore,
      taskStore,
      rootDir: testRoot,
    });

    const result = await createResolvedAgentSession({
      sessionPurpose: "executor",
      runtimeHint: "paperclip",
      pluginRunner,
      cwd: testRoot,
      systemPrompt: "fallback",
    });

    expect(result.runtimeId).toBe("pi");
    expect(result.wasConfigured).toBe(false);
    expect(mockCreateFnAgent).toHaveBeenCalledWith({
      cwd: testRoot,
      systemPrompt: "fallback",
    });
  });
});
