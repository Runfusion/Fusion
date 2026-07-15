import { afterEach, describe, expect, it, vi } from "vitest";
import type { AsyncDataLayer } from "@fusion/core";
import { createNotifier, type NotifierDeps } from "../notifier.js";
import type { SnapshotRow } from "../notifications/types.js";

afterEach(() => {
  vi.useRealTimers();
});

function createPersistence() {
  const table = new Map<string, SnapshotRow>();
  const snapshotStore: NonNullable<NotifierDeps["snapshotStore"]> = {
    read: vi.fn(async () => new Map(table)),
    write: vi.fn(async (_layer, rows) => {
      for (const row of rows) table.set(row.taskId, { ...row });
    }),
    prune: vi.fn(async (_layer, presentTaskIds) => {
      let deleted = 0;
      for (const taskId of [...table.keys()]) {
        if (!presentTaskIds.has(taskId)) {
          table.delete(taskId);
          deleted += 1;
        }
      }
      return deleted;
    }),
  };
  return {
    layer: { projectId: "notifier-test" } as AsyncDataLayer,
    snapshotStore,
  };
}

function task(id: string, column: string, updatedAt: string) {
  return { id, column, updatedAt, description: id, dependencies: [], steps: [], currentStep: 1, log: [] } as any;
}

describe("createNotifier", () => {
  it("seeds snapshot and emits only watched new tasks", async () => {
    const persistence = createPersistence();
    const transport = { pushCard: vi.fn(async () => undefined) } as any;
    const notifier = createNotifier({
      taskStore: { listTasks: vi.fn(async () => [task("FN-1", "todo", "2026-01-01T00:00:00.000Z"), task("FN-2", "in-review", "2026-01-01T00:00:01.000Z")]) } as any,
      ...persistence,
      transport,
      settings: { notifyOnColumns: ["in-review"] },
      pluginId: "p1",
      logger: console as any,
      now: () => new Date("2026-01-01T00:00:02.000Z"),
    });

    const events = await notifier.pollOnce();
    expect(events.map((e) => e.taskId)).toEqual(["FN-2"]);
    expect(transport.pushCard).toHaveBeenCalledTimes(1);
  });

  it("emits entered-column transition once", async () => {
    const persistence = createPersistence();
    const listTasks = vi
      .fn()
      .mockResolvedValueOnce([task("FN-1", "todo", "2026-01-01T00:00:00.000Z")])
      .mockResolvedValueOnce([task("FN-1", "in-review", "2026-01-01T00:00:05.000Z")]);
    const transport = { pushCard: vi.fn(async () => undefined) } as any;
    const notifier = createNotifier({ taskStore: { listTasks } as any, ...persistence, transport, settings: { notifyOnColumns: ["in-review"] }, pluginId: "p1", logger: console as any });

    await notifier.pollOnce();
    const events = await notifier.pollOnce();
    expect(events).toHaveLength(1);
    expect(events[0]?.reason).toBe("entered-column");
  });

  it("does not rewrite an unchanged snapshot on the next poll", async () => {
    const persistence = createPersistence();
    const tasks = [task("FN-1", "todo", "2026-01-01T00:00:00.000Z")];
    const notifier = createNotifier({
      taskStore: { listTasks: vi.fn(async () => tasks) } as any,
      ...persistence,
      transport: { pushCard: vi.fn(async () => undefined) } as any,
      settings: {},
      pluginId: "p1",
    });

    await notifier.pollOnce();
    await notifier.pollOnce();
    expect(persistence.snapshotStore.write).toHaveBeenCalledTimes(1);
    expect(persistence.snapshotStore.write).toHaveBeenCalledWith(persistence.layer, [
      expect.objectContaining({ taskId: "FN-1" }),
    ]);
  });

  it("continues when push fails", async () => {
    const persistence = createPersistence();
    const transport = { pushCard: vi.fn().mockRejectedValueOnce(new Error("nope")).mockResolvedValueOnce(undefined) } as any;
    const notifier = createNotifier({
      taskStore: { listTasks: vi.fn(async () => [task("FN-1", "in-review", "2026-01-01T00:00:00.000Z"), task("FN-2", "in-review", "2026-01-01T00:00:01.000Z")]) } as any,
      ...persistence,
      transport,
      settings: { notifyOnColumns: ["in-review"] },
      pluginId: "p1",
      logger: { error: vi.fn() } as any,
    });

    const events = await notifier.pollOnce();
    expect(events).toHaveLength(2);
    expect(transport.pushCard).toHaveBeenCalledTimes(2);
  });

  it("stop clears timer", async () => {
    vi.useFakeTimers();
    const listTasks = vi.fn(async () => [task("FN-1", "todo", "2026-01-01T00:00:00.000Z")]);
    const notifier = createNotifier({ taskStore: { listTasks } as any, ...createPersistence(), transport: { pushCard: vi.fn(async () => undefined) } as any, settings: { pollingIntervalSeconds: 5 }, pluginId: "p1", logger: console as any });
    notifier.start();
    await vi.advanceTimersByTimeAsync(5000);
    const before = listTasks.mock.calls.length;
    await notifier.stop();
    await vi.advanceTimersByTimeAsync(10000);
    expect(listTasks.mock.calls.length).toBe(before);
  });

  it("peek/drain and ring buffer", async () => {
    const persistence = createPersistence();
    const tasks = Array.from({ length: 220 }, (_, i) => task(`FN-${i}`, "in-review", `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}.000Z`));
    const notifier = createNotifier({ taskStore: { listTasks: vi.fn(async () => tasks) } as any, ...persistence, transport: { pushCard: vi.fn(async () => undefined) } as any, settings: { notifyOnColumns: ["in-review"] }, pluginId: "p1", logger: console as any });

    await notifier.pollOnce();
    expect(notifier.peekPending(200)).toHaveLength(200);
    expect(notifier.drainPending(10)).toHaveLength(10);
    expect(notifier.peekPending(200)).toHaveLength(190);
  });
});
