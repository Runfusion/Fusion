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

function openClawPluginModulePath(): string {
  return fileURLToPath(
    new URL("../../../../plugins/fusion-plugin-openclaw-runtime/src/index.ts", import.meta.url),
  );
}

async function preloadOpenClawPluginModule(): Promise<void> {
  await import(pathToFileURL(openClawPluginModulePath()).href);
}

describe("OpenClaw runtime E2E pipeline", () => {
  const originalEnv = { ...process.env };
  let testRoot: string;

  beforeEach(async () => {
    testRoot = mkdtempSync(join(tmpdir(), "fn-openclaw-e2e-"));
    vi.clearAllMocks();

    process.env = {
      ...originalEnv,
      OPENCLAW_GATEWAY_URL: "http://127.0.0.1:18789",
      OPENCLAW_AGENT_ID: "openclaw-agent",
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

      if (method === "HEAD" && url === "http://127.0.0.1:18789") {
        return new Response(null, { status: 200 });
      }

      if (method === "POST" && url === "http://127.0.0.1:18789/v1/chat/completions") {
        const ssePayload =
          'data: {"choices":[{"delta":{"content":"OpenClaw response"}}]}\n\n' +
          "data: [DONE]\\n\\n";
        return new Response(ssePayload, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }

      return new Response(`Unexpected request: ${method} ${url}`, { status: 500 });
    });

    vi.stubGlobal("fetch", fetchMock);

    await preloadOpenClawPluginModule();
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    vi.unstubAllGlobals();
    await rm(testRoot, { recursive: true, force: true });
  });

  it("loads OpenClaw plugin and executes through OpenClaw runtime", async () => {
    const pluginStore = new PluginStore(testRoot, { inMemoryDb: true });
    await pluginStore.init();

    await pluginStore.registerPlugin({
      manifest: {
        id: "fusion-plugin-openclaw-runtime",
        name: "OpenClaw Runtime Plugin",
        version: "0.1.0",
        description: "Provides OpenClaw runtime for Fusion AI agents",
        runtime: {
          runtimeId: "openclaw",
          name: "OpenClaw Runtime",
          description: "OpenClaw-backed AI session using the local OpenClaw gateway",
          version: "0.1.0",
        },
      },
      path: openClawPluginModulePath(),
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
      runtimeHint: "openclaw",
      pluginRunner,
    });

    expect(resolved.runtimeId).toBe("openclaw");
    expect(resolved.wasConfigured).toBe(true);
    expect(resolved.runtime.id).toBe("openclaw");
    expect(resolved.runtime.name).toBe("OpenClaw Runtime");

    const created = await createResolvedAgentSession({
      sessionPurpose: "executor",
      runtimeHint: "openclaw",
      pluginRunner,
      cwd: testRoot,
      systemPrompt: "You are helpful",
      tools: "coding",
      skills: ["bash"],
    });

    expect(created.runtimeId).toBe("openclaw");
    expect(created.wasConfigured).toBe(true);
    expect(created.session).toBeTruthy();

    await expect(resolved.runtime.promptWithFallback(created.session, "Hello from e2e")).resolves.toBeUndefined();
    expect(resolved.runtime.describeModel(created.session)).toBe("openclaw/openclaw-agent");
    expect(mockCreateFnAgent).not.toHaveBeenCalled();
  });

  it("falls back to default pi runtime when OpenClaw plugin is not installed", async () => {
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
      runtimeHint: "openclaw",
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
