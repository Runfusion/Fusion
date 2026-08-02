import { describe, expect, it, vi } from "vitest";
import type { Task, TaskStore } from "@fusion/core";

vi.mock("@fusion/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@fusion/core")>()),
  getCurrentRepo: () => ({ owner: "fusion", repo: "test" }),
}));

import { Scheduler } from "../scheduler.js";

type Listener = (...args: unknown[]) => void;

function createStore() {
  const listeners = new Map<string, Listener[]>();
  const resolveTaskWorkflowIrSync = vi.fn(() => ({ columns: [] }));
  const store = {
    on: vi.fn((event: string, listener: Listener) => listeners.set(event, [...(listeners.get(event) ?? []), listener])),
    off: vi.fn(),
    getRootDir: () => "/test/project",
    getSettings: vi.fn().mockResolvedValue({ globalPause: false, enginePaused: false }),
    listTasks: vi.fn().mockResolvedValue([]),
    resolveTaskWorkflowIrSync,
  } as unknown as TaskStore;
  return {
    store,
    resolveTaskWorkflowIrSync,
    emit(task: Task, meta?: { lanes?: { wip?: string; review?: string } }) {
      for (const listener of listeners.get("task:updated") ?? []) listener(task, meta);
    },
  };
}

function task(overrides: Partial<Task>): Task {
  return {
    id: "FN-update-lanes",
    title: "lane test",
    description: "",
    column: "building",
    status: null,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as Task;
}

/*
FNXC:WorkflowEvents 2026-08-01-06:29:
The scheduler's update handler must act in the emitter's synchronous tick. These cases pin the
renamed workflow answer, the unknown-metadata literal fallback, and the tracked-map re-entrance
barrier so a future resolver/await conversion cannot silently restore default-board behavior.
*/
describe("scheduler task:updated lane metadata", () => {
  it("records renamed-wip failures and starts renamed-review PR monitoring from payload lanes", () => {
    const { store, emit } = createStore();
    const startMonitoring = vi.fn();
    const tracked = new Map<string, unknown>();
    const scheduler = new Scheduler(store, {
      prMonitor: { startMonitoring, getTrackedPrs: () => tracked, updatePrInfo: vi.fn() },
    } as never);

    emit(task({ id: "FN-failed", status: "failed", sliceId: "slice-1", column: "building" }), { lanes: { wip: "building", review: "reviewing" } });
    emit(task({ id: "FN-pr", column: "reviewing", prInfo: { number: 7, url: "https://example.invalid/7", branch: "fusion/FN-pr" } }), { lanes: { wip: "building", review: "reviewing" } });

    expect((scheduler as unknown as { failedTaskIds: Set<string> }).failedTaskIds).toContain("FN-failed");
    expect(startMonitoring).toHaveBeenCalledWith("FN-pr", "fusion", "test", expect.anything());
  });

  it("keeps absent metadata on the legacy literal path without consulting the PostgreSQL sync resolver", () => {
    const { store, emit, resolveTaskWorkflowIrSync } = createStore();
    const startMonitoring = vi.fn();
    const scheduler = new Scheduler(store, {
      prMonitor: { startMonitoring, getTrackedPrs: () => new Map(), updatePrInfo: vi.fn() },
    } as never);

    emit(task({ id: "FN-custom", status: "failed", sliceId: "slice-1", column: "building" }));
    emit(task({ id: "FN-default", status: "failed", sliceId: "slice-1", column: "in-progress" }));
    emit(task({ id: "FN-custom-pr", column: "reviewing", prInfo: { number: 8, url: "https://example.invalid/8", branch: "fusion/FN-custom" } }));

    const failed = (scheduler as unknown as { failedTaskIds: Set<string> }).failedTaskIds;
    expect(failed.has("FN-custom")).toBe(false);
    expect(failed.has("FN-default")).toBe(true);
    expect(startMonitoring).not.toHaveBeenCalled();
    expect(resolveTaskWorkflowIrSync).not.toHaveBeenCalled();
  });

  it("does not double-start a monitor on repeated update events", () => {
    const { store, emit } = createStore();
    const startMonitoring = vi.fn();
    const tracked = new Map<string, unknown>();
    const scheduler = new Scheduler(store, {
      prMonitor: {
        startMonitoring: (...args: unknown[]) => { startMonitoring(...args); tracked.set(args[0] as string, {}); },
        getTrackedPrs: () => tracked,
        updatePrInfo: vi.fn(),
      },
    } as never);
    const prTask = task({ id: "FN-once", column: "reviewing", prInfo: { number: 9, url: "https://example.invalid/9", branch: "fusion/FN-once" } });

    emit(prTask, { lanes: { review: "reviewing" } });
    emit(prTask, { lanes: { review: "reviewing" } });

    expect(startMonitoring).toHaveBeenCalledTimes(1);
  });
});
