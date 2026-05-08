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

function droidPluginModulePath(): string {
  return fileURLToPath(
    new URL("../../../../plugins/fusion-plugin-droid-runtime/src/index.ts", import.meta.url),
  );
}

async function preloadDroidPluginModule(): Promise<void> {
  await import(pathToFileURL(droidPluginModulePath()).href);
}

describe("Droid runtime E2E pipeline", () => {
  let testRoot: string;

  beforeEach(async () => {
    testRoot = mkdtempSync(join(tmpdir(), "fn-droid-e2e-"));
    vi.clearAllMocks();

    mockCreateFnAgent.mockResolvedValue({
      session: { id: "fallback-session", dispose: vi.fn() },
      sessionFile: "/tmp/fallback.session.json",
    });
    mockPromptWithFallback.mockResolvedValue(undefined);
    mockDescribeModel.mockReturnValue("pi/default");

    await preloadDroidPluginModule();
  });

  afterEach(async () => {
    await rm(testRoot, { recursive: true, force: true });
  });

  it("loads Droid plugin and creates sessions through Droid runtime without createFnAgent", async () => {
    const pluginStore = new PluginStore(testRoot, { inMemoryDb: true, centralGlobalDir: testRoot });
    await pluginStore.init();

    await pluginStore.registerPlugin({
      manifest: {
        id: "fusion-plugin-droid-runtime",
        name: "Droid Runtime Plugin",
        version: "0.1.0",
        runtime: {
          runtimeId: "droid",
          name: "Droid Runtime",
          version: "0.1.0",
        },
      },
      path: droidPluginModulePath(),
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
      runtimeHint: "droid",
      pluginRunner,
    });

    expect(resolved.runtimeId).toBe("droid");
    expect(resolved.wasConfigured).toBe(true);

    const created = await createResolvedAgentSession({
      sessionPurpose: "executor",
      runtimeHint: "droid",
      pluginRunner,
      cwd: testRoot,
      systemPrompt: "You are helpful",
      defaultModelId: "droid-pro",
    });

    expect(created.runtimeId).toBe("droid");
    expect(created.wasConfigured).toBe(true);
    expect(created.session).toBeTruthy();
    expect(resolved.runtime.describeModel(created.session)).toBe("droid/droid-pro");

    expect(
      typeof (created.session as { promptWithFallback?: unknown }).promptWithFallback,
    ).toBe("function");
    expect(mockCreateFnAgent).not.toHaveBeenCalled();
  });

  it("falls back to default pi runtime when Droid plugin is not installed", async () => {
    const pluginStore = new PluginStore(testRoot, { inMemoryDb: true, centralGlobalDir: testRoot });
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
      runtimeHint: "droid",
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
