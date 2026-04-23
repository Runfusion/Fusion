/**
 * Hermes Runtime Plugin Tests
 *
 * Tests verify:
 * - Plugin manifest identity
 * - Runtime registration presence
 * - Deferred-implementation behavior
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import plugin, { hermesRuntimeMetadata, hermesRuntimeFactory, HERMES_RUNTIME_ID } from "../index.js";

// ── Mock Context ───────────────────────────────────────────────────────────────

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

// ── Test Suite ─────────────────────────────────────────────────────────────────

describe("hermes-runtime plugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("plugin manifest identity", () => {
    it("should have correct manifest id", () => {
      expect(plugin.manifest.id).toBe("fusion-plugin-hermes-runtime");
    });

    it("should have correct manifest name", () => {
      expect(plugin.manifest.name).toBe("Hermes Runtime Plugin");
    });

    it("should have correct version", () => {
      expect(plugin.manifest.version).toBe("0.1.0");
    });

    it("should have description", () => {
      expect(plugin.manifest.description).toBeDefined();
      expect(plugin.manifest.description).toContain("Hermes");
    });

    it("should have author", () => {
      expect(plugin.manifest.author).toBe("Fusion Team");
    });

    it("should have homepage", () => {
      expect(plugin.manifest.homepage).toBe("https://github.com/gsxdsm/fusion");
    });

    it("should have state 'installed'", () => {
      expect(plugin.state).toBe("installed");
    });
  });

  describe("runtime registration", () => {
    it("should have runtime registration", () => {
      expect(plugin.runtime).toBeDefined();
    });

    it("should have correct runtime metadata", () => {
      expect(plugin.runtime?.metadata).toBeDefined();
      expect(plugin.runtime?.metadata.runtimeId).toBe(HERMES_RUNTIME_ID);
      expect(plugin.runtime?.metadata.name).toBe("Hermes Runtime");
      expect(plugin.runtime?.metadata.description).toContain("deferred to FN-2264");
      expect(plugin.runtime?.metadata.version).toBe("0.1.0");
    });

    it("should have runtime factory function", () => {
      expect(plugin.runtime?.factory).toBeDefined();
      expect(typeof plugin.runtime?.factory).toBe("function");
    });

    it("should have consistent runtime metadata between export and manifest", () => {
      expect(plugin.manifest.runtime).toBeDefined();
      expect(plugin.manifest.runtime?.runtimeId).toBe(hermesRuntimeMetadata.runtimeId);
      expect(plugin.manifest.runtime?.name).toBe(hermesRuntimeMetadata.name);
      expect(plugin.manifest.runtime?.version).toBe(hermesRuntimeMetadata.version);
    });
  });

  describe("hooks", () => {
    it("should have onLoad hook", () => {
      expect(plugin.hooks.onLoad).toBeDefined();
      expect(typeof plugin.hooks.onLoad).toBe("function");
    });

    it("should have onUnload hook", () => {
      expect(plugin.hooks.onUnload).toBeDefined();
      expect(typeof plugin.hooks.onUnload).toBe("function");
    });

    it("onLoad should log startup message", async () => {
      const ctx = createMockContext();
      await plugin.hooks.onLoad?.(ctx as any);
      expect(ctx.logger.info).toHaveBeenCalledWith(
        expect.stringContaining("Hermes Runtime Plugin loaded"),
      );
    });

    it("onLoad should emit loaded event", async () => {
      const ctx = createMockContext();
      await plugin.hooks.onLoad?.(ctx as any);
      expect(ctx.emitEvent).toHaveBeenCalledWith("hermes-runtime:loaded", {
        runtimeId: HERMES_RUNTIME_ID,
        version: "0.1.0",
        status: "deferred",
      });
    });

    it("onUnload should not throw", () => {
      expect(plugin.hooks.onUnload).toBeDefined();
      expect(() => plugin.hooks.onUnload?.()).not.toThrow();
    });
  });

  describe("deferred implementation behavior", () => {
    it("should export hermesRuntimeMetadata", () => {
      expect(hermesRuntimeMetadata).toBeDefined();
      expect(hermesRuntimeMetadata.runtimeId).toBe("hermes");
      expect(hermesRuntimeMetadata.name).toBe("Hermes Runtime");
    });

    it("should export hermesRuntimeFactory", () => {
      expect(hermesRuntimeFactory).toBeDefined();
      expect(typeof hermesRuntimeFactory).toBe("function");
    });

    it("should export HERMES_RUNTIME_ID constant", () => {
      expect(HERMES_RUNTIME_ID).toBe("hermes");
    });

    it("runtime factory should return placeholder object", () => {
      const ctx = createMockContext();
      const runtime = hermesRuntimeFactory(ctx as any) as Record<string, unknown>;

      expect(runtime).toBeDefined();
      expect(runtime).toHaveProperty("runtimeId", HERMES_RUNTIME_ID);
      expect(runtime).toHaveProperty("version", "0.1.0");
      expect(runtime).toHaveProperty("status", "deferred");
      expect(runtime).toHaveProperty("message");
      expect(runtime.message).toContain("FN-2264");
    });

    it("runtime factory execute should throw error referencing FN-2264", async () => {
      const ctx = createMockContext();
      const runtime = hermesRuntimeFactory(ctx as any) as { execute: () => Promise<never> };

      await expect(runtime.execute()).rejects.toThrow("FN-2264");
      await expect(runtime.execute()).rejects.toThrow("not yet implemented");
    });

    it("runtime factory should not throw during creation (only on execute)", () => {
      const ctx = createMockContext();
      expect(() => hermesRuntimeFactory(ctx as any)).not.toThrow();
    });
  });

  describe("manifest consistency", () => {
    it("plugin.manifest.runtime matches hermesRuntimeMetadata", () => {
      expect(plugin.manifest.runtime).toEqual(hermesRuntimeMetadata);
    });

    it("plugin.runtime.metadata matches hermesRuntimeMetadata", () => {
      expect(plugin.runtime?.metadata).toEqual(hermesRuntimeMetadata);
    });

    it("manifest.json fields match plugin manifest", () => {
      // These should match the manifest.json file
      expect(plugin.manifest.id).toBe("fusion-plugin-hermes-runtime");
      expect(plugin.manifest.name).toBe("Hermes Runtime Plugin");
      expect(plugin.manifest.version).toBe("0.1.0");
    });
  });
});
