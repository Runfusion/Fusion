import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { StuckTaskDetector, type DisposableSession } from "./stuck-task-detector.js";
import type { Settings } from "@kb/core";

// Mock the logger
vi.mock("./logger.js", () => ({
  createLogger: () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

/** Minimal mock store that satisfies StuckTaskDetector's needs. */
function createMockStore(settings: Partial<Settings> = {}) {
  const defaultSettings: Settings = {
    maxConcurrent: 2,
    maxWorktrees: 4,
    pollIntervalMs: 15000,
    groupOverlappingFiles: false,
    autoMerge: true,
    taskStuckTimeoutMs: undefined,
    ...settings,
  };

  const store: any = {
    _settings: { ...defaultSettings },
    getSettings: vi.fn(async () => ({ ...store._settings })),
    logEntry: vi.fn(async () => {}),
    updateTask: vi.fn(async () => ({})),
    moveTask: vi.fn(async () => ({})),
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
  };
  return store;
}

function createMockSession(): DisposableSession & { dispose: ReturnType<typeof vi.fn> } {
  return { dispose: vi.fn() };
}

describe("StuckTaskDetector", () => {
  let detector: StuckTaskDetector;

  afterEach(() => {
    detector?.stop();
    vi.restoreAllMocks();
  });

  describe("trackTask / untrackTask", () => {
    it("records initial activity timestamp when tracking a task", () => {
      const store = createMockStore();
      detector = new StuckTaskDetector(store);

      const session = createMockSession();
      const before = Date.now();
      detector.trackTask("KB-001", session);
      const after = Date.now();

      const lastActivity = detector.getLastActivity("KB-001");
      expect(lastActivity).toBeDefined();
      expect(lastActivity).toBeGreaterThanOrEqual(before);
      expect(lastActivity).toBeLessThanOrEqual(after);
    });

    it("returns undefined for untracked tasks", () => {
      const store = createMockStore();
      detector = new StuckTaskDetector(store);

      expect(detector.getLastActivity("KB-999")).toBeUndefined();
    });

    it("removes task from monitoring on untrack", () => {
      const store = createMockStore();
      detector = new StuckTaskDetector(store);

      const session = createMockSession();
      detector.trackTask("KB-001", session);
      expect(detector.trackedCount).toBe(1);

      detector.untrackTask("KB-001");
      expect(detector.trackedCount).toBe(0);
      expect(detector.getLastActivity("KB-001")).toBeUndefined();
    });

    it("is a no-op when untracking a non-existent task", () => {
      const store = createMockStore();
      detector = new StuckTaskDetector(store);

      // Should not throw
      detector.untrackTask("KB-999");
      expect(detector.trackedCount).toBe(0);
    });
  });

  describe("recordActivity", () => {
    it("updates the activity timestamp", async () => {
      const store = createMockStore();
      detector = new StuckTaskDetector(store);

      const session = createMockSession();
      detector.trackTask("KB-001", session);
      const initial = detector.getLastActivity("KB-001")!;

      // Wait a small amount to ensure timestamp differs
      await new Promise((resolve) => setTimeout(resolve, 5));

      detector.recordActivity("KB-001");
      const updated = detector.getLastActivity("KB-001")!;

      expect(updated).toBeGreaterThanOrEqual(initial);
    });

    it("is a no-op for untracked tasks", () => {
      const store = createMockStore();
      detector = new StuckTaskDetector(store);

      // Should not throw
      detector.recordActivity("KB-999");
      expect(detector.getLastActivity("KB-999")).toBeUndefined();
    });
  });

  describe("isStuck", () => {
    it("returns true when elapsed time exceeds timeout", () => {
      const store = createMockStore();
      detector = new StuckTaskDetector(store);

      const session = createMockSession();
      detector.trackTask("KB-001", session);

      // Manually backdate the activity to simulate stagnation
      const entry = (detector as any).tracked.get("KB-001");
      entry.lastActivity = Date.now() - 600_001; // 10 minutes + 1ms

      expect(detector.isStuck("KB-001", 600_000)).toBe(true);
    });

    it("returns false when elapsed time is within timeout", () => {
      const store = createMockStore();
      detector = new StuckTaskDetector(store);

      const session = createMockSession();
      detector.trackTask("KB-001", session);

      // Just tracked — should not be stuck
      expect(detector.isStuck("KB-001", 600_000)).toBe(false);
    });

    it("returns false for untracked tasks", () => {
      const store = createMockStore();
      detector = new StuckTaskDetector(store);

      expect(detector.isStuck("KB-999", 600_000)).toBe(false);
    });
  });

  describe("killAndRetry", () => {
    it("disposes the session and moves task to todo", async () => {
      const store = createMockStore();
      const onStuck = vi.fn();
      detector = new StuckTaskDetector(store, { onStuck });

      const session = createMockSession();
      detector.trackTask("KB-001", session);

      await detector.killAndRetry("KB-001", 600_000);

      // Session disposed
      expect(session.dispose).toHaveBeenCalledOnce();

      // Task logged
      expect(store.logEntry).toHaveBeenCalledWith(
        "KB-001",
        expect.stringContaining("stuck agent session"),
      );

      // Task set to transient "stuck-killed" status then moved to todo
      expect(store.updateTask).toHaveBeenCalledWith("KB-001", { status: "stuck-killed" });
      expect(store.moveTask).toHaveBeenCalledWith("KB-001", "todo");

      // Callback invoked
      expect(onStuck).toHaveBeenCalledWith("KB-001");

      // Task untracked
      expect(detector.trackedCount).toBe(0);
    });

    it("is a no-op for untracked tasks", async () => {
      const store = createMockStore();
      detector = new StuckTaskDetector(store);

      await detector.killAndRetry("KB-999", 600_000);

      expect(store.logEntry).not.toHaveBeenCalled();
      expect(store.moveTask).not.toHaveBeenCalled();
    });

    it("sets transient stuck-killed status then moves to todo", async () => {
      const store = createMockStore();
      detector = new StuckTaskDetector(store);

      const session = createMockSession();
      detector.trackTask("KB-001", session);

      await detector.killAndRetry("KB-001", 600_000);

      // First updateTask sets "stuck-killed" (transient status)
      expect(store.updateTask).toHaveBeenCalledWith("KB-001", { status: "stuck-killed" });
      // Then moveTask moves to "todo" — moveTask automatically clears status
      expect(store.moveTask).toHaveBeenCalledWith("KB-001", "todo");
      // Only one updateTask call (the stuck-killed one) — no explicit clear needed
      expect(store.updateTask).toHaveBeenCalledTimes(1);
    });

    it("preserves step progress — does not reset currentStep", async () => {
      const store = createMockStore();
      detector = new StuckTaskDetector(store);

      const session = createMockSession();
      detector.trackTask("KB-001", session);

      await detector.killAndRetry("KB-001", 600_000);

      // updateTask should NOT set currentStep or steps — they're preserved
      for (const call of store.updateTask.mock.calls) {
        const [, update] = call;
        expect(update).not.toHaveProperty("currentStep");
        expect(update).not.toHaveProperty("steps");
      }
    });

    it("handles session dispose errors gracefully", async () => {
      const store = createMockStore();
      detector = new StuckTaskDetector(store);

      const session = createMockSession();
      session.dispose.mockImplementation(() => {
        throw new Error("Session already disposed");
      });
      detector.trackTask("KB-001", session);

      // Should not throw
      await detector.killAndRetry("KB-001", 600_000);

      // Should still proceed to move task
      expect(store.moveTask).toHaveBeenCalledWith("KB-001", "todo");
    });
  });

  describe("checkStuckTasks (via polling)", () => {
    it("kills only tasks exceeding the timeout", async () => {
      const store = createMockStore({ taskStuckTimeoutMs: 60_000 });
      const onStuck = vi.fn();
      detector = new StuckTaskDetector(store, { onStuck });

      const session1 = createMockSession();
      const session2 = createMockSession();

      detector.trackTask("KB-001", session1);
      detector.trackTask("KB-002", session2);

      // Backdate KB-001 to be stuck
      const entry1 = (detector as any).tracked.get("KB-001");
      entry1.lastActivity = Date.now() - 120_000; // 2 minutes ago (> 60s timeout)

      // KB-002 is still recent (just tracked)

      // Trigger check manually
      await (detector as any).checkStuckTasks();

      // Only KB-001 should be killed
      expect(session1.dispose).toHaveBeenCalledOnce();
      expect(session2.dispose).not.toHaveBeenCalled();
      expect(onStuck).toHaveBeenCalledWith("KB-001");
      expect(onStuck).not.toHaveBeenCalledWith("KB-002");
    });

    it("does nothing when taskStuckTimeoutMs is undefined (disabled)", async () => {
      const store = createMockStore({ taskStuckTimeoutMs: undefined });
      detector = new StuckTaskDetector(store);

      const session = createMockSession();
      detector.trackTask("KB-001", session);

      // Backdate to be "stuck"
      const entry = (detector as any).tracked.get("KB-001");
      entry.lastActivity = Date.now() - 9999_000;

      await (detector as any).checkStuckTasks();

      // Should not kill anything since feature is disabled
      expect(session.dispose).not.toHaveBeenCalled();
    });

    it("does nothing when taskStuckTimeoutMs is 0", async () => {
      const store = createMockStore({ taskStuckTimeoutMs: 0 });
      detector = new StuckTaskDetector(store);

      const session = createMockSession();
      detector.trackTask("KB-001", session);

      const entry = (detector as any).tracked.get("KB-001");
      entry.lastActivity = Date.now() - 9999_000;

      await (detector as any).checkStuckTasks();

      expect(session.dispose).not.toHaveBeenCalled();
    });

    it("does nothing when no tasks are tracked", async () => {
      const store = createMockStore({ taskStuckTimeoutMs: 60_000 });
      detector = new StuckTaskDetector(store);

      // Should not throw or call settings
      await (detector as any).checkStuckTasks();

      expect(store.getSettings).not.toHaveBeenCalled();
    });

    it("respects dynamically changed timeout values", async () => {
      const store = createMockStore({ taskStuckTimeoutMs: 300_000 }); // 5 minutes
      const onStuck = vi.fn();
      detector = new StuckTaskDetector(store, { onStuck });

      const session = createMockSession();
      detector.trackTask("KB-001", session);

      // Backdate to 2 minutes ago
      const entry = (detector as any).tracked.get("KB-001");
      entry.lastActivity = Date.now() - 120_000;

      // With 5-minute timeout, should not be stuck
      await (detector as any).checkStuckTasks();
      expect(onStuck).not.toHaveBeenCalled();

      // Change settings to 1-minute timeout
      store._settings.taskStuckTimeoutMs = 60_000;

      // Now it should be detected as stuck (120s > 60s)
      await (detector as any).checkStuckTasks();
      expect(onStuck).toHaveBeenCalledWith("KB-001");
    });
  });

  describe("checkNow (immediate check)", () => {
    it("detects and kills stuck tasks immediately", async () => {
      const store = createMockStore({ taskStuckTimeoutMs: 60_000 });
      const onStuck = vi.fn();
      detector = new StuckTaskDetector(store, { onStuck });

      const session = createMockSession();
      detector.trackTask("KB-001", session);

      // Backdate to be stuck (2 minutes > 1 minute timeout)
      const entry = (detector as any).tracked.get("KB-001");
      entry.lastActivity = Date.now() - 120_000;

      // Call checkNow instead of polling
      await detector.checkNow();

      // Should kill the stuck task
      expect(session.dispose).toHaveBeenCalledOnce();
      expect(onStuck).toHaveBeenCalledWith("KB-001");
      expect(detector.trackedCount).toBe(0);
    });

    it("is safe to call when no tasks are tracked", async () => {
      const store = createMockStore({ taskStuckTimeoutMs: 60_000 });
      detector = new StuckTaskDetector(store);

      // Should not throw or call settings when no tasks tracked
      await detector.checkNow();

      expect(store.getSettings).not.toHaveBeenCalled();
    });

    it("is safe to call when timeout is disabled (undefined)", async () => {
      const store = createMockStore({ taskStuckTimeoutMs: undefined });
      detector = new StuckTaskDetector(store);

      const session = createMockSession();
      detector.trackTask("KB-001", session);

      // Backdate to be "stuck"
      const entry = (detector as any).tracked.get("KB-001");
      entry.lastActivity = Date.now() - 9999_000;

      // Should not throw or kill anything
      await detector.checkNow();

      expect(session.dispose).not.toHaveBeenCalled();
      expect(detector.trackedCount).toBe(1); // Still tracked
    });

    it("respects current timeout value from settings", async () => {
      const store = createMockStore({ taskStuckTimeoutMs: 300_000 }); // 5 minutes
      const onStuck = vi.fn();
      detector = new StuckTaskDetector(store, { onStuck });

      const session = createMockSession();
      detector.trackTask("KB-001", session);

      // Backdate to 2 minutes ago
      const entry = (detector as any).tracked.get("KB-001");
      entry.lastActivity = Date.now() - 120_000;

      // With 5-minute timeout, should not be stuck
      await detector.checkNow();
      expect(onStuck).not.toHaveBeenCalled();
      expect(session.dispose).not.toHaveBeenCalled();

      // Change settings to 1-minute timeout
      store._settings.taskStuckTimeoutMs = 60_000;

      // Now checkNow should detect it as stuck
      await detector.checkNow();
      expect(onStuck).toHaveBeenCalledWith("KB-001");
      expect(session.dispose).toHaveBeenCalledOnce();
    });

    it("is safe to call when detector is stopped", async () => {
      const store = createMockStore({ taskStuckTimeoutMs: 60_000 });
      const onStuck = vi.fn();
      detector = new StuckTaskDetector(store, { onStuck });

      const session = createMockSession();
      detector.trackTask("KB-001", session);

      // Backdate to be stuck
      const entry = (detector as any).tracked.get("KB-001");
      entry.lastActivity = Date.now() - 120_000;

      // Don't start the detector - just call checkNow
      await detector.checkNow();

      // Should still work even though detector was never started
      expect(session.dispose).toHaveBeenCalledOnce();
      expect(onStuck).toHaveBeenCalledWith("KB-001");
    });
  });

  describe("start / stop", () => {
    it("starts polling and can be stopped", async () => {
      const store = createMockStore({ taskStuckTimeoutMs: 100 });
      detector = new StuckTaskDetector(store, { pollIntervalMs: 50 });

      const session = createMockSession();
      detector.trackTask("KB-001", session);

      // Backdate to trigger stuck detection
      const entry = (detector as any).tracked.get("KB-001");
      entry.lastActivity = Date.now() - 200;

      detector.start();

      // Wait for at least one poll cycle
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Should have detected and killed the stuck task
      expect(session.dispose).toHaveBeenCalled();

      detector.stop();
    });

    it("stop prevents further checks", async () => {
      const store = createMockStore({ taskStuckTimeoutMs: 100 });
      const onStuck = vi.fn();
      detector = new StuckTaskDetector(store, { pollIntervalMs: 30, onStuck });

      detector.start();
      detector.stop();

      const session = createMockSession();
      detector.trackTask("KB-001", session);
      const entry = (detector as any).tracked.get("KB-001");
      entry.lastActivity = Date.now() - 200;

      // Wait to confirm no polling happens
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(onStuck).not.toHaveBeenCalled();
    });

    it("start is idempotent", () => {
      const store = createMockStore();
      detector = new StuckTaskDetector(store, { pollIntervalMs: 10_000 });

      detector.start();
      detector.start(); // Should not create a second interval

      // Just verify it doesn't throw
      detector.stop();
    });

    it("stop is idempotent", () => {
      const store = createMockStore();
      detector = new StuckTaskDetector(store);

      detector.stop(); // Not started — should be a no-op
      detector.start();
      detector.stop();
      detector.stop(); // Already stopped — should be a no-op
    });
  });

  describe("edge cases", () => {
    it("handles getSettings failure gracefully during check", async () => {
      const store = createMockStore({ taskStuckTimeoutMs: 60_000 });
      detector = new StuckTaskDetector(store);

      const session = createMockSession();
      detector.trackTask("KB-001", session);

      // Make getSettings throw
      store.getSettings.mockRejectedValueOnce(new Error("Store unavailable"));

      // Should not throw
      await (detector as any).checkStuckTasks();

      // Session should not be killed
      expect(session.dispose).not.toHaveBeenCalled();
    });

    it("handles moveTask failure gracefully during killAndRetry", async () => {
      const store = createMockStore();
      store.moveTask.mockRejectedValueOnce(new Error("Invalid transition"));
      detector = new StuckTaskDetector(store);

      const session = createMockSession();
      detector.trackTask("KB-001", session);

      // Should not throw
      await detector.killAndRetry("KB-001", 600_000);

      // Session should still be disposed
      expect(session.dispose).toHaveBeenCalled();
      // Task should be untracked even on error
      expect(detector.trackedCount).toBe(0);
    });
  });
});
