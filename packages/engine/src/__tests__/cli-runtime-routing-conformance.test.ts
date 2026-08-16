import { beforeEach, describe, expect, it, vi } from "vitest";
import * as fusionCore from "@fusion/core";
import { createResolvedAgentSession } from "../agents/agent-session-helpers.js";
import { CLI_PROVIDER_ROUTING_CENSUS, type CliProviderRouting } from "../agents/cli-provider-routing.js";
import type { PluginRunner } from "../plugins/plugin-runner.js";
import type { PluginRuntimeRegistration } from "@fusion/core";

const { mockCreateFnAgent, mockPromptWithFallback } = vi.hoisted(() => ({
  mockCreateFnAgent: vi.fn(),
  mockPromptWithFallback: vi.fn(),
}));

vi.mock("../pi.js", () => ({
  createFnAgent: mockCreateFnAgent,
  promptWithFallback: mockPromptWithFallback,
  describeModel: vi.fn().mockReturnValue("pi/default"),
  wrapToolsWithActionGate: vi.fn((tools) => tools),
  wrapToolsWithPermanentAgentGating: vi.fn((tools) => tools),
  wrapToolsWithOutputBudget: vi.fn((tools) => tools),
  wrapToolsWithRtkRewrite: vi.fn((tools) => tools),
  isRetryableModelSelectionError: vi.fn().mockReturnValue(false),
}));

function registration(runtimeId: string): { pluginId: string; runtime: PluginRuntimeRegistration } {
  return {
    pluginId: `fusion-plugin-${runtimeId}-runtime`,
    runtime: {
      metadata: { runtimeId, name: `${runtimeId} runtime` },
      factory: vi.fn().mockResolvedValue({
        id: runtimeId,
        name: `${runtimeId} runtime`,
        createSession: vi.fn().mockResolvedValue({ session: { runtimeId } }),
        promptWithFallback: vi.fn(),
        describeModel: vi.fn().mockReturnValue(`${runtimeId}/model`),
      }),
    },
  } as PluginRuntimeRegistration;
}

function runner(runtimeId: string, availability: "available" | "missing" | "throws" = "available"): PluginRunner {
  return {
    getRuntimeById: vi.fn(() => {
      if (availability === "throws") throw new Error("runtime lookup failed");
      return availability === "available" ? registration(runtimeId) : undefined;
    }),
    createRuntimeContext: vi.fn().mockResolvedValue({
      pluginId: `fusion-plugin-${runtimeId}-runtime`, taskStore: {}, settings: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }, emitEvent: vi.fn(),
    }),
  } as unknown as PluginRunner;
}

function options(entry?: CliProviderRouting, overrides: Record<string, unknown> = {}) {
  return {
    sessionPurpose: "executor" as const,
    cwd: "/tmp/project",
    systemPrompt: "system",
    defaultProvider: entry?.providerId,
    defaultModelId: entry ? `${entry.providerId}/profile` : "model",
    pluginRunner: entry?.runtimeId ? runner(entry.runtimeId) : runner("unused"),
    ...overrides,
  };
}

function grokVisibility(entry: CliProviderRouting, role: "primary" | "fallback" = "primary"): boolean {
  return entry.providerId === "grok-cli" && role === "primary" ? false : true;
}

/**
 * FNXC:CliRuntimeRouting 2026-08-15-14:06:
 * This is the all-lanes production seam, not a routing-helper unit test. Drive
 * every assertion from the census so a catalog classification or per-path
 * policy cannot drift without exercising createResolvedAgentSession.
 */
describe("CLI provider routing conformance", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(fusionCore, "isGrokApiKeyFusionVisible").mockReturnValue(false);
    mockCreateFnAgent.mockReset().mockResolvedValue({ session: { runtimeId: "pi" } });
    mockPromptWithFallback.mockReset().mockResolvedValue(undefined);
  });

  it.each(CLI_PROVIDER_ROUTING_CENSUS.filter((entry) => entry.classification === "runtime-routed"))(
    "routes no-hint $providerId selections through $runtimeId when its derive guard applies",
    async (entry) => {
      vi.spyOn(fusionCore, "isGrokApiKeyFusionVisible").mockReturnValue(grokVisibility(entry));
      const result = await createResolvedAgentSession(options(entry));
      expect(result.runtimeId).toBe(entry.runtimeId);
      expect(result.runtimeId).not.toBe("pi");
      expect(mockCreateFnAgent).not.toHaveBeenCalled();
    },
  );

  it.each(CLI_PROVIDER_ROUTING_CENSUS.filter((entry) => entry.autoDerive === "fail-fast"))(
    "applies $providerId auto-derive fail-fast policy for every unavailable lookup state",
    async (entry) => {
      vi.spyOn(fusionCore, "isGrokApiKeyFusionVisible").mockReturnValue(grokVisibility(entry));
      for (const availability of ["missing", "throws"] as const) {
        await expect(createResolvedAgentSession(options(entry, {
          pluginRunner: entry.runtimeId ? runner(entry.runtimeId, availability) : undefined,
        }))).rejects.toThrow(entry.providerId === "cursor-cli" ? /Cursor CLI/ : /runtime plugin/i);
      }
      await expect(createResolvedAgentSession(options(entry, { pluginRunner: undefined }))).rejects.toThrow(
        entry.providerId === "cursor-cli" ? /Cursor CLI/ : /runtime plugin/i,
      );
    },
  );

  it.each(CLI_PROVIDER_ROUTING_CENSUS.filter((entry) => entry.guardNotApplicable === "pinned-pi-fallback"))(
    "preserves $providerId guard-not-applicable pi fallback instead of applying another path policy",
    async (entry) => {
      vi.spyOn(fusionCore, "isGrokApiKeyFusionVisible").mockReturnValue(true);
      const result = await createResolvedAgentSession(options(undefined, {
        defaultProvider: "openai",
        defaultModelId: "primary",
        fallbackProvider: entry.providerId,
        fallbackModelId: `${entry.providerId}/fallback`,
        pluginRunner: runner(entry.runtimeId ?? "unused", "missing"),
      }));
      expect(result.runtimeId).toBe("pi");
    },
  );

  it.each(CLI_PROVIDER_ROUTING_CENSUS.filter((entry) => entry.onExplicitHint !== "n/a"))(
    "applies $providerId explicit-hint policy independently from auto-derive",
    async (entry) => {
      const runtimeHint = entry.runtimeId!;
      if (entry.onExplicitHint === "assert-available") {
        // Cursor remains withheld even with a registered stub runtime.
        if (entry.classification === "withheld-unsupported") {
          for (const availability of ["available", "missing", "throws"] as const) {
            await expect(createResolvedAgentSession(options(entry, {
              runtimeHint,
              pluginRunner: runner(runtimeHint, availability),
            }))).rejects.toThrow(/Cursor CLI/);
          }
          return;
        }
        const available = await createResolvedAgentSession(options(entry, {
          runtimeHint,
          pluginRunner: runner(runtimeHint, "available"),
        }));
        expect(available.runtimeId).toBe(runtimeHint);
        for (const availability of ["missing", "throws"] as const) {
          await expect(createResolvedAgentSession(options(entry, {
            runtimeHint,
            pluginRunner: runner(runtimeHint, availability),
          }))).rejects.toThrow(/runtime plugin/i);
        }
        return;
      }
      const result = await createResolvedAgentSession(options(entry, {
        runtimeHint,
        pluginRunner: runner(runtimeHint, "missing"),
      }));
      expect(result.runtimeId).toBe("pi");
    },
  );

  it.each(CLI_PROVIDER_ROUTING_CENSUS.filter((entry) => entry.classification === "registry-native" || entry.classification === "non-cli"))(
    "leaves $providerId registry/native selection without a CLI runtime hint",
    async (entry) => {
      const pluginRunner = runner("unused");
      const result = await createResolvedAgentSession(options(entry, { pluginRunner }));
      expect(result.runtimeId).toBe("pi");
      expect(pluginRunner.getRuntimeById).not.toHaveBeenCalled();
    },
  );

  it.each(CLI_PROVIDER_ROUTING_CENSUS)(
    "honors $providerId fallback policy across primary-only, fallback-only, both, and absent roles",
    async (entry) => {
      vi.spyOn(fusionCore, "isGrokApiKeyFusionVisible").mockReturnValue(true);
      const pluginRunner = runner(entry.runtimeId ?? "unused");
      if (entry.classification === "withheld-unsupported") {
        await expect(createResolvedAgentSession(options(entry, { pluginRunner }))).rejects.toThrow(/Cursor CLI/);
        await expect(createResolvedAgentSession(options(entry, {
          fallbackProvider: entry.providerId, fallbackModelId: `${entry.providerId}/fallback`, pluginRunner,
        }))).rejects.toThrow(/Cursor CLI/);
      } else {
        await createResolvedAgentSession(options(entry, { pluginRunner }));
        await createResolvedAgentSession(options(entry, {
          fallbackProvider: entry.providerId, fallbackModelId: `${entry.providerId}/fallback`, pluginRunner,
        }));
      }
      const fallback = await createResolvedAgentSession(options(undefined, {
        defaultProvider: "openai", defaultModelId: "primary", fallbackProvider: entry.providerId,
        fallbackModelId: `${entry.providerId}/fallback`, pluginRunner,
      }));
      const absent = await createResolvedAgentSession(options(undefined, { pluginRunner }));
      expect(fallback.runtimeId).toBe(entry.fallbackPolicy === "promote-to-primary" ? "omp" : "pi");
      if (entry.fallbackPolicy === "defer-cross-runtime") {
        expect(mockCreateFnAgent).toHaveBeenCalledWith(expect.objectContaining({
          defaultProvider: "openai",
          fallbackProvider: undefined,
          fallbackModelId: undefined,
        }));
      }
      expect(absent.runtimeId).toBe("pi");
    },
  );

  it.each(CLI_PROVIDER_ROUTING_CENSUS)("short-circuits $providerId before CLI lookup in test mode", async (entry) => {
    const pluginRunner = runner(entry.runtimeId ?? "unused", "throws");
    const result = await createResolvedAgentSession(options(entry, {
      pluginRunner,
      settings: { testMode: true },
    }));
    expect(result.runtimeId).toBe("mock");
    expect(pluginRunner.getRuntimeById).not.toHaveBeenCalled();
  });

  it("swaps a deferred Cursor fallback after a retryable primary failure with portable context", async () => {
    const cursorPrompt = vi.fn().mockResolvedValue("cursor result");
    const cursorCreateSession = vi.fn().mockResolvedValue({ session: {} });
    const pluginRunner = {
      getRuntimeById: vi.fn(() => ({
        pluginId: "fusion-plugin-cursor-runtime",
        runtime: {
          metadata: { runtimeId: "cursor", name: "Cursor" },
          factory: vi.fn().mockResolvedValue({
            id: "cursor", name: "Cursor", createSession: cursorCreateSession,
            promptWithFallback: cursorPrompt, describeModel: vi.fn(),
          }),
        },
      })),
      createRuntimeContext: vi.fn().mockResolvedValue({ pluginId: "fusion-plugin-cursor-runtime", taskStore: {}, settings: {}, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }, emitEvent: vi.fn() }),
    } as unknown as PluginRunner;
    mockCreateFnAgent.mockResolvedValue({ session: { state: { messages: [{ role: "assistant", content: "prior answer" }] } } });
    vi.mocked((await import("../pi.js")).isRetryableModelSelectionError).mockReturnValue(true);
    mockPromptWithFallback.mockRejectedValueOnce(new Error("rate limit"));
    const database = vi.fn();
    const result = await createResolvedAgentSession(options(undefined, {
      defaultProvider: "openai", defaultModelId: "primary", fallbackProvider: "cursor-cli", fallbackModelId: "cursor-cli/small",
      pluginRunner, runAuditor: { database },
    }));
    await expect((result.session as { promptWithFallback: (prompt: string) => Promise<unknown> }).promptWithFallback("current prompt")).resolves.toBe("cursor result");
    expect(cursorCreateSession).toHaveBeenCalledOnce();
    expect(cursorPrompt).toHaveBeenCalledWith(expect.anything(), expect.stringContaining("prior answer"), undefined);
    expect(database).toHaveBeenCalledWith(expect.objectContaining({
      type: "session:runtime-resolved",
      metadata: expect.objectContaining({ crossRuntimeFallbackDeferred: true }),
    }));
    expect(database).toHaveBeenCalledWith(expect.objectContaining({ type: "session:cross-runtime-fallback-engaged" }));
  });

  it("drops an unavailable Cursor fallback without creating a replacement runtime", async () => {
    const pluginRunner = runner("cursor", "missing");
    const database = vi.fn();
    const result = await createResolvedAgentSession(options(undefined, {
      defaultProvider: "openai", defaultModelId: "primary", fallbackProvider: "cursor-cli", fallbackModelId: "cursor-cli/small",
      pluginRunner, runAuditor: { database },
    }));
    await expect((result.session as { promptWithFallback: (prompt: string) => Promise<unknown> }).promptWithFallback("current prompt")).resolves.toBeUndefined();
    expect(database).toHaveBeenCalledWith(expect.objectContaining({
      type: "session:runtime-resolved",
      metadata: expect.objectContaining({ crossRuntimeFallbackDropped: true }),
    }));
    expect(pluginRunner.getRuntimeById).toHaveBeenCalledTimes(1);
  });

  it("routes Cursor primary selection through its installed runtime", async () => {
    const entry = CLI_PROVIDER_ROUTING_CENSUS.find((candidate) => candidate.providerId === "cursor-cli");
    const result = await createResolvedAgentSession(options(entry, { runtimeHint: "cursor", pluginRunner: runner("cursor") }));
    expect(result.runtimeId).toBe("cursor");
  });
});
