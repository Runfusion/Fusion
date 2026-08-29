import { describe, expect, it, vi } from "vitest";
import type { Task } from "@fusion/core";

const mocks = vi.hoisted(() => ({
  store: undefined as any,
  runtimeStart: vi.fn(async () => undefined),
  runtimeStop: vi.fn(async () => undefined),
  enqueued: [] as string[],
}));

vi.mock("../spec-drift-reconciler.js", () => ({
  SpecDriftReconciler: vi.fn().mockImplementation(function () { return { enqueue: (id: string) => mocks.enqueued.push(id), stop: vi.fn() }; }),
  createStoreSpecDriftRepository: vi.fn(() => ({})),
}));

vi.mock("../runtimes/in-process-runtime.js", () => ({
  InProcessRuntime: vi.fn().mockImplementation(function () { return ({
    start: mocks.runtimeStart,
    stop: mocks.runtimeStop,
    getTaskStore: () => mocks.store,
    getMessageStore: () => undefined,
    getPluginRunner: () => undefined,
    getAgentStore: () => undefined,
    getRoutineStore: () => undefined,
    getRoutineRunner: () => undefined,
    getHeartbeatMonitor: () => undefined,
    getTriggerScheduler: () => undefined,
    getSelfHealingManager: () => undefined,
    setActiveMergeTaskIdProvider: vi.fn(),
    setActiveMergeStartedAtMsProvider: vi.fn(),
    setActiveMergeAborter: vi.fn(),
    setMergeEnqueuer: vi.fn(),
    setMergeActiveClearer: vi.fn(),
    setMergePendingProvider: vi.fn(),
    setMergeRequester: vi.fn(),
    configurePrMonitoring: vi.fn(),
    resumeAfterUnpause: vi.fn(),
  }); }),
}));

import { ProjectEngine } from "../project-engine.js";

const task = (id: string, column = "todo"): Task => ({ id, title: id, description: "test", column } as Task);

function createStore(tasks: Task[]) {
  const handlers = new Map<string, Array<(value: Task) => void>>();
  return {
    getSettings: vi.fn(async () => ({ autoMerge: false, pollIntervalMs: 60_000 })),
    listTasks: vi.fn(async (options?: { includeArchived?: boolean }) => options?.includeArchived ? tasks : tasks.filter((entry) => entry.column !== "archived")),
    getAsyncLayer: vi.fn(() => ({})),
    getAutomationStore: vi.fn(() => undefined),
    on: vi.fn((event: string, handler: (value: Task) => void) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    }),
    emitEvent(event: string, value: Task) {
      for (const handler of handlers.get(event) ?? []) handler(value);
    },
  };
}

/**
 * FNXC:SpecDrift 2026-08-23-08:10:
 * FN-179 must exercise the runtime boundary, not source text: startup only queues live cards,
 * while archived cards re-enter via the durable task-updated subscription after unarchive.
 */
describe("ProjectEngine spec-drift startup replay", () => {
  it("enqueues live tasks at startup and archived tasks only through later live events", async () => {
    const live = task("FN-live");
    const archived = task("FN-archived", "archived");
    const store = createStore([live, archived]);
    mocks.store = store;
    const engine = new ProjectEngine({ projectId: "fn-179", workingDirectory: "/tmp/fn-179", isolationMode: "in-process", maxConcurrent: 1, maxWorktrees: 1 }, {} as never, { skipNotifier: true });
    mocks.enqueued = [];
    await engine.start();

    expect(store.listTasks).toHaveBeenCalledWith({ slim: true });
    expect(mocks.enqueued).toContain("FN-live");
    expect(mocks.enqueued).not.toContain("FN-archived");

    store.emitEvent("task:updated", archived);
    expect(mocks.enqueued).toContain("FN-archived");
    await engine.stop();
  });
});
