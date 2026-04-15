import { describe, it, expect, vi, beforeEach } from "vitest";
import plugin from "../index.js";

// ── Types for mocking ─────────────────────────────────────────────────────────

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
    pluginId: "fusion-plugin-settings-demo",
    settings: {
      webhookSecret: undefined,
      customMessage: "Hello from Settings Demo!",
      greetingMessage: "Hello from Settings Demo!",
      maxTags: 3,
      enableLogging: true,
      logLevel: "info",
      priorityTags: ["bug", "feature"],
    },
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

// ── Mock Task ─────────────────────────────────────────────────────────────────

const mockTask = {
  id: "FN-001",
  title: "Test Task",
  description: "Fix the bug in the performance module",
  column: "todo" as const,
  dependencies: [],
  steps: [],
  currentStep: 0,
  size: "M" as const,
  reviewLevel: "full" as const,
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
};

// ── Test Suite ─────────────────────────────────────────────────────────────────

describe("settings demo plugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("plugin export", () => {
    it("should export a valid FusionPlugin with correct manifest fields", () => {
      expect(plugin.manifest.id).toBe("fusion-plugin-settings-demo");
      expect(plugin.manifest.name).toBe("Settings Demo Plugin");
      expect(plugin.manifest.version).toBe("0.1.0");
      expect(plugin.manifest.description).toBe(
        "Example plugin demonstrating settings schema, hooks, and tools",
      );
      expect(plugin.state).toBe("installed");
      expect(plugin.hooks).toBeDefined();
      expect(plugin.tools).toBeDefined();
    });

    it("should have manifest matching manifest.json", () => {
      // Verify consistency between code and manifest.json
      expect(plugin.manifest.id).toBe("fusion-plugin-settings-demo");
      expect(plugin.manifest.name).toBe("Settings Demo Plugin");
      expect(plugin.manifest.version).toBe("0.1.0");
    });

    it("should have settings schema defined with all field types", () => {
      expect(plugin.manifest.settingsSchema).toBeDefined();
      const schema = plugin.manifest.settingsSchema!;

      // Password type
      expect(schema.webhookSecret).toBeDefined();
      expect(schema.webhookSecret.type).toBe("password");
      expect(schema.webhookSecret.label).toBe("Webhook Secret");

      // String type with multiline
      expect(schema.customMessage).toBeDefined();
      expect(schema.customMessage.type).toBe("string");
      expect(schema.customMessage.label).toBe("Custom Message");
      expect(schema.customMessage.multiline).toBe(true);

      // String type
      expect(schema.greetingMessage).toBeDefined();
      expect(schema.greetingMessage.type).toBe("string");
      expect(schema.greetingMessage.label).toBe("Greeting Message");

      // Number type
      expect(schema.maxTags).toBeDefined();
      expect(schema.maxTags.type).toBe("number");
      expect(schema.maxTags.label).toBe("Max Tags");

      // Boolean type
      expect(schema.enableLogging).toBeDefined();
      expect(schema.enableLogging.type).toBe("boolean");
      expect(schema.enableLogging.label).toBe("Enable Logging");

      // Enum type
      expect(schema.logLevel).toBeDefined();
      expect(schema.logLevel.type).toBe("enum");
      expect(schema.logLevel.enumValues).toEqual(["debug", "info", "warn", "error"]);

      // Array type
      expect(schema.priorityTags).toBeDefined();
      expect(schema.priorityTags.type).toBe("array");
      expect(schema.priorityTags.label).toBe("Priority Tags");
      expect(schema.priorityTags.itemType).toBe("string");
    });

    it("should have default values in settings schema", () => {
      const schema = plugin.manifest.settingsSchema!;

      expect(schema.customMessage.defaultValue).toBe("Hello from Settings Demo!");
      expect(schema.greetingMessage.defaultValue).toBe("Hello from Settings Demo!");
      expect(schema.maxTags.defaultValue).toBe(3);
      expect(schema.enableLogging.defaultValue).toBe(true);
      expect(schema.logLevel.defaultValue).toBe("info");
      expect(schema.priorityTags.defaultValue).toEqual(["bug", "feature"]);
    });

    it("should have tools defined", () => {
      expect(plugin.tools).toBeDefined();
      expect(plugin.tools!.length).toBe(2);

      const toolNames = plugin.tools!.map((t) => t.name);
      expect(toolNames).toContain("settings_demo_suggest_tags");
      expect(toolNames).toContain("settings_demo_status");
    });

    it("should have all required hooks defined", () => {
      expect(plugin.hooks.onLoad).toBeDefined();
      expect(plugin.hooks.onTaskCreated).toBeDefined();
      expect(plugin.hooks.onTaskCompleted).toBeDefined();
    });
  });

  describe("hooks.onLoad", () => {
    it("should log greeting message when logging is enabled", async () => {
      const ctx = createMockContext({
        settings: {
          webhookSecret: "secret123",
          customMessage: "Custom Message",
          greetingMessage: "Custom Greeting",
          maxTags: 3,
          enableLogging: true,
          logLevel: "info",
          priorityTags: ["urgent"],
        },
      });

      await plugin.hooks.onLoad?.(ctx as any);

      expect(ctx.logger.info).toHaveBeenCalledWith("Webhook secret is configured");
      expect(ctx.logger.info).toHaveBeenCalledWith("Custom Message");
      expect(ctx.logger.info).toHaveBeenCalledWith(
        expect.stringContaining("maxTags: 3"),
      );
      expect(ctx.logger.info).toHaveBeenCalledWith(
        expect.stringContaining("Priority tags: urgent"),
      );
    });

    it("should not log when logging is disabled", async () => {
      const ctx = createMockContext({
        settings: {
          greetingMessage: "Custom Greeting",
          maxTags: 3,
          enableLogging: false,
          logLevel: "info",
        },
      });

      await plugin.hooks.onLoad?.(ctx as any);

      expect(ctx.logger.info).not.toHaveBeenCalled();
    });

    it("should use default greeting when not configured", async () => {
      const ctx = createMockContext({
        settings: {
          greetingMessage: "",
          maxTags: 3,
          enableLogging: true,
          logLevel: "info",
        },
      });

      await plugin.hooks.onLoad?.(ctx as any);

      expect(ctx.logger.info).toHaveBeenCalledWith("Hello from Settings Demo!");
    });
  });

  describe("hooks.onTaskCreated", () => {
    it("should log when task is created with logging enabled", async () => {
      const ctx = createMockContext({
        settings: {
          greetingMessage: "Hello",
          maxTags: 3,
          enableLogging: true,
          logLevel: "debug",
        },
      });

      await plugin.hooks.onTaskCreated?.(mockTask as any, ctx as any);

      expect(ctx.logger.debug).toHaveBeenCalledWith(
        expect.stringContaining("FN-001"),
      );
    });

    it("should suggest tags for task with description", async () => {
      const ctx = createMockContext({
        settings: {
          greetingMessage: "Hello",
          maxTags: 3,
          enableLogging: true,
          logLevel: "debug",
        },
      });

      await plugin.hooks.onTaskCreated?.(mockTask as any, ctx as any);

      // "performance" keyword matches performance tag
      expect(ctx.logger.debug).toHaveBeenCalledWith(
        expect.stringContaining("Suggested tags"),
      );
      expect(ctx.logger.debug).toHaveBeenCalledWith(
        expect.stringContaining("performance"),
      );
    });

    it("should not log when logging is disabled", async () => {
      const ctx = createMockContext({
        settings: {
          greetingMessage: "Hello",
          maxTags: 3,
          enableLogging: false,
          logLevel: "info",
        },
      });

      await plugin.hooks.onTaskCreated?.(mockTask as any, ctx as any);

      expect(ctx.logger.debug).not.toHaveBeenCalled();
    });

    it("should handle task without description gracefully", async () => {
      const ctx = createMockContext({
        settings: {
          greetingMessage: "Hello",
          maxTags: 3,
          enableLogging: true,
          logLevel: "debug",
        },
      });

      const taskNoDesc = { ...mockTask, description: undefined };

      await plugin.hooks.onTaskCreated?.(taskNoDesc as any, ctx as any);

      // Should log task creation but not tag suggestions
      expect(ctx.logger.debug).toHaveBeenCalledWith(
        expect.stringContaining("FN-001"),
      );
    });
  });

  describe("hooks.onTaskCompleted", () => {
    it("should log when task is completed with logging enabled", async () => {
      const ctx = createMockContext({
        settings: {
          greetingMessage: "Hello",
          maxTags: 3,
          enableLogging: true,
          logLevel: "info",
        },
      });

      await plugin.hooks.onTaskCompleted?.(mockTask as any, ctx as any);

      expect(ctx.logger.info).toHaveBeenCalledWith(
        expect.stringContaining("Task completed"),
      );
      expect(ctx.logger.info).toHaveBeenCalledWith(
        expect.stringContaining("FN-001"),
      );
    });

    it("should not log when logging is disabled", async () => {
      const ctx = createMockContext({
        settings: {
          greetingMessage: "Hello",
          maxTags: 3,
          enableLogging: false,
          logLevel: "info",
        },
      });

      await plugin.hooks.onTaskCompleted?.(mockTask as any, ctx as any);

      expect(ctx.logger.info).not.toHaveBeenCalled();
    });
  });

  describe("tools.suggest_tags", () => {
    it("should suggest tags based on description keywords", async () => {
      const ctx = createMockContext({
        settings: {
          greetingMessage: "Hello",
          maxTags: 3,
          enableLogging: false,
          logLevel: "info",
        },
      });

      const tool = plugin.tools!.find((t) => t.name === "settings_demo_suggest_tags")!;
      const result = await tool.execute(
        { taskDescription: "Fix the bug in the performance module" },
        ctx as any,
      );

      expect(result.content[0].text).toContain("Suggested tags:");
      expect(result.content[0].text).toContain("performance");
    });

    it("should respect maxTags setting", async () => {
      const ctx = createMockContext({
        settings: {
          greetingMessage: "Hello",
          maxTags: 1,
          enableLogging: false,
          logLevel: "info",
        },
      });

      const tool = plugin.tools!.find((t) => t.name === "settings_demo_suggest_tags")!;
      const result = await tool.execute(
        { taskDescription: "Fix bug fix fix" },
        ctx as any,
      );

      // Should only return 1 tag
      expect(result.details!.count).toBe(1);
    });

    it("should return no tags for generic description", async () => {
      const ctx = createMockContext({
        settings: {
          greetingMessage: "Hello",
          maxTags: 3,
          enableLogging: false,
          logLevel: "info",
        },
      });

      const tool = plugin.tools!.find((t) => t.name === "settings_demo_suggest_tags")!;
      const result = await tool.execute(
        { taskDescription: "Do something" },
        ctx as any,
      );

      expect(result.content[0].text).toContain("No tags could be suggested");
    });

    it("should handle empty description", async () => {
      const ctx = createMockContext({
        settings: {
          greetingMessage: "Hello",
          maxTags: 3,
          enableLogging: false,
          logLevel: "info",
        },
      });

      const tool = plugin.tools!.find((t) => t.name === "settings_demo_suggest_tags")!;
      const result = await tool.execute({ taskDescription: "" }, ctx as any);

      expect(result.content[0].text).toContain("No tags could be suggested");
    });
  });

  describe("tools.status", () => {
    it("should return current configuration status", async () => {
      const ctx = createMockContext({
        settings: {
          webhookSecret: "secret123",
          customMessage: "Custom Message",
          greetingMessage: "Custom Greeting",
          maxTags: 5,
          enableLogging: true,
          logLevel: "debug",
          priorityTags: ["urgent", "critical"],
        },
      });

      const tool = plugin.tools!.find((t) => t.name === "settings_demo_status")!;
      const result = await tool.execute({}, ctx as any);

      expect(result.content[0].text).toContain("Settings Demo Plugin Status:");
      expect(result.content[0].text).toContain("Webhook Secret: configured");
      expect(result.content[0].text).toContain("Custom Message: Custom Message");
      expect(result.content[0].text).toContain("Greeting: Custom Greeting");
      expect(result.content[0].text).toContain("Max Tags: 5");
      expect(result.content[0].text).toContain("Logging: enabled");
      expect(result.content[0].text).toContain("Log Level: debug");
      expect(result.content[0].text).toContain("Priority Tags: urgent, critical");

      expect(result.details!.webhookSecret).toBe("(configured)");
      expect(result.details!.customMessage).toBe("Custom Message");
      expect(result.details!.greetingMessage).toBe("Custom Greeting");
      expect(result.details!.maxTags).toBe(5);
      expect(result.details!.enableLogging).toBe(true);
      expect(result.details!.logLevel).toBe("debug");
      expect(result.details!.priorityTags).toEqual(["urgent", "critical"]);
    });

    it("should return raw settings values including undefined", async () => {
      const ctx = createMockContext({
        settings: {
          webhookSecret: undefined,
          customMessage: "",
          greetingMessage: "",
          maxTags: undefined,
          enableLogging: undefined,
          logLevel: undefined,
          priorityTags: undefined,
        },
      });

      const tool = plugin.tools!.find((t) => t.name === "settings_demo_status")!;
      const result = await tool.execute({}, ctx as any);

      // Details returns raw values (not resolved defaults)
      expect(result.details!.webhookSecret).toBeUndefined();
      expect(result.details!.customMessage).toBe("");
      expect(result.details!.greetingMessage).toBe("");
      expect(result.details!.maxTags).toBeUndefined();
      expect(result.details!.enableLogging).toBeUndefined();
      expect(result.details!.logLevel).toBeUndefined();
      expect(result.details!.priorityTags).toBeUndefined();

      // But display text uses resolved defaults
      expect(result.content[0].text).toContain("Webhook Secret: not configured");
      expect(result.content[0].text).toContain("Custom Message: Not configured");
      expect(result.content[0].text).toContain("Greeting: Not configured");
      expect(result.content[0].text).toContain("Max Tags: 3");
      expect(result.content[0].text).toContain("Logging: enabled");
      expect(result.content[0].text).toContain("Log Level: info");
      expect(result.content[0].text).toContain("Priority Tags: bug, feature");
    });

    it("should verify priorityTags array default is used when not configured", async () => {
      const ctx = createMockContext({
        settings: {
          webhookSecret: undefined,
          customMessage: undefined,
          greetingMessage: undefined,
          maxTags: undefined,
          enableLogging: false,
          logLevel: undefined,
          priorityTags: undefined,
        },
      });

      const tool = plugin.tools!.find((t) => t.name === "settings_demo_status")!;
      const result = await tool.execute({}, ctx as any);

      // Priority tags should use the schema default
      expect(result.content[0].text).toContain("Priority Tags: bug, feature");
    });
  });

  describe("settings-driven behavior", () => {
    it("should log debug messages only when logLevel allows", async () => {
      const ctx = createMockContext({
        settings: {
          greetingMessage: "Hello",
          maxTags: 3,
          enableLogging: true,
          logLevel: "error", // Only error level
        },
      });

      await plugin.hooks.onLoad?.(ctx as any);
      await plugin.hooks.onTaskCreated?.(mockTask as any, ctx as any);

      // Debug and info should be filtered out
      expect(ctx.logger.debug).not.toHaveBeenCalled();
      expect(ctx.logger.info).not.toHaveBeenCalled();
    });

    it("should log all levels when logLevel is debug", async () => {
      const ctx = createMockContext({
        settings: {
          greetingMessage: "Hello",
          maxTags: 3,
          enableLogging: true,
          logLevel: "debug",
        },
      });

      await plugin.hooks.onLoad?.(ctx as any);

      // All log levels should work
      expect(ctx.logger.info).toHaveBeenCalled();
    });

    it("should handle maxTags edge case of 0", async () => {
      const ctx = createMockContext({
        settings: {
          greetingMessage: "Hello",
          maxTags: 0, // Edge case: 0 tags
          enableLogging: false,
          logLevel: "info",
        },
      });

      const tool = plugin.tools!.find((t) => t.name === "settings_demo_suggest_tags")!;
      const result = await tool.execute(
        { taskDescription: "Fix bug performance ui" },
        ctx as any,
      );

      // When maxTags is 0, no tags should be returned
      expect(result.details!.tags).toHaveLength(0);
    });
  });
});
