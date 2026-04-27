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
      pluginId: "fusion-plugin-openclaw-runtime",
      taskStore: {},
      settings: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      emitEvent: vi.fn(),
    }),
    ...overrides,
  } as unknown as PluginRunner;
}

function createOpenClawRegistration(factoryImpl?: () => unknown): {
  pluginId: string;
  runtime: PluginRuntimeRegistration;
} {
  return {
    pluginId: "fusion-plugin-openclaw-runtime",
    runtime: {
      metadata: {
        runtimeId: "openclaw",
        name: "OpenClaw Runtime",
        description: "OpenClaw-backed AI session using the local OpenClaw gateway",
        version: "0.1.0",
      },
      factory: vi.fn().mockImplementation(async () =>
        factoryImpl
          ? factoryImpl()
          : {
              id: "openclaw",
              name: "OpenClaw Runtime",
              createSession: vi.fn().mockResolvedValue({
                session: { runtime: "openclaw", prompt: vi.fn() },
                sessionFile: "/tmp/openclaw.session.json",
              }),
              promptWithFallback: vi.fn().mockResolvedValue(undefined),
              describeModel: vi.fn().mockReturnValue("openclaw/main"),
            },
      ),
    },
  };
}

describe("OpenClaw runtime integration via engine resolution pipeline", () => {
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

  it("resolves OpenClaw runtime through PluginRunner lookup when runtimeHint is openclaw", async () => {
    const registration = createOpenClawRegistration();
    const pluginRunner = createMockPluginRunner({
      getRuntimeById: vi.fn().mockReturnValue(registration),
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
    expect(pluginRunner.getRuntimeById).toHaveBeenCalledWith("openclaw");
    expect(pluginRunner.createRuntimeContext).toHaveBeenCalledWith("fusion-plugin-openclaw-runtime");
  });

  it("returns a runtime object that conforms to AgentRuntime", async () => {
    const registration = createOpenClawRegistration();
    const pluginRunner = createMockPluginRunner({
      getRuntimeById: vi.fn().mockReturnValue(registration),
    });

    const resolved = await resolveRuntime({
      sessionPurpose: "executor",
      runtimeHint: "openclaw",
      pluginRunner,
    });

    expect(isAgentRuntime(resolved.runtime)).toBe(true);
  });

  it("createResolvedAgentSession uses OpenClaw runtime and reports configured runtime metadata", async () => {
    const runtimeSession = { runtime: "openclaw", prompt: vi.fn() };
    const createSession = vi.fn().mockResolvedValue({
      session: runtimeSession,
      sessionFile: "/tmp/openclaw.session.json",
    });
    const registration = createOpenClawRegistration(() => ({
      id: "openclaw",
      name: "OpenClaw Runtime",
      createSession,
      promptWithFallback: vi.fn().mockResolvedValue(undefined),
      describeModel: vi.fn().mockReturnValue("openclaw/main"),
    }));

    const pluginRunner = createMockPluginRunner({
      getRuntimeById: vi.fn().mockReturnValue(registration),
    });

    const result = await createResolvedAgentSession({
      sessionPurpose: "executor",
      runtimeHint: "openclaw",
      pluginRunner,
      cwd: "/tmp/project",
      systemPrompt: "You are helpful",
      tools: "coding",
    });

    expect(result.runtimeId).toBe("openclaw");
    expect(result.wasConfigured).toBe(true);
    expect(result.session).toBe(runtimeSession);
    expect(result.sessionFile).toBe("/tmp/openclaw.session.json");
    expect(createSession).toHaveBeenCalledWith({
      cwd: "/tmp/project",
      systemPrompt: "You are helpful",
      tools: "coding",
    });
  });

  it("falls back to default pi runtime when OpenClaw factory throws", async () => {
    const registration = createOpenClawRegistration(() => {
      throw new Error("factory exploded");
    });

    const pluginRunner = createMockPluginRunner({
      getRuntimeById: vi.fn().mockReturnValue(registration),
    });

    const result = await createResolvedAgentSession({
      sessionPurpose: "executor",
      runtimeHint: "openclaw",
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
