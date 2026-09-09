import { describe, expect, it, vi } from "vitest";
import type { Settings, Task, TaskStore, WorkflowWorkItem } from "@fusion/core";

const { resolveTaskLifecycleColumnsMock } = vi.hoisted(() => ({
  resolveTaskLifecycleColumnsMock: vi.fn(async () => ({ complete: "done" })),
}));
vi.mock("@fusion/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@fusion/core")>()),
  resolveTaskLifecycleColumns: resolveTaskLifecycleColumnsMock,
}));

import { registerPlanningLivenessProbe } from "../agents/planning-liveness.js";
import { SelfHealingManager } from "../self-healing.js";
import {
  createPlanningContinuationDispatcher,
  drainDuePlanningContinuations,
  resolvePlanningContinuationCandidate,
} from "../runtimes/in-process-runtime.js";
import { TriageProcessor } from "../triage.js";

const NOW = Date.parse("2026-09-06T00:29:00.000Z");
const STALE = new Date(NOW - 20 * 60_000).toISOString();

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-299-RACE",
    title: "Planner and Plan Review must be sequential",
    description: "Reproduce a live planner whose plan row looks abandoned",
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: STALE,
    updatedAt: STALE,
    ...overrides,
  } as Task;
}

function planItem(overrides: Partial<WorkflowWorkItem> = {}): WorkflowWorkItem {
  return {
    id: "wi-plan",
    runId: "triage-FN-299-RACE",
    taskId: "FN-299-RACE",
    nodeId: "plan",
    nodeInstanceId: "plan",
    kind: "task",
    state: "running",
    attempt: 0,
    retryAfter: null,
    leaseOwner: "triage:FN-299-RACE",
    leaseExpiresAt: null,
    lastError: null,
    blockedReason: null,
    createdAt: STALE,
    updatedAt: STALE,
    ...overrides,
  } as WorkflowWorkItem;
}

function raceHarness() {
  const currentTask = task();
  let item = planItem();
  const logs: string[] = [];
  const transitionWorkflowWorkItem = vi.fn(async (
    id: string,
    state: WorkflowWorkItem["state"],
    patch: Record<string, unknown>,
  ) => {
    if (id !== item.id || (patch.expectedState && patch.expectedState !== item.state)) return item;
    item = { ...item, ...patch, state, updatedAt: new Date(NOW).toISOString() } as WorkflowWorkItem;
    return item;
  });
  const store = {
    getSettings: vi.fn(async () => ({ globalPause: false, enginePaused: false } as Settings)),
    listDueWorkflowWorkItems: vi.fn(async () => [item]),
    getTask: vi.fn(async () => currentTask),
    transitionWorkflowWorkItem,
    logEntry: vi.fn(async (_id: string, message: string) => { logs.push(message); }),
    getRootDir: vi.fn(() => "/repo"),
    getTasksDir: vi.fn(() => "/repo/.fusion/tasks"),
  } as unknown as TaskStore;
  return {
    currentTask,
    store,
    logs,
    transitionWorkflowWorkItem,
    get item() {
      return item;
    },
    forceItem(next: WorkflowWorkItem) {
      item = next;
    },
  };
}

async function drain(h: ReturnType<typeof raceHarness>, plannerLive: boolean) {
  const dispatched: string[] = [];
  const deferred: Array<{ itemId: string; expectedState: string; retryAfter: string }> = [];
  await drainDuePlanningContinuations({
    listDue: async () => h.item.state === "runnable" || h.item.state === "retrying" ? [h.item] : [],
    getTask: async () => h.currentTask,
    resolveTerminalColumns: async () => new Set(["done"]),
    isPlannerLive: () => plannerLive,
    cancelOrphan: async () => undefined,
    defer: async (value) => { deferred.push(value); },
    dispatch: async (_task, item) => {
      dispatched.push(item.nodeId);
      dispatched.push("plan-review");
    },
    nowMs: () => NOW,
    warn: () => undefined,
  });
  return { dispatched, deferred };
}

/*
FNXC:PlanningContinuationDispatch 2026-09-06-00:29:
This replays FN-299 at the recovery and drain boundary: an old NULL-lease `plan` row must remain owned
while the planner lives, and even an independently-runnable copy must be deferred. Once ownership
clears, recovery may hand the row to the graph, where the only observable order is plan then review.
*/
describe("Plan Review cannot overlap a live planning session", () => {
  function delayedAdmissionHarness() {
    const currentTask = task({ status: null });
    let currentItem = planItem({ state: "runnable", leaseOwner: null, leaseExpiresAt: null });
    let releaseSettings!: () => void;
    let settingsRequested!: () => void;
    const requested = new Promise<void>((resolve) => { settingsRequested = resolve; });
    const settingsReady = new Promise<Settings>((resolve) => {
      releaseSettings = () => resolve({ maxConcurrent: 4 } as Settings);
    });
    const lockEvents: string[] = [];
    const store = {
      getSettings: vi.fn(async () => {
        settingsRequested();
        return await settingsReady;
      }),
      listTasks: vi.fn(async () => [currentTask]),
      getTask: vi.fn(async () => currentTask),
      getTaskWorkflowSelection: vi.fn(() => undefined),
      getTaskWorkflowSelectionAsync: vi.fn(async () => undefined),
      getWorkflowDefinition: vi.fn(async () => undefined),
      getWorkflowWorkItem: vi.fn(async () => {
        lockEvents.push("item-read");
        return currentItem;
      }),
      withPlanningLifecycleLock: vi.fn(async (_taskId: string, callback: () => Promise<boolean>) => {
        lockEvents.push("lock-enter");
        const result = await callback();
        lockEvents.push("lock-exit");
        return result;
      }),
      logEntry: vi.fn(async () => undefined),
    } as unknown as TaskStore;
    return {
      currentTask,
      store,
      requested,
      releaseSettings,
      lockEvents,
      get currentItem() { return currentItem; },
      replaceItem(next: WorkflowWorkItem) { currentItem = next; },
    };
  }

  it("neither reclaims nor dispatches the incident row while planning remains live", async () => {
    const h = raceHarness();
    const manager = new SelfHealingManager(h.store, { rootDir: "/repo" });
    const unregister = registerPlanningLivenessProbe((taskId) => taskId === h.currentTask.id);
    try {
      await expect(manager.reconcileStrandedWorkflowContinuations()).resolves.toBe(0);
      expect(h.item.state).toBe("running");
      expect(h.transitionWorkflowWorkItem).not.toHaveBeenCalled();
      expect(h.logs).toEqual([]);

      const untouched = await drain(h, true);
      expect(untouched.dispatched).toEqual([]);

      h.forceItem(planItem({ state: "runnable" }));
      const independentlyRunnable = await drain(h, true);
      expect(independentlyRunnable.dispatched).toEqual([]);
      expect(independentlyRunnable.deferred).toEqual([expect.objectContaining({
        itemId: "wi-plan",
        expectedState: "runnable",
      })]);
    } finally {
      unregister();
    }
  });

  it("recovers after planning exits and dispatches only plan then Plan Review", async () => {
    const h = raceHarness();
    const manager = new SelfHealingManager(h.store, { rootDir: "/repo" });
    const unregister = registerPlanningLivenessProbe((taskId) => taskId === h.currentTask.id);
    unregister();

    await expect(manager.reconcileStrandedWorkflowContinuations()).resolves.toBe(1);
    expect(h.item.state).toBe("runnable");
    expect(h.logs).toEqual([expect.stringContaining("plan was stranded in 'running' (dead-lease)")]);

    const resumed = await drain(h, false);
    expect(resumed.deferred).toEqual([]);
    expect(resumed.dispatched).toEqual(["plan", "plan-review"]);
  });

  it("rechecks planner ownership under the lifecycle lock after capacity admission waits", async () => {
    const h = delayedAdmissionHarness();
    const execute = vi.fn(async () => undefined);
    let plannerLive = false;
    const isPlannerLive = () => plannerLive;
    const draining = drainDuePlanningContinuations({
      listDue: async () => [h.currentItem],
      getTask: async () => h.currentTask,
      resolveTerminalColumns: async () => new Set(["done"]),
      isPlannerLive,
      cancelOrphan: async () => undefined,
      defer: async () => undefined,
      dispatch: createPlanningContinuationDispatcher({
        store: h.store,
        projectId: "fn-299-dispatch-fence",
        execute,
        isPlannerLive,
      }),
      nowMs: () => NOW,
      warn: () => undefined,
    });

    await h.requested;
    plannerLive = true;
    h.releaseSettings();
    await draining;

    expect(h.store.withPlanningLifecycleLock).toHaveBeenCalledWith(h.currentTask.id, expect.any(Function));
    expect(h.lockEvents).toEqual(["lock-enter", "lock-exit"]);
    expect(execute).not.toHaveBeenCalled();
  });

  it("revalidates the exact durable continuation under the dispatch fence", async () => {
    const h = delayedAdmissionHarness();
    const execute = vi.fn(async () => undefined);
    const draining = drainDuePlanningContinuations({
      listDue: async () => [h.currentItem],
      getTask: async () => h.currentTask,
      resolveTerminalColumns: async () => new Set(["done"]),
      isPlannerLive: () => false,
      cancelOrphan: async () => undefined,
      defer: async () => undefined,
      dispatch: createPlanningContinuationDispatcher({
        store: h.store,
        projectId: "fn-299-continuation-fence",
        execute,
        isPlannerLive: () => false,
      }),
      nowMs: () => NOW,
      warn: () => undefined,
    });

    await h.requested;
    h.replaceItem(planItem({
      id: h.currentItem.id,
      runId: "triage-FN-299-RACE-new-owner",
      state: "running",
      leaseOwner: "triage:FN-299-RACE:new-owner",
      leaseExpiresAt: new Date(NOW + 60_000).toISOString(),
    }));
    h.releaseSettings();
    await draining;

    expect(h.lockEvents).toEqual(["lock-enter", "item-read", "lock-exit"]);
    expect(execute).not.toHaveBeenCalled();
  });

  it("evicts a stale owner with no live session so planner deferral remains bounded", () => {
    const processor = new TriageProcessor({ on: vi.fn(), off: vi.fn() } as unknown as TaskStore, "/repo");
    const internals = processor as unknown as {
      processing: Set<string>;
      processingSince: Map<string, number>;
    };
    internals.processing.add("FN-299-STALE");
    internals.processingSince.set("FN-299-STALE", Date.now() - 31 * 60_000);
    const item = planItem({ taskId: "FN-299-STALE", state: "runnable" });
    const staleTask = task({ id: "FN-299-STALE" });

    expect(processor.getPlanningTaskIds()).toContain("FN-299-STALE");
    expect(resolvePlanningContinuationCandidate(item, staleTask, {
      plannerLive: processor.getPlanningTaskIds().has("FN-299-STALE"),
    })).toMatchObject({ kind: "skip", reason: "planner-live" });

    expect(processor.evictStaleProcessing()).toEqual(new Set(["FN-299-STALE"]));
    expect(processor.getPlanningTaskIds()).not.toContain("FN-299-STALE");
    expect(resolvePlanningContinuationCandidate(item, staleTask, {
      plannerLive: processor.getPlanningTaskIds().has("FN-299-STALE"),
    })).toMatchObject({ kind: "actionable" });
    processor.stop();
  });
});
