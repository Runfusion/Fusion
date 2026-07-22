import { describe, expect, it, vi } from "vitest";
import type { TaskStore } from "@fusion/core";
import { Scheduler } from "../scheduler.js";

function createStore() {
  const listeners = new Map<string, ((payload: unknown) => void)[]>();
  const on = vi.fn((event: string, listener: (payload: unknown) => void) => {
    const existing = listeners.get(event) ?? [];
    existing.push(listener);
    listeners.set(event, existing);
  });

  const store = {
    on,
    off: vi.fn(),
    getRootDir: vi.fn().mockReturnValue("/test/project"),
    getSettings: vi.fn().mockResolvedValue({ globalPause: false, enginePaused: false }),
    listTasks: vi.fn().mockResolvedValue([]),
  } as unknown as TaskStore;

  const emit = (event: string, payload: unknown) => {
    for (const listener of listeners.get(event) ?? []) {
      listener(payload);
    }
  };

  return { store, emit };
}

function createTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "FN-1",
    column: "todo",
    paused: false,
    assignedAgentId: null,
    checkedOutBy: null,
    deletedAt: null,
    dependencies: [],
    columnMovedAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("Scheduler auto-claim snapshot invalidation", () => {
  it("invalidates on task:created, first-seen task:updated, and task:deleted", () => {
    const invalidate = vi.fn();
    const { store, emit } = createStore();
    new Scheduler(store, { snapshotManager: { invalidate } as any });

    emit("task:created", createTask({ id: "FN-1" }));
    emit("task:updated", createTask({ id: "FN-99" }));
    emit("task:deleted", { id: "FN-1" });

    expect(invalidate).toHaveBeenCalledWith("task:created");
    expect(invalidate).toHaveBeenCalledWith("task:updated");
    expect(invalidate).toHaveBeenCalledWith("task:deleted");
  });

  it("does not invalidate for candidacy-neutral task:updated events", () => {
    const invalidate = vi.fn();
    const { store, emit } = createStore();
    new Scheduler(store, { snapshotManager: { invalidate } as any });

    emit("task:created", createTask());
    for (let i = 1; i <= 5; i += 1) {
      emit("task:updated", createTask({ updatedAt: `2026-01-01T00:00:0${i}.000Z`, title: `v${i}` }));
    }

    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenNthCalledWith(1, "task:created");
    expect(invalidate).not.toHaveBeenCalledWith("task:updated");
  });

  it("invalidates once per candidacy-changing task:updated mutation", () => {
    const invalidate = vi.fn();
    const { store, emit } = createStore();
    new Scheduler(store, { snapshotManager: { invalidate } as any });

    emit("task:created", createTask());

    emit("task:updated", createTask({ paused: true }));
    expect(invalidate).toHaveBeenCalledTimes(2);
    expect(invalidate).toHaveBeenLastCalledWith("task:updated");

    emit("task:updated", createTask({ paused: true, updatedAt: "2026-01-01T00:00:02.000Z" }));
    expect(invalidate).toHaveBeenCalledTimes(2);

    emit("task:updated", createTask({ paused: false, updatedAt: "2026-01-01T00:00:03.000Z" }));
    expect(invalidate).toHaveBeenCalledTimes(3);
    expect(invalidate).toHaveBeenLastCalledWith("task:updated");
  });

  it.each([
    ["column", { column: "in-progress" }],
    ["paused", { paused: true }],
    ["userPaused", { userPaused: true }],
    ["assignedAgentId", { assignedAgentId: "agent-1" }],
    ["checkedOutBy", { checkedOutBy: "agent-2" }],
    ["deletedAt", { deletedAt: "2026-01-02T00:00:00.000Z" }],
    ["dependencies", { dependencies: ["FN-2"] }],
    ["columnMovedAt", { columnMovedAt: "2026-01-03T00:00:00.000Z" }],
  ])("invalidates when %s changes", (_field, mutation) => {
    const invalidate = vi.fn();
    const { store, emit } = createStore();
    new Scheduler(store, { snapshotManager: { invalidate } as any });

    emit("task:created", createTask());
    emit("task:updated", createTask(mutation));

    expect(invalidate).toHaveBeenCalledTimes(2);
    expect(invalidate).toHaveBeenNthCalledWith(1, "task:created");
    expect(invalidate).toHaveBeenNthCalledWith(2, "task:updated");
  });

  it("triggers immediate scheduling when a userPaused-only task is unpaused", () => {
    const { store, emit } = createStore();
    const scheduler = new Scheduler(store, {});
    const schedule = vi.spyOn(scheduler, "schedule").mockResolvedValue(undefined);
    (scheduler as unknown as { running: boolean }).running = true;

    emit("task:updated", createTask({ userPaused: true }));
    emit("task:updated", createTask({ userPaused: false }));

    expect(schedule).toHaveBeenCalledTimes(1);
  });

  it("invalidates on first-sighting task:updated with no stored fingerprint", () => {
    const invalidate = vi.fn();
    const { store, emit } = createStore();
    new Scheduler(store, { snapshotManager: { invalidate } as any });

    emit("task:updated", createTask({ id: "FN-99" }));

    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith("task:updated");
  });

  it("clears task fingerprint on task:deleted", () => {
    const invalidate = vi.fn();
    const { store, emit } = createStore();
    new Scheduler(store, { snapshotManager: { invalidate } as any });

    emit("task:created", createTask({ id: "FN-1" }));
    emit("task:deleted", { id: "FN-1" });
    emit("task:updated", createTask({ id: "FN-1" }));

    expect(invalidate).toHaveBeenNthCalledWith(1, "task:created");
    expect(invalidate).toHaveBeenNthCalledWith(2, "task:deleted");
    expect(invalidate).toHaveBeenNthCalledWith(3, "task:updated");
  });

  it("clears scheduler bookkeeping for deleted tasks", () => {
    const { store, emit } = createStore();
    const scheduler = new Scheduler(store, {});
    const internals = scheduler as unknown as {
      pausedTaskIds: Set<string>;
      failedTaskIds: Set<string>;
      wasNodeDispatchValidationBlocked: Set<string>;
      wasNodeBlocked: Set<string>;
    };

    internals.pausedTaskIds.add("FN-1");
    internals.failedTaskIds.add("FN-1");
    internals.wasNodeDispatchValidationBlocked.add("FN-1");
    internals.wasNodeBlocked.add("FN-1");

    emit("task:deleted", { id: "FN-1" });

    expect(internals.pausedTaskIds.has("FN-1")).toBe(false);
    expect(internals.failedTaskIds.has("FN-1")).toBe(false);
    expect(internals.wasNodeDispatchValidationBlocked.has("FN-1")).toBe(false);
    expect(internals.wasNodeBlocked.has("FN-1")).toBe(false);
  });

  it("invalidates task:moved only when todo is source or destination", () => {
    const invalidate = vi.fn();
    const { store, emit } = createStore();
    new Scheduler(store, { snapshotManager: { invalidate } as any });

    emit("task:moved", { task: createTask({ id: "FN-1" }), from: "todo", to: "in-progress" });
    emit("task:moved", { task: createTask({ id: "FN-2" }), from: "in-progress", to: "todo" });
    emit("task:moved", { task: createTask({ id: "FN-3", column: "done" }), from: "in-review", to: "done" });

    expect(invalidate).toHaveBeenCalledWith("task:moved:todo->in-progress");
    expect(invalidate).toHaveBeenCalledWith("task:moved:in-progress->todo");
    expect(invalidate).toHaveBeenCalledTimes(2);
  });
});
