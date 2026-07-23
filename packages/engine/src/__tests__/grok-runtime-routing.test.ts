import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginRunner } from "../plugins/plugin-runner.js";
import type { PluginRuntimeRegistration } from "@fusion/core";
import * as fusionCore from "@fusion/core";
import { resolveRuntime } from "../execution/runtime-resolution.js";
import { createResolvedAgentSession, extractRuntimeHint } from "../agents/agent-session-helpers.js";

/*
FNXC:GrokCli 2026-07-09-00:00:
FN-7725: end-to-end routing test for the decided wiring (option (a),
docs/grok-cli-contract.md "Wiring") — an agent's
`runtimeConfig.runtimeHint === "grok"` (as set by the dashboard's Runtime
Source -> Runtime picker) must resolve the REAL GrokRuntimeAdapter (FN-7722,
imported unmodified from the plugin package, not re-implemented/mocked here)
through the generic extractRuntimeHint -> resolveRuntime ->
resolvePluginRuntime -> plugin factory chain, and driving a prompt through
that resolved session must invoke onText from streamed ACP updates.

FNXC:GrokAcp 2026-07-11-12:00:
Prompt transport is now ACP (`grok agent stdio`). Tests inject a fake
AcpRuntimeAdapter via `createAcpAdapter` — no live `grok` binary, no real
subprocess, no real network. Surface Enumeration: trigger OFF / unset /
non-grok hints still fall back to the default pi runtime unchanged.
*/

const mockCreateFnAgent = vi.hoisted(() => vi.fn());
const mockPiPromptWithFallback = vi.hoisted(() => vi.fn());

vi.mock("../logger.js", () => ({
  createLogger: vi.fn(() => ({
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

vi.mock("../pi.js", () => ({
  createFnAgent: mockCreateFnAgent,
  promptWithFallback: mockPiPromptWithFallback,
  describeModel: vi.fn().mockReturnValue("pi/default"),
  // FNXC:GrokCliRouting 2026-07-22-15:10: the deferred-fallback wrapper classifies primary failures through this seam; mirror the real classifier's 429/auth substrings for the engagement tests.
  isRetryableModelSelectionError: (message: string) => {
    const normalized = message.toLowerCase();
    return normalized.includes("429") || normalized.includes("rate limit") || normalized.includes("401") || normalized.includes("authentication");
  },
}));

function grokRuntimeAdapterModulePath(): string {
  return fileURLToPath(
    new URL("../../../../plugins/fusion-plugin-grok-runtime/src/runtime-adapter.ts", import.meta.url),
  );
}

type FakeAcpAdapter = {
  createSession: (options: {
    onText?: (t: string) => void;
    onThinking?: (t: string) => void;
    defaultModelId?: string;
    systemPrompt?: string;
  }) => Promise<{ session: Record<string, unknown> }>;
  promptWithFallback: (
    session: Record<string, unknown>,
    prompt: string,
    options?: unknown,
  ) => Promise<void | { stopReason?: string }>;
  describeModel: (session: unknown) => string;
  dispose?: (session: unknown) => Promise<void>;
};

type GrokRuntimeAdapterCtor = new (options?: {
  binary?: string;
  createAcpAdapter?: (settings: Record<string, unknown>) => FakeAcpAdapter;
}) => {
  id: string;
  name: string;
  createSession: (options?: unknown) => Promise<{ session: unknown; sessionFile?: string }>;
  promptWithFallback: (session: unknown, prompt: string, options?: unknown) => Promise<void>;
  describeModel: (session: unknown) => string;
};

async function loadGrokRuntimeAdapter(): Promise<GrokRuntimeAdapterCtor> {
  const mod = (await import(pathToFileURL(grokRuntimeAdapterModulePath()).href)) as {
    GrokRuntimeAdapter: GrokRuntimeAdapterCtor;
  };
  return mod.GrokRuntimeAdapter;
}

/**
 * Fake ACP adapter that simulates streamed session/update callbacks without a
 * live `grok agent stdio` process. `promptBehavior` controls the turn outcome.
 */
function makeFakeAcpFactory(options?: {
  promptBehavior?: "text" | "empty-json" | "throw";
  settingsOut?: Record<string, unknown>[];
}): (settings: Record<string, unknown>) => FakeAcpAdapter {
  const promptBehavior = options?.promptBehavior ?? "text";
  const settingsOut = options?.settingsOut;
  return (settings) => {
    settingsOut?.push(settings);
    let capturedOnText: ((t: string) => void) | undefined;
    const sessionShell: Record<string, unknown> = {
      model: String(settings.acpModel ?? "grok/default"),
      messages: [],
      state: { messages: [] },
      lastModelDescription: `acp/${settings.acpModel ?? "default"}`,
      callbacks: {},
      connection: { id: "conn-1" },
      sessionId: "acp-session-1",
      dispose: vi.fn(),
    };
    return {
      createSession: async (opts) => {
        capturedOnText = opts.onText;
        sessionShell.callbacks = {
          onText: opts.onText,
          onThinking: opts.onThinking,
        };
        sessionShell.systemPrompt = opts.systemPrompt;
        return { session: sessionShell };
      },
      promptWithFallback: async () => {
        if (promptBehavior === "throw") {
          throw new Error("ACP bridge hung up");
        }
        if (promptBehavior === "empty-json") {
          return { stopReason: "end_turn" };
        }
        capturedOnText?.("hi there");
        return { stopReason: "end_turn" };
      },
      describeModel: (session) => `acp/${(session as { model?: string }).model ?? "default"}`,
      dispose: async () => undefined,
    };
  };
}

function createMockPluginRunner(overrides: Partial<PluginRunner> = {}): PluginRunner {
  return {
    getPluginRuntimes: vi.fn().mockReturnValue([]),
    getRuntimeById: vi.fn().mockReturnValue(undefined),
    createRuntimeContext: vi.fn().mockResolvedValue({
      pluginId: "fusion-plugin-grok-runtime",
      taskStore: {},
      settings: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      emitEvent: vi.fn(),
    }),
    ...overrides,
  } as unknown as PluginRunner;
}

async function createGrokRegistration(
  createAcpAdapter: (settings: Record<string, unknown>) => FakeAcpAdapter = makeFakeAcpFactory(),
): Promise<{ pluginId: string; runtime: PluginRuntimeRegistration }> {
  const GrokRuntimeAdapter = await loadGrokRuntimeAdapter();
  return {
    pluginId: "fusion-plugin-grok-runtime",
    runtime: {
      metadata: {
        runtimeId: "grok",
        name: "Grok Runtime",
        description: "Grok CLI runtime support for Fusion (ACP)",
        version: "0.2.0",
      },
      factory: vi.fn().mockImplementation(async () => new GrokRuntimeAdapter({ createAcpAdapter })),
    },
  };
}

describe("Grok CLI runtime routing (FN-7725)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(fusionCore, "isGrokApiKeyFusionVisible").mockReturnValue(true);
    mockCreateFnAgent.mockResolvedValue({
      session: { runtime: "pi", prompt: vi.fn() },
      sessionFile: "/tmp/pi.session.json",
    });
    mockPiPromptWithFallback.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves the real GrokRuntimeAdapter via resolveRuntime when runtimeHint is 'grok'", async () => {
    const grokRegistration = await createGrokRegistration();
    const pluginRunner = createMockPluginRunner({
      getRuntimeById: vi.fn().mockReturnValue(grokRegistration),
    });

    const resolved = await resolveRuntime({
      sessionPurpose: "executor",
      runtimeHint: "grok",
      pluginRunner,
    });

    expect(resolved.runtimeId).toBe("grok");
    expect(resolved.wasConfigured).toBe(true);
    expect(resolved.runtime.id).toBe("grok");
    expect(resolved.runtime.name).toBe("Grok Runtime");
    expect(pluginRunner.getRuntimeById).toHaveBeenCalledWith("grok");
  });

  it("createResolvedAgentSession routes an agent's runtimeConfig.runtimeHint through to GrokRuntimeAdapter and streams onText from faked ACP updates", async () => {
    const settingsOut: Record<string, unknown>[] = [];
    const grokRegistration = await createGrokRegistration(
      makeFakeAcpFactory({ promptBehavior: "text", settingsOut }),
    );
    const pluginRunner = createMockPluginRunner({
      getRuntimeById: vi.fn().mockReturnValue(grokRegistration),
    });

    // Mirrors the exact seam: dashboard Runtime-mode picker writes
    // agent.runtimeConfig.runtimeHint = "grok"; extractRuntimeHint reads it.
    const agentRuntimeConfig = { runtimeHint: "grok" };
    const runtimeHint = extractRuntimeHint(agentRuntimeConfig);
    expect(runtimeHint).toBe("grok");

    const onText = vi.fn();
    const result = await createResolvedAgentSession({
      sessionPurpose: "executor",
      runtimeHint,
      pluginRunner,
      cwd: "/tmp/project",
      systemPrompt: "You are helpful",
      onText,
    });

    expect(result.runtimeId).toBe("grok");
    expect(result.wasConfigured).toBe(true);
    expect(mockCreateFnAgent).not.toHaveBeenCalled();
    // FNXC:GrokAcp 2026-07-11-14:00 / 15:00: ACP args include --no-auto-update
    // (official headless scripting docs), session-scoped --plugin-dir for Fusion
    // skills, then stdio (optional -m when a model is set).
    const acpArgs = settingsOut[0]?.acpArgs as string[];
    expect(acpArgs).toContain("--no-auto-update");
    expect(acpArgs).toContain("agent");
    expect(acpArgs).toContain("--plugin-dir");
    expect(acpArgs.at(-1)).toBe("stdio");

    // Drive the resolved session's promptWithFallback (attached by
    // createResolvedAgentSession). Fake ACP fires onText with streamed text.
    const session = result.session as { promptWithFallback: (prompt: string) => Promise<void> };
    await session.promptWithFallback("hello grok");

    expect(onText.mock.calls.map((c) => c[0])).toEqual(["hi there"]);
  });

  it("surfaces ACP prompt failures through the shared runtime session seam without rejecting", async () => {
    const grokRegistration = await createGrokRegistration(
      makeFakeAcpFactory({ promptBehavior: "throw" }),
    );
    const pluginRunner = createMockPluginRunner({
      getRuntimeById: vi.fn().mockReturnValue(grokRegistration),
    });
    const onText = vi.fn();
    const result = await createResolvedAgentSession({
      sessionPurpose: "executor",
      runtimeHint: "grok",
      pluginRunner,
      cwd: "/tmp/project",
      onText,
    });

    const session = result.session as {
      state?: { errorMessage?: string };
      promptWithFallback: (prompt: string) => Promise<void>;
    };
    await expect(session.promptWithFallback("hello grok")).resolves.toBeUndefined();

    // FNXC:GrokAcp 2026-07-11-12:00: ACP path resolves-never-rejects and surfaces
    // turn failures as diagnosable onText (same empty-bubble invariant as FN-7779).
    expect(session.state?.errorMessage).toContain("Grok ACP turn failed");
    expect(onText).toHaveBeenCalledWith(expect.stringContaining("Grok ACP turn failed"));
  });

  it("falls back to the default pi runtime when the Grok plugin runtime is not registered", async () => {
    const pluginRunner = createMockPluginRunner({
      getRuntimeById: vi.fn().mockReturnValue(undefined),
    });

    const result = await createResolvedAgentSession({
      sessionPurpose: "executor",
      runtimeHint: "grok",
      pluginRunner,
      cwd: "/tmp/project",
      systemPrompt: "fallback",
    });

    expect(result.runtimeId).toBe("pi");
    expect(result.wasConfigured).toBe(false);
    expect(mockCreateFnAgent).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/tmp/project",
      systemPrompt: "fallback",
    }));
  });

  it("does not route through Grok when runtimeHint is unset (non-grok agent unaffected)", async () => {
    const pluginRunner = createMockPluginRunner();

    // No runtimeHint set on the agent's runtimeConfig at all.
    const runtimeHint = extractRuntimeHint(undefined);
    expect(runtimeHint).toBeUndefined();

    const result = await createResolvedAgentSession({
      sessionPurpose: "executor",
      runtimeHint,
      pluginRunner,
      cwd: "/tmp/project",
      systemPrompt: "unhinted",
    });

    expect(result.runtimeId).toBe("pi");
    expect(result.wasConfigured).toBe(false);
    expect(pluginRunner.getRuntimeById).not.toHaveBeenCalled();
  });

  it("auto-routes a grok-cli model selection to the Grok runtime when no Fusion-visible key exists", async () => {
    vi.mocked(fusionCore.isGrokApiKeyFusionVisible).mockReturnValue(false);
    const grokRegistration = await createGrokRegistration();
    const pluginRunner = createMockPluginRunner({
      getRuntimeById: vi.fn().mockReturnValue(grokRegistration),
    });
    const audit = { database: vi.fn().mockResolvedValue(undefined) };

    const runtimeHint = extractRuntimeHint({ model: "grok-cli/grok-4.5" });
    expect(runtimeHint).toBeUndefined();

    const result = await createResolvedAgentSession({
      sessionPurpose: "executor",
      runtimeHint,
      pluginRunner,
      runAuditor: audit as never,
      cwd: "/tmp/project",
      defaultProvider: "grok-cli",
      defaultModelId: "grok-cli/grok-4.5",
      systemPrompt: "model-selection-only",
    });

    expect(result.runtimeId).toBe("grok");
    expect(result.wasConfigured).toBe(true);
    expect(mockCreateFnAgent).not.toHaveBeenCalled();
    expect(result.session).toMatchObject({ model: "grok-4.5" });
    expect(audit.database).toHaveBeenCalledWith(expect.objectContaining({
      type: "session:runtime-resolved",
      target: "grok",
      metadata: expect.objectContaining({
        runtimeHint: "grok",
        reason: "grok-cli-no-visible-key",
        provider: "grok-cli",
        // FNXC:ModelResolution 2026-07-22-14:30: audit records the post-transform model the session actually runs (provider prefix stripped for the CLI).
        modelId: "grok-4.5",
      }),
    }));
  });

  it("keeps grok-cli on the direct pi runtime when a Fusion-visible key exists", async () => {
    vi.mocked(fusionCore.isGrokApiKeyFusionVisible).mockReturnValue(true);
    const grokRegistration = await createGrokRegistration();
    const pluginRunner = createMockPluginRunner({
      getRuntimeById: vi.fn().mockReturnValue(grokRegistration),
    });

    const result = await createResolvedAgentSession({
      sessionPurpose: "executor",
      pluginRunner,
      cwd: "/tmp/project",
      defaultProvider: "grok-cli",
      defaultModelId: "grok-4.5",
      systemPrompt: "direct-endpoint-default",
    });

    expect(result.runtimeId).toBe("pi");
    expect(result.wasConfigured).toBe(false);
    expect(mockCreateFnAgent).toHaveBeenCalledWith(expect.objectContaining({
      defaultProvider: "grok-cli",
      defaultModelId: "grok-4.5",
    }));
  });

  it("surfaces an actionable dual-remediation error instead of falling through to the key-requiring pi runtime when the Grok runtime is unavailable", async () => {
    vi.mocked(fusionCore.isGrokApiKeyFusionVisible).mockReturnValue(false);
    const pluginRunner = createMockPluginRunner({
      getRuntimeById: vi.fn().mockReturnValue(undefined),
    });

    /*
     * FNXC:GrokCliRouting 2026-07-09-23:05:
     * FN-7761 symptom reproduction: packaged hosts previously left fusion-plugin-grok-runtime uninstalled, so getRuntimeById("grok") was undefined and grok-cli/no-key sessions fell through to pi's direct endpoint. The fixed invariant forbids that silent fallback and tells operators to either enable the Grok CLI runtime or set GROK_API_KEY.
     */
    await expect(createResolvedAgentSession({
      sessionPurpose: "executor",
      pluginRunner,
      cwd: "/tmp/project",
      defaultProvider: "grok-cli",
      defaultModelId: "grok-4.5",
      systemPrompt: "no-runtime-registered",
    })).rejects.toThrow(/Install and enable the Grok CLI runtime plugin, or set GROK_API_KEY/);

    expect(mockCreateFnAgent).not.toHaveBeenCalled();
  });

  it("auto-routes heartbeat/room responder grok-cli defaults to the Grok runtime when no Fusion-visible key exists", async () => {
    vi.mocked(fusionCore.isGrokApiKeyFusionVisible).mockReturnValue(false);
    const grokRegistration = await createGrokRegistration();
    const pluginRunner = createMockPluginRunner({
      getRuntimeById: vi.fn().mockReturnValue(grokRegistration),
    });
    const audit = { database: vi.fn().mockResolvedValue(undefined) };

    const result = await createResolvedAgentSession({
      sessionPurpose: "heartbeat",
      pluginRunner,
      runAuditor: audit as never,
      cwd: "/tmp/project",
      defaultProvider: "grok-cli",
      defaultModelId: "grok-4.5",
      systemPrompt: "room-responder",
    });

    expect(result.runtimeId).toBe("grok");
    expect(result.wasConfigured).toBe(true);
    expect(result.session).toMatchObject({ model: "grok-4.5" });
    expect(audit.database).toHaveBeenCalledWith(expect.objectContaining({
      type: "session:runtime-resolved",
      target: "grok",
      metadata: expect.objectContaining({
        sessionPurpose: "heartbeat",
        runtimeHint: "grok",
        reason: "grok-cli-no-visible-key",
      }),
    }));
  });

  /*
  FNXC:GrokCliRouting 2026-07-22-15:10:
  A grok-cli FALLBACK behind a healthy non-grok primary must never preempt the primary.
  The old FN-7758 behavior routed the whole session onto the Grok CLI runtime and promoted
  the fallback model up front, so every planning session silently ran grok-4.5 instead of
  the configured primary. The fixed invariant: the primary stays on its own runtime with
  its configured model, the grok-cli pair is withheld from the primary runtime's options,
  and (when the Grok runtime plugin is available) it is DEFERRED — engaged on the Grok CLI
  runtime only after the primary actually fails with a retryable model error.
  */
  it("keeps the configured primary and defers a grok-cli fallback when no Fusion-visible key exists", async () => {
    vi.mocked(fusionCore.isGrokApiKeyFusionVisible).mockReturnValue(false);
    const grokRegistration = await createGrokRegistration();
    const getRuntimeById = vi.fn().mockReturnValue(grokRegistration);
    const pluginRunner = createMockPluginRunner({ getRuntimeById });
    const audit = { database: vi.fn().mockResolvedValue(undefined) };

    const result = await createResolvedAgentSession({
      sessionPurpose: "executor",
      pluginRunner,
      runAuditor: audit as never,
      cwd: "/tmp/project",
      defaultProvider: "openai",
      defaultModelId: "gpt-4o",
      fallbackProvider: "grok-cli",
      fallbackModelId: "grok-cli/grok-4.5",
      systemPrompt: "fallback-selection-only",
    });

    expect(result.runtimeId).toBe("pi");
    expect(mockCreateFnAgent).toHaveBeenCalledWith(expect.objectContaining({
      defaultProvider: "openai",
      defaultModelId: "gpt-4o",
      fallbackProvider: undefined,
      fallbackModelId: undefined,
    }));
    expect(audit.database).toHaveBeenCalledWith(expect.objectContaining({
      type: "session:runtime-resolved",
      target: "pi",
      metadata: expect.objectContaining({
        reason: "grok-cli-fallback-deferred-no-visible-key",
        grokCliFallbackDeferred: true,
        provider: "openai",
        modelId: "gpt-4o",
      }),
    }));
  });

  it("engages the deferred grok-cli fallback on the Grok CLI runtime when the primary fails retryably at prompt time", async () => {
    vi.mocked(fusionCore.isGrokApiKeyFusionVisible).mockReturnValue(false);
    const grokRegistration = await createGrokRegistration();
    const pluginRunner = createMockPluginRunner({
      getRuntimeById: vi.fn().mockReturnValue(grokRegistration),
    });
    const audit = { database: vi.fn().mockResolvedValue(undefined) };
    const onFallbackModelUsed = vi.fn().mockResolvedValue(undefined);
    const onText = vi.fn();

    const result = await createResolvedAgentSession({
      sessionPurpose: "triage",
      pluginRunner,
      runAuditor: audit as never,
      cwd: "/tmp/project",
      defaultProvider: "openai-codex",
      defaultModelId: "gpt-5.6-sol",
      fallbackProvider: "grok-cli",
      fallbackModelId: "grok-cli/grok-4.5",
      onFallbackModelUsed,
      onText,
      systemPrompt: "deferred-engagement",
    });

    expect(result.runtimeId).toBe("pi");

    // First prompt: primary fails retryably → wrapper swaps onto the Grok CLI runtime and replays.
    mockPiPromptWithFallback.mockRejectedValueOnce(new Error("429 Too Many Requests"));
    const promptable = result.session as unknown as {
      promptWithFallback: (prompt: string, options?: unknown) => Promise<unknown>;
    };
    await promptable.promptWithFallback("plan the task");

    expect(onText).toHaveBeenCalledWith("hi there");
    expect(onFallbackModelUsed).toHaveBeenCalledWith(expect.objectContaining({
      primaryModel: "openai-codex/gpt-5.6-sol",
      fallbackModel: "grok-cli/grok-4.5",
      triggerPoint: "prompt-time",
      failureCategory: "rate-limit",
    }));
    expect(audit.database).toHaveBeenCalledWith(expect.objectContaining({
      type: "session:grok-cli-fallback-engaged",
      target: "grok",
      metadata: expect.objectContaining({
        sessionPurpose: "triage",
        primaryProvider: "openai-codex",
        primaryModelId: "gpt-5.6-sol",
        fallbackModelId: "grok-4.5",
        failureCategory: "rate-limit",
      }),
    }));

    // Later prompts stay on the swapped Grok CLI session without re-touching pi.
    mockPiPromptWithFallback.mockClear();
    await promptable.promptWithFallback("continue planning");
    expect(mockPiPromptWithFallback).not.toHaveBeenCalled();
  });

  it("propagates non-retryable primary failures without engaging the deferred grok-cli fallback", async () => {
    vi.mocked(fusionCore.isGrokApiKeyFusionVisible).mockReturnValue(false);
    const grokRegistration = await createGrokRegistration();
    const pluginRunner = createMockPluginRunner({
      getRuntimeById: vi.fn().mockReturnValue(grokRegistration),
    });

    const result = await createResolvedAgentSession({
      sessionPurpose: "executor",
      pluginRunner,
      cwd: "/tmp/project",
      defaultProvider: "openai",
      defaultModelId: "gpt-4o",
      fallbackProvider: "grok-cli",
      fallbackModelId: "grok-4.5",
      systemPrompt: "non-retryable",
    });

    mockPiPromptWithFallback.mockRejectedValueOnce(new Error("tool schema validation failed"));
    const promptable = result.session as unknown as {
      promptWithFallback: (prompt: string, options?: unknown) => Promise<unknown>;
    };
    await expect(promptable.promptWithFallback("do work")).rejects.toThrow("tool schema validation failed");
  });

  it("drops a grok-cli fallback with an audit flag when the Grok runtime plugin is unavailable", async () => {
    vi.mocked(fusionCore.isGrokApiKeyFusionVisible).mockReturnValue(false);
    const pluginRunner = createMockPluginRunner({
      getRuntimeById: vi.fn().mockReturnValue(undefined),
    });
    const audit = { database: vi.fn().mockResolvedValue(undefined) };

    const result = await createResolvedAgentSession({
      sessionPurpose: "validation",
      pluginRunner,
      runAuditor: audit as never,
      cwd: "/tmp/project",
      defaultProvider: "anthropic",
      defaultModelId: "claude-sonnet-4-5",
      fallbackProvider: "grok-cli",
      fallbackModelId: "grok-4.5",
      systemPrompt: "fallback-bare-model",
    });

    expect(result.runtimeId).toBe("pi");
    expect(mockCreateFnAgent).toHaveBeenCalledWith(expect.objectContaining({
      defaultProvider: "anthropic",
      defaultModelId: "claude-sonnet-4-5",
      fallbackProvider: undefined,
      fallbackModelId: undefined,
    }));
    expect(audit.database).toHaveBeenCalledWith(expect.objectContaining({
      type: "session:runtime-resolved",
      metadata: expect.objectContaining({
        reason: "grok-cli-fallback-dropped-no-visible-key",
        grokCliFallbackDropped: true,
      }),
    }));
  });

  it("keeps a grok-cli fallback when a Fusion-visible key exists (pi can resolve it directly)", async () => {
    vi.mocked(fusionCore.isGrokApiKeyFusionVisible).mockReturnValue(true);
    const pluginRunner = createMockPluginRunner();

    const result = await createResolvedAgentSession({
      sessionPurpose: "executor",
      pluginRunner,
      cwd: "/tmp/project",
      defaultProvider: "openai",
      defaultModelId: "gpt-4o",
      fallbackProvider: "grok-cli",
      fallbackModelId: "grok-4.5",
      systemPrompt: "visible-key-fallback",
    });

    expect(result.runtimeId).toBe("pi");
    expect(mockCreateFnAgent).toHaveBeenCalledWith(expect.objectContaining({
      defaultProvider: "openai",
      defaultModelId: "gpt-4o",
      fallbackProvider: "grok-cli",
      fallbackModelId: "grok-4.5",
    }));
  });

  it("keeps mock/test-mode provider routing on the mock runtime when grok-cli fallback is configured", async () => {
    vi.mocked(fusionCore.isGrokApiKeyFusionVisible).mockReturnValue(false);
    const grokRegistration = await createGrokRegistration();
    const pluginRunner = createMockPluginRunner({
      getRuntimeById: vi.fn().mockReturnValue(grokRegistration),
    });

    const result = await createResolvedAgentSession({
      sessionPurpose: "executor",
      pluginRunner,
      cwd: "/tmp/project",
      defaultProvider: "mock",
      defaultModelId: "scripted",
      fallbackProvider: "grok-cli",
      fallbackModelId: "grok-4.5",
      systemPrompt: "mock-mode",
    });

    expect(result.runtimeId).toBe("mock");
    expect(result.wasConfigured).toBe(true);
    expect(pluginRunner.getRuntimeById).not.toHaveBeenCalledWith("grok");
    expect(mockCreateFnAgent).not.toHaveBeenCalled();
  });

  it("honors explicit runtime hints over the no-key grok-cli auto-derivation", async () => {
    vi.mocked(fusionCore.isGrokApiKeyFusionVisible).mockReturnValue(false);
    const grokRegistration = await createGrokRegistration();
    const getRuntimeById = vi.fn((runtimeId: string) => runtimeId === "grok" ? grokRegistration : undefined);
    const pluginRunner = createMockPluginRunner({ getRuntimeById });

    const result = await createResolvedAgentSession({
      sessionPurpose: "executor",
      runtimeHint: "pi",
      pluginRunner,
      cwd: "/tmp/project",
      defaultProvider: "grok-cli",
      defaultModelId: "grok-4.5",
      systemPrompt: "explicit-pi",
    });

    expect(result.runtimeId).toBe("pi");
    expect(result.wasConfigured).toBe(true);
    expect(getRuntimeById).not.toHaveBeenCalledWith("grok");
    expect(mockCreateFnAgent).toHaveBeenCalledWith(expect.objectContaining({
      defaultProvider: "grok-cli",
      defaultModelId: "grok-4.5",
    }));
  });

  it("does not crash and falls back to pi for an empty/undefined runtimeConfig", async () => {
    const pluginRunner = createMockPluginRunner();

    expect(extractRuntimeHint(undefined)).toBeUndefined();
    expect(extractRuntimeHint({})).toBeUndefined();
    expect(extractRuntimeHint({ runtimeHint: "" })).toBeUndefined();
    expect(extractRuntimeHint({ runtimeHint: 42 as unknown as string })).toBeUndefined();

    const result = await createResolvedAgentSession({
      sessionPurpose: "executor",
      runtimeHint: extractRuntimeHint({}),
      pluginRunner,
      cwd: "/tmp/project",
      systemPrompt: "empty-config",
    });

    expect(result.runtimeId).toBe("pi");
    expect(result.wasConfigured).toBe(false);
  });
});
