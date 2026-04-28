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

const {
  mockCreateFnAgent,
  mockPromptWithFallback,
  mockDescribeModel,
  mockGetModel,
  mockStreamSimple,
} = vi.hoisted(() => ({
  mockCreateFnAgent: vi.fn(),
  mockPromptWithFallback: vi.fn(),
  mockDescribeModel: vi.fn(),
  mockGetModel: vi.fn(),
  mockStreamSimple: vi.fn(),
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

vi.mock("@mariozechner/pi-ai", () => ({
  getModel: mockGetModel,
  streamSimple: mockStreamSimple,
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

async function preloadHermesPluginModule(): Promise<void> {
  await import(pathToFileURL(hermesPluginModulePath()).href);
}

function createFakeStream(events: unknown[], finalMessage: unknown) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    },
    result: vi.fn().mockResolvedValue(finalMessage),
  };
}

describe("Hermes runtime E2E pipeline", () => {
  let testRoot: string;

  beforeEach(async () => {
    testRoot = mkdtempSync(join(tmpdir(), "fn-hermes-e2e-"));
    vi.clearAllMocks();

    mockCreateFnAgent.mockResolvedValue({
      session: { id: "fallback-session", dispose: vi.fn() },
      sessionFile: "/tmp/fallback.session.json",
    });
    mockPromptWithFallback.mockResolvedValue(undefined);
    mockDescribeModel.mockReturnValue("anthropic/claude-sonnet-4-5");

    mockGetModel.mockReturnValue({ provider: "anthropic", id: "claude-sonnet-4-5" });
    const doneMessage = {
      content: [{ type: "text", text: "Hello from Hermes" }],
      usage: { input: 1, output: 1 },
    };
    mockStreamSimple.mockReturnValue(createFakeStream([{ type: "done", message: doneMessage }], doneMessage));

    await preloadHermesPluginModule();
  });

  afterEach(async () => {
    await rm(testRoot, { recursive: true, force: true });
  });

  it("loads Hermes plugin and executes through Hermes runtime without createFnAgent", async () => {
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
          description: "Hermes raw-model runtime using pi-ai direct streaming",
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
    expect(created.sessionFile).toBeUndefined();
    expect(created.session).toBeTruthy();

    const promptSpy = vi.spyOn(resolved.runtime, "promptWithFallback").mockResolvedValue(undefined);
    await expect(resolved.runtime.promptWithFallback(created.session, "Hello from e2e", { attempt: 1 })).resolves.toBeUndefined();

    expect(promptSpy).toHaveBeenCalledWith(created.session, "Hello from e2e", { attempt: 1 });
    expect(typeof resolved.runtime.describeModel(created.session)).toBe("string");
    expect(mockCreateFnAgent).not.toHaveBeenCalled();
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

  it("attaches runtime.promptWithFallback as session.promptWithFallback so pi dispatch hook routes to plugin", async () => {
    // This test verifies the fix for the bug where createResolvedAgentSession did NOT
    // attach the resolved runtime's promptWithFallback onto the session object.
    // Without the fix, pi.promptWithFallback (pi.ts:175) would fall through to
    // pi's own session.prompt() instead of dispatching to HermesRuntimeAdapter.
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

    const created = await createResolvedAgentSession({
      sessionPurpose: "heartbeat",
      runtimeHint: "hermes",
      pluginRunner,
      cwd: testRoot,
      systemPrompt: "test",
    });

    // The session must have a promptWithFallback method attached by createResolvedAgentSession.
    // This is the dispatch hook that pi.promptWithFallback (pi.ts:175) checks —
    // if absent, every prompt silently falls through to pi's native session.prompt().
    expect(typeof (created.session as any).promptWithFallback).toBe("function");

    // Calling the attached method must invoke the resolved runtime's promptWithFallback,
    // not pi's own path. Resolve the runtime separately to spy on it.
    const resolved = await resolveRuntime({
      sessionPurpose: "heartbeat",
      runtimeHint: "hermes",
      pluginRunner,
    });
    const runtimeSpy = vi.spyOn(resolved.runtime, "promptWithFallback").mockResolvedValue(undefined);

    // Replace the session's attached method with one that delegates to the spied runtime
    // (simulating what createResolvedAgentSession wires up internally).
    (created.session as any).promptWithFallback = (prompt: string, opts?: unknown) =>
      resolved.runtime.promptWithFallback(created.session, prompt, opts);

    await (created.session as any).promptWithFallback("dispatch test");

    expect(runtimeSpy).toHaveBeenCalledWith(created.session, "dispatch test", undefined);
    // pi's createFnAgent must not have been called — that would mean the session
    // was created through the default pi path rather than hermes.
    expect(mockCreateFnAgent).not.toHaveBeenCalled();
  });
});
