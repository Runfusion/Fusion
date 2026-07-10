import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsWatchPollController } from "../fs-watch-poll-controller.js";

/**
 * FN-7726: unit coverage for the shared mechanical fs.watch+poll lifecycle
 * controller extracted from TaskStore/AgentStore. No real fs.watch sleeps or
 * real-time polling waits — every tick is driven directly via fake timers or
 * a directly-invoked onPoll callback, per docs/testing.md.
 */
describe("FsWatchPollController", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fusion-fs-watch-poll-controller-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  function makeLogger() {
    return { warn: vi.fn() };
  }

  it("is not watching before start() and reports watching after", () => {
    const controller = new FsWatchPollController();
    expect(controller.isWatching()).toBe(false);

    const log = makeLogger();
    controller.start({ dir, pollIntervalMs: 1000, onPoll: () => {}, log });
    try {
      expect(controller.isWatching()).toBe(true);
    } finally {
      controller.stop();
    }
  });

  it("start() registers a poll interval and invokes onPoll on a driven tick", () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "setImmediate", "clearImmediate"],
    });
    const controller = new FsWatchPollController();
    const onPoll = vi.fn();
    const log = makeLogger();

    controller.start({ dir, pollIntervalMs: 1000, onPoll, log });
    try {
      expect(onPoll).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1000);
      expect(onPoll).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(2000);
      expect(onPoll).toHaveBeenCalledTimes(3);
    } finally {
      controller.stop();
    }
  });

  it("start() is idempotent — a second call while already watching is a no-op", () => {
    const controller = new FsWatchPollController();
    const log = makeLogger();
    const onPoll1 = vi.fn();
    const onPoll2 = vi.fn();

    controller.start({ dir, pollIntervalMs: 1000, onPoll: onPoll1, log });
    const watcherAfterFirstStart = controller.watcher;
    controller.start({ dir, pollIntervalMs: 500, onPoll: onPoll2, log });

    try {
      // Second start() must not replace the existing watcher/interval.
      expect(controller.watcher).toBe(watcherAfterFirstStart);
    } finally {
      controller.stop();
    }
  });

  it("emits the canonical fail-soft warn string when fs.watch throws on setup", () => {
    const controller = new FsWatchPollController();
    const log = makeLogger();
    const onPoll = vi.fn();

    // fs.watch on a nonexistent directory throws synchronously (ENOENT).
    const missingDir = join(dir, "does-not-exist");
    controller.start({ dir: missingDir, pollIntervalMs: 1000, onPoll, log, errorContext: { rootDir: missingDir } });

    try {
      expect(controller.watcher).toBeNull();
      // The poll fallback must still be registered even though fs.watch failed.
      expect(controller.isWatching()).toBe(true);

      const fallbackCall = log.warn.mock.calls.find(
        (call) => call[0] === "fs.watch unavailable; falling back to polling-only updates",
      );
      expect(fallbackCall).toBeDefined();
      expect(fallbackCall?.[1]).toMatchObject({
        phase: "watch:fs-watch-setup",
        rootDir: missingDir,
      });
    } finally {
      controller.stop();
    }
  });

  it("emits the canonical fail-soft warn string when the watcher emits a runtime error", () => {
    const controller = new FsWatchPollController();
    const log = makeLogger();
    const onPoll = vi.fn();

    controller.start({ dir, pollIntervalMs: 1000, onPoll, log, errorContext: { tasksDir: dir } });
    try {
      expect(controller.watcher).not.toBeNull();
      controller.watcher?.emit("error", new Error("simulated watcher degradation"));

      const errorCall = log.warn.mock.calls.find(
        (call) => call[0] === "fs.watch emitted an error; polling will continue",
      );
      expect(errorCall).toBeDefined();
      expect(errorCall?.[1]).toMatchObject({
        phase: "watch:fs-watch-error",
        error: "simulated watcher degradation",
        tasksDir: dir,
      });
      // A watcher runtime error must not tear down the poll fallback.
      expect(controller.isWatching()).toBe(true);
    } finally {
      controller.stop();
    }
  });

  it("stop() clears both the FSWatcher and the poll interval, and is idempotent", () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "setImmediate", "clearImmediate"],
    });
    const controller = new FsWatchPollController();
    const onPoll = vi.fn();
    const log = makeLogger();

    controller.start({ dir, pollIntervalMs: 1000, onPoll, log });
    expect(controller.isWatching()).toBe(true);

    controller.stop();
    expect(controller.isWatching()).toBe(false);
    expect(controller.watcher).toBeNull();

    // No further ticks after stop().
    vi.advanceTimersByTime(5000);
    expect(onPoll).not.toHaveBeenCalled();

    // Idempotent — calling stop() again must not throw.
    expect(() => controller.stop()).not.toThrow();
    expect(controller.isWatching()).toBe(false);
  });

  it("start() after stop() re-registers a fresh watcher/interval", () => {
    const controller = new FsWatchPollController();
    const log = makeLogger();

    controller.start({ dir, pollIntervalMs: 1000, onPoll: () => {}, log });
    const firstWatcher = controller.watcher;
    controller.stop();
    expect(controller.isWatching()).toBe(false);

    controller.start({ dir, pollIntervalMs: 1000, onPoll: () => {}, log });
    try {
      expect(controller.isWatching()).toBe(true);
      // A brand-new watcher instance was created for the second start().
      expect(controller.watcher).not.toBe(firstWatcher);
    } finally {
      controller.stop();
    }
  });

  it("supports a recursive directory watch (TaskStore's tasksDir shape)", () => {
    const controller = new FsWatchPollController();
    const log = makeLogger();

    controller.start({ dir, recursive: true, pollIntervalMs: 1000, onPoll: () => {}, log });
    try {
      expect(controller.isWatching()).toBe(true);
    } finally {
      controller.stop();
    }
  });
});
