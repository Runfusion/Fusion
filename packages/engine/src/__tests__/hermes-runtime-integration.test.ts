import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AgentRuntime } from "../agent-runtime.js";
import { resolveRuntime } from "../runtime-resolution.js";
import { createResolvedAgentSession } from "../agent-session-helpers.js";
import type { PluginRunner } from "../plugin-runner.js";
import type { PluginRuntimeRegistration } from "@fusion/core";

const mockCreateFnAgent = vi.hoisted(() => vi.fn());

vi.mock("../logger.js", () => ({
  createLogger: vi.fn(() => ({
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

vi.mock("../pi.js", () => ({
  createFnAgent: mockCreateFnAgent,
  promptWithFallback: vi.fn().mockResolvedValue(undefined),
  describeModel: vi.fn().mockReturnValue("pi/default"),
}));

function isAgentRuntime(value: unknown): value is AgentRuntime {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    "name" in value &&
    typeof (value as AgentRuntime).createSession === "function" &&
    typeof (value as AgentRuntime).promptWithFallback === "function" &&
    typeof (value as AgentRuntime).describeModel === "function"
  );
}

function createMockPluginRunner(overrides: Partial<PluginRunner> = {}): PluginRunner {
  return {
    getPluginRuntimes: vi.fn().mockReturnValue([]),
    getRuntimeById: vi.fn().mockReturnValue(undefined),
    createRuntimeContext: vi.fn().mockResolvedValue({
      pluginId: "fusion-plugin-hermes-runtime",
      taskStore: {},
      settings: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      emitEvent: vi.fn(),
    }),
    ...overrides,
  } as unknown as PluginRunner;
}

function createHermesRegistration(factoryImpl?: () => unknown): {
  pluginId: string;
  runtime: PluginRuntimeRegistration;
} {
  return {
    pluginId: "fusion-plugin-hermes-runtime",
    runtime: {
      metadata: {
        runtimeId: "hermes",
        name: "Hermes Runtime",
        description: "Hermes-backed AI session using configured provider/model",
        version: "0.1.0",
      },
      factory: vi.fn().mockImplementation(async () =>
        factoryImpl
          ? factoryImpl()
          : {
              id: "hermes",
              name: "Hermes Runtime",
              createSession: vi.fn().mockResolvedValue({
                session: { runtime: "hermes", prompt: vi.fn() },
                sessionFile: "/tmp/hermes.session.json",
              }),
              promptWithFallback: vi.fn().mockResolvedValue(undefined),
              describeModel: vi.fn().mockReturnValue("anthropic/claude-sonnet-4-5"),
            },
      ),
    },
  };
}

describe("Hermes runtime integration via engine resolution pipeline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateFnAgent.mockResolvedValue({
      session: { runtime: "pi", prompt: vi.fn() },
      sessionFile: "/tmp/pi.session.json",
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves Hermes runtime through PluginRunner lookup when runtimeHint is hermes", async () => {
    const hermesRegistration = createHermesRegistration();
    const pluginRunner = createMockPluginRunner({
      getRuntimeById: vi.fn().mockReturnValue(hermesRegistration),
    });

    const resolved = await resolveRuntime({
      sessionPurpose: "executor",
      runtimeHint: "hermes",
      pluginRunner,
    });

    expect(resolved.runtimeId).toBe("hermes");
    expect(resolved.wasConfigured).toBe(true);
    expect(resolved.runtime.id).toBe("hermes");
    expect(resolved.runtime.name).toBe("Hermes Runtime");
    expect(pluginRunner.getRuntimeById).toHaveBeenCalledWith("hermes");
    expect(pluginRunner.createRuntimeContext).toHaveBeenCalledWith("fusion-plugin-hermes-runtime");
  });

  it("returns a runtime object that conforms to AgentRuntime", async () => {
    const hermesRegistration = createHermesRegistration();
    const pluginRunner = createMockPluginRunner({
      getRuntimeById: vi.fn().mockReturnValue(hermesRegistration),
    });

    const resolved = await resolveRuntime({
      sessionPurpose: "executor",
      runtimeHint: "hermes",
      pluginRunner,
    });

    expect(isAgentRuntime(resolved.runtime)).toBe(true);
  });

  it("createResolvedAgentSession uses Hermes runtime and reports configured runtime metadata", async () => {
    const hermesSession = { runtime: "hermes", prompt: vi.fn() };
    const hermesCreateSession = vi.fn().mockResolvedValue({
      session: hermesSession,
      sessionFile: "/tmp/hermes.session.json",
    });
    const hermesRegistration = createHermesRegistration(() => ({
      id: "hermes",
      name: "Hermes Runtime",
      createSession: hermesCreateSession,
      promptWithFallback: vi.fn().mockResolvedValue(undefined),
      describeModel: vi.fn().mockReturnValue("anthropic/claude-sonnet-4-5"),
    }));

    const pluginRunner = createMockPluginRunner({
      getRuntimeById: vi.fn().mockReturnValue(hermesRegistration),
    });

    const result = await createResolvedAgentSession({
      sessionPurpose: "executor",
      runtimeHint: "hermes",
      pluginRunner,
      cwd: "/tmp/project",
      systemPrompt: "You are helpful",
      tools: "coding",
    });

    expect(result.runtimeId).toBe("hermes");
    expect(result.wasConfigured).toBe(true);
    expect(result.session).toBe(hermesSession);
    expect(result.sessionFile).toBe("/tmp/hermes.session.json");
    expect(hermesCreateSession).toHaveBeenCalledWith({
      cwd: "/tmp/project",
      systemPrompt: "You are helpful",
      tools: "coding",
    });
  });

  it("falls back to default pi runtime when Hermes factory throws", async () => {
    const hermesRegistration = createHermesRegistration(() => {
      throw new Error("factory exploded");
    });

    const pluginRunner = createMockPluginRunner({
      getRuntimeById: vi.fn().mockReturnValue(hermesRegistration),
    });

    const result = await createResolvedAgentSession({
      sessionPurpose: "executor",
      runtimeHint: "hermes",
      pluginRunner,
      cwd: "/tmp/project",
      systemPrompt: "Use fallback",
    });

    expect(result.runtimeId).toBe("pi");
    expect(result.wasConfigured).toBe(false);
    expect(mockCreateFnAgent).toHaveBeenCalledWith({
      cwd: "/tmp/project",
      systemPrompt: "Use fallback",
    });
  });
});
