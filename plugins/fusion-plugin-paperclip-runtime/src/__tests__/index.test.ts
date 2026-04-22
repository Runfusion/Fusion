import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import plugin from "../index.js";
import { PaperclipRuntimeAdapter } from "../runtime-adapter.js";

// ── Test Suite ─────────────────────────────────────────────────────────────────

describe("paperclip-runtime plugin", () => {
  describe("plugin manifest identity", () => {
    it("should export a valid FusionPlugin with correct manifest fields", () => {
      expect(plugin.manifest.id).toBe("fusion-plugin-paperclip-runtime");
      expect(plugin.manifest.name).toBe("Paperclip Runtime Plugin");
      expect(plugin.manifest.version).toBe("1.0.0");
      expect(plugin.manifest.description).toBe(
        "Provides Paperclip runtime for Fusion AI agents",
      );
      expect(plugin.manifest.author).toBe("Fusion Team");
      expect(plugin.state).toBe("installed");
    });

    it("should have runtime manifest metadata matching manifest.json", () => {
      expect(plugin.manifest.runtime).toBeDefined();
      expect(plugin.manifest.runtime!.runtimeId).toBe("paperclip");
      expect(plugin.manifest.runtime!.name).toBe("Paperclip Runtime");
      expect(plugin.manifest.runtime!.version).toBe("1.0.0");
    });

    it("should have fusionVersion requirement", () => {
      expect(plugin.manifest.fusionVersion).toBe(">=0.1.0");
    });
  });

  describe("runtime registration", () => {
    it("should have runtime registration", () => {
      expect(plugin.runtime).toBeDefined();
    });

    it("should have correct runtime metadata", () => {
      const runtime = plugin.runtime!;
      expect(runtime.metadata.runtimeId).toBe("paperclip");
      expect(runtime.metadata.name).toBe("Paperclip Runtime");
      expect(runtime.metadata.description).toBe(
        "Paperclip-backed AI session using the user's configured pi provider and model",
      );
      expect(runtime.metadata.version).toBe("1.0.0");
    });

    it("should have a factory function", () => {
      expect(plugin.runtime!.factory).toBeDefined();
      expect(typeof plugin.runtime!.factory).toBe("function");
    });
  });

  describe("runtime factory invocation", () => {
    beforeEach(() => {
      // Mock @fusion/engine for createFnAgent
      vi.mock("@fusion/engine", () => ({
        createFnAgent: vi.fn().mockResolvedValue({ session: {} }),
        promptWithFallback: vi.fn(),
      }));
      // Mock describeModel
      vi.mock("../../engine/src/pi.js", () => ({
        describeModel: vi.fn().mockReturnValue("mock/model"),
      }));
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("should return a PaperclipRuntimeAdapter instance when factory is invoked", async () => {
      const runtime = await plugin.runtime!.factory({} as any);
      expect(runtime).toBeInstanceOf(PaperclipRuntimeAdapter);
    });

    it("should return an adapter with correct id and name", async () => {
      const runtime = await plugin.runtime!.factory({} as any);
      expect(runtime.id).toBe("paperclip");
      expect(runtime.name).toBe("Paperclip Runtime");
    });
  });

  describe("hooks", () => {
    it("should have onLoad hook", () => {
      expect(plugin.hooks.onLoad).toBeDefined();
      expect(typeof plugin.hooks.onLoad).toBe("function");
    });

    it("onLoad should not throw when called with valid context", () => {
      const mockLogger = {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
      };
      const mockCtx = {
        pluginId: "fusion-plugin-paperclip-runtime",
        settings: {},
        logger: mockLogger,
        emitEvent: () => {},
        taskStore: {},
      };

      expect(() => plugin.hooks.onLoad!(mockCtx as any)).not.toThrow();
    });

    it("onLoad should call logger.info", () => {
      const mockLogger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      };
      const mockCtx = {
        pluginId: "fusion-plugin-paperclip-runtime",
        settings: {},
        logger: mockLogger,
        emitEvent: () => {},
        taskStore: {},
      };

      plugin.hooks.onLoad!(mockCtx as any);

      expect(mockLogger.info).toHaveBeenCalledWith("Paperclip Runtime Plugin loaded");
    });
  });
});
