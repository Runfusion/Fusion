import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { PluginLoader, PluginStore, type TaskStore } from "@fusion/core";
import { PluginRunner } from "../plugin-runner.js";
import { resolveRuntime } from "../runtime-resolution.js";
import { createResolvedAgentSession } from "../agent-session-helpers.js";

const {
  mockCreateFnAgent,
  mockPromptWithFallback,
  mockDescribeModel,
} = vi.hoisted(() => ({
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

vi.mock("@fusion/engine", () => ({
  createFnAgent: mockCreateFnAgent,
  promptWithFallback: mockPromptWithFallback,
  describeModel: mockDescribeModel,
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

function hermesPluginModulePath(): string {
  return fileURLToPath(
    new URL("../../../../plugins/fusion-plugin-hermes-runtime/src/index.ts", import.meta.url),
  );
}

describe("Hermes runtime E2E pipeline", () => {
  let testRoot: string;

  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), "fn-hermes-e2e-"));
    vi.clearAllMocks();

    mockCreateFnAgent.mockResolvedValue({
      session: { id: "hermes-session", dispose: vi.fn() },
      sessionFile: "/tmp/hermes-session.json",
    });
    mockPromptWithFallback.mockResolvedValue(undefined);
    mockDescribeModel.mockReturnValue("anthropic/claude-sonnet-4-5");
  });

  afterEach(async () => {
    await rm(testRoot, { recursive: true, force: true });
  });

  it("loads Hermes plugin via PluginLoader and resolves Hermes runtime through PluginRunner", async () => {
    const pluginStore = new PluginStore(testRoot, { inMemoryDb: true });
    await pluginStore.init();

    await pluginStore.registerPlugin({
      manifest: {
        id: "fusion-plugin-hermes-runtime",
        name: "Hermes Runtime Plugin",
        version: "0.1.0",
        description: "Hermes AI runtime plugin for Fusion - provides AI agent execution runtime capabilities",
        runtime: {
          runtimeId: "hermes",
          name: "Hermes Runtime",
          description: "Hermes-backed AI session using the user's configured pi provider and model",
          version: "0.1.0",
        },
      },
      path: hermesPluginModulePath(),
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
      runtimeHint: "hermes",
      pluginRunner,
    });

    expect(resolved.runtimeId).toBe("hermes");
    expect(resolved.wasConfigured).toBe(true);

    const created = await createResolvedAgentSession({
      sessionPurpose: "executor",
      runtimeHint: "hermes",
      pluginRunner,
      cwd: testRoot,
      systemPrompt: "You are helpful",
      tools: "coding",
      skills: ["bash"],
    });

    expect(created.runtimeId).toBe("hermes");
    expect(created.wasConfigured).toBe(true);
    expect(created.sessionFile).toBe("/tmp/hermes-session.json");

    expect(mockCreateFnAgent).toHaveBeenCalledWith({
      cwd: testRoot,
      systemPrompt: "You are helpful",
      tools: "coding",
      customTools: undefined,
      onText: undefined,
      onThinking: undefined,
      onToolStart: undefined,
      onToolEnd: undefined,
      defaultProvider: undefined,
      defaultModelId: undefined,
      fallbackProvider: undefined,
      fallbackModelId: undefined,
      defaultThinkingLevel: undefined,
      sessionManager: undefined,
      skillSelection: undefined,
      skills: ["bash"],
    });

    await resolved.runtime.promptWithFallback(created.session, "Hello from e2e", { attempt: 1 });
    expect(mockPromptWithFallback).toHaveBeenCalledWith(created.session, "Hello from e2e", { attempt: 1 });

    expect(resolved.runtime.describeModel(created.session)).toBe("anthropic/claude-sonnet-4-5");
    expect(mockDescribeModel).toHaveBeenCalledWith(created.session);
  });

  it("reuses Hermes adapter instance without compatibility wrapping when runtime is AgentRuntime-shaped", async () => {
    const pluginStore = new PluginStore(testRoot, { inMemoryDb: true });
    await pluginStore.init();

    await pluginStore.registerPlugin({
      manifest: {
        id: "fusion-plugin-hermes-runtime",
        name: "Hermes Runtime Plugin",
        version: "0.1.0",
        runtime: {
          runtimeId: "hermes",
          name: "Hermes Runtime",
          version: "0.1.0",
        },
      },
      path: hermesPluginModulePath(),
    });

    const taskStore = createTaskStoreMock(testRoot);
    const pluginLoader = new PluginLoader({ pluginStore, taskStore });
    await pluginLoader.loadAllPlugins();

    const pluginRunner = new PluginRunner({
      pluginLoader,
      pluginStore,
      taskStore,
      rootDir: testRoot,
    });

    const registration = pluginRunner.getRuntimeById("hermes");
    expect(registration).toBeDefined();

    const runtimeContext = await pluginRunner.createRuntimeContext("fusion-plugin-hermes-runtime");
    expect(runtimeContext).toBeTruthy();

    const hermesAdapter = await registration!.runtime.factory(runtimeContext!);
    registration!.runtime.factory = vi.fn().mockResolvedValue(hermesAdapter);

    const resolved = await resolveRuntime({
      sessionPurpose: "executor",
      runtimeHint: "hermes",
      pluginRunner,
    });

    // If isAgentRuntime() returns true, wrapPluginRuntime returns the instance as-is.
    expect(resolved.runtime).toBe(hermesAdapter);
    expect("dispose" in resolved.runtime).toBe(true);
  });

  it("falls back to default pi runtime when Hermes plugin is not installed", async () => {
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
      runtimeHint: "hermes",
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
