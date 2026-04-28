import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
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
  mockSpawn,
} = vi.hoisted(() => ({
  mockCreateFnAgent: vi.fn(),
  mockPromptWithFallback: vi.fn(),
  mockDescribeModel: vi.fn(),
  mockSpawn: vi.fn(),
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

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
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

function createFakeChildProcess(): EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
} {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
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

    mockSpawn.mockImplementation((command: string, args: string[] = []) => {
      const child = createFakeChildProcess();

      queueMicrotask(() => {
        if (command === "which" || command === "where") {
          child.stdout.emit("data", Buffer.from("/usr/local/bin/openclaw\n"));
          child.emit("close", 0);
          return;
        }

        if (args[0] === "--version") {
          child.stdout.emit("data", Buffer.from("OpenClaw 2026.4.27\n"));
          child.emit("close", 0);
          return;
        }

        if (args.includes("agent") && args.includes("--json")) {
          const payload = JSON.stringify({
            payloads: [{ text: "OpenClaw response" }],
            meta: {
              agentMeta: {
                provider: "openclaw",
                model: "openclaw-agent",
                usage: { input: 1, output: 1, total: 2 },
              },
            },
          });
          child.stdout.emit("data", Buffer.from(payload));
          child.emit("close", 0);
          return;
        }

        child.stderr.emit("data", Buffer.from(`Unexpected spawn: ${command} ${args.join(" ")}`));
        child.emit("close", 1);
      });

      return child;
    });

    await preloadOpenClawPluginModule();
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
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
    expect(resolved.runtime.describeModel(created.session)).toBe(
      "openclaw/openclaw-agent/openclaw/openclaw-agent",
    );
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
