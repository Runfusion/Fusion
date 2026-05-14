import { describe, it, expect, vi } from "vitest";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import { createMockStore, resetExecutorMocks } from "./executor-test-helpers.js";

describe("TaskExecutor user cancel handling", () => {
  it("aborts before dispose when user moves in-progress task back to todo", async () => {
    resetExecutorMocks();
    const store = createMockStore();
    const executor = new TaskExecutor(store as any, "/tmp/test");

    const callOrder: string[] = [];
    const session = {
      prompt: vi.fn(),
      abort: vi.fn(() => {
        callOrder.push("abort");
        return Promise.resolve();
      }),
      dispose: vi.fn(() => {
        callOrder.push("dispose");
      }),
    } as any;

    (executor as any).activeSessions.set("FN-001", {
      session,
      seenSteeringIds: new Set<string>(),
    });

    (store as any)._trigger("task:moved", {
      task: {
        id: "FN-001",
        column: "todo",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
      },
      from: "in-progress",
      to: "todo",
      source: "user",
    });

    await Promise.resolve();

    expect(callOrder[0]).toBe("abort");
    expect(callOrder[1]).toBe("dispose");
    expect((executor as any).activeSessions.has("FN-001")).toBe(false);
    expect((executor as any).userCanceledTaskIds.has("FN-001")).toBe(true);
    expect(store.moveTask).not.toHaveBeenCalled();
  });

  it("does not mark engine-initiated move as user cancel", () => {
    resetExecutorMocks();
    const store = createMockStore();
    const executor = new TaskExecutor(store as any, "/tmp/test");

    (store as any)._trigger("task:moved", {
      task: {
        id: "FN-002",
        column: "todo",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
      },
      from: "in-progress",
      to: "todo",
      source: "engine",
    });

    expect((executor as any).userCanceledTaskIds.has("FN-002")).toBe(false);
  });

  it("clears userCanceled marker when task is moved back to in-progress", () => {
    resetExecutorMocks();
    const store = createMockStore();
    const executor = new TaskExecutor(store as any, "/tmp/test");

    (executor as any).userCanceledTaskIds.add("FN-003");

    (store as any)._trigger("task:moved", {
      task: {
        id: "FN-003",
        column: "in-progress",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
      },
      from: "todo",
      to: "in-progress",
      source: "user",
    });

    expect((executor as any).userCanceledTaskIds.has("FN-003")).toBe(false);
  });
});
