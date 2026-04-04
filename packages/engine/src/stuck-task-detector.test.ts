import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { StuckTaskDetector } from "./stuck-task-detector.js";
import type { TaskStore } from "@fusion/core";

// Mock store factory
function createMockStore(overrides: Partial<TaskStore> = {}): TaskStore {
  return {
    getSettings: vi.fn().mockResolvedValue({}),
    logEntry: vi.fn().mockResolvedValue(undefined),
    updateTask: vi.fn().mockResolvedValue(undefined),
    moveTask: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as TaskStore;
}

// Mock disposable session
function createMockSession(): { dispose: ReturnType<typeof vi.fn> } {
  return {
    dispose: vi.fn(),
  };
}

describe("StuckTaskDetector", () => {
  let store: TaskStore;
  let detector: StuckTaskDetector;

  beforeEach(() => {
    store = createMockStore();
    detector = new StuckTaskDetector(store);
  });

  afterEach(() => {
    detector.stop();
  });

  describe("constructor", () => {
    it("initializes with default options", () => {
      expect(detector).toBeDefined();
      expect(detector.trackedCount).toBe(0);
    });

    it("accepts custom poll interval", () => {
      const customDetector = new StuckTaskDetector(store, { pollIntervalMs: 5000 });
      expect(customDetector).toBeDefined();
    });

    it("accepts onStuck callback", () => {
      const onStuck = vi.fn();
      const customDetector = new StuckTaskDetector(store, { onStuck });
      expect(customDetector).toBeDefined();
    });
  });

  describe("start/stop", () => {
    it("starts and stops the polling loop", () => {
      detector.start();
      detector.stop();
      // Should not throw
    });

    it("is safe to stop when not started", () => {
      detector.stop();
      // Should not throw
    });

    it("is safe to start multiple times", () => {
      detector.start();
      detector.start(); // Second call should no-op
      detector.stop();
    });
  });

  describe("trackTask", () => {
    it("adds task to tracking", () => {
      const session = createMockSession();
      detector.trackTask("FN-001", session);
      expect(detector.trackedCount).toBe(1);
    });

    it("sets initial activity timestamp", () => {
      const session = createMockSession();
      const before = Date.now();
      detector.trackTask("FN-001", session);
      const after = Date.now();

      const lastActivity = detector.getLastActivity("FN-001");
      expect(lastActivity).toBeDefined();
      expect(lastActivity).toBeGreaterThanOrEqual(before);
      expect(lastActivity).toBeLessThanOrEqual(after);
    });

    it("sets initial progress timestamp", () => {
      const session = createMockSession();
      const before = Date.now();
      detector.trackTask("FN-001", session);
      const after = Date.now();

      const lastProgressAt = detector.getLastProgressAt("FN-001");
      expect(lastProgressAt).toBeDefined();
      expect(lastProgressAt).toBeGreaterThanOrEqual(before);
      expect(lastProgressAt).toBeLessThanOrEqual(after);
    });

    it("initializes activitySinceProgress to 0", () => {
      const session = createMockSession();
      detector.trackTask("FN-001", session);

      expect(detector.getActivitySinceProgress("FN-001")).toBe(0);
    });

    it("can track multiple tasks", () => {
      detector.trackTask("FN-001", createMockSession());
      detector.trackTask("FN-002", createMockSession());
      expect(detector.trackedCount).toBe(2);
    });
  });

  describe("untrackTask", () => {
    it("removes task from tracking", () => {
      detector.trackTask("FN-001", createMockSession());
      expect(detector.trackedCount).toBe(1);

      detector.untrackTask("FN-001");
      expect(detector.trackedCount).toBe(0);
    });

    it("is safe to untrack untracked task", () => {
      detector.untrackTask("FN-001");
      expect(detector.trackedCount).toBe(0);
    });
  });

  describe("recordActivity", () => {
    it("updates last activity timestamp", () => {
      const session = createMockSession();
      vi.useFakeTimers({ shouldAdvanceTime: true });
      
      detector.trackTask("FN-001", session);
      const initialActivity = detector.getLastActivity("FN-001")!;

      // Advance time
      vi.advanceTimersByTime(10);
      detector.recordActivity("FN-001");

      const newActivity = detector.getLastActivity("FN-001")!;
      expect(newActivity).toBeGreaterThanOrEqual(initialActivity);

      vi.useRealTimers();
    });

    it("increments activitySinceProgress counter", () => {
      const session = createMockSession();
      detector.trackTask("FN-001", session);
      expect(detector.getActivitySinceProgress("FN-001")).toBe(0);

      detector.recordActivity("FN-001");
      expect(detector.getActivitySinceProgress("FN-001")).toBe(1);

      detector.recordActivity("FN-001");
      expect(detector.getActivitySinceProgress("FN-001")).toBe(2);
    });

    it("does nothing for untracked task", () => {
      // Should not throw
      detector.recordActivity("FN-001");
    });
  });

  describe("recordProgress", () => {
    it("updates lastProgressAt timestamp", () => {
      const session = createMockSession();
      vi.useFakeTimers({ shouldAdvanceTime: true });

      detector.trackTask("FN-001", session);
      const initialProgress = detector.getLastProgressAt("FN-001")!;

      vi.advanceTimersByTime(10);
      detector.recordProgress("FN-001");

      const newProgress = detector.getLastProgressAt("FN-001")!;
      expect(newProgress).toBeGreaterThanOrEqual(initialProgress);

      vi.useRealTimers();
    });

    it("resets activitySinceProgress to 0", () => {
      const session = createMockSession();
      detector.trackTask("FN-001", session);

      // Simulate some activity
      detector.recordActivity("FN-001");
      detector.recordActivity("FN-001");
      detector.recordActivity("FN-001");
      expect(detector.getActivitySinceProgress("FN-001")).toBe(3);

      // Progress resets the counter
      detector.recordProgress("FN-001");
      expect(detector.getActivitySinceProgress("FN-001")).toBe(0);
    });

    it("does nothing for untracked task", () => {
      // Should not throw
      detector.recordProgress("FN-001");
    });
  });

  describe("isStuck", () => {
    it("returns false when no timeout exceeded", () => {
      const session = createMockSession();
      detector.trackTask("FN-001", session);

      expect(detector.isStuck("FN-001", 60000)).toBe(false);
    });

    it("returns true when timeout exceeded", () => {
      const session = createMockSession();
      vi.useFakeTimers({ shouldAdvanceTime: true });

      detector.trackTask("FN-001", session);
      vi.advanceTimersByTime(61000); // Advance 61 seconds

      expect(detector.isStuck("FN-001", 60000)).toBe(true);

      vi.useRealTimers();
    });

    it("returns false for untracked task", () => {
      expect(detector.isStuck("FN-001", 60000)).toBe(false);
    });
  });

  describe("classifyStuckReason", () => {
    it("returns null when not stuck", () => {
      const session = createMockSession();
      detector.trackTask("FN-001", session);

      expect(detector.classifyStuckReason("FN-001", 60000)).toBeNull();
    });

    it("returns 'inactivity' when no activity at all for the timeout", () => {
      const session = createMockSession();
      vi.useFakeTimers({ shouldAdvanceTime: true });

      detector.trackTask("FN-001", session);
      vi.advanceTimersByTime(61000);

      expect(detector.classifyStuckReason("FN-001", 60000)).toBe("inactivity");

      vi.useRealTimers();
    });

    it("returns 'loop' when active but no progress with high activity count", () => {
      const session = createMockSession();
      vi.useFakeTimers({ shouldAdvanceTime: true });

      detector.trackTask("FN-001", session);

      // Simulate time passing with lots of activity but no progress
      vi.advanceTimersByTime(61000); // 61 seconds

      // Simulate many activity heartbeats (agent is working but not advancing steps)
      for (let i = 0; i < 60; i++) {
        detector.recordActivity("FN-001");
      }

      // Inactivity is near-zero because we just called recordActivity, but
      // noProgress is 61s. With activity >= 60, this should be a loop.
      expect(detector.classifyStuckReason("FN-001", 60000)).toBe("loop");

      vi.useRealTimers();
    });

    it("returns null when no-progress timeout exceeded but activity count is below threshold", () => {
      const session = createMockSession();
      vi.useFakeTimers({ shouldAdvanceTime: true });

      detector.trackTask("FN-001", session);

      // Advance time past timeout
      vi.advanceTimersByTime(61000);

      // Only a few activity events (below threshold of 60)
      for (let i = 0; i < 30; i++) {
        detector.recordActivity("FN-001");
      }

      // Should not be classified as stuck (not enough activity for loop,
      // and activity just happened so inactivity timeout hasn't been hit)
      expect(detector.classifyStuckReason("FN-001", 60000)).toBeNull();

      vi.useRealTimers();
    });

    it("returns null for untracked task", () => {
      expect(detector.classifyStuckReason("FN-001", 60000)).toBeNull();
    });

    it("progress resets loop detection: no loop after recordProgress", () => {
      const session = createMockSession();
      vi.useFakeTimers({ shouldAdvanceTime: true });

      detector.trackTask("FN-001", session);

      // Simulate time passing with lots of activity
      vi.advanceTimersByTime(61000);
      for (let i = 0; i < 80; i++) {
        detector.recordActivity("FN-001");
      }

      // This would be a loop...
      expect(detector.classifyStuckReason("FN-001", 60000)).toBe("loop");

      // But after progress, it resets
      detector.recordProgress("FN-001");
      expect(detector.classifyStuckReason("FN-001", 60000)).toBeNull();

      vi.useRealTimers();
    });
  });

  describe("killAndRetry", () => {
    it("disposes the session", async () => {
      const session = createMockSession();
      detector.trackTask("FN-001", session);

      vi.useFakeTimers({ shouldAdvanceTime: true });
      vi.advanceTimersByTime(61000);

      await detector.killAndRetry("FN-001", 60000);

      expect(session.dispose).toHaveBeenCalled();

      vi.useRealTimers();
    });

    it("removes task from tracking", async () => {
      const session = createMockSession();
      detector.trackTask("FN-001", session);
      expect(detector.trackedCount).toBe(1);

      vi.useFakeTimers({ shouldAdvanceTime: true });
      vi.advanceTimersByTime(61000);

      await detector.killAndRetry("FN-001", 60000);

      expect(detector.trackedCount).toBe(0);

      vi.useRealTimers();
    });

    it("logs to task log with reason", async () => {
      const session = createMockSession();
      detector.trackTask("FN-001", session);

      vi.useFakeTimers({ shouldAdvanceTime: true });
      vi.advanceTimersByTime(61000);

      await detector.killAndRetry("FN-001", 60000);

      expect(store.logEntry).toHaveBeenCalledWith(
        "FN-001",
        expect.stringContaining("Task terminated due to stuck agent session"),
      );
      expect(store.logEntry).toHaveBeenCalledWith(
        "FN-001",
        expect.stringContaining("reason=inactivity"),
      );

      vi.useRealTimers();
    });

    it("logs loop reason when activity detected", async () => {
      const session = createMockSession();
      vi.useFakeTimers({ shouldAdvanceTime: true });

      detector.trackTask("FN-001", session);
      vi.advanceTimersByTime(61000);

      // Simulate lots of activity (loop behavior)
      for (let i = 0; i < 80; i++) {
        detector.recordActivity("FN-001");
      }

      await detector.killAndRetry("FN-001", 60000);

      expect(store.logEntry).toHaveBeenCalledWith(
        "FN-001",
        expect.stringContaining("reason=loop"),
      );

      vi.useRealTimers();
    });

    it("updates task status and moves to todo", async () => {
      const session = createMockSession();
      detector.trackTask("FN-001", session);

      vi.useFakeTimers({ shouldAdvanceTime: true });
      vi.advanceTimersByTime(61000);

      await detector.killAndRetry("FN-001", 60000);

      expect(store.updateTask).toHaveBeenCalledWith("FN-001", { status: "stuck-killed" });
      expect(store.moveTask).toHaveBeenCalledWith("FN-001", "todo");

      vi.useRealTimers();
    });

    it("calls onStuck callback with structured event payload", async () => {
      const onStuck = vi.fn();
      const customDetector = new StuckTaskDetector(store, { onStuck });
      const session = createMockSession();

      customDetector.trackTask("FN-001", session);

      vi.useFakeTimers({ shouldAdvanceTime: true });
      vi.advanceTimersByTime(61000);

      await customDetector.killAndRetry("FN-001", 60000);

      expect(onStuck).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: "FN-001",
          reason: "inactivity",
          noProgressMs: expect.any(Number),
          inactivityMs: expect.any(Number),
          activitySinceProgress: 0,
        }),
      );

      vi.useRealTimers();
    });

    it("marks the abort via onStuck before disposing the session", async () => {
      let onStuckCalled = false;
      const onStuck = vi.fn(() => {
        onStuckCalled = true;
      });
      const customDetector = new StuckTaskDetector(store, { onStuck });
      const session = {
        dispose: vi.fn(() => {
          expect(onStuckCalled).toBe(true);
        }),
      };

      customDetector.trackTask("FN-001", session);

      vi.useFakeTimers({ shouldAdvanceTime: true });
      vi.advanceTimersByTime(61000);

      await customDetector.killAndRetry("FN-001", 60000);

      expect(onStuck).toHaveBeenCalledTimes(1);

      vi.useRealTimers();
    });

    it("calls onStuck with loop reason and activity count", async () => {
      const onStuck = vi.fn();
      const customDetector = new StuckTaskDetector(store, { onStuck });
      const session = createMockSession();

      vi.useFakeTimers({ shouldAdvanceTime: true });

      customDetector.trackTask("FN-001", session);
      vi.advanceTimersByTime(61000);

      for (let i = 0; i < 80; i++) {
        customDetector.recordActivity("FN-001");
      }

      await customDetector.killAndRetry("FN-001", 60000);

      expect(onStuck).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: "FN-001",
          reason: "loop",
          activitySinceProgress: 80,
        }),
      );

      vi.useRealTimers();
    });

    it("does nothing for untracked task", async () => {
      await detector.killAndRetry("FN-001", 60000);
      // Should not throw
      expect(store.moveTask).not.toHaveBeenCalled();
    });

    it("calls beforeRequeue and skips re-queue when it returns false", async () => {
      const beforeRequeue = vi.fn().mockResolvedValue(false);
      const onStuck = vi.fn();
      const customDetector = new StuckTaskDetector(store, { beforeRequeue, onStuck });
      const session = createMockSession();

      customDetector.trackTask("FN-001", session);

      vi.useFakeTimers({ shouldAdvanceTime: true });
      vi.advanceTimersByTime(61000);

      await customDetector.killAndRetry("FN-001", 60000);

      expect(beforeRequeue).toHaveBeenCalledWith("FN-001");
      expect(session.dispose).toHaveBeenCalled();
      // onStuck should still be called (so executor can mark stuck-aborted)
      expect(onStuck).toHaveBeenCalled();
      // But task should NOT be moved to todo
      expect(store.moveTask).not.toHaveBeenCalled();
      expect(store.updateTask).not.toHaveBeenCalledWith("FN-001", { status: "stuck-killed" });

      vi.useRealTimers();
    });

    it("calls beforeRequeue and proceeds with re-queue when it returns true", async () => {
      const beforeRequeue = vi.fn().mockResolvedValue(true);
      const customDetector = new StuckTaskDetector(store, { beforeRequeue });
      const session = createMockSession();

      customDetector.trackTask("FN-001", session);

      vi.useFakeTimers({ shouldAdvanceTime: true });
      vi.advanceTimersByTime(61000);

      await customDetector.killAndRetry("FN-001", 60000);

      expect(beforeRequeue).toHaveBeenCalledWith("FN-001");
      expect(store.updateTask).toHaveBeenCalledWith("FN-001", { status: "stuck-killed" });
      expect(store.moveTask).toHaveBeenCalledWith("FN-001", "todo");

      vi.useRealTimers();
    });

    it("falls through to re-queue when beforeRequeue throws", async () => {
      const beforeRequeue = vi.fn().mockRejectedValue(new Error("check failed"));
      const customDetector = new StuckTaskDetector(store, { beforeRequeue });
      const session = createMockSession();

      customDetector.trackTask("FN-001", session);

      vi.useFakeTimers({ shouldAdvanceTime: true });
      vi.advanceTimersByTime(61000);

      await customDetector.killAndRetry("FN-001", 60000);

      // Should still re-queue on error (safe fallback)
      expect(store.moveTask).toHaveBeenCalledWith("FN-001", "todo");

      vi.useRealTimers();
    });
  });

  describe("checkNow", () => {
    it("checks stuck tasks immediately", async () => {
      store = createMockStore({
        getSettings: vi.fn().mockResolvedValue({ taskStuckTimeoutMs: 60000 }),
      });
      const customDetector = new StuckTaskDetector(store);
      const session = createMockSession();

      customDetector.trackTask("FN-001", session);

      vi.useFakeTimers({ shouldAdvanceTime: true });
      vi.advanceTimersByTime(61000);

      await customDetector.checkNow();

      expect(store.moveTask).toHaveBeenCalledWith("FN-001", "todo");

      vi.useRealTimers();
    });
  });

  describe("checkStuckTasks (via polling)", () => {
    it("does nothing when no tasks tracked", async () => {
      store = createMockStore({
        getSettings: vi.fn().mockResolvedValue({ taskStuckTimeoutMs: 60000 }),
      });
      const customDetector = new StuckTaskDetector(store);

      // Start and let it poll
      customDetector.start();
      vi.useFakeTimers({ shouldAdvanceTime: true });
      vi.advanceTimersByTime(35000); // Default poll interval is 30s

      expect(store.moveTask).not.toHaveBeenCalled();

      customDetector.stop();
      vi.useRealTimers();
    });

    it("does nothing when timeout is disabled", async () => {
      store = createMockStore({
        getSettings: vi.fn().mockResolvedValue({ taskStuckTimeoutMs: undefined }),
      });
      const customDetector = new StuckTaskDetector(store);
      const session = createMockSession();

      customDetector.trackTask("FN-001", session);

      vi.useFakeTimers({ shouldAdvanceTime: true });
      vi.advanceTimersByTime(61000);

      await customDetector.checkNow();

      expect(store.moveTask).not.toHaveBeenCalled();

      vi.useRealTimers();
    });

    it("does nothing when timeout is zero or negative", async () => {
      store = createMockStore({
        getSettings: vi.fn().mockResolvedValue({ taskStuckTimeoutMs: 0 }),
      });
      const customDetector = new StuckTaskDetector(store);
      const session = createMockSession();

      customDetector.trackTask("FN-001", session);

      vi.useFakeTimers({ shouldAdvanceTime: true });
      vi.advanceTimersByTime(61000);

      await customDetector.checkNow();

      expect(store.moveTask).not.toHaveBeenCalled();

      vi.useRealTimers();
    });

    it("skips check when settings cannot be read", async () => {
      store = createMockStore({
        getSettings: vi.fn().mockRejectedValue(new Error("Settings error")),
      });
      const customDetector = new StuckTaskDetector(store);
      const session = createMockSession();

      customDetector.trackTask("FN-001", session);

      vi.useFakeTimers({ shouldAdvanceTime: true });
      vi.advanceTimersByTime(61000);

      await customDetector.checkNow();

      // Should not throw, just skip
      expect(store.moveTask).not.toHaveBeenCalled();

      vi.useRealTimers();
    });
  });

  describe("dual detection: inactivity vs loop", () => {
    it("detects inactivity when agent goes silent (no text/tool calls)", async () => {
      store = createMockStore({
        getSettings: vi.fn().mockResolvedValue({ taskStuckTimeoutMs: 60000 }),
      });
      const onStuck = vi.fn();
      const customDetector = new StuckTaskDetector(store, { onStuck });
      const session = createMockSession();

      customDetector.trackTask("FN-001", session);

      vi.useFakeTimers({ shouldAdvanceTime: true });
      // No activity at all for 61 seconds
      vi.advanceTimersByTime(61000);

      await customDetector.checkNow();

      expect(onStuck).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: "FN-001",
          reason: "inactivity",
          activitySinceProgress: 0,
        }),
      );
      expect(store.moveTask).toHaveBeenCalledWith("FN-001", "todo");

      vi.useRealTimers();
    });

    it("detects loop when agent is active but not making step progress", async () => {
      store = createMockStore({
        getSettings: vi.fn().mockResolvedValue({ taskStuckTimeoutMs: 60000 }),
      });
      const onStuck = vi.fn();
      const customDetector = new StuckTaskDetector(store, { onStuck });
      const session = createMockSession();

      vi.useFakeTimers({ shouldAdvanceTime: true });

      customDetector.trackTask("FN-001", session);

      // Advance past timeout
      vi.advanceTimersByTime(61000);

      // Agent is actively generating text/tool calls but not advancing steps
      for (let i = 0; i < 100; i++) {
        customDetector.recordActivity("FN-001");
      }

      await customDetector.checkNow();

      expect(onStuck).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: "FN-001",
          reason: "loop",
          activitySinceProgress: 100,
          noProgressMs: expect.any(Number),
        }),
      );

      vi.useRealTimers();
    });

    it("does not trigger loop when activity is below threshold", async () => {
      store = createMockStore({
        getSettings: vi.fn().mockResolvedValue({ taskStuckTimeoutMs: 60000 }),
      });
      const onStuck = vi.fn();
      const customDetector = new StuckTaskDetector(store, { onStuck });
      const session = createMockSession();

      vi.useFakeTimers({ shouldAdvanceTime: true });

      customDetector.trackTask("FN-001", session);

      // Advance past timeout
      vi.advanceTimersByTime(61000);

      // Only 30 activity events (below threshold of 60)
      for (let i = 0; i < 30; i++) {
        customDetector.recordActivity("FN-001");
      }

      await customDetector.checkNow();

      // Should NOT trigger — activity is recent but below loop threshold
      expect(onStuck).not.toHaveBeenCalled();

      vi.useRealTimers();
    });

    it("progress resets counters and prevents loop detection", async () => {
      store = createMockStore({
        getSettings: vi.fn().mockResolvedValue({ taskStuckTimeoutMs: 60000 }),
      });
      const onStuck = vi.fn();
      const customDetector = new StuckTaskDetector(store, { onStuck });
      const session = createMockSession();

      vi.useFakeTimers({ shouldAdvanceTime: true });

      customDetector.trackTask("FN-001", session);

      // Advance past timeout and generate lots of activity
      vi.advanceTimersByTime(61000);
      for (let i = 0; i < 100; i++) {
        customDetector.recordActivity("FN-001");
      }

      // This would be a loop...
      await customDetector.checkNow();
      expect(onStuck).toHaveBeenCalledTimes(1);

      vi.useRealTimers();
    });

    it("timeout disabled disables both inactivity and loop paths", async () => {
      store = createMockStore({
        getSettings: vi.fn().mockResolvedValue({ taskStuckTimeoutMs: undefined }),
      });
      const onStuck = vi.fn();
      const customDetector = new StuckTaskDetector(store, { onStuck });
      const session = createMockSession();

      vi.useFakeTimers({ shouldAdvanceTime: true });

      customDetector.trackTask("FN-001", session);
      vi.advanceTimersByTime(61000);

      // Even with lots of activity
      for (let i = 0; i < 100; i++) {
        customDetector.recordActivity("FN-001");
      }

      await customDetector.checkNow();

      expect(onStuck).not.toHaveBeenCalled();

      vi.useRealTimers();
    });
  });
});
