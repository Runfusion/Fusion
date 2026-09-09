import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings, Task, TaskStore, WorkflowWorkItem } from "@fusion/core";

const { execMock, execFileMock, existsSyncMock } = vi.hoisted(() => {
  const execFileMock = vi.fn();
  (execFileMock as any)[Symbol.for("nodejs.util.promisify.custom")] = execFileMock;
  return { execMock: vi.fn(), execFileMock, existsSyncMock: vi.fn(() => false) };
});
vi.mock("node:child_process", () => ({ exec: execMock, execSync: vi.fn(), execFile: execFileMock }));
vi.mock("node:fs", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs")>(),
  existsSync: existsSyncMock,
}));
vi.mock("../logger.js", () => ({
  createLogger: vi.fn(() => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() })),
  schedulerLog: { log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
  runtimeLog: { log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { planningContinuationDispatchLeaseOwner } from "../agents/planning-execution-liveness.js";
import { blockOuterDispatchWhenFileScopeLeaseHeld } from "../executor/file-scope-lease-dispatch-gate.js";
import {
  createPlanningContinuationDispatcher,
  createRuntimeSelfHealingManager,
  InProcessRuntime,
} from "../runtimes/in-process-runtime.js";

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    description: "",
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-09-09T21:27:00.000Z",
    updatedAt: "2026-09-09T21:27:00.000Z",
    ...overrides,
  } as Task;
}

function continuation(taskId: string): WorkflowWorkItem {
  return {
    id: "wi-plan-review",
    runId: `${taskId}:builtin:coding:plan-review`,
    taskId,
    nodeId: "plan-review",
    nodeInstanceId: "plan-review",
    kind: "task",
    state: "runnable",
    attempt: 0,
    retryAfter: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    lastError: null,
    blockedReason: null,
    stableWorkflowRunId: `${taskId}:builtin:coding`,
    continuationSequence: 1,
    waitReason: "planning",
    sourceColumn: "todo",
    targetColumn: "todo",
    irHash: "fn-329-ir",
    principalAgentId: null,
    workflowRole: null,
    authorityKind: null,
    createdAt: "2026-09-09T21:27:00.000Z",
    updatedAt: "2026-09-09T21:27:00.000Z",
  };
}

function createHarness() {
  const blocked = makeTask("FN-326");
  const holder = makeTask("FN-327", { column: "in-review", worktree: "/wt/fn-327" });
  const tasks = new Map([[blocked.id, blocked], [holder.id, holder]]);
  let item = continuation(blocked.id);
  const emitter = new EventEmitter();
  const settings = {
    groupOverlappingFiles: true,
    globalPause: false,
    enginePaused: false,
    maxConcurrent: 4,
    pollIntervalMs: 15 * 60_000,
  } as Settings;
  const store = Object.assign(emitter, {
    getSettings: vi.fn(async () => settings),
    getRootDir: vi.fn(() => "/repo"),
    getTasksDir: vi.fn(() => "/repo/.fusion/tasks"),
    listTasks: vi.fn(async (opts?: { column?: string }) => {
      const all = [...tasks.values()];
      return opts?.column ? all.filter((task) => task.column === opts.column) : all;
    }),
    getTask: vi.fn(async (id: string) => tasks.get(id)),
    updateTask: vi.fn(async (id: string, patch: Partial<Task>) => {
      const next = { ...tasks.get(id)!, ...patch } as Task;
      tasks.set(id, next);
      return next;
    }),
    updateTaskAtomic: vi.fn(async (id: string, build: (live: Task) => Partial<Task> | null) => {
      const live = tasks.get(id)!;
      const patch = build(live);
      if (patch) tasks.set(id, { ...live, ...patch } as Task);
      return tasks.get(id)!;
    }),
    transitionQueuedEpisode: vi.fn(async (id: string, transition: Record<string, unknown>) => {
      const live = tasks.get(id)!;
      const next = {
        ...live,
        status: "queued",
        blockedBy: transition.blockedBy,
        overlapBlockedBy: transition.overlapBlockedBy,
        queuedLogEpisodeSignature: transition.signature,
      } as Task;
      tasks.set(id, next);
      return { appended: true, task: next };
    }),
    parseFileScopeFromPrompt: vi.fn(async () => ["packages/dashboard/app/App.tsx"]),
    getCompletionHandoffAcceptedMarker: vi.fn(async () => null),
    getTaskWorkflowSelection: vi.fn(() => undefined),
    getTaskWorkflowSelectionAsync: vi.fn(async () => undefined),
    getWorkflowDefinition: vi.fn(async () => undefined),
    listWorkflowDefinitions: vi.fn(async () => []),
    getWorkflowWorkItem: vi.fn(async () => item),
    listWorkflowWorkItemsForTask: vi.fn(async () => [item]),
    listDueWorkflowWorkItems: vi.fn(async () => item.state === "runnable" || item.state === "retrying" ? [item] : []),
    transitionWorkflowWorkItem: vi.fn(async (_id: string, state: WorkflowWorkItem["state"], patch: Record<string, unknown>) => {
      if ((patch.expectedState === undefined || item.state === patch.expectedState)
        && (patch.expectedLeaseOwner === undefined || item.leaseOwner === patch.expectedLeaseOwner)) {
        const { expectedState: _state, expectedLeaseOwner: _owner, ...updates } = patch;
        item = { ...item, ...updates, state } as WorkflowWorkItem;
      }
      return item;
    }),
    withPlanningLifecycleLock: vi.fn(async (_id: string, callback: () => Promise<unknown>) => callback()),
    logEntry: vi.fn(async () => undefined),
    recordRunAuditEvent: vi.fn(async () => undefined),
    moveTask: vi.fn(async (id: string, column: string) => {
      const live = tasks.get(id)!;
      const next = { ...live, column } as Task;
      tasks.set(id, next);
      emitter.emit("task:moved", {
        task: next,
        from: live.column,
        to: column,
        source: "engine",
        lanes: { review: new Set(["in-review"]), complete: new Set(["done"]) },
      });
      return next;
    }),
  }) as unknown as TaskStore & EventEmitter;
  return { store, blocked, holder, get item() { return item; } };
}

describe("workflow continuation file-scope completion wake", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    execFileMock.mockResolvedValue({ stdout: "", stderr: "" });
    execMock.mockImplementation((_cmd: string, _opts: unknown, callback: (error: unknown, stdout: string, stderr: string) => void) => callback(null, "", ""));
  });

  it("replays a settlement wake after the active runtime drain releases ownership", async () => {
    const h = createHarness();
    const runtime = Object.create(InProcessRuntime.prototype) as any;
    runtime.status = "active";
    runtime.workflowContinuationDrainActive = false;
    runtime.workflowContinuationDrainSince = 0;
    runtime.workflowContinuationDrainPending = false;
    runtime.workflowContinuationDrainGeneration = 0;
    runtime.taskStore = h.store;
    runtime.triageProcessor = undefined;
    let executions = 0;
    runtime.executor = {
      execute: vi.fn(async () => {
        executions++;
        if (executions === 2) {
          await h.store.transitionWorkflowWorkItem(h.item.id, "succeeded", {
            expectedState: "running",
            expectedLeaseOwner: planningContinuationDispatchLeaseOwner(h.item),
            leaseOwner: null,
            leaseExpiresAt: null,
          });
        }
      }),
    };

    runtime.kickWorkflowContinuationProcessor();

    await vi.waitFor(() => expect(executions).toBe(2));
    expect(h.item).toMatchObject({ state: "succeeded", leaseOwner: null });
    expect(h.store.listDueWorkflowWorkItems).toHaveBeenCalledTimes(2);
  });

  it("re-enters plan review from the terminal event without a recovery timer", async () => {
    const h = createHarness();
    let graphEntries = 0;
    let dispatch!: (task: Task, item: WorkflowWorkItem) => Promise<boolean>;
    const scheduler = { requestImmediateSchedule: vi.fn() };
    const kick = vi.fn(() => {
      if (h.item.state === "runnable") void dispatch(h.blocked, h.item);
    });
    dispatch = createPlanningContinuationDispatcher({
      store: h.store,
      projectId: "fn-329-project",
      isPlannerLive: () => false,
      kick,
      execute: async (task) => {
        const gated = await blockOuterDispatchWhenFileScopeLeaseHeld({
          store: h.store,
          getRunContextFor: () => undefined,
        }, task);
        if (gated) return;
        graphEntries++;
        await h.store.transitionWorkflowWorkItem(h.item.id, "succeeded", {
          expectedState: "running",
          expectedLeaseOwner: planningContinuationDispatchLeaseOwner(h.item),
          leaseOwner: null,
          leaseExpiresAt: null,
        });
      },
    });
    const manager = createRuntimeSelfHealingManager(h.store, scheduler, { rootDir: "/repo" }, { kick });
    manager.start();

    await expect(dispatch(h.blocked, h.item)).resolves.toBe(true);
    await vi.waitFor(() => expect(h.item).toMatchObject({
      state: "held",
      leaseOwner: null,
      blockedReason: h.item.blockedReason,
    }));
    expect(h.item.blockedReason).toBe(`file-scope:${h.holder.id}`);
    expect(graphEntries).toBe(0);
    expect(h.blocked.column).toBe("todo");

    await h.store.moveTask(h.holder.id, "done");

    await vi.waitFor(() => expect(graphEntries).toBe(1));
    expect(h.item).toMatchObject({ state: "succeeded", leaseOwner: null });
    expect((await h.store.getTask(h.blocked.id))).toMatchObject({ status: null, overlapBlockedBy: null });
    expect(kick).toHaveBeenCalledOnce();
    expect(scheduler.requestImmediateSchedule).toHaveBeenCalledOnce();
    expect(h.store.logEntry).not.toHaveBeenCalledWith(h.blocked.id, expect.stringContaining("dead-lease"));

    h.store.emit("task:moved", {
      task: await h.store.getTask(h.holder.id),
      from: "in-review",
      to: "done",
      source: "replication",
      lanes: { review: new Set(["in-review"]), complete: new Set(["done"]) },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(graphEntries).toBe(1);
    expect(kick).toHaveBeenCalledOnce();
    manager.stop();
  });
});
