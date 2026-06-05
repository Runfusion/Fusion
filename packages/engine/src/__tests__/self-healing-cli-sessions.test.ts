/**
 * U8 — self-healing + stuck-detector CLI-session awareness.
 *
 * Idle-worktree sweeps (enforceWorktreeCap, cleanupOrphans, reapUnregisteredOrphans)
 * must SKIP a worktree backing a resume-eligible cli_sessions record; the stuck
 * detector must suppress stuck/inactivity flagging while a task's CLI session is
 * waitingOnInput, yet still flag a genuinely-quiet session.
 *
 * The sweeps + module functions are exercised through the narrow seams
 * (isWorktreeResumeReserved option / isCliSessionWaitingOnInput option) with the
 * heavy git/FS dependencies mocked.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { TaskStore } from "@fusion/core";

import { SelfHealingManager } from "../self-healing.js";
import * as worktreePool from "../worktree-pool.js";
import { StuckTaskDetector, type DisposableSession } from "../stuck-task-detector.js";

function createStore(settings: Record<string, unknown>): TaskStore & EventEmitter {
  const emitter = new EventEmitter() as TaskStore & EventEmitter;
  (emitter as any).getSettings = vi.fn().mockResolvedValue(settings);
  (emitter as any).listTasks = vi.fn().mockResolvedValue([]);
  return emitter;
}

describe("self-healing idle-worktree sweeps skip resume-eligible CLI session worktrees (U8)", () => {
  let rootDir: string;
  let worktreesDir: string;
  let reservedPath: string;
  let freePath: string;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "kb-selfheal-cli-"));
    worktreesDir = join(rootDir, ".worktrees");
    mkdirSync(worktreesDir, { recursive: true });
    reservedPath = join(worktreesDir, "wt-reserved");
    freePath = join(worktreesDir, "wt-free");
    mkdirSync(reservedPath);
    mkdirSync(freePath);
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("enforceWorktreeCap skips the reserved worktree, reaps the free one", async () => {
    // cap = maxWorktrees(1) * 2 = 2; we have 2 dirs → need 3 to exceed. Add one more.
    mkdirSync(join(worktreesDir, "wt-extra"));
    const store = createStore({ maxWorktrees: 1, recycleWorktrees: false });
    vi.spyOn(worktreePool, "scanIdleWorktrees").mockResolvedValue([reservedPath, freePath, join(worktreesDir, "wt-extra")]);
    const removeSpy = vi.spyOn(worktreePool, "removeWorktree").mockResolvedValue(undefined as never);

    const manager = new SelfHealingManager(store, {
      rootDir,
      isWorktreeResumeReserved: (p) => p === reservedPath,
    });

    await (manager as any).enforceWorktreeCap();

    const removed = removeSpy.mock.calls.map((c) => (c[0] as { worktreePath: string }).worktreePath);
    expect(removed).not.toContain(reservedPath);
    expect(removed).toContain(freePath);
  });

  it("cleanupOrphans (recycle off) skips the reserved worktree", async () => {
    const store = createStore({ recycleWorktrees: false });
    vi.spyOn(worktreePool, "scanIdleWorktrees").mockResolvedValue([reservedPath, freePath]);
    const removeSpy = vi.spyOn(worktreePool, "removeWorktree").mockResolvedValue(undefined as never);

    const manager = new SelfHealingManager(store, {
      rootDir,
      isWorktreeResumeReserved: (p) => p === reservedPath,
    });

    const cleaned = await (manager as any).cleanupOrphans();

    const removed = removeSpy.mock.calls.map((c) => (c[0] as { worktreePath: string }).worktreePath);
    expect(removed).toEqual([freePath]);
    expect(cleaned).toBe(1);
  });

  it("without the seam predicate, both worktrees are reaped (no behavior change)", async () => {
    const store = createStore({ recycleWorktrees: false });
    vi.spyOn(worktreePool, "scanIdleWorktrees").mockResolvedValue([reservedPath, freePath]);
    const removeSpy = vi.spyOn(worktreePool, "removeWorktree").mockResolvedValue(undefined as never);

    const manager = new SelfHealingManager(store, { rootDir });
    await (manager as any).cleanupOrphans();

    const removed = removeSpy.mock.calls.map((c) => (c[0] as { worktreePath: string }).worktreePath);
    expect(removed).toEqual([reservedPath, freePath]);
  });
});

// ── Stuck detector waitingOnInput suppression ────────────────────────────────

function fakeStore(settings: Record<string, unknown>): TaskStore {
  return {
    getSettings: vi.fn().mockResolvedValue(settings),
    getTask: vi.fn(),
  } as unknown as TaskStore;
}

function fakeSession(): DisposableSession {
  return { dispose: vi.fn() } as unknown as DisposableSession;
}

describe("stuck-task detector suppresses flagging while CLI session waitingOnInput (U8)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("waitingOnInput session is NOT flagged; same session IS flagged once it stops waiting", async () => {
    const onStuck = vi.fn();
    let waiting = true;
    const store = fakeStore({ taskStuckTimeoutMs: 1000, globalPause: false, enginePaused: false });
    const detector = new StuckTaskDetector(store, {
      onStuck,
      isCliSessionWaitingOnInput: () => waiting,
      // Accept the requeue so killAndRetry proceeds to onStuck.
      beforeRequeue: async () => true,
    });

    detector.trackTask("FN-1", fakeSession());
    // Force the task to look inactive (past the 1s timeout).
    (detector as any).tracked.get("FN-1").lastActivity = Date.now() - 10_000;

    // While waitingOnInput: suppressed.
    await (detector as any).checkStuckTasks();
    expect(onStuck).not.toHaveBeenCalled();

    // Once it stops waiting (genuinely quiet): the U3-style backstop equivalent
    // (the detector) now flags it.
    waiting = false;
    // killAndRetry needs moveTask/logEntry; stub them on the store.
    (store as any).moveTask = vi.fn().mockResolvedValue(undefined);
    (store as any).logEntry = vi.fn().mockResolvedValue(undefined);
    (store as any).getTask = vi.fn().mockResolvedValue({ id: "FN-1", status: "in-progress", steps: [], error: null });
    await (detector as any).checkStuckTasks();
    expect(onStuck).toHaveBeenCalledTimes(1);
    expect(onStuck.mock.calls[0][0].taskId).toBe("FN-1");
  });

  it("without the seam lookup, a waitingOnInput-shaped quiet task is flagged normally", async () => {
    const onStuck = vi.fn();
    const store = fakeStore({ taskStuckTimeoutMs: 1000, globalPause: false, enginePaused: false });
    (store as any).moveTask = vi.fn().mockResolvedValue(undefined);
    (store as any).logEntry = vi.fn().mockResolvedValue(undefined);
    (store as any).getTask = vi.fn().mockResolvedValue({ id: "FN-2", status: "in-progress", steps: [], error: null });
    const detector = new StuckTaskDetector(store, { onStuck, beforeRequeue: async () => true });

    detector.trackTask("FN-2", fakeSession());
    (detector as any).tracked.get("FN-2").lastActivity = Date.now() - 10_000;
    await (detector as any).checkStuckTasks();
    expect(onStuck).toHaveBeenCalledTimes(1);
  });
});
