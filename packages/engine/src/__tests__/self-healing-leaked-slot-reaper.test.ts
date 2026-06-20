import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

const { logger } = vi.hoisted(() => ({ logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../logger.js", () => ({
  createLogger: vi.fn(() => logger),
  schedulerLog: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../worktree-pool.js", () => ({
  WorktreePool: vi.fn(),
  RemovalReason: {},
  scanIdleWorktrees: vi.fn().mockResolvedValue([]),
  cleanupOrphanedWorktrees: vi.fn().mockResolvedValue(0),
  isUsableTaskWorktree: vi.fn().mockResolvedValue(true),
  removeWorktree: vi.fn().mockResolvedValue(undefined),
  resolveWorktreeBackend: vi.fn(),
}));

vi.mock("../merger.js", () => ({ classifyOwnedLandedEvidence: vi.fn() }));

import { SelfHealingManager } from "../self-healing.js";
import type { Settings, Task, TaskStore } from "@fusion/core";

function createMockStore(overrides: Record<string, unknown> = {}): TaskStore & EventEmitter {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    getSettings: vi.fn().mockResolvedValue({
      autoMerge: true,
      globalPause: false,
      enginePaused: false,
      maintenanceIntervalMs: 0,
    } as unknown as Settings),
    listTasks: vi.fn().mockResolvedValue([]),
    getTask: vi.fn(),
    updateTask: vi.fn().mockResolvedValue({} as Task),
    logEntry: vi.fn().mockResolvedValue(undefined),
    moveTask: vi.fn().mockResolvedValue(undefined),
    recordRunAuditEvent: vi.fn().mockResolvedValue(undefined),
    getRootDir: vi.fn().mockReturnValue("/tmp/test-project"),
    ...overrides,
  }) as unknown as TaskStore & EventEmitter;
}

// A task that has sat in its column well past the reaper's 60s grace.
function taskRow(id: string, column: string, extra: Record<string, unknown> = {}): Task {
  return {
    id,
    column,
    paused: false,
    columnMovedAt: "2026-05-20T12:00:00.000Z",
    updatedAt: "2026-05-20T12:00:00.000Z",
    steps: [],
    ...extra,
  } as unknown as Task;
}

describe("reapLeakedConcurrencySlots", () => {
  let store: TaskStore & EventEmitter;
  let clearPhantomExecutorBinding: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    // Well past the 60s grace relative to the task rows' columnMovedAt.
    vi.setSystemTime(new Date("2026-05-20T12:05:00.000Z"));
    clearPhantomExecutorBinding = vi.fn().mockReturnValue(true);
    store = createMockStore();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  function makeManager(holders: Array<{ taskId: string; worktreePath: string }>, executing: string[] = []) {
    return new SelfHealingManager(store, {
      rootDir: "/tmp/test-project",
      listWorktreeHolders: () => holders,
      getExecutingTaskIds: () => new Set<string>(executing),
      clearPhantomExecutorBinding,
    });
  }

  it("releases a leaked slot whose holder sits in todo and is not executing", async () => {
    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(taskRow("FN-6756", "todo"));
    const manager = makeManager([{ taskId: "FN-6756", worktreePath: "/wt/pearl-lark" }]);

    const reaped = await manager.reapLeakedConcurrencySlots();

    expect(reaped).toBe(1);
    expect(clearPhantomExecutorBinding).toHaveBeenCalledWith("FN-6756");
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-6756",
      expect.stringContaining("released leaked worktree/concurrency slot"),
    );
  });

  it("does NOT release a legit in-progress holder", async () => {
    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(taskRow("FN-6750", "in-progress"));
    const manager = makeManager([{ taskId: "FN-6750", worktreePath: "/wt/proud-delta" }]);

    const reaped = await manager.reapLeakedConcurrencySlots();

    expect(reaped).toBe(0);
    expect(clearPhantomExecutorBinding).not.toHaveBeenCalled();
  });

  it("does NOT release a holder that is still executing, even if its column looks reapable", async () => {
    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(taskRow("FN-6700", "todo"));
    const manager = makeManager([{ taskId: "FN-6700", worktreePath: "/wt/fast-falcon" }], ["FN-6700"]);

    const reaped = await manager.reapLeakedConcurrencySlots();

    expect(reaped).toBe(0);
    expect(clearPhantomExecutorBinding).not.toHaveBeenCalled();
  });

  it("does NOT release an in-review holder (conservative — it legitimately keeps its worktree)", async () => {
    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(taskRow("FN-6744", "in-review"));
    const manager = makeManager([{ taskId: "FN-6744", worktreePath: "/wt/jade-grove" }]);

    const reaped = await manager.reapLeakedConcurrencySlots();

    expect(reaped).toBe(0);
    expect(clearPhantomExecutorBinding).not.toHaveBeenCalled();
  });

  it("does NOT release a todo holder still inside the grace window", async () => {
    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(
      taskRow("FN-6753", "todo", { columnMovedAt: "2026-05-20T12:04:30.000Z" }), // 30s < 60s grace
    );
    const manager = makeManager([{ taskId: "FN-6753", worktreePath: "/wt/swift-falcon" }]);

    const reaped = await manager.reapLeakedConcurrencySlots();

    expect(reaped).toBe(0);
    expect(clearPhantomExecutorBinding).not.toHaveBeenCalled();
  });

  it("skips entirely under global pause", async () => {
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      globalPause: true,
      enginePaused: false,
    } as unknown as Settings);
    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(taskRow("FN-6756", "todo"));
    const manager = makeManager([{ taskId: "FN-6756", worktreePath: "/wt/pearl-lark" }]);

    const reaped = await manager.reapLeakedConcurrencySlots();

    expect(reaped).toBe(0);
    expect(clearPhantomExecutorBinding).not.toHaveBeenCalled();
  });

  it("reaps an orphan holder with no task row", async () => {
    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const manager = makeManager([{ taskId: "FN-ghost", worktreePath: "/wt/gone" }]);

    const reaped = await manager.reapLeakedConcurrencySlots();

    expect(reaped).toBe(1);
    expect(clearPhantomExecutorBinding).toHaveBeenCalledWith("FN-ghost");
  });
});
