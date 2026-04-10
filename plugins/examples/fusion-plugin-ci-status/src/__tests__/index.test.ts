import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import plugin from "../index.js";

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
    pluginId: "fusion-plugin-ci-status",
    settings: {
      ciUrl: "https://ci.example.com/api",
      pollIntervalMs: 60000,
      branchPrefix: "fusion/",
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

// ── Mock Request/Response ──────────────────────────────────────────────────────

function createMockRequest(overrides: Partial<{ params: Record<string, string>; method: string; url: string }> = {}): {
  params: Record<string, string>;
  method: string;
  url: string;
} {
  return {
    params: {},
    method: "GET",
    url: "/status",
    ...overrides,
  };
}

function createMockResponse() {
  const json = vi.fn();
  const status = vi.fn().mockReturnThis();
  return { json, status };
}

// ── Test Suite ─────────────────────────────────────────────────────────────────

describe("ci-status plugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe("plugin export", () => {
    it("should export a valid FusionPlugin with correct manifest fields", () => {
      expect(plugin.manifest.id).toBe("fusion-plugin-ci-status");
      expect(plugin.manifest.name).toBe("CI Status Plugin");
      expect(plugin.manifest.version).toBe("0.1.0");
      expect(plugin.state).toBe("installed");
    });

    it("should have routes array with 3 routes", () => {
      expect(plugin.routes).toBeDefined();
      expect(plugin.routes!.length).toBe(3);
    });

    it("should have GET /status route", () => {
      const route = plugin.routes!.find(
        (r) => r.method === "GET" && r.path === "/status",
      );
      expect(route).toBeDefined();
      expect(route!.description).toBe("Get status of all tracked branches");
    });

    it("should have GET /status/:branch route", () => {
      const route = plugin.routes!.find(
        (r) => r.method === "GET" && r.path === "/status/:branch",
      );
      expect(route).toBeDefined();
      expect(route!.description).toBe("Get status of a specific branch");
    });

    it("should have POST /refresh route", () => {
      const route = plugin.routes!.find(
        (r) => r.method === "POST" && r.path === "/refresh",
      );
      expect(route).toBeDefined();
      expect(route!.description).toBe("Trigger an immediate CI status refresh");
    });

    it("should have onLoad, onUnload, and onTaskMoved hooks", () => {
      expect(plugin.hooks.onLoad).toBeDefined();
      expect(plugin.hooks.onUnload).toBeDefined();
      expect(plugin.hooks.onTaskMoved).toBeDefined();
    });

    it("should have settings schema defined", () => {
      expect(plugin.manifest.settingsSchema).toBeDefined();
      expect(plugin.manifest.settingsSchema!.ciUrl).toBeDefined();
      expect(plugin.manifest.settingsSchema!.pollIntervalMs).toBeDefined();
      expect(plugin.manifest.settingsSchema!.branchPrefix).toBeDefined();
    });
  });

  describe("hooks.onLoad", () => {
    it("should log startup message", async () => {
      const ctx = createMockContext();
      await plugin.hooks.onLoad?.(ctx as any);
      expect(ctx.logger.info).toHaveBeenCalledWith("CI Status plugin loaded");
    });

    it("should start an interval for polling", async () => {
      const ctx = createMockContext();
      await plugin.hooks.onLoad?.(ctx as any);

      // The interval should be set
      expect(ctx.logger.info).toHaveBeenCalledWith(
        expect.stringContaining("CI polling started"),
      );
    });
  });

  describe("hooks.onUnload", () => {
    it("should log shutdown message", async () => {
      const ctx = createMockContext();
      await plugin.hooks.onLoad?.(ctx as any);
      vi.clearAllMocks();

      await plugin.hooks.onUnload?.();

      expect(ctx.logger.info).toHaveBeenCalledWith("CI Status plugin unloaded");
    });
  });

  describe("hooks.onTaskMoved", () => {
    const mockTask = {
      id: "FN-001",
      title: "Test Task",
      description: "A test task",
      column: "in-progress" as const,
      dependencies: [],
      steps: [],
      currentStep: 0,
      size: "M" as const,
      reviewLevel: "full" as const,
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    };

    it("should track branch when task moves to in-progress", async () => {
      const ctx = createMockContext();
      await plugin.hooks.onTaskMoved?.(
        mockTask as any,
        "todo",
        "in-progress",
        ctx as any,
      );
      expect(ctx.logger.info).toHaveBeenCalledWith(
        expect.stringContaining("Tracking branch for task FN-001"),
      );
    });

    it("should stop tracking branch when task moves to done", async () => {
      const ctx = createMockContext();

      // First move to in-progress
      await plugin.hooks.onTaskMoved?.(
        mockTask as any,
        "todo",
        "in-progress",
        ctx as any,
      );
      vi.clearAllMocks();

      // Then move to done
      await plugin.hooks.onTaskMoved?.(
        mockTask as any,
        "in-progress",
        "done",
        ctx as any,
      );
      expect(ctx.logger.info).toHaveBeenCalledWith(
        expect.stringContaining("Stopped tracking branch for task FN-001"),
      );
    });

    it("should use configured branch prefix", async () => {
      const ctx = createMockContext({
        settings: {
          ciUrl: "https://ci.example.com/api",
          pollIntervalMs: 60000,
          branchPrefix: "custom/",
        },
      });

      await plugin.hooks.onTaskMoved?.(
        mockTask as any,
        "todo",
        "in-progress",
        ctx as any,
      );

      expect(ctx.logger.info).toHaveBeenCalledWith(
        expect.stringContaining("custom/fn-001"),
      );
    });
  });

  describe("route handlers", () => {
    describe("GET /status", () => {
      it("should return branches array", async () => {
        const ctx = createMockContext();
        const req = createMockRequest();
        const res = createMockResponse();

        const route = plugin.routes!.find(
          (r) => r.method === "GET" && r.path === "/status",
        )!;

        const result = await route.handler(req as any, ctx as any) as { branches?: unknown[] };

        expect(result).toHaveProperty("branches");
        expect(Array.isArray(result.branches)).toBe(true);
      });
    });

    describe("GET /status/:branch", () => {
      it("should return specific branch data", async () => {
        const ctx = createMockContext();
        const req = createMockRequest({
          params: { branch: "fusion/fn-001" },
        });

        // First add the branch via onTaskMoved
        await plugin.hooks.onTaskMoved?.(
          {
            id: "FN-001",
            title: "Test Task",
            description: "A test task",
            column: "in-progress" as const,
            dependencies: [],
            steps: [],
            currentStep: 0,
            size: "M" as const,
            reviewLevel: "full" as const,
            createdAt: "2024-01-01T00:00:00.000Z",
            updatedAt: "2024-01-01T00:00:00.000Z",
          } as any,
          "todo",
          "in-progress",
          ctx as any,
        );

        const route = plugin.routes!.find(
          (r) => r.method === "GET" && r.path === "/status/:branch",
        )!;

        const result = await route.handler(req as any, ctx as any) as { branch?: string; status?: string };

        expect(result).toHaveProperty("branch", "fusion/fn-001");
        expect(result).toHaveProperty("status", "pending");
      });

      it("should throw 404 for unknown branch", async () => {
        const ctx = createMockContext();
        const req = createMockRequest({
          params: { branch: "unknown/branch" },
        });

        const route = plugin.routes!.find(
          (r) => r.method === "GET" && r.path === "/status/:branch",
        )!;

        expect(() => route.handler(req as any, ctx as any)).toThrow(
          "Branch not found",
        );

        try {
          route.handler(req as any, ctx as any);
        } catch (error) {
          expect((error as { statusCode?: number }).statusCode).toBe(404);
        }
      });
    });

    describe("POST /refresh", () => {
      it("should trigger refresh and return branches", async () => {
        const ctx = createMockContext();
        const req = createMockRequest({ method: "POST" });
        const res = createMockResponse();

        const route = plugin.routes!.find(
          (r) => r.method === "POST" && r.path === "/refresh",
        )!;

        const result = await route.handler(req as any, ctx as any) as { refreshed?: boolean; branches?: unknown[] };

        expect(result).toHaveProperty("refreshed", true);
        expect(result).toHaveProperty("branches");
        expect(Array.isArray(result.branches)).toBe(true);
      });
    });
  });
});
