import { describe, expect, it, vi } from "vitest";
import { TaskStore } from "../store.js";

const now = new Date("2026-07-15T12:00:00.000Z");
const staleHeartbeat = "2026-07-15T11:58:00.000Z";
const startedBeforeHeartbeat = "2026-07-15T11:50:00.000Z";

type TimingTask = {
  id: string;
  executionStartedAt?: string;
};

function createStoreDouble(settings: Record<string, unknown>, tasks: TimingTask[]) {
  const updateTask = vi.fn(async (id: string, patch: { executionStartedAt: string }) => {
    const task = tasks.find((candidate) => candidate.id === id);
    if (task) task.executionStartedAt = patch.executionStartedAt;
  });
  return {
    getSettings: vi.fn(async () => settings),
    listTasks: vi.fn(async () => tasks),
    updateTask,
  };
}

async function reconcile(
  store: ReturnType<typeof createStoreDouble>,
  opts?: { engineLastActiveAtOverride?: string },
) {
  return TaskStore.prototype.reconcileActiveTimingForEngineDowntime.call(store as never, now, opts);
}

describe("TaskStore.reconcileActiveTimingForEngineDowntime", () => {
  it("uses a stale captured override despite a fresh settings heartbeat and shifts exactly once by downtime", async () => {
    const tasks = [{ id: "FN-active", executionStartedAt: startedBeforeHeartbeat }];
    const store = createStoreDouble({ pollIntervalMs: 15_000, engineLastActiveAt: now.toISOString() }, tasks);

    const result = await reconcile(store, { engineLastActiveAtOverride: staleHeartbeat });

    expect(result).toEqual({ shiftedTaskIds: ["FN-active"], downtimeMs: 120_000 });
    expect(tasks[0].executionStartedAt).toBe("2026-07-15T11:52:00.000Z");
    // The subsequent in-progress exit accrues only the pre-pause eight-minute segment.
    expect(now.getTime() - Date.parse(tasks[0].executionStartedAt!)).toBe(8 * 60_000);
    expect(store.updateTask).toHaveBeenCalledTimes(1);
  });

  it("treats missing or invalid supplied overrides as no-action without falling back to settings", async () => {
    for (const engineLastActiveAtOverride of [undefined, "not-a-date"]) {
      const tasks = [{ id: "FN-active", executionStartedAt: startedBeforeHeartbeat }];
      const store = createStoreDouble({ pollIntervalMs: 15_000, engineLastActiveAt: staleHeartbeat }, tasks);

      await expect(reconcile(store, { engineLastActiveAtOverride })).resolves.toEqual({
        shiftedTaskIds: [],
        downtimeMs: 0,
      });
      expect(tasks[0].executionStartedAt).toBe(startedBeforeHeartbeat);
      expect(store.updateTask).not.toHaveBeenCalled();
    }
  });

  it("keeps the no-options startup recovery fallback and ignores recent or absent settings heartbeats", async () => {
    const staleTasks = [{ id: "FN-stale", executionStartedAt: startedBeforeHeartbeat }];
    const staleStore = createStoreDouble({ pollIntervalMs: 15_000, engineLastActiveAt: staleHeartbeat }, staleTasks);
    await expect(reconcile(staleStore)).resolves.toEqual({ shiftedTaskIds: ["FN-stale"], downtimeMs: 120_000 });

    for (const engineLastActiveAt of [now.toISOString(), undefined]) {
      const tasks = [{ id: "FN-active", executionStartedAt: startedBeforeHeartbeat }];
      const store = createStoreDouble({ pollIntervalMs: 15_000, engineLastActiveAt }, tasks);
      await expect(reconcile(store)).resolves.toEqual({ shiftedTaskIds: [], downtimeMs: 0 });
      expect(store.updateTask).not.toHaveBeenCalled();
    }
  });

  it("does not shift a task started after the stale heartbeat or downtime at the threshold", async () => {
    const postHeartbeatTask = [{ id: "FN-after-pause", executionStartedAt: "2026-07-15T11:59:00.000Z" }];
    const staleStore = createStoreDouble({ pollIntervalMs: 15_000, engineLastActiveAt: staleHeartbeat }, postHeartbeatTask);
    await expect(reconcile(staleStore)).resolves.toEqual({ shiftedTaskIds: [], downtimeMs: 120_000 });
    expect(staleStore.updateTask).not.toHaveBeenCalled();

    const thresholdStore = createStoreDouble(
      { pollIntervalMs: 15_000, engineLastActiveAt: "2026-07-15T11:59:00.000Z" },
      [{ id: "FN-at-threshold", executionStartedAt: startedBeforeHeartbeat }],
    );
    await expect(reconcile(thresholdStore)).resolves.toEqual({ shiftedTaskIds: [], downtimeMs: 60_000 });
    expect(thresholdStore.updateTask).not.toHaveBeenCalled();
  });
});
