import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import plugin, { classifyText } from "../index.js";

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
    pluginId: "fusion-plugin-auto-label",
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

describe("auto-label plugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("plugin export", () => {
    it("should export a valid FusionPlugin with correct manifest fields", () => {
      expect(plugin.manifest.id).toBe("fusion-plugin-auto-label");
      expect(plugin.manifest.name).toBe("Auto-Label Plugin");
      expect(plugin.manifest.version).toBe("0.1.0");
      expect(plugin.state).toBe("installed");
    });

    it("should have tools array with auto_label_classify tool", () => {
      expect(plugin.tools).toBeDefined();
      expect(plugin.tools!.length).toBe(1);
      expect(plugin.tools![0].name).toBe("auto_label_classify");
    });

    it("should have onLoad and onTaskCreated hooks", () => {
      expect(plugin.hooks.onLoad).toBeDefined();
      expect(plugin.hooks.onTaskCreated).toBeDefined();
    });
  });

  describe("classifyText function", () => {
    it('should classify "Fix the login bug" as bug', () => {
      const labels = classifyText("Fix the login bug");
      expect(labels).toContain("bug");
    });

    it('should classify "Add new feature for search" as feature', () => {
      const labels = classifyText("Add new feature for search");
      expect(labels).toContain("feature");
    });

    it("should not return duplicate labels", () => {
      const labels = classifyText("Fix the bug with the error and crash");
      // Should contain bug but not multiple times
      expect(labels.filter((l) => l === "bug").length).toBe(1);
    });

    it("should return multiple labels when text matches multiple categories", () => {
      const labels = classifyText(
        "Refactor and add tests for the broken parser",
      );
      expect(labels).toContain("refactor");
      expect(labels).toContain("testing");
      expect(labels).toContain("bug");
    });

    it("should return empty array when no keywords match", () => {
      const labels = classifyText("Update the color scheme");
      expect(labels).toEqual([]);
    });

    it("should match keywords case-insensitively", () => {
      expect(classifyText("BUG in the code")).toContain("bug");
      expect(classifyText("ADD new feature")).toContain("feature");
      expect(classifyText("PERFORMANCE optimization")).toContain("performance");
    });

    it("should match keywords with word boundaries", () => {
      // "add" should match in "Add new feature" but not in "address"
      expect(classifyText("Add new feature")).toContain("feature");
      expect(classifyText("Add to cart")).toContain("feature");

      // "spec" should match in "Add test spec" but not in "specific"
      expect(classifyText("Add test spec")).toContain("testing");
    });

    it("should handle empty string", () => {
      const labels = classifyText("");
      expect(labels).toEqual([]);
    });

    it("should handle string with special characters", () => {
      const labels = classifyText("Fix bug: app crashes on startup (error!)");
      expect(labels).toContain("bug");
    });
  });

  describe("hooks.onLoad", () => {
    it("should log startup message with category count", async () => {
      const ctx = createMockContext();
      await plugin.hooks.onLoad?.(ctx as any);
      expect(ctx.logger.info).toHaveBeenCalledWith(
        expect.stringContaining("Auto-Label plugin loaded"),
      );
      expect(ctx.logger.info).toHaveBeenCalledWith(
        expect.stringContaining("6 category rules"),
      );
    });
  });

  describe("hooks.onTaskCreated", () => {
    it("should run without error on a mock task", async () => {
      const ctx = createMockContext();
      const mockTask = {
        id: "FN-001",
        title: "Test Task",
        description: "Fix the login bug",
        column: "triage" as const,
        dependencies: [],
        steps: [],
        currentStep: 0,
        size: "M" as const,
        reviewLevel: "full" as const,
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
      };

      await expect(
        plugin.hooks.onTaskCreated?.(mockTask as any, ctx as any),
      ).resolves.not.toThrow();
    });

    it("should call emitEvent with labels when task matches categories", async () => {
      const ctx = createMockContext();
      const mockTask = {
        id: "FN-001",
        title: "Test Task",
        description: "Fix the login bug",
        column: "triage" as const,
        dependencies: [],
        steps: [],
        currentStep: 0,
        size: "M" as const,
        reviewLevel: "full" as const,
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
      };

      await plugin.hooks.onTaskCreated?.(mockTask as any, ctx as any);

      expect(ctx.emitEvent).toHaveBeenCalledWith("auto-label:classified", {
        taskId: "FN-001",
        labels: expect.arrayContaining(["bug"]),
      });
    });

    it("should not call emitEvent when task does not match any categories", async () => {
      const ctx = createMockContext();
      const mockTask = {
        id: "FN-002",
        title: "Test Task",
        description: "Update the color scheme",
        column: "triage" as const,
        dependencies: [],
        steps: [],
        currentStep: 0,
        size: "M" as const,
        reviewLevel: "full" as const,
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
      };

      await plugin.hooks.onTaskCreated?.(mockTask as any, ctx as any);

      expect(ctx.emitEvent).not.toHaveBeenCalled();
      expect(ctx.logger.info).toHaveBeenCalledWith(
        expect.stringContaining("did not match any categories"),
      );
    });

    it("should emit multiple labels when task matches multiple categories", async () => {
      const ctx = createMockContext();
      const mockTask = {
        id: "FN-003",
        title: "Test Task",
        description: "Refactor the parser and add tests",
        column: "triage" as const,
        dependencies: [],
        steps: [],
        currentStep: 0,
        size: "M" as const,
        reviewLevel: "full" as const,
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
      };

      await plugin.hooks.onTaskCreated?.(mockTask as any, ctx as any);

      expect(ctx.emitEvent).toHaveBeenCalledWith("auto-label:classified", {
        taskId: "FN-003",
        labels: expect.arrayContaining(["refactor", "testing"]),
      });
    });
  });

  describe("tool: auto_label_classify", () => {
    it("should return correct PluginToolResult for valid text", async () => {
      const ctx = createMockContext();
      const tool = plugin.tools![0];

      const result = await tool.execute(
        { text: "Fix the login bug" },
        ctx as any,
      );

      expect(result).toHaveProperty("content");
      expect(result.content).toHaveLength(1);
      expect(result.content[0]).toEqual({ type: "text", text: expect.any(String) });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toContain("bug");
    });

    it("should return empty array for non-matching text", async () => {
      const ctx = createMockContext();
      const tool = plugin.tools![0];

      const result = await tool.execute(
        { text: "Update the color scheme" },
        ctx as any,
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toEqual([]);
    });

    it("should return empty array for empty text", async () => {
      const ctx = createMockContext();
      const tool = plugin.tools![0];

      const result = await tool.execute({ text: "" }, ctx as any);

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toEqual([]);
    });

    it("should return empty array for missing text parameter", async () => {
      const ctx = createMockContext();
      const tool = plugin.tools![0];

      const result = await tool.execute({}, ctx as any);

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toEqual([]);
    });

    it("should return isError false", async () => {
      const ctx = createMockContext();
      const tool = plugin.tools![0];

      const result = await tool.execute(
        { text: "Some text" },
        ctx as any,
      );

      expect(result.isError).toBe(false);
    });
  });
});
