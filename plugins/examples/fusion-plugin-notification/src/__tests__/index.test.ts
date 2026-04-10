import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
    pluginId: "fusion-plugin-notification",
    settings: {
      webhookUrl: "https://example.com/webhook",
      webhookType: "generic",
      events: "",
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
  description: "A test task description",
  column: "done" as const,
  dependencies: [],
  steps: [],
  currentStep: 0,
  size: "M" as const,
  reviewLevel: "full" as const,
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
};

// ── Test Suite ─────────────────────────────────────────────────────────────────

describe("notification plugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("plugin export", () => {
    it("should export a valid FusionPlugin with correct manifest fields", () => {
      expect(plugin.manifest.id).toBe("fusion-plugin-notification");
      expect(plugin.manifest.name).toBe("Notification Plugin");
      expect(plugin.manifest.version).toBe("0.1.0");
      expect(plugin.manifest.description).toBe(
        "Sends webhook notifications on task lifecycle events",
      );
      expect(plugin.state).toBe("installed");
      expect(plugin.hooks).toBeDefined();
    });

    it("should have all required hooks defined", () => {
      expect(plugin.hooks.onLoad).toBeDefined();
      expect(plugin.hooks.onTaskCompleted).toBeDefined();
      expect(plugin.hooks.onTaskMoved).toBeDefined();
      expect(plugin.hooks.onError).toBeDefined();
    });

    it("should have settings schema defined", () => {
      expect(plugin.manifest.settingsSchema).toBeDefined();
      expect(plugin.manifest.settingsSchema!.webhookUrl).toBeDefined();
      expect(plugin.manifest.settingsSchema!.webhookType).toBeDefined();
      expect(plugin.manifest.settingsSchema!.events).toBeDefined();
    });
  });

  describe("hooks.onLoad", () => {
    it("should log startup message", async () => {
      const ctx = createMockContext();
      await plugin.hooks.onLoad?.(ctx as any);
      expect(ctx.logger.info).toHaveBeenCalledWith("Notification plugin loaded");
    });

    it("should warn if webhookUrl is not configured", async () => {
      const ctx = createMockContext({
        settings: { webhookUrl: "", webhookType: "generic", events: "" },
      });
      await plugin.hooks.onLoad?.(ctx as any);
      expect(ctx.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("No webhook URL configured"),
      );
    });

    it("should not warn if webhookUrl is configured", async () => {
      const ctx = createMockContext({
        settings: {
          webhookUrl: "https://example.com/webhook",
          webhookType: "generic",
          events: "",
        },
      });
      await plugin.hooks.onLoad?.(ctx as any);
      expect(ctx.logger.warn).not.toHaveBeenCalled();
    });
  });

  describe("hooks.onTaskCompleted", () => {
    it("should fire fetch call with generic payload for generic webhook type", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal("fetch", fetchMock);

      const ctx = createMockContext({
        settings: {
          webhookUrl: "https://example.com/webhook",
          webhookType: "generic",
          events: "",
        },
      });

      await plugin.hooks.onTaskCompleted?.(mockTask as any, ctx as any);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://example.com/webhook",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
        }),
      );

      const call = fetchMock.mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.event).toBe("task-completed");
      expect(body.task.id).toBe("FN-001");
      expect(body.task.title).toBe("Test Task");
    });

    it("should fire fetch call with Slack payload for slack webhook type", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal("fetch", fetchMock);

      const ctx = createMockContext({
        settings: {
          webhookUrl: "https://hooks.slack.com/webhook",
          webhookType: "slack",
          events: "",
        },
      });

      await plugin.hooks.onTaskCompleted?.(mockTask as any, ctx as any);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const call = fetchMock.mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body).toEqual({ text: expect.stringContaining("Task completed") });
    });

    it("should fire fetch call with Discord payload for discord webhook type", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal("fetch", fetchMock);

      const ctx = createMockContext({
        settings: {
          webhookUrl: "https://discord.com/api/webhooks/webhook",
          webhookType: "discord",
          events: "",
        },
      });

      await plugin.hooks.onTaskCompleted?.(mockTask as any, ctx as any);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const call = fetchMock.mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body).toEqual({ content: expect.stringContaining("Task completed") });
    });

    it("should not fire webhook if webhookUrl is not set", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal("fetch", fetchMock);

      const ctx = createMockContext({
        settings: { webhookUrl: "", webhookType: "generic", events: "" },
      });

      await plugin.hooks.onTaskCompleted?.(mockTask as any, ctx as any);

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("should not fire webhook if event is filtered out", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal("fetch", fetchMock);

      const ctx = createMockContext({
        settings: {
          webhookUrl: "https://example.com/webhook",
          webhookType: "generic",
          events: "task-moved", // Only task-moved events
        },
      });

      await plugin.hooks.onTaskCompleted?.(mockTask as any, ctx as any);

      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("event filtering", () => {
    it("should fire webhook for task-completed when events filter is task-completed", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal("fetch", fetchMock);

      const ctx = createMockContext({
        settings: {
          webhookUrl: "https://example.com/webhook",
          webhookType: "generic",
          events: "task-completed",
        },
      });

      await plugin.hooks.onTaskCompleted?.(mockTask as any, ctx as any);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("should NOT fire webhook for task-moved when events filter is task-completed only", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal("fetch", fetchMock);

      const ctx = createMockContext({
        settings: {
          webhookUrl: "https://example.com/webhook",
          webhookType: "generic",
          events: "task-completed",
        },
      });

      await plugin.hooks.onTaskMoved?.(
        mockTask as any,
        "todo",
        "in-progress",
        ctx as any,
      );

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("should fire for multiple events when multiple are specified", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal("fetch", fetchMock);

      const ctx = createMockContext({
        settings: {
          webhookUrl: "https://example.com/webhook",
          webhookType: "generic",
          events: "task-completed,task-moved",
        },
      });

      await plugin.hooks.onTaskCompleted?.(mockTask as any, ctx as any);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      vi.clearAllMocks();

      await plugin.hooks.onTaskMoved?.(
        mockTask as any,
        "todo",
        "in-progress",
        ctx as any,
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("hooks.onTaskMoved", () => {
    it("should send webhook with from and to columns", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal("fetch", fetchMock);

      const ctx = createMockContext({
        settings: {
          webhookUrl: "https://example.com/webhook",
          webhookType: "generic",
          events: "",
        },
      });

      await plugin.hooks.onTaskMoved?.(
        mockTask as any,
        "todo",
        "in-progress",
        ctx as any,
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const call = fetchMock.mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.event).toBe("task-moved");
      expect(body.task.from).toBe("todo");
      expect(body.task.to).toBe("in-progress");
    });
  });

  describe("hooks.onError", () => {
    it("should send webhook with error message", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal("fetch", fetchMock);

      const ctx = createMockContext({
        settings: {
          webhookUrl: "https://example.com/webhook",
          webhookType: "generic",
          events: "",
        },
      });

      const error = new Error("Something went wrong");
      await plugin.hooks.onError?.(error, ctx as any);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const call = fetchMock.mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.event).toBe("error");
      expect(body.error).toBe("Something went wrong");
    });
  });

  describe("webhook failure handling", () => {
    it("should not throw when fetch fails", async () => {
      const fetchMock = vi
        .fn()
        .mockRejectedValue(new Error("Network error"));
      vi.stubGlobal("fetch", fetchMock);

      const ctx = createMockContext({
        settings: {
          webhookUrl: "https://example.com/webhook",
          webhookType: "generic",
          events: "",
        },
      });

      // Should not throw
      await expect(
        plugin.hooks.onTaskCompleted?.(mockTask as any, ctx as any),
      ).resolves.not.toThrow();

      expect(ctx.logger.error).toHaveBeenCalledWith(
        expect.stringContaining("Network error"),
      );
    });

    it("should log error when fetch returns non-ok status", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      });
      vi.stubGlobal("fetch", fetchMock);

      const ctx = createMockContext({
        settings: {
          webhookUrl: "https://example.com/webhook",
          webhookType: "generic",
          events: "",
        },
      });

      await plugin.hooks.onTaskCompleted?.(mockTask as any, ctx as any);

      expect(ctx.logger.error).toHaveBeenCalledWith(
        expect.stringContaining("500"),
      );
    });
  });
});
