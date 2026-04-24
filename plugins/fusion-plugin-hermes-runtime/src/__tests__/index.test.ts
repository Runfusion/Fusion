import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockCreateFnAgent, mockPromptWithFallback, mockDescribeModel } = vi.hoisted(() => ({
  mockCreateFnAgent: vi.fn(),
  mockPromptWithFallback: vi.fn(),
  mockDescribeModel: vi.fn().mockReturnValue("unknown model"),
}));

vi.mock("../pi-module.js", () => ({
  createFnAgent: mockCreateFnAgent,
  promptWithFallback: mockPromptWithFallback,
  describeModel: mockDescribeModel,
}));

import plugin, { hermesRuntimeMetadata, hermesRuntimeFactory, HERMES_RUNTIME_ID } from "../index.js";
import { HermesRuntimeAdapter } from "../runtime-adapter.js";

interface MockLogger {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
}

interface MockContext {
  pluginId: string;
  settings: Record<string, unknown>;
  logger: MockLogger;
  emitEvent: ReturnType<typeof vi.fn>;
  taskStore: {
    getTask: ReturnType<typeof vi.fn>;
  };
}

function createMockContext(overrides: Partial<MockContext> = {}): MockContext {
  return {
    pluginId: "fusion-plugin-hermes-runtime",
    settings: {},
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    emitEvent: vi.fn(),
    taskStore: {
      getTask: vi.fn(),
    },
    ...overrides,
  };
}

describe("hermes-runtime plugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("plugin manifest identity", () => {
    it("should have correct manifest fields", () => {
      expect(plugin.manifest.id).toBe("fusion-plugin-hermes-runtime");
      expect(plugin.manifest.name).toBe("Hermes Runtime Plugin");
      expect(plugin.manifest.version).toBe("0.1.0");
      expect(plugin.manifest.description).toContain("Hermes");
      expect(plugin.manifest.author).toBe("Fusion Team");
      expect(plugin.state).toBe("installed");
    });
  });

  describe("runtime registration", () => {
    it("should register hermes runtime metadata", () => {
      expect(plugin.runtime).toBeDefined();
      expect(plugin.runtime?.metadata.runtimeId).toBe(HERMES_RUNTIME_ID);
      expect(plugin.runtime?.metadata.name).toBe("Hermes Runtime");
      expect(plugin.runtime?.metadata.description).toContain("Hermes-backed AI session");
      expect(plugin.runtime?.metadata.version).toBe("0.1.0");
    });

    it("should have consistent runtime metadata between export and manifest", () => {
      expect(plugin.manifest.runtime).toEqual(hermesRuntimeMetadata);
      expect(plugin.runtime?.metadata).toEqual(hermesRuntimeMetadata);
    });
  });

  describe("hooks", () => {
    it("onLoad should log startup message and emit loaded event", async () => {
      const ctx = createMockContext();
      await plugin.hooks.onLoad?.(ctx as any);

      expect(ctx.logger.info).toHaveBeenCalledWith("Hermes Runtime Plugin loaded");
      expect(ctx.emitEvent).toHaveBeenCalledWith("hermes-runtime:loaded", {
        runtimeId: HERMES_RUNTIME_ID,
        version: "0.1.0",
      });
    });

    it("onUnload should not throw", () => {
      expect(() => plugin.hooks.onUnload?.()).not.toThrow();
    });
  });

  describe("runtime factory behavior", () => {
    it("should export runtime constants", () => {
      expect(HERMES_RUNTIME_ID).toBe("hermes");
      expect(hermesRuntimeMetadata.runtimeId).toBe("hermes");
      expect(typeof hermesRuntimeFactory).toBe("function");
    });

    it("runtime factory should return executable runtime adapter", async () => {
      const runtime = (await hermesRuntimeFactory(createMockContext() as any)) as HermesRuntimeAdapter;

      expect(runtime).toBeInstanceOf(HermesRuntimeAdapter);
      expect(runtime.id).toBe("hermes");
      expect(runtime.name).toBe("Hermes Runtime");
      expect(runtime).not.toHaveProperty("status");
      expect(runtime).not.toHaveProperty("execute");
    });

    it("factory creation should not throw", async () => {
      await expect(hermesRuntimeFactory(createMockContext() as any)).resolves.toBeInstanceOf(
        HermesRuntimeAdapter,
      );
    });
  });
});
