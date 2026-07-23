import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "@fusion/core";
import * as fusionCore from "@fusion/core";
import { createResolvedAgentSession } from "../agents/agent-session-helpers.js";
import { makePrResponseAgentRunner } from "../merge/pr-response-run-ops.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/*
FNXC:GrokCliRouting 2026-07-15-09:45:
Auto-merge was failing with "Grok CLI models require the bundled Grok CLI runtime" while dashboard chat worked, because project-engine's runAiMerge options omitted pluginRunner. ChatManager already receives engine.getPluginRunner(); the merge door must forward the same runner so createResolvedAgentSession can resolve getRuntimeById("grok") for grok-cli/no-key selections.

FNXC:GrokCliRouting 2026-07-15-09:58:
Session-advisor and PR-response createResolvedAgentSession paths must also forward PluginRunner so grok-cli/no-key selections resolve via getRuntimeById("grok") instead of dual-remediation error or pi fallthrough.
*/

/** Stub PluginRunner that serves a grok plugin runtime for wiring assertions. */
function makeGrokPluginRunnerStub() {
  const createSession = vi.fn().mockResolvedValue({
    session: {
      model: "grok-4.5",
      messages: [],
      dispose: vi.fn(),
    },
  });
  const grokRuntime = {
    id: "grok",
    name: "Grok Runtime",
    createSession,
    promptWithFallback: vi.fn(),
    describeModel: vi.fn(() => "grok/grok-4.5"),
  };
  const registration = {
    pluginId: "fusion-plugin-grok-runtime",
    runtime: {
      metadata: { runtimeId: "grok", name: "Grok Runtime" },
      factory: vi.fn().mockResolvedValue(grokRuntime),
    },
  };
  const pluginRunner = {
    getPluginRuntimes: vi.fn().mockReturnValue([registration]),
    getRuntimeById: vi.fn().mockReturnValue(registration),
    createRuntimeContext: vi.fn().mockResolvedValue({
      pluginId: "fusion-plugin-grok-runtime",
      taskStore: {},
      settings: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      emitEvent: vi.fn(),
    }),
  };
  return { pluginRunner, createSession };
}

describe("AI merge PluginRunner wiring for Grok CLI", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("project-engine merge door forwards this.getPluginRunner() into mergerOptions", () => {
    const source = readFileSync(resolve(__dirname, "../project-engine.ts"), "utf8");
    const optionsIndex = source.indexOf("const mergerOptions = {");
    const pluginRunnerIndex = source.indexOf("pluginRunner: this.getPluginRunner()", optionsIndex);
    const runAiMergeIndex = source.indexOf("return runAiMerge(store, cwd, taskId, mergeOptionsWithSettings)", optionsIndex);

    expect(optionsIndex).toBeGreaterThanOrEqual(0);
    expect(pluginRunnerIndex).toBeGreaterThan(optionsIndex);
    expect(runAiMergeIndex).toBeGreaterThan(pluginRunnerIndex);
  });

  it("createResolvedAgentSession routes merger grok-cli selections through the provided PluginRunner", async () => {
    vi.spyOn(fusionCore, "isGrokApiKeyFusionVisible").mockReturnValue(false);

    const { pluginRunner, createSession } = makeGrokPluginRunnerStub();

    const result = await createResolvedAgentSession({
      sessionPurpose: "merger",
      pluginRunner: pluginRunner as never,
      cwd: "/tmp/project",
      defaultProvider: "grok-cli",
      defaultModelId: "grok-4.5",
      systemPrompt: "merge",
    });

    expect(pluginRunner.getRuntimeById).toHaveBeenCalledWith("grok");
    expect(result.runtimeId).toBe("grok");
    expect(createSession).toHaveBeenCalled();
  });

  it("throws the dual-remediation error for merger grok-cli when pluginRunner is omitted", async () => {
    vi.spyOn(fusionCore, "isGrokApiKeyFusionVisible").mockReturnValue(false);

    await expect(createResolvedAgentSession({
      sessionPurpose: "merger",
      // Intentionally omit pluginRunner — the pre-fix auto-merge wiring bug.
      cwd: "/tmp/project",
      defaultProvider: "grok-cli",
      defaultModelId: "grok-4.5",
      systemPrompt: "merge",
    })).rejects.toThrow(/Install and enable the Grok CLI runtime plugin, or set GROK_API_KEY/);
  });
});

describe("Session advisor + PR response PluginRunner wiring for Grok CLI", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("project-engine session advisor forwards pluginRunner: this.getPluginRunner()", () => {
    const source = readFileSync(resolve(__dirname, "../project-engine.ts"), "utf8");
    // Anchor on the session-advisor agentFactory complete() createResolvedAgentSession call.
    const advisorAnchor = source.indexOf("session advisor complete failed");
    // Search backwards from the warn log for the createResolvedAgentSession block.
    const sessionCreateIndex = source.lastIndexOf("createResolvedAgentSession({", advisorAnchor);
    const pluginRunnerIndex = source.indexOf("pluginRunner: this.getPluginRunner()", sessionCreateIndex);
    const nextCreateIndex = source.indexOf("createResolvedAgentSession({", sessionCreateIndex + 1);

    expect(sessionCreateIndex).toBeGreaterThanOrEqual(0);
    expect(pluginRunnerIndex).toBeGreaterThan(sessionCreateIndex);
    // The pluginRunner must land inside this advisor createResolvedAgentSession call.
    if (nextCreateIndex >= 0) {
      expect(pluginRunnerIndex).toBeLessThan(nextCreateIndex);
    }
  });

  it("makePrResponseAgentRunner forwards pluginRunner into createResolvedAgentSession", () => {
    const source = readFileSync(resolve(__dirname, "../pr-response-run-ops.ts"), "utf8");
    const fnIndex = source.indexOf("export function makePrResponseAgentRunner(");
    const createIndex = source.indexOf("createResolvedAgentSession({", fnIndex);
    const pluginRunnerParamIndex = source.indexOf("pluginRunner?:", fnIndex);
    const pluginRunnerArgIndex = source.indexOf("pluginRunner,", createIndex);
    const nextFnIndex = source.indexOf("export function", fnIndex + 1);

    expect(fnIndex).toBeGreaterThanOrEqual(0);
    expect(pluginRunnerParamIndex).toBeGreaterThan(fnIndex);
    expect(createIndex).toBeGreaterThan(fnIndex);
    expect(pluginRunnerArgIndex).toBeGreaterThan(createIndex);
    if (nextFnIndex >= 0) {
      expect(pluginRunnerArgIndex).toBeLessThan(nextFnIndex);
    }
  });

  it("buildPrNodeDeps / in-process-runtime thread pluginRunner into PR respond", () => {
    const prNodes = readFileSync(resolve(__dirname, "../pr-nodes.ts"), "utf8");
    const runtime = readFileSync(resolve(__dirname, "../runtimes/in-process-runtime.ts"), "utf8");

    expect(prNodes).toMatch(/buildRespondCallback\([\s\S]*pluginRunner/);
    expect(prNodes).toMatch(/makePrResponseAgentRunner\([\s\S]*pluginRunner\)/);
    expect(prNodes).toMatch(/export function buildPrNodeDeps\([\s\S]*pluginRunner\?:/);
    expect(runtime).toMatch(/buildPrNodeDeps\(\(\) => this\.taskStore, prNodeGithubOps, this\.pluginRunner\)/);
  });

  it("makePrResponseAgentRunner with stub PluginRunner + grok-cli resolves runtime id grok", async () => {
    vi.spyOn(fusionCore, "isGrokApiKeyFusionVisible").mockReturnValue(false);

    // Keep the post-session prompt path inert so the test only asserts runtime routing.
    const pi = await import("../pi.js");
    const usageLimit = await import("../errors/usage-limit-detector.js");
    vi.spyOn(pi, "promptWithFallback").mockResolvedValue(undefined as never);
    vi.spyOn(usageLimit, "checkSessionError").mockReturnValue(undefined as never);

    const { pluginRunner, createSession } = makeGrokPluginRunnerStub();
    const settings = {
      mergerProvider: "grok-cli",
      mergerModelId: "grok-4.5",
      defaultProvider: "grok-cli",
      defaultModelId: "grok-4.5",
    } as Settings;

    const runAgent = makePrResponseAgentRunner(
      settings,
      "FN-test",
      "/tmp/fusion-pr-response",
      undefined,
      pluginRunner as never,
    );
    await runAgent({
      prompt: "Resolve review threads",
      systemPrompt: "System",
      threads: [{ id: "thread-1" }],
    });

    expect(pluginRunner.getRuntimeById).toHaveBeenCalledWith("grok");
    expect(createSession).toHaveBeenCalled();
  });
});
