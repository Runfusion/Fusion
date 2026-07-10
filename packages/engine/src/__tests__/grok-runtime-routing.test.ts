import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginRunner } from "../plugin-runner.js";
import type { PluginRuntimeRegistration } from "@fusion/core";
import * as fusionCore from "@fusion/core";
import { resolveRuntime } from "../runtime-resolution.js";
import { createResolvedAgentSession, extractRuntimeHint } from "../agent-session-helpers.js";

/*
FNXC:GrokCli 2026-07-09-00:00:
FN-7725: end-to-end routing test for the decided wiring (option (a),
docs/grok-cli-contract.md "Wiring") — an agent's
`runtimeConfig.runtimeHint === "grok"` (as set by the dashboard's Runtime
Source -> Runtime picker) must resolve the REAL GrokRuntimeAdapter (FN-7722,
imported unmodified from the plugin package, not re-implemented/mocked here)
through the generic extractRuntimeHint -> resolveRuntime ->
resolvePluginRuntime -> plugin factory chain, and driving a prompt through
that resolved session must invoke onText from faked NDJSON `text` lines.
Uses the adapter's own injectable `spawn` seam (runtime-adapter.ts) — no
live `grok` binary, no real subprocess, no real network. Also asserts the
Surface Enumeration invariant: trigger OFF / unset / non-grok hints still
fall back to the default pi runtime unchanged, and an empty/undefined
runtimeConfig does not crash.
*/

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

function grokRuntimeAdapterModulePath(): string {
  return fileURLToPath(
    new URL("../../../../plugins/fusion-plugin-grok-runtime/src/runtime-adapter.ts", import.meta.url),
  );
}

type GrokRuntimeAdapterCtor = new (options?: {
  binary?: string;
  spawn?: (binary: string, prompt: string, options?: { cwd?: string; model?: string; signal?: AbortSignal }) => unknown;
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

/** Fake `GrokStreamProcess`: an EventEmitter + a writable PassThrough stdout, matching
 *  the shape runtime-adapter.ts's own fixture tests use (no live subprocess). */
function makeFakeGrokProcess(): { proc: unknown; stdout: PassThrough; kill: ReturnType<typeof vi.fn> } {
  const stdout = new PassThrough();
  const emitter = new EventEmitter();
  const kill = vi.fn();
  const proc = Object.assign(emitter, { stdout, kill });
  return { proc, stdout, kill };
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
  spawnFn: ReturnType<typeof vi.fn>,
): Promise<{ pluginId: string; runtime: PluginRuntimeRegistration }> {
  const GrokRuntimeAdapter = await loadGrokRuntimeAdapter();
  return {
    pluginId: "fusion-plugin-grok-runtime",
    runtime: {
      metadata: {
        runtimeId: "grok",
        name: "Grok Runtime",
        description: "Grok CLI runtime support for Fusion",
        version: "0.1.0",
      },
      factory: vi.fn().mockImplementation(async () => new GrokRuntimeAdapter({ spawn: spawnFn })),
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
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves the real GrokRuntimeAdapter via resolveRuntime when runtimeHint is 'grok'", async () => {
    const spawn = vi.fn().mockReturnValue(makeFakeGrokProcess().proc);
    const grokRegistration = await createGrokRegistration(spawn);
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

  it("createResolvedAgentSession routes an agent's runtimeConfig.runtimeHint through to GrokRuntimeAdapter and streams onText from faked NDJSON", async () => {
    const { proc, stdout } = makeFakeGrokProcess();
    const spawn = vi.fn().mockReturnValue(proc);
    const grokRegistration = await createGrokRegistration(spawn);
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

    // Drive the resolved session's promptWithFallback (attached by
    // createResolvedAgentSession) and feed faked NDJSON `text` lines through
    // the adapter's injected fake stdout — no live grok binary involved.
    const session = result.session as { promptWithFallback: (prompt: string) => Promise<void> };
    const promptPromise = session.promptWithFallback("hello grok");

    stdout.write(`${JSON.stringify({ type: "step_start", stepNumber: 1, timestamp: 1 })}\n`);
    stdout.write(`${JSON.stringify({ type: "text", stepNumber: 1, text: "hi ", timestamp: 2 })}\n`);
    stdout.write(`${JSON.stringify({ type: "text", stepNumber: 1, text: "there", timestamp: 3 })}\n`);
    stdout.write(
      `${JSON.stringify({ type: "step_finish", stepNumber: 1, timestamp: 4, finishReason: "stop", usage: {} })}\n`,
    );
    (proc as EventEmitter).emit("close", 0, null);

    await promptPromise;

    expect(spawn).toHaveBeenCalledWith("grok", "hello grok", expect.objectContaining({}));
    expect(onText.mock.calls.map((c) => c[0])).toEqual(["hi ", "there"]);
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
    expect(mockCreateFnAgent).toHaveBeenCalledWith({
      cwd: "/tmp/project",
      systemPrompt: "fallback",
    });
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
    const spawn = vi.fn().mockReturnValue(makeFakeGrokProcess().proc);
    const grokRegistration = await createGrokRegistration(spawn);
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
        modelId: "grok-cli/grok-4.5",
      }),
    }));
  });

  it("keeps grok-cli on the direct pi runtime when a Fusion-visible key exists", async () => {
    vi.mocked(fusionCore.isGrokApiKeyFusionVisible).mockReturnValue(true);
    const spawn = vi.fn().mockReturnValue(makeFakeGrokProcess().proc);
    const grokRegistration = await createGrokRegistration(spawn);
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

  it("keeps grok-cli on pi when no key is visible but the Grok runtime is not registered", async () => {
    vi.mocked(fusionCore.isGrokApiKeyFusionVisible).mockReturnValue(false);
    const pluginRunner = createMockPluginRunner({
      getRuntimeById: vi.fn().mockReturnValue(undefined),
    });

    const result = await createResolvedAgentSession({
      sessionPurpose: "executor",
      pluginRunner,
      cwd: "/tmp/project",
      defaultProvider: "grok-cli",
      defaultModelId: "grok-4.5",
      systemPrompt: "no-runtime-registered",
    });

    expect(result.runtimeId).toBe("pi");
    expect(result.wasConfigured).toBe(false);
    expect(mockCreateFnAgent).toHaveBeenCalledWith(expect.objectContaining({
      defaultProvider: "grok-cli",
      defaultModelId: "grok-4.5",
    }));
  });

  it("honors explicit runtime hints over the no-key grok-cli auto-derivation", async () => {
    vi.mocked(fusionCore.isGrokApiKeyFusionVisible).mockReturnValue(false);
    const spawn = vi.fn().mockReturnValue(makeFakeGrokProcess().proc);
    const grokRegistration = await createGrokRegistration(spawn);
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
