import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings, TaskStore } from "@fusion/core";
import { SelfHealingManager } from "../self-healing.js";

function createTask(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    title: id,
    description: id,
    column: "todo",
    status: null,
    paused: false,
    blockedBy: null,
    dependencies: [],
    steps: [],
    log: [],
    ...overrides,
  };
}

describe("SelfHealingManager stale merge fanout recovery (FN-4241)", () => {
  let tasks: Map<string, Record<string, unknown>>;
  let store: TaskStore;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:30:00.000Z"));
    tasks = new Map();

    store = {
      getSettings: vi.fn().mockResolvedValue({
        globalPause: false,
        enginePaused: false,
        autoUnpauseEnabled: false,
        maintenanceIntervalMs: 0,
      } as unknown as Settings),
      listTasks: vi.fn().mockImplementation(async (options?: { column?: string; includeArchived?: boolean }) => {
        const all = Array.from(tasks.values());
        if (!options?.column) return all;
        return all.filter((task) => task.column === options.column);
      }),
      updateTask: vi.fn().mockImplementation(async (id: string, patch: Record<string, unknown>) => {
        const current = tasks.get(id);
        if (!current) throw new Error(`Task ${id} missing`);
        tasks.set(id, { ...current, ...patch });
      }),
      logEntry: vi.fn().mockResolvedValue(undefined),
      /*
      FNXC:OverlapSelfHealing 2026-06-26-12:00:
      clearStaleBlockedBy fakes must expose every store method its file-scope-overlap path can call so recovery-count assertions stay deterministic across shard order.
      */
      getTask: vi.fn().mockImplementation(async (id: string) => tasks.get(id) ?? null),
      parseFileScopeFromPrompt: vi.fn().mockResolvedValue([]),
      getCompletionHandoffAcceptedMarker: vi.fn().mockReturnValue(null),
    } as unknown as TaskStore;

    const blocker = createTask("FN-4241-BLOCKER", {
      column: "in-review",
      status: "merging",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    tasks.set(String(blocker.id), blocker);

    for (let index = 1; index <= 5; index += 1) {
      const id = `FN-4241-DOWNSTREAM-${index}`;
      tasks.set(id, createTask(id, {
        column: "todo",
        blockedBy: "FN-4241-BLOCKER",
        status: "queued",
      }));
    }
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("FN-4241: clears stale merging status then unblocks downstream fanout", async () => {
    const manager = new SelfHealingManager(store, {
      rootDir: "/tmp/test-project",
      staleMergingStatusMinAgeMs: 5 * 60_000,
      staleMergingFanoutMinAgeMs: 15 * 60_000,
      getActiveMergeTaskId: () => null,
    });

    const recoveredMerging = await manager.recoverStaleMergingStatus();
    expect(recoveredMerging).toBe(1);
    expect(tasks.get("FN-4241-BLOCKER")?.status).toBeNull();

    const recoveredBlockedBy = await manager.clearStaleBlockedBy();
    expect(recoveredBlockedBy).toBe(5);

    for (let index = 1; index <= 5; index += 1) {
      const downstream = tasks.get(`FN-4241-DOWNSTREAM-${index}`);
      expect(downstream?.blockedBy).toBeNull();
    }

    manager.stop();
  });
});
