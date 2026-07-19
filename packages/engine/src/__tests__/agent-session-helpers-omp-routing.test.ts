import { beforeEach, describe, expect, it, vi } from "vitest";
import * as fusionCore from "@fusion/core";
import { createResolvedAgentSession } from "../agent-session-helpers.js";
import { MOCK_PROVIDER_ID } from "../providers/mock-provider.js";

const mockCreateFnAgent = vi.hoisted(() => vi.fn());

vi.mock("../pi.js", () => ({
  createFnAgent: mockCreateFnAgent,
  promptWithFallback: vi.fn().mockResolvedValue(undefined),
  describeModel: vi.fn().mockReturnValue("pi/default"),
  wrapToolsWithActionGate: vi.fn((tools) => tools),
  wrapToolsWithPermanentAgentGating: vi.fn((tools) => tools),
  wrapToolsWithRtkRewrite: vi.fn((tools) => tools),
}));

/*
FNXC:OmpAcp 2026-07-18-09:00:
FN-8262 regression coverage keeps `omp-cli` selections out of pi's model registry: primary/fallback selections use the ACP runtime, unavailable runtime states provide the plugin remediation, and mock/test mode makes no OMP lookup.
*/
function makeOmpPluginRunnerStub(options?: { includeOmp?: boolean; includeOther?: boolean }) {
  const createSession = vi.fn().mockResolvedValue({
    session: { model: "omp/MiniMax-M2.5", messages: [], dispose: vi.fn() },
  });
  const ompRegistration = {
    pluginId: "fusion-plugin-omp-runtime",
    runtime: {
      metadata: { runtimeId: "omp", name: "OMP Runtime" },
      factory: vi.fn().mockResolvedValue({
        id: "omp",
        name: "OMP Runtime",
        createSession,
        promptWithFallback: vi.fn(),
        describeModel: vi.fn(() => "omp/MiniMax-M2.5"),
      }),
    },
  };
  const otherRegistration = {
    pluginId: "other-runtime",
    runtime: {
      metadata: { runtimeId: "other", name: "Other Runtime" },
      factory: vi.fn().mockResolvedValue({
        id: "other",
        name: "Other Runtime",
        createSession,
        promptWithFallback: vi.fn(),
        describeModel: vi.fn(() => "other/model"),
      }),
    },
  };
  const getRuntimeById = vi.fn((runtimeId: string) => {
    if (runtimeId === "omp" && options?.includeOmp !== false) return ompRegistration;
    if (runtimeId === "other" && options?.includeOther) return otherRegistration;
    return undefined;
  });
  return {
    pluginRunner: {
      getRuntimeById,
      createRuntimeContext: vi.fn().mockResolvedValue({
        pluginId: "fusion-plugin-omp-runtime",
        taskStore: {},
        settings: {},
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        emitEvent: vi.fn(),
      }),
    },
    getRuntimeById,
    createSession,
  };
}

function sessionOptions(overrides: Record<string, unknown> = {}) {
  return {
    sessionPurpose: "executor" as const,
    cwd: "/tmp/project",
    systemPrompt: "system",
    ...overrides,
  };
}

describe("createResolvedAgentSession OMP runtime routing", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockCreateFnAgent.mockReset().mockResolvedValue({
      session: { model: "pi/default", messages: [], dispose: vi.fn() },
    });
  });

  it.each(["MiniMax-M2.5", "omp-cli/MiniMax-M2.5"])(
    "routes primary omp-cli model %s through OMP ACP instead of pi registry",
    async (defaultModelId) => {
      const { pluginRunner, getRuntimeById, createSession } = makeOmpPluginRunnerStub();
      const audit = { database: vi.fn().mockResolvedValue(undefined) };

      const result = await createResolvedAgentSession(sessionOptions({
        pluginRunner: pluginRunner as never,
        runAuditor: audit as never,
        defaultProvider: "omp-cli",
        defaultModelId,
      }));

      expect(result.runtimeId).toBe("omp");
      expect(getRuntimeById).toHaveBeenCalledWith("omp");
      expect(createSession).toHaveBeenCalledWith(expect.objectContaining({
        defaultProvider: "omp-cli",
        defaultModelId: "MiniMax-M2.5",
      }));
      expect(mockCreateFnAgent).not.toHaveBeenCalled();
      expect(audit.database).toHaveBeenCalledWith(expect.objectContaining({
        type: "session:runtime-resolved",
        target: "omp",
        metadata: expect.objectContaining({ reason: "omp-cli-runtime" }),
      }));
    },
  );

  it("promotes an omp-cli fallback pair and thinking level into the OMP session", async () => {
    const { pluginRunner, createSession } = makeOmpPluginRunnerStub();

    const result = await createResolvedAgentSession(sessionOptions({
      pluginRunner: pluginRunner as never,
      defaultProvider: undefined,
      defaultModelId: undefined,
      fallbackProvider: "omp-cli",
      fallbackModelId: "omp-cli/MiniMax-M2.5",
      fallbackThinkingLevel: "high",
    }));

    expect(result.runtimeId).toBe("omp");
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({
      defaultProvider: "omp-cli",
      defaultModelId: "MiniMax-M2.5",
      defaultThinkingLevel: "high",
      fallbackProvider: undefined,
      fallbackModelId: undefined,
      fallbackThinkingLevel: undefined,
    }));
  });

  it.each([
    ["an absent runtime registration", makeOmpPluginRunnerStub({ includeOmp: false }).pluginRunner],
    ["no pluginRunner", undefined],
  ])("reports OMP plugin remediation for %s", async (_label, pluginRunner) => {
    const promise = createResolvedAgentSession(sessionOptions({
      pluginRunner: pluginRunner as never,
      defaultProvider: "omp-cli",
      defaultModelId: "MiniMax-M2.5",
    }));

    await expect(promise).rejects.toThrow(/OMP runtime plugin/);
    await expect(promise).rejects.not.toThrow(/not found in the pi model registry/);
  });

  it("reports OMP plugin remediation for an unavailable explicit omp hint", async () => {
    const { pluginRunner } = makeOmpPluginRunnerStub({ includeOmp: false });

    await expect(createResolvedAgentSession(sessionOptions({
      pluginRunner: pluginRunner as never,
      runtimeHint: "omp",
      defaultProvider: "omp-cli",
      defaultModelId: "MiniMax-M2.5",
    }))).rejects.toThrow(/OMP runtime plugin/);
  });

  it("uses mock without OMP lookup in test mode or when mock is primary", async () => {
    const testModeRunner = makeOmpPluginRunnerStub();
    const testModeResult = await createResolvedAgentSession(sessionOptions({
      pluginRunner: testModeRunner.pluginRunner as never,
      settings: { testMode: true } as never,
      defaultProvider: "omp-cli",
      defaultModelId: "MiniMax-M2.5",
    }));
    expect(testModeResult.runtimeId).toBe(MOCK_PROVIDER_ID);
    expect(testModeRunner.getRuntimeById).not.toHaveBeenCalled();

    const mockRunner = makeOmpPluginRunnerStub();
    const mockResult = await createResolvedAgentSession(sessionOptions({
      pluginRunner: mockRunner.pluginRunner as never,
      defaultProvider: MOCK_PROVIDER_ID,
      defaultModelId: "scripted",
      fallbackProvider: "omp-cli",
      fallbackModelId: "MiniMax-M2.5",
    }));
    expect(mockResult.runtimeId).toBe(MOCK_PROVIDER_ID);
    expect(mockRunner.getRuntimeById).not.toHaveBeenCalled();

    const configuredMockRunner = makeOmpPluginRunnerStub();
    const configuredMockResult = await createResolvedAgentSession(sessionOptions({
      pluginRunner: configuredMockRunner.pluginRunner as never,
      settings: { defaultProvider: MOCK_PROVIDER_ID } as never,
      defaultProvider: "omp-cli",
      defaultModelId: "MiniMax-M2.5",
    }));
    expect(configuredMockResult.runtimeId).toBe(MOCK_PROVIDER_ID);
    expect(configuredMockRunner.getRuntimeById).not.toHaveBeenCalled();
  });

  it("respects a non-OMP explicit runtime hint and leaves Grok routing independent", async () => {
    const { pluginRunner, getRuntimeById } = makeOmpPluginRunnerStub({ includeOther: true });
    const explicitResult = await createResolvedAgentSession(sessionOptions({
      pluginRunner: pluginRunner as never,
      runtimeHint: "other",
      defaultProvider: "omp-cli",
      defaultModelId: "MiniMax-M2.5",
    }));
    expect(explicitResult.runtimeId).toBe("other");
    expect(getRuntimeById).not.toHaveBeenCalledWith("omp");

    vi.spyOn(fusionCore, "isGrokApiKeyFusionVisible").mockReturnValue(true);
    const grokRunner = makeOmpPluginRunnerStub();
    await createResolvedAgentSession(sessionOptions({
      pluginRunner: grokRunner.pluginRunner as never,
      defaultProvider: "grok-cli",
      defaultModelId: "grok-4.5",
    }));
    expect(grokRunner.getRuntimeById).not.toHaveBeenCalledWith("omp");
  });
});
