import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { Task, TaskStore } from "@fusion/core";

vi.mock("@fusion/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@fusion/core")>()),
  getCurrentRepo: () => ({ owner: "fusion", repo: "test" }),
}));

import { RemoteNodeRuntime } from "../runtimes/remote-node-runtime.js";
import { Scheduler } from "../scheduler.js";
import { TriageProcessor } from "../triage.js";


function createStore() {
  const store = Object.assign(new EventEmitter(), {
    getRootDir: () => "/test/project",
    getSettings: vi.fn().mockResolvedValue({ globalPause: false, enginePaused: false }),
    listTasks: vi.fn().mockResolvedValue([]),
    logEntry: vi.fn().mockResolvedValue(undefined),
    updateTask: vi.fn().mockResolvedValue(undefined),
    getTask: vi.fn(),
    resolveTaskWorkflowIrSync: vi.fn(() => ({ columns: [] })),
  }) as unknown as TaskStore & EventEmitter;
  return store;
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-bridge",
    title: "bridge compatibility",
    description: "",
    column: "building",
    status: "planning",
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
FNXC:WorkflowEvents 2026-08-01-06:40:
RemoteNodeRuntime is a real runtime boundary, not a synthetic EventEmitter stand-in. It deliberately
re-emits only the serialized Task argument, so a receiving store observes lanes as unknown and its
scheduler and triage listeners retain their literal fallback behavior.
*/
describe("task:updated runtime bridge compatibility", () => {
  it("drops lanes through RemoteNodeRuntime while scheduler and triage retain their absent-meta fallbacks", () => {
    const store = createStore();
    const startMonitoring = vi.fn();
    const scheduler = new Scheduler(store, {
      prMonitor: { startMonitoring, getTrackedPrs: () => new Map(), updatePrInfo: vi.fn() },
    } as never);
    const triage = new TriageProcessor(store, "/test/project");
    triage.start();
    const session = { abort: vi.fn().mockResolvedValue(undefined), dispose: vi.fn() };
    (triage as any).activeSessions.set("FN-bridge", session);
    vi.spyOn(triage as any, "recordTriageSessionTokenUsageSoon").mockImplementation(() => undefined);

    const runtime = new RemoteNodeRuntime({
      nodeConfig: { id: "node-1", name: "node", url: "https://remote.invalid", apiKey: "token" },
      projectId: "project-1",
      projectName: "Project 1",
    });
    const forwarded: Array<[Task, unknown]> = [];
    runtime.on("task:updated", (updated, meta) => {
      forwarded.push([updated, meta]);
      store.emit("task:updated", updated, meta);
    });

    // Exercise the runtime's actual remote-event forwarding method. The remote payload can contain
    // a renamed lane answer, but the runtime's serialized event contract must not forward it as meta.
    (runtime as any).forwardRemoteEvent({
      type: "task:updated",
      payload: task({
        status: "failed",
        sliceId: "slice-1",
        column: "building",
        prInfo: { number: 7, url: "https://example.invalid/7", branch: "fusion/FN-bridge" },
      }),
    });

    expect(forwarded).toHaveLength(1);
    expect(forwarded[0][1]).toBeUndefined();
    expect((scheduler as any).failedTaskIds.has("FN-bridge")).toBe(false);
    expect(startMonitoring).not.toHaveBeenCalled();
    expect(session.dispose).toHaveBeenCalledOnce();
    triage.stop();
  });
});
