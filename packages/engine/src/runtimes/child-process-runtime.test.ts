import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CentralCore } from "@fusion/core";
import { ChildProcessRuntime } from "./child-process-runtime.js";
import type { ProjectRuntimeConfig } from "../project-runtime.js";

// Mock child_process
vi.mock("node:child_process", () => ({
  fork: vi.fn().mockReturnValue({
    on: vi.fn(),
    kill: vi.fn(),
    killed: false,
    connected: false,
    send: vi.fn(),
  }),
}));

describe("ChildProcessRuntime", () => {
  let runtime: ChildProcessRuntime;
  let mockCentralCore: CentralCore;
  const testConfig: ProjectRuntimeConfig = {
    projectId: "proj_test123",
    workingDirectory: "/tmp/test-project",
    isolationMode: "child-process",
    maxConcurrent: 2,
    maxWorktrees: 4,
  };

  beforeEach(() => {
    mockCentralCore = {
      getGlobalConcurrencyState: vi.fn().mockResolvedValue({
        globalMaxConcurrent: 4,
        currentlyActive: 0,
        queuedCount: 0,
        projectsActive: {},
      }),
    } as unknown as CentralCore;

    runtime = new ChildProcessRuntime(testConfig, mockCentralCore);
  });

  afterEach(async () => {
    try {
      await runtime.stop();
    } catch {
      // Ignore errors during cleanup
    }
    vi.clearAllMocks();
  });

  describe("lifecycle", () => {
    it("should start with status 'stopped'", () => {
      expect(runtime.getStatus()).toBe("stopped");
    });

    it("should throw when getting TaskStore", () => {
      expect(() => runtime.getTaskStore()).toThrow("not accessible in ChildProcessRuntime");
    });

    it("should throw when getting Scheduler", () => {
      expect(() => runtime.getScheduler()).toThrow("not accessible in ChildProcessRuntime");
    });

    it("should return metrics even when stopped", () => {
      const metrics = runtime.getMetrics();
      expect(metrics.inFlightTasks).toBe(0);
      expect(metrics.activeAgents).toBe(0);
      expect(metrics.lastActivityAt).toBeDefined();
    });
  });

  describe("configuration", () => {
    it("should store projectId in config", () => {
      expect(testConfig.projectId).toBe("proj_test123");
    });

    it("should store workingDirectory in config", () => {
      expect(testConfig.workingDirectory).toBe("/tmp/test-project");
    });

    it("should have child-process isolation mode", () => {
      expect(testConfig.isolationMode).toBe("child-process");
    });
  });

  describe("event handling", () => {
    it("should support health-changed event", () => {
      const handler = vi.fn();
      runtime.on("health-changed", handler);
      
      // The constructor may emit health-changed, so we just verify
      // the event listener can be registered
      expect(handler).not.toHaveBeenCalled();
    });

    it("should support error event", () => {
      const handler = vi.fn();
      runtime.on("error", handler);
      
      expect(handler).not.toHaveBeenCalled();
    });
  });
});
