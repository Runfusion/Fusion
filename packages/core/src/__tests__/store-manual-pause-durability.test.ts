import { describe, expect, it } from "vitest";
import { pauseTaskImpl } from "../task-store/branch-group-ops.js";
import type { TaskStore } from "../store.js";
import type { Task } from "../types.js";

describe("TaskStore manual pause durability", () => {
  it("marks a manual pause as user-paused", async () => {
    let persisted = {
      id: "FN-001",
      column: "in-progress",
      status: "executing",
      log: [],
    } as unknown as Task;

    const store = {
      withTaskLock: async (_id: string, operation: () => Promise<Task>) => operation(),
      taskDir: () => "/tmp/FN-001",
      readTaskJson: async () => ({ ...persisted, log: [...(persisted.log ?? [])] }),
      atomicWriteTaskJson: async (_dir: string, task: Task) => {
        persisted = task;
      },
      isWatching: false,
      emit: () => undefined,
    } as unknown as TaskStore;

    const paused = await pauseTaskImpl(store, "FN-001", true, undefined, { userPaused: true });

    expect(paused).toMatchObject({ paused: true, userPaused: true, status: "paused" });
    expect(persisted).toMatchObject({ paused: true, userPaused: true, status: "paused" });
  });

  it("does not mark an automatic hold as user-paused", async () => {
    let persisted = {
      id: "FN-002",
      column: "in-progress",
      status: "executing",
      log: [],
    } as unknown as Task;

    const store = {
      withTaskLock: async (_id: string, operation: () => Promise<Task>) => operation(),
      taskDir: () => "/tmp/FN-002",
      readTaskJson: async () => ({ ...persisted, log: [...(persisted.log ?? [])] }),
      atomicWriteTaskJson: async (_dir: string, task: Task) => {
        persisted = task;
      },
      isWatching: false,
      emit: () => undefined,
    } as unknown as TaskStore;

    const paused = await pauseTaskImpl(store, "FN-002", true, undefined, {
      pausedReason: "token_budget_exceeded",
    });

    expect(paused).toMatchObject({ paused: true, status: "paused" });
    expect(paused.userPaused).toBeUndefined();
    expect(persisted.userPaused).toBeUndefined();
  });

  it("clears the durable user-pause latch when unpaused", async () => {
    let persisted = {
      id: "FN-003",
      column: "in-progress",
      status: "executing",
      log: [],
    } as unknown as Task;

    const store = {
      withTaskLock: async (_id: string, operation: () => Promise<Task>) => operation(),
      taskDir: () => "/tmp/FN-003",
      readTaskJson: async () => ({ ...persisted, log: [...(persisted.log ?? [])] }),
      atomicWriteTaskJson: async (_dir: string, task: Task) => {
        persisted = task;
      },
      isWatching: false,
      emit: () => undefined,
    } as unknown as TaskStore;

    await pauseTaskImpl(store, "FN-003", true, undefined, { userPaused: true });
    const unpaused = await pauseTaskImpl(store, "FN-003", false);

    expect(unpaused.paused).toBeUndefined();
    expect(unpaused.status).toBeUndefined();
    expect(unpaused.userPaused).toBeUndefined();
    expect(persisted.paused).toBeUndefined();
    expect(persisted.status).toBeUndefined();
    expect(persisted.userPaused).toBeUndefined();
  });
});
