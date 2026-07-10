/**
 * Runtime Resolution Tests
 *
 * Tests for the runtime resolution system including:
 * - Default pi runtime selection
 * - Plugin runtime lookup by hint
 * - Fallback behavior when configured runtime is unavailable
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AgentRuntime, AgentRuntimeOptions, AgentSessionResult } from "../agent-runtime.js";
import {
  resolveRuntime,
  getDefaultPiRuntime,
  type RuntimeResolutionContext,
  type ResolvedRuntime,
} from "../runtime-resolution.js";
import type { PluginRunner } from "../plugin-runner.js";
import type { PluginRuntimeRegistration } from "@fusion/core";

// Mock the logger to suppress output during tests
vi.mock("../logger.js", () => ({
  createLogger: vi.fn(() => ({
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

// Mock pi.js to avoid actual session creation
vi.mock("../pi.js", () => ({
  createFnAgent: vi.fn().mockResolvedValue({
    session: {
      model: { provider: "anthropic", id: "claude-sonnet-4-5" },
      prompt: vi.fn(),
    },
    sessionFile: undefined,
  }),
  promptWithFallback: vi.fn().mockResolvedValue(undefined),
  describeModel: vi.fn().mockReturnValue("anthropic/claude-sonnet-4-5"),
}));

describe("runtime-resolution", () => {
  let mockPluginRunner: {
    getPluginRuntimes: ReturnType<typeof vi.fn>;
    getRuntimeById: ReturnType<typeof vi.fn>;
    createRuntimeContext: ReturnType<typeof vi.fn>;
  };

  const createMockPluginRuntime = (runtimeId: string, name: string): PluginRuntimeRegistration => ({
    metadata: {
      runtimeId,
      name,
      description: `Test runtime ${runtimeId}`,
      version: "1.0.0",
    },
    factory: vi.fn().mockResolvedValue({
      id: runtimeId,
      name,
      createSession: vi.fn().mockResolvedValue({
        session: { model: { provider: "test", id: "test-model" } },
      }),
      promptWithFallback: vi.fn(),
      describeModel: vi.fn().mockReturnValue("test/model"),
    }),
  });

  beforeEach(() => {
    mockPluginRunner = {
      getPluginRuntimes: vi.fn().mockReturnValue([]),
      getRuntimeById: vi.fn().mockReturnValue(undefined),
      createRuntimeContext: vi.fn().mockResolvedValue({
        pluginId: "test-plugin",
        taskStore: {},
        settings: {},
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        emitEvent: vi.fn(),
      }),
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("getDefaultPiRuntime()", () => {
    it("should return the same instance on multiple calls", () => {
      const runtime1 = getDefaultPiRuntime();
      const runtime2 = getDefaultPiRuntime();
      expect(runtime1).toBe(runtime2);
    });

    it("should have pi as the runtime id", () => {
      const runtime = getDefaultPiRuntime();
      expect(runtime.id).toBe("pi");
    });

    it("should have a human-readable name", () => {
      const runtime = getDefaultPiRuntime();
      expect(runtime.name).toBe("Default PI Runtime");
    });

    it("should implement createSession", () => {
      const runtime = getDefaultPiRuntime();
      expect(typeof runtime.createSession).toBe("function");
    });

    it("should implement promptWithFallback", () => {
      const runtime = getDefaultPiRuntime();
      expect(typeof runtime.promptWithFallback).toBe("function");
    });

    it("should implement describeModel", () => {
      const runtime = getDefaultPiRuntime();
      expect(typeof runtime.describeModel).toBe("function");
    });
  });

  describe("resolveRuntime()", () => {
    const createContext = (
      purpose: RuntimeResolutionContext["sessionPurpose"] = "executor",
      runtimeHint?: string,
    ): RuntimeResolutionContext => ({
      sessionPurpose: purpose,
      runtimeHint,
      pluginRunner: mockPluginRunner as unknown as PluginRunner,
    });

    describe("no runtime hint", () => {
      it("should return default pi runtime when hint is undefined", async () => {
        const context = createContext("executor", undefined);
        const result = await resolveRuntime(context);

        expect(result.runtimeId).toBe("pi");
        expect(result.wasConfigured).toBe(false);
        expect(result.runtime.id).toBe("pi");
      });

      it("should return default pi runtime when hint is empty string", async () => {
        const context = createContext("executor", "");
        const result = await resolveRuntime(context);

        expect(result.runtimeId).toBe("pi");
        expect(result.wasConfigured).toBe(false);
      });

      it("should return default pi runtime when hint is whitespace only", async () => {
        const context = createContext("executor", "   ");
        const result = await resolveRuntime(context);

        expect(result.runtimeId).toBe("pi");
        expect(result.wasConfigured).toBe(false);
      });

      it("should work for all session purposes without hint", async () => {
        const purposes: RuntimeResolutionContext["sessionPurpose"][] = [
          "executor",
          "triage",
          "reviewer",
          "merger",
          "heartbeat",
          "validation",
        ];

        for (const purpose of purposes) {
          const context = createContext(purpose, undefined);
          const result = await resolveRuntime(context);
          expect(result.runtimeId).toBe("pi");
        }
      });
    });

    describe("explicit pi hint", () => {
      it("should return pi runtime when hint is 'pi'", async () => {
        const context = createContext("executor", "pi");
        const result = await resolveRuntime(context);

        expect(result.runtimeId).toBe("pi");
        expect(result.wasConfigured).toBe(true);
      });

      it("should return pi runtime when hint is 'default'", async () => {
        const context = createContext("executor", "default");
        const result = await resolveRuntime(context);

        expect(result.runtimeId).toBe("pi");
        expect(result.wasConfigured).toBe(true);
      });
    });

    describe("plugin runtime lookup", () => {
      it("should return plugin runtime when hint matches existing runtime", async () => {
        const mockRuntime = createMockPluginRuntime("code-interpreter", "Code Interpreter Runtime");
        mockPluginRunner.getRuntimeById.mockReturnValue({
          pluginId: "test-plugin",
          runtime: mockRuntime,
        });

        const context = createContext("executor", "code-interpreter");
        const result = await resolveRuntime(context);

        expect(result.runtimeId).toBe("code-interpreter");
        expect(result.wasConfigured).toBe(true);
        expect(result.runtime.id).toBe("code-interpreter");
      });

      it("should create runtime context when resolving plugin runtime", async () => {
        const mockRuntime = createMockPluginRuntime("web-search", "Web Search Runtime");
        mockPluginRunner.getRuntimeById.mockReturnValue({
          pluginId: "web-plugin",
          runtime: mockRuntime,
        });

        const context = createContext("executor", "web-search");
        await resolveRuntime(context);

        expect(mockPluginRunner.createRuntimeContext).toHaveBeenCalledWith("web-plugin");
      });

      it("should call the plugin runtime factory", async () => {
        const mockRuntime = createMockPluginRuntime("custom", "Custom Runtime");
        mockPluginRunner.getRuntimeById.mockReturnValue({
          pluginId: "custom-plugin",
          runtime: mockRuntime,
        });

        const context = createContext("executor", "custom");
        await resolveRuntime(context);

        expect(mockRuntime.factory).toHaveBeenCalled();
      });

      it("should find runtime by ID when multiple plugins have runtimes", async () => {
        const mockRuntime = createMockPluginRuntime("unique-id", "First Runtime");
        // getRuntimeById returns the first match
        mockPluginRunner.getRuntimeById.mockReturnValue({
          pluginId: "plugin-1",
          runtime: mockRuntime,
        });

        const context = createContext("executor", "unique-id");
        const result = await resolveRuntime(context);

        // Should return the matching runtime
        expect(result.runtime.id).toBe("unique-id");
      });

      it("should resolve the openclaw runtime when registered", async () => {
        const openclawRuntime = createMockPluginRuntime("openclaw", "OpenClaw Runtime");
        mockPluginRunner.getRuntimeById.mockReturnValue({
          pluginId: "fusion-plugin-openclaw-runtime",
          runtime: openclawRuntime,
        });

        const result = await resolveRuntime(createContext("executor", "openclaw"));

        expect(result.runtimeId).toBe("openclaw");
        expect(result.wasConfigured).toBe(true);
      });
    });

    describe("fallback behavior", () => {
      it("should fall back to pi when runtime hint references non-existent runtime", async () => {
        // getRuntimeById returns undefined for non-existent runtime
        mockPluginRunner.getRuntimeById.mockReturnValue(undefined);

        const context = createContext("executor", "non-existent");
        const result = await resolveRuntime(context);

        expect(result.runtimeId).toBe("pi");
        expect(result.wasConfigured).toBe(false);
        expect(result.fallbackReason).toBe("not_found");
      });

      it("should fall back to pi when openclaw runtime is not registered", async () => {
        mockPluginRunner.getRuntimeById.mockReturnValue(undefined);

        const result = await resolveRuntime(createContext("executor", "openclaw"));

        expect(result.runtimeId).toBe("pi");
        expect(result.wasConfigured).toBe(false);
        expect(result.fallbackReason).toBe("not_found");
      });

      it("should fall back to pi when runtime factory throws", async () => {
        const mockRuntime: PluginRuntimeRegistration = {
          metadata: {
            runtimeId: "broken",
            name: "Broken Runtime",
          },
          factory: vi.fn().mockRejectedValue(new Error("Factory failed")),
        };
        mockPluginRunner.getRuntimeById.mockReturnValue({
          pluginId: "broken-plugin",
          runtime: mockRuntime,
        });

        const context = createContext("executor", "broken");
        const result = await resolveRuntime(context);

        expect(result.runtimeId).toBe("pi");
        expect(result.wasConfigured).toBe(false);
        expect(result.fallbackReason).toBe("factory_error");
      });

      it("should fall back to pi when runtime factory returns null", async () => {
        const mockRuntime: PluginRuntimeRegistration = {
          metadata: {
            runtimeId: "null-return",
            name: "Null Return Runtime",
          },
          factory: vi.fn().mockResolvedValue(null),
        };
        mockPluginRunner.getRuntimeById.mockReturnValue({
          pluginId: "null-plugin",
          runtime: mockRuntime,
        });

        const context = createContext("executor", "null-return");
        const result = await resolveRuntime(context);

        expect(result.runtimeId).toBe("pi");
        expect(result.wasConfigured).toBe(false);
        expect(result.fallbackReason).toBe("factory_error");
      });

      it("should fall back to pi with reason 'init_error' when createRuntimeContext returns null", async () => {
        // Registration is found (getRuntimeById succeeds) but the plugin fails to
        // produce a usable context -- this is an initialization failure, distinct
        // from a registration that was never found in the first place.
        mockPluginRunner.createRuntimeContext.mockResolvedValue(null);
        const mockRuntime = createMockPluginRuntime("orphan", "Orphan Runtime");
        mockPluginRunner.getRuntimeById.mockReturnValue({
          pluginId: "orphan-plugin",
          runtime: mockRuntime,
        });

        const context = createContext("executor", "orphan");
        const result = await resolveRuntime(context);

        expect(result.runtimeId).toBe("pi");
        expect(result.wasConfigured).toBe(false);
        expect(result.fallbackReason).toBe("init_error");
      });

      it("should report reason 'not_found' distinct from 'factory_error' across the two hint failure modes", async () => {
        // not_found: no registration at all
        mockPluginRunner.getRuntimeById.mockReturnValueOnce(undefined);
        const notFoundResult = await resolveRuntime(createContext("executor", "missing-plugin"));
        expect(notFoundResult.fallbackReason).toBe("not_found");

        // factory_error: registration exists but factory throws during instantiation
        const throwingRuntime: PluginRuntimeRegistration = {
          metadata: { runtimeId: "throws", name: "Throwing Runtime" },
          factory: vi.fn().mockRejectedValue(new Error("boom")),
        };
        mockPluginRunner.getRuntimeById.mockReturnValueOnce({
          pluginId: "throwing-plugin",
          runtime: throwingRuntime,
        });
        const factoryErrorResult = await resolveRuntime(createContext("executor", "throws"));
        expect(factoryErrorResult.fallbackReason).toBe("factory_error");

        expect(notFoundResult.fallbackReason).not.toBe(factoryErrorResult.fallbackReason);
      });

      it("should distinguish all three reachable FallbackReason values: not_found, init_error, factory_error", async () => {
        // not_found: registration never existed for the requested runtimeId.
        mockPluginRunner.getRuntimeById.mockReturnValueOnce(undefined);
        const notFoundResult = await resolveRuntime(createContext("executor", "never-registered"));
        expect(notFoundResult.fallbackReason).toBe("not_found");

        // init_error: registration exists but the plugin fails to initialize a context.
        mockPluginRunner.createRuntimeContext.mockResolvedValueOnce(null);
        const initErrorRuntime = createMockPluginRuntime("uninitializable", "Uninitializable Runtime");
        mockPluginRunner.getRuntimeById.mockReturnValueOnce({
          pluginId: "uninitializable-plugin",
          runtime: initErrorRuntime,
        });
        const initErrorResult = await resolveRuntime(createContext("executor", "uninitializable"));
        expect(initErrorResult.fallbackReason).toBe("init_error");

        // factory_error: registration exists, context initializes, but the factory itself fails.
        const factoryErrorRuntime: PluginRuntimeRegistration = {
          metadata: { runtimeId: "factory-broken", name: "Factory Broken Runtime" },
          factory: vi.fn().mockRejectedValue(new Error("factory boom")),
        };
        mockPluginRunner.getRuntimeById.mockReturnValueOnce({
          pluginId: "factory-broken-plugin",
          runtime: factoryErrorRuntime,
        });
        const factoryErrorResult = await resolveRuntime(createContext("executor", "factory-broken"));
        expect(factoryErrorResult.fallbackReason).toBe("factory_error");

        // All three reasons must be pairwise distinct so a regression collapsing
        // any two of them back together fails this assertion.
        const reasons = [notFoundResult.fallbackReason, initErrorResult.fallbackReason, factoryErrorResult.fallbackReason];
        expect(new Set(reasons).size).toBe(3);
      });
    });
  });

  describe("AgentRuntime interface compliance", () => {
    it("default pi runtime should implement all required interface methods", () => {
      const runtime = getDefaultPiRuntime();

      // Check required properties
      expect(typeof runtime.id).toBe("string");
      expect(typeof runtime.name).toBe("string");

      // Check required methods
      expect(typeof runtime.createSession).toBe("function");
      expect(typeof runtime.promptWithFallback).toBe("function");
      expect(typeof runtime.describeModel).toBe("function");
    });
  });
});
