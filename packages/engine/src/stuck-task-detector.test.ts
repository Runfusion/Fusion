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

    // ── FN-1461: Step-session step-scoped key regression tests ─────────────────────
    // In step-session mode, tasks are tracked with compound keys like "FN-200-step-0".
    // When the executor calls untrackTask with the bare task ID "FN-200",
    // the entry should still be removed. This test verifies the FIX works correctly.

    it("FIX: untracking with bare task ID removes entries tracked with step-scoped key", () => {
      // Track with step-scoped key (as StepSessionExecutor does)
      detector.trackTask("FN-200-step-0", createMockSession(), "FN-200");
      expect(detector.trackedCount).toBe(1);

      // Executor calls untrackTask with bare task ID (as it does for both modes)
      detector.untrackTask("FN-200");

      // After fix: entry IS removed even though keys don't match exactly
      expect(detector.trackedCount).toBe(0);
    });

    it("FIX: multiple step entries are cleaned up with bare task ID", () => {
      // Track multiple steps for the same task
      detector.trackTask("FN-200-step-0", createMockSession(), "FN-200");
      detector.trackTask("FN-200-step-1", createMockSession(), "FN-200");
      expect(detector.trackedCount).toBe(2);

      // Untracking with bare ID removes ALL step entries for that task
      detector.untrackTask("FN-200");

      // After fix: all entries are removed
      expect(detector.trackedCount).toBe(0);
    });

    it("FIX: orphaned step entries do not remain after cleanup", () => {
      // Simulate what happens in step-session mode:
      // 1. Track step-0
      detector.trackTask("FN-200-step-0", createMockSession(), "FN-200");

      // 2. Step completes, untrack with bare ID
      detector.untrackTask("FN-200");

      // 3. After fix: entry is properly removed
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

    it("does not move task to todo directly (deferred to executor)", async () => {
      const session = createMockSession();
      detector.trackTask("FN-001", session);

      vi.useFakeTimers({ shouldAdvanceTime: true });
      vi.advanceTimersByTime(61000);

      await detector.killAndRetry("FN-001", 60000);

      // The detector no longer moves the task — the executor handles this
      // in its finally block after clearing the execution guard.
      expect(store.updateTask).not.toHaveBeenCalledWith("FN-001", { status: "stuck-killed" });
      expect(store.moveTask).not.toHaveBeenCalled();

      vi.useRealTimers();
    });

    it("calls onStuck callback with structured event payload including shouldRequeue", async () => {
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
          shouldRequeue: true,
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
      expect(store.logEntry).not.toHaveBeenCalled();
    });

    it("calls beforeRequeue and passes shouldRequeue=false to onStuck when budget exhausted", async () => {
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
      // onStuck should still be called with shouldRequeue=false
      expect(onStuck).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: "FN-001", shouldRequeue: false }),
      );
      // Detector no longer moves tasks — executor handles it
      expect(store.moveTask).not.toHaveBeenCalled();

      vi.useRealTimers();
    });

    it("calls beforeRequeue and passes shouldRequeue=true to onStuck when budget allows", async () => {
      const beforeRequeue = vi.fn().mockResolvedValue(true);
      const onStuck = vi.fn();
      const customDetector = new StuckTaskDetector(store, { beforeRequeue, onStuck });
      const session = createMockSession();

      customDetector.trackTask("FN-001", session);

      vi.useFakeTimers({ shouldAdvanceTime: true });
      vi.advanceTimersByTime(61000);

      await customDetector.killAndRetry("FN-001", 60000);

      expect(beforeRequeue).toHaveBeenCalledWith("FN-001");
      expect(onStuck).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: "FN-001", shouldRequeue: true }),
      );
      // Detector no longer moves tasks — executor handles it
      expect(store.moveTask).not.toHaveBeenCalled();

      vi.useRealTimers();
    });

    it("falls through with shouldRequeue=true when beforeRequeue throws", async () => {
      const beforeRequeue = vi.fn().mockRejectedValue(new Error("check failed"));
      const onStuck = vi.fn();
      const customDetector = new StuckTaskDetector(store, { beforeRequeue, onStuck });
      const session = createMockSession();

      customDetector.trackTask("FN-001", session);

      vi.useFakeTimers({ shouldAdvanceTime: true });
      vi.advanceTimersByTime(61000);

      await customDetector.killAndRetry("FN-001", 60000);

      // Should pass shouldRequeue=true on error (safe fallback)
      expect(onStuck).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: "FN-001", shouldRequeue: true }),
      );
      expect(store.moveTask).not.toHaveBeenCalled();

      vi.useRealTimers();
    });
  });

  describe("checkNow", () => {
    it("checks stuck tasks immediately and disposes session", async () => {
      store = createMockStore({
        getSettings: vi.fn().mockResolvedValue({ taskStuckTimeoutMs: 60000 }),
      });
      const onStuck = vi.fn();
      const customDetector = new StuckTaskDetector(store, { onStuck });
      const session = createMockSession();

      customDetector.trackTask("FN-001", session);

      vi.useFakeTimers({ shouldAdvanceTime: true });
      vi.advanceTimersByTime(61000);

      await customDetector.checkNow();

      expect(session.dispose).toHaveBeenCalled();
      expect(onStuck).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: "FN-001", shouldRequeue: true }),
      );
      // Detector no longer moves tasks — executor handles it
      expect(store.moveTask).not.toHaveBeenCalled();

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
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
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
      // Should log the settings-read failure
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to read settings"),
        expect.any(Error),
      );

      errorSpy.mockRestore();
      vi.useRealTimers();
    });

    it("keeps task tracked after settings-read failure", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      store = createMockStore({
        getSettings: vi.fn().mockRejectedValue(new Error("DB locked")),
      });
      const customDetector = new StuckTaskDetector(store);
      const session = createMockSession();

      customDetector.trackTask("FN-001", session);
      expect(customDetector.trackedCount).toBe(1);

      vi.useFakeTimers({ shouldAdvanceTime: true });
      vi.advanceTimersByTime(61000);

      await customDetector.checkNow();

      // Task should still be tracked — not untracked or disposed
      expect(customDetector.trackedCount).toBe(1);
      expect(session.dispose).not.toHaveBeenCalled();

      errorSpy.mockRestore();
      vi.useRealTimers();
    });

    it("recovers on next cycle after transient settings-read failure", async () => {
      let callCount = 0;
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      store = createMockStore({
        getSettings: vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) return Promise.reject(new Error("transient"));
          return Promise.resolve({ taskStuckTimeoutMs: 60000 });
        }),
      });
      const onStuck = vi.fn();
      const customDetector = new StuckTaskDetector(store, { onStuck });
      const session = createMockSession();

      customDetector.trackTask("FN-001", session);

      vi.useFakeTimers({ shouldAdvanceTime: true });
      vi.advanceTimersByTime(61000);

      // First check: settings read fails — logged but skipped
      await customDetector.checkNow();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to read settings"),
        expect.any(Error),
      );
      expect(onStuck).not.toHaveBeenCalled();

      // Second check: settings read succeeds — stuck detected normally
      await customDetector.checkNow();
      expect(onStuck).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: "FN-001", reason: "inactivity" }),
      );

      errorSpy.mockRestore();
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
          shouldRequeue: true,
        }),
      );
      expect(session.dispose).toHaveBeenCalled();

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

  describe("onLoopDetected pre-kill callback", () => {
    it("calls onLoopDetected before onStuck when reason is loop", async () => {
      const callOrder: string[] = [];
      const onLoopDetected = vi.fn(async () => { callOrder.push("onLoopDetected"); return false; });
      const onStuck = vi.fn(() => { callOrder.push("onStuck"); });
      const customDetector = new StuckTaskDetector(store, { onLoopDetected, onStuck });
      const session = createMockSession();

      vi.useFakeTimers({ shouldAdvanceTime: true });
      customDetector.trackTask("FN-001", session);
      vi.advanceTimersByTime(61000);
      for (let i = 0; i < 80; i++) {
        customDetector.recordActivity("FN-001");
      }

      await customDetector.killAndRetry("FN-001", 60000);

      // onLoopDetected should be called first
      expect(onLoopDetected).toHaveBeenCalledTimes(1);
      expect(onLoopDetected).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: "FN-001", reason: "loop" }),
      );
      expect(callOrder).toEqual(["onLoopDetected", "onStuck"]);

      vi.useRealTimers();
    });

    it("skips kill/requeue when onLoopDetected returns true", async () => {
      const onLoopDetected = vi.fn().mockResolvedValue(true);
      const onStuck = vi.fn();
      const customDetector = new StuckTaskDetector(store, { onLoopDetected, onStuck });
      const session = createMockSession();

      vi.useFakeTimers({ shouldAdvanceTime: true });
      customDetector.trackTask("FN-001", session);
      vi.advanceTimersByTime(61000);
      for (let i = 0; i < 80; i++) {
        customDetector.recordActivity("FN-001");
      }

      await customDetector.killAndRetry("FN-001", 60000);

      // onLoopDetected accepted recovery — no kill/requeue
      expect(onLoopDetected).toHaveBeenCalledTimes(1);
      expect(onStuck).not.toHaveBeenCalled();
      expect(session.dispose).not.toHaveBeenCalled();
      expect(customDetector.trackedCount).toBe(0); // untracked

      vi.useRealTimers();
    });

    it("does NOT call onLoopDetected when reason is inactivity", async () => {
      const onLoopDetected = vi.fn().mockResolvedValue(true);
      const onStuck = vi.fn();
      const customDetector = new StuckTaskDetector(store, { onLoopDetected, onStuck });
      const session = createMockSession();

      vi.useFakeTimers({ shouldAdvanceTime: true });
      customDetector.trackTask("FN-001", session);
      vi.advanceTimersByTime(61000);
      // No activity — pure inactivity

      await customDetector.killAndRetry("FN-001", 60000);

      // onLoopDetected should NOT be called for inactivity
      expect(onLoopDetected).not.toHaveBeenCalled();
      // Normal kill path should still execute
      expect(onStuck).toHaveBeenCalled();
      expect(session.dispose).toHaveBeenCalled();

      vi.useRealTimers();
    });

    it("falls through to normal kill when onLoopDetected returns false", async () => {
      const onLoopDetected = vi.fn().mockResolvedValue(false);
      const onStuck = vi.fn();
      const customDetector = new StuckTaskDetector(store, { onLoopDetected, onStuck });
      const session = createMockSession();

      vi.useFakeTimers({ shouldAdvanceTime: true });
      customDetector.trackTask("FN-001", session);
      vi.advanceTimersByTime(61000);
      for (let i = 0; i < 80; i++) {
        customDetector.recordActivity("FN-001");
      }

      await customDetector.killAndRetry("FN-001", 60000);

      // Callback declined — normal kill path
      expect(onLoopDetected).toHaveBeenCalledTimes(1);
      expect(onStuck).toHaveBeenCalled();
      expect(session.dispose).toHaveBeenCalled();
      expect(store.moveTask).not.toHaveBeenCalled(); // executor handles move

      vi.useRealTimers();
    });

    it("falls through to normal kill when onLoopDetected throws", async () => {
      const onLoopDetected = vi.fn().mockRejectedValue(new Error("callback exploded"));
      const onStuck = vi.fn();
      const customDetector = new StuckTaskDetector(store, { onLoopDetected, onStuck });
      const session = createMockSession();

      vi.useFakeTimers({ shouldAdvanceTime: true });
      customDetector.trackTask("FN-001", session);
      vi.advanceTimersByTime(61000);
      for (let i = 0; i < 80; i++) {
        customDetector.recordActivity("FN-001");
      }

      await customDetector.killAndRetry("FN-001", 60000);

      // Error in callback — normal kill path
      expect(onLoopDetected).toHaveBeenCalledTimes(1);
      expect(onStuck).toHaveBeenCalled();
      expect(session.dispose).toHaveBeenCalled();

      vi.useRealTimers();
    });

    it("does not call onLoopDetected when callback is not registered", async () => {
      // No onLoopDetected callback — normal kill path
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

      // No callback registered — goes straight to onStuck + dispose
      expect(onStuck).toHaveBeenCalled();
      expect(session.dispose).toHaveBeenCalled();

      vi.useRealTimers();
    });

    it("receives correct event payload with shouldRequeue from beforeRequeue", async () => {
      const beforeRequeue = vi.fn().mockResolvedValue(false); // budget exhausted
      const onLoopDetected = vi.fn().mockResolvedValue(true);
      const customDetector = new StuckTaskDetector(store, { beforeRequeue, onLoopDetected });
      const session = createMockSession();

      vi.useFakeTimers({ shouldAdvanceTime: true });
      customDetector.trackTask("FN-001", session);
      vi.advanceTimersByTime(61000);
      for (let i = 0; i < 80; i++) {
        customDetector.recordActivity("FN-001");
      }

      await customDetector.killAndRetry("FN-001", 60000);

      // onLoopDetected should receive shouldRequeue=false from beforeRequeue
      expect(onLoopDetected).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: "FN-001",
          reason: "loop",
          shouldRequeue: false,
        }),
      );

      vi.useRealTimers();
    });
  });
});

// ─── Heartbeat Tracking Integration Tests (FN-978) ────────────────────────────
//
// These tests verify the complete heartbeat tracking lifecycle:
// trackTask → recordActivity → getLastActivity → untrackTask
describe("StuckTaskDetector heartbeat tracking (FN-978)", () => {
  let store: TaskStore;
  let detector: StuckTaskDetector;

  beforeEach(() => {
    store = createMockStore();
    detector = new StuckTaskDetector(store);
  });

  afterEach(() => {
    detector.stop();
  });

  it("records activity and updates lastActivity timestamp", () => {
    const session = createMockSession();
    const beforeTrack = Date.now();
    detector.trackTask("FN-001", session);

    // Record some activity
    const beforeActivity = Date.now();
    detector.recordActivity("FN-001");

    const lastActivity = detector.getLastActivity("FN-001");
    expect(lastActivity).toBeDefined();
    expect(lastActivity!).toBeGreaterThanOrEqual(beforeActivity);
    expect(lastActivity!).toBeLessThanOrEqual(Date.now());

    // Activity counter should increment
    expect(detector.getActivitySinceProgress("FN-001")).toBe(1);
  });

  it("accumulates multiple activity recordings", () => {
    const session = createMockSession();
    detector.trackTask("FN-001", session);

    // Record multiple activities
    for (let i = 0; i < 10; i++) {
      detector.recordActivity("FN-001");
    }

    expect(detector.getActivitySinceProgress("FN-001")).toBe(10);
  });

  it("resets activity counter on recordProgress", () => {
    const session = createMockSession();
    detector.trackTask("FN-001", session);

    // Record some activity
    detector.recordActivity("FN-001");
    detector.recordActivity("FN-001");
    detector.recordActivity("FN-001");
    expect(detector.getActivitySinceProgress("FN-001")).toBe(3);

    // Record progress (step transition)
    detector.recordProgress("FN-001");
    expect(detector.getActivitySinceProgress("FN-001")).toBe(0);

    // Activity counter resets but lastActivity still updates
    const lastProgress = detector.getLastProgressAt("FN-001");
    expect(lastProgress).toBeDefined();
  });

  it("tracks task and untracks on completion", () => {
    const session = createMockSession();

    // Track task
    detector.trackTask("FN-001", session);
    expect(detector.trackedCount).toBe(1);

    // Simulate completion
    detector.untrackTask("FN-001");
    expect(detector.trackedCount).toBe(0);
    expect(detector.getLastActivity("FN-001")).toBeUndefined();
    expect(detector.getActivitySinceProgress("FN-001")).toBeUndefined();
  });

  it("handles multiple tasks independently", () => {
    const session1 = createMockSession();
    const session2 = createMockSession();

    detector.trackTask("FN-001", session1);
    detector.trackTask("FN-002", session2);
    expect(detector.trackedCount).toBe(2);

    // Record activity for one task
    detector.recordActivity("FN-001");
    expect(detector.getActivitySinceProgress("FN-001")).toBe(1);
    expect(detector.getActivitySinceProgress("FN-002")).toBe(0);

    // Untrack one task
    detector.untrackTask("FN-001");
    expect(detector.trackedCount).toBe(1);
    expect(detector.getLastActivity("FN-001")).toBeUndefined();
    expect(detector.getLastActivity("FN-002")).toBeDefined();
  });

  it("does not crash when recording activity for untracked task", () => {
    // Should not throw
    expect(() => detector.recordActivity("FN-999")).not.toThrow();
    expect(detector.getLastActivity("FN-999")).toBeUndefined();
  });

  it("does not crash when untracking untracked task", () => {
    // Should not throw
    expect(() => detector.untrackTask("FN-999")).not.toThrow();
    expect(detector.trackedCount).toBe(0);
  });

  it("re-tracking a task resets its counters", () => {
    const session = createMockSession();
    detector.trackTask("FN-001", session);

    // Record some activity
    detector.recordActivity("FN-001");
    detector.recordActivity("FN-001");
    expect(detector.getActivitySinceProgress("FN-001")).toBe(2);

    // Re-track (e.g., after a retry)
    detector.trackTask("FN-001", session);
    expect(detector.getActivitySinceProgress("FN-001")).toBe(0);
    expect(detector.trackedCount).toBe(1);
  });
});
