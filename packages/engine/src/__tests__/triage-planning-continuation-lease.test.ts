import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, Settings, Task, TaskDetail, TaskStore, WorkflowWorkItem } from "@fusion/core";

import { isPlanningContinuationDispatchClaim } from "../agents/planning-execution-liveness.js";
import {
  createPlanningContinuationDispatcher,
  releaseFileScopeWaitingContinuations,
  planningContinuationTerminalColumns,
} from "../runtimes/in-process-runtime.js";
import { PLANNING_CONTINUATION_LEASE_MS, TriageProcessor } from "../triage.js";

const { mockCreateResolvedAgentSession, mockPromptWithFallback } = vi.hoisted(() => ({
  mockCreateResolvedAgentSession: vi.fn(),
  mockPromptWithFallback: vi.fn(),
}));

vi.mock("../agents/agent-session-helpers.js", () => ({
  createResolvedAgentSession: mockCreateResolvedAgentSession,
  extractRuntimeHint: vi.fn(),
  resolvePlanningSessionModel: vi.fn().mockReturnValue({ provider: "mock", modelId: "mock-model" }),
  resolveExecutorThinkingLevel: vi.fn(() => undefined),
  resolveExecutorFallbackThinkingLevel: vi.fn(() => undefined),
  resolvePlanningThinkingLevel: vi.fn(() => undefined),
  resolvePlanningFallbackThinkingLevel: vi.fn(() => undefined),
  resolveValidatorThinkingLevel: vi.fn(() => undefined),
  resolveValidatorFallbackThinkingLevel: vi.fn(() => undefined),
  resolveMergerThinkingLevel: vi.fn(() => undefined),
  resolveMergerFallbackThinkingLevel: vi.fn(() => undefined),
  resolveImplicitPlanningFallbackModel: vi.fn(() => ({ provider: undefined, modelId: undefined })),
}));

vi.mock("../pi.js", () => {
  class ModelFallbackExhaustedError extends Error {}
  return {
    describeModel: vi.fn().mockReturnValue("mock-model"),
    promptWithFallback: mockPromptWithFallback,
    formatModelMarkerDetails: vi.fn((model: string) => model),
    ModelFallbackExhaustedError,
  };
});

const NOW = new Date("2026-09-06T00:29:00.000Z").getTime();

function task(): Task {
  return {
    id: "FN-299-LEASE",
    title: "Long planning session",
    description: "Keep its planning continuation lease alive",
    column: "todo",
    status: "needs-replan",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
  } as Task;
}

function detail(value: Task): TaskDetail {
  return { ...value, attachments: [], comments: [], log: value.log ?? [] } as TaskDetail;
}

function runnablePlanningContinuation(taskId: string): WorkflowWorkItem {
  return {
    id: "wi-dispatch",
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
    irHash: "fn-299-ir",
    principalAgentId: null,
    workflowRole: null,
    authorityKind: null,
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
  };
}

function triageAgent(): Agent {
  return {
    id: "agent-triage",
    name: "Workflow Planner",
    role: "triage",
    roles: ["triage"],
    state: "idle",
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    metadata: {},
    runtimeConfig: {},
  } as Agent;
}

function harness() {
  const current = task();
  let workItem: WorkflowWorkItem | undefined;
  const transitions = vi.fn(async (
    id: string,
    state: WorkflowWorkItem["state"],
    patch: Record<string, unknown>,
  ) => {
    const { expectedState, expectedLeaseOwner, ...updates } = patch;
    if (!workItem
      || workItem.id !== id
      || (expectedState !== undefined && workItem.state !== expectedState)
      || (expectedLeaseOwner !== undefined && workItem.leaseOwner !== expectedLeaseOwner)) {
      return workItem as WorkflowWorkItem;
    }
    workItem = { ...workItem, ...updates, state, updatedAt: new Date(Date.now()).toISOString() } as WorkflowWorkItem;
    return workItem;
  });
  const replace = vi.fn(async (input: Record<string, unknown>) => {
    workItem = {
      id: "wi-plan",
      attempt: 0,
      retryAfter: null,
      lastError: null,
      blockedReason: null,
      createdAt: new Date(Date.now()).toISOString(),
      updatedAt: new Date(Date.now()).toISOString(),
      ...input,
    } as WorkflowWorkItem;
    return workItem;
  });
  const lifecycleLock = vi.fn(async (_taskId: string, callback: () => Promise<WorkflowWorkItem>) => callback());
  const listWorkflowWorkItemsForTask = vi.fn(async () => workItem ? [workItem] : []);
  const store = {
    getTask: vi.fn(async () => detail(current)),
    listTasks: vi.fn().mockResolvedValue([]),
    getSettings: vi.fn().mockResolvedValue({
      pollIntervalMs: 60_000,
      maxConcurrent: 1,
      maxWorktrees: 1,
      autoMerge: true,
      groupOverlappingFiles: false,
      maxStuckKills: 6,
      requirePlanApproval: false,
    } as Settings),
    getTaskDocument: vi.fn(async () => null),
    getTaskWorkflowSelection: vi.fn(() => undefined),
    getTaskWorkflowSelectionAsync: vi.fn(async () => undefined),
    getWorkflowDefinition: vi.fn(async () => undefined),
    getWorkflowWorkItem: vi.fn(async (id: string) => workItem?.id === id ? workItem : null),
    updateTask: vi.fn(async (_id: string, patch: Partial<Task>) => Object.assign(current, patch)),
    moveTask: vi.fn(async (_id: string, column: Task["column"]) => Object.assign(current, { column, status: null })),
    logEntry: vi.fn(async () => undefined),
    appendAgentLog: vi.fn().mockResolvedValue(undefined),
    parseDependenciesFromPrompt: vi.fn().mockResolvedValue([]),
    parseStepsFromPrompt: vi.fn().mockResolvedValue([]),
    parseFileScopeFromPrompt: vi.fn().mockResolvedValue([]),
    replaceActiveTaskWorkflowContinuation: replace,
    transitionWorkflowWorkItem: transitions,
    withPlanningLifecycleLock: lifecycleLock,
    listWorkflowWorkItemsForTask,
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as TaskStore;
  const agent = triageAgent();
  const agentStore = {
    workflowProjectId: "fn-299-project",
    listAgents: vi.fn(async () => [agent]),
    getAgent: vi.fn(async () => agent),
    acquireWorkflowSessionCapacity: vi.fn(async () => "acquired" as const),
    releaseWorkflowSessionCapacity: vi.fn(async () => undefined),
  };
  const processor = new TriageProcessor(store, "/repo", { agentStore: agentStore as never });
  return {
    current,
    store,
    processor,
    replace,
    transitions,
    lifecycleLock,
    listWorkflowWorkItemsForTask,
    get workItem() {
      return workItem;
    },
    replaceWorkItem(next: WorkflowWorkItem) {
      workItem = next;
    },
  };
}

async function waitForCall(mock: ReturnType<typeof vi.fn>): Promise<void> {
  await vi.waitFor(() => expect(mock).toHaveBeenCalled(), { timeout: 1_000, interval: 1 });
}

/*
FNXC:PlanningContinuationLease 2026-09-06-00:29:
The durable plan row must describe its live owner even when planning exceeds ten minutes. This test
holds the real `specifyTask` model turn open, observes installation and renewal through TaskStore,
then proves finalization clears the timer and cannot revive a row after a compare-and-set loss.
*/
describe("triage planning continuation lease", () => {
  let restoreSetInterval: (() => void) | undefined;
  let unref: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.clearAllMocks();
    mockCreateResolvedAgentSession.mockResolvedValue({
      session: {
        state: {},
        sessionManager: { getLeafId: vi.fn().mockReturnValue(null) },
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
        navigateTree: vi.fn(),
      },
    });

    const fakeSetInterval = globalThis.setInterval;
    unref = vi.fn();
    const spy = vi.spyOn(globalThis, "setInterval").mockImplementation(((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      const timer = fakeSetInterval(handler, timeout, ...args);
      Object.defineProperty(timer, "unref", { configurable: true, value: unref });
      return timer;
    }) as typeof setInterval);
    restoreSetInterval = () => spy.mockRestore();
  });

  afterEach(() => {
    restoreSetInterval?.();
    restoreSetInterval = undefined;
    vi.useRealTimers();
  });

  it("installs, renews, and stops a future compare-and-set lease", async () => {
    const h = harness();
    let finishPrompt: (() => void) | undefined;
    mockPromptWithFallback.mockImplementationOnce(() => new Promise<void>((resolve) => {
      finishPrompt = resolve;
    }));

    const planning = h.processor.specifyTask(h.current);
    await waitForCall(h.replace);
    await waitForCall(mockPromptWithFallback);

    expect(h.lifecycleLock).toHaveBeenCalledWith(h.current.id, expect.any(Function));
    expect(h.replace).toHaveBeenCalledWith(expect.objectContaining({
      state: "running",
      leaseOwner: expect.stringMatching(/^triage:FN-299-LEASE:triage-FN-299-LEASE-/),
      leaseExpiresAt: expect.any(String),
    }));
    const installed = h.replace.mock.calls[0]?.[0] as Record<string, unknown>;
    const installedLeaseOwner = String(installed.leaseOwner);
    expect(Date.parse(String(installed.leaseExpiresAt)) - Date.parse(h.workItem!.createdAt))
      .toBe(PLANNING_CONTINUATION_LEASE_MS);
    expect(unref).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(PLANNING_CONTINUATION_LEASE_MS / 3);
    expect(h.transitions).toHaveBeenCalledWith("wi-plan", "running", expect.objectContaining({
      expectedState: "running",
      expectedLeaseOwner: installedLeaseOwner,
      leaseOwner: installedLeaseOwner,
      leaseExpiresAt: expect.any(String),
    }));
    const renewalPatch = h.transitions.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(Date.parse(String(renewalPatch.leaseExpiresAt)) - Date.parse(h.workItem!.updatedAt))
      .toBe(PLANNING_CONTINUATION_LEASE_MS);

    h.processor.markStuckAborted(h.current.id);
    finishPrompt?.();
    await planning;
    const transitionCountAfterFinally = h.transitions.mock.calls.length;
    expect(h.transitions).toHaveBeenLastCalledWith("wi-plan", "succeeded", expect.objectContaining({
      expectedState: "running",
      expectedLeaseOwner: installedLeaseOwner,
      leaseOwner: null,
      leaseExpiresAt: null,
    }));

    await vi.advanceTimersByTimeAsync(PLANNING_CONTINUATION_LEASE_MS);
    expect(h.transitions).toHaveBeenCalledTimes(transitionCountAfterFinally);
  });

  it("absorbs a failed renewal without reviving or escaping the planning turn", async () => {
    const h = harness();
    let finishPrompt: (() => void) | undefined;
    mockPromptWithFallback.mockImplementationOnce(() => new Promise<void>((resolve) => {
      finishPrompt = resolve;
    }));
    const planning = h.processor.specifyTask(h.current);
    await waitForCall(h.replace);
    await waitForCall(mockPromptWithFallback);
    h.transitions.mockRejectedValueOnce(new Error("compare-and-set lost"));

    await vi.advanceTimersByTimeAsync(PLANNING_CONTINUATION_LEASE_MS / 3);
    expect(h.transitions).toHaveBeenCalledTimes(1);

    h.processor.markStuckAborted(h.current.id);
    finishPrompt?.();
    await expect(planning).resolves.toBeUndefined();
    const installedLeaseOwner = String((h.replace.mock.calls[0]?.[0] as Record<string, unknown>).leaseOwner);
    expect(h.transitions).toHaveBeenLastCalledWith("wi-plan", "succeeded", expect.objectContaining({
      expectedState: "running",
      expectedLeaseOwner: installedLeaseOwner,
      leaseOwner: null,
      leaseExpiresAt: null,
    }));
  });

  it("cannot renew or terminalize a successor that is running under a new owner", async () => {
    const h = harness();
    let finishPrompt: (() => void) | undefined;
    mockPromptWithFallback.mockImplementationOnce(() => new Promise<void>((resolve) => {
      finishPrompt = resolve;
    }));
    const planning = h.processor.specifyTask(h.current);
    await waitForCall(h.replace);
    await waitForCall(mockPromptWithFallback);
    const oldOwner = h.workItem!.leaseOwner;
    h.replaceWorkItem({
      ...h.workItem!,
      state: "running",
      leaseOwner: "workflow-dispatch:new-attempt",
      leaseExpiresAt: new Date(Date.now() + PLANNING_CONTINUATION_LEASE_MS).toISOString(),
    });

    await vi.advanceTimersByTimeAsync(PLANNING_CONTINUATION_LEASE_MS / 3);
    expect(h.transitions).toHaveBeenLastCalledWith("wi-plan", "running", expect.objectContaining({
      expectedState: "running",
      expectedLeaseOwner: oldOwner,
    }));
    expect(h.workItem).toMatchObject({
      state: "running",
      leaseOwner: "workflow-dispatch:new-attempt",
    });

    h.processor.markStuckAborted(h.current.id);
    finishPrompt?.();
    await planning;
    expect(h.transitions).toHaveBeenLastCalledWith("wi-plan", "succeeded", expect.objectContaining({
      expectedState: "running",
      expectedLeaseOwner: oldOwner,
    }));
    expect(h.workItem).toMatchObject({
      state: "running",
      leaseOwner: "workflow-dispatch:new-attempt",
    });
  });

  /*
  FNXC:PlanningContinuationDispatch 2026-09-06-01:58:
  Exercise the missing dispatch-first ordering through both production boundaries. The runtime must
  first persist its running claim; a later real specifyTask call must observe that claim under the
  lifecycle lock and return before replacing it or creating a planner session.

  FNXC:PlanningContinuationDispatch 2026-09-06-02:12:
  The losing planner must observe dispatch before publishing its planning status. Returning only at
  continuation installation leaves `status:"planning"` with no planner-owned row to clean it up and
  hides the already-running graph, so this case also proves triage performs no task mutation.
  */
  it("keeps one authority when dispatch claims before the planner installs", async () => {
    const h = harness();
    const runnable = runnablePlanningContinuation(h.current.id);
    h.replaceWorkItem(runnable);
    let finishExecution!: () => void;
    const execute = vi.fn(() => new Promise<void>((resolve) => { finishExecution = resolve; }));
    const dispatch = createPlanningContinuationDispatcher({
      store: h.store,
      projectId: "fn-299-project",
      execute,
      isPlannerLive: () => false,
    });

    await expect(dispatch(h.current, runnable)).resolves.toBe(true);
    expect(execute).toHaveBeenCalledOnce();
    expect(h.workItem && isPlanningContinuationDispatchClaim(h.workItem)).toBe(true);
    expect(h.transitions).toHaveBeenCalledWith(runnable.id, "running", expect.objectContaining({
      expectedState: "runnable",
      expectedLeaseOwner: null,
      leaseOwner: expect.stringMatching(/^planning-continuation-dispatch:/),
    }));

    await expect(h.processor.specifyTask(h.current)).resolves.toBeUndefined();

    expect(h.lifecycleLock).toHaveBeenCalledTimes(2);
    expect(h.current.status).toBe("needs-replan");
    expect(h.store.updateTask).not.toHaveBeenCalled();
    expect(h.transitions).toHaveBeenCalledTimes(1);
    expect(h.replace).not.toHaveBeenCalled();
    expect(mockCreateResolvedAgentSession).not.toHaveBeenCalled();
    expect(mockPromptWithFallback).not.toHaveBeenCalled();
    expect(h.workItem && isPlanningContinuationDispatchClaim(h.workItem)).toBe(true);

    finishExecution();
    await Promise.resolve();
  });

  it("parks the exact dispatch claim without a lease when outer file-scope admission returns", async () => {
    const h = harness();
    const runnable = runnablePlanningContinuation(h.current.id);
    h.replaceWorkItem(runnable);
    const kick = vi.fn();
    const dispatch = createPlanningContinuationDispatcher({
      store: h.store,
      projectId: "fn-329-project",
      execute: vi.fn(async () => {
        Object.assign(h.current, { status: "queued", overlapBlockedBy: "FN-HOLDER" });
      }),
      isPlannerLive: () => false,
      kick,
    });

    await expect(dispatch(h.current, runnable)).resolves.toBe(true);
    await vi.waitFor(() => expect(h.workItem).toMatchObject({
      state: "held",
      leaseOwner: null,
      leaseExpiresAt: null,
      blockedReason: "file-scope:FN-HOLDER",
    }));
    expect(kick).not.toHaveBeenCalled();
    expect(h.transitions).toHaveBeenLastCalledWith(runnable.id, "held", expect.objectContaining({
      expectedState: "running",
      expectedLeaseOwner: expect.stringMatching(/^planning-continuation-dispatch:/),
    }));
  });

  it("re-enters the real admission path after ownership cleanup when completion wins before settlement", async () => {
    const h = harness();
    const runnable = runnablePlanningContinuation(h.current.id);
    h.replaceWorkItem(runnable);
    const execute = vi.fn(async () => {
      if (execute.mock.calls.length === 1) {
        Object.assign(h.current, { status: null, overlapBlockedBy: null });
        return;
      }
      h.replaceWorkItem({ ...h.workItem!, state: "succeeded", leaseOwner: null });
    });
    let dispatch!: ReturnType<typeof createPlanningContinuationDispatcher>;
    const kick = vi.fn(() => {
      const due = h.workItem;
      if (due) void dispatch(h.current, due);
    });
    dispatch = createPlanningContinuationDispatcher({
      store: h.store,
      projectId: "fn-329-project",
      execute,
      isPlannerLive: () => false,
      kick,
    });

    await expect(dispatch(h.current, runnable)).resolves.toBe(true);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    expect(kick).toHaveBeenCalledOnce();
    expect(h.workItem).toMatchObject({ state: "succeeded", leaseOwner: null });
    expect(h.transitions).toHaveBeenCalledWith(runnable.id, "running", expect.objectContaining({
      expectedState: "runnable",
      expectedLeaseOwner: null,
    }));
  });

  it("releases only the matching lease-free file-scope wait", async () => {
    const h = harness();
    h.replaceWorkItem({
      ...runnablePlanningContinuation(h.current.id),
      state: "held",
      blockedReason: "file-scope:FN-HOLDER",
    });
    Object.assign(h.current, { status: null, overlapBlockedBy: null });

    await expect(releaseFileScopeWaitingContinuations(h.store, [{
      taskId: h.current.id,
      blockerId: "FN-OTHER",
    }])).resolves.toEqual([]);
    expect(h.workItem).toMatchObject({ state: "held", blockedReason: "file-scope:FN-HOLDER" });

    Object.assign(h.current, { blockedBy: "FN-DEPENDENCY" });
    await expect(releaseFileScopeWaitingContinuations(h.store, [{
      taskId: h.current.id,
      blockerId: "FN-HOLDER",
    }])).resolves.toEqual([]);
    expect(h.workItem).toMatchObject({ state: "held", blockedReason: "file-scope:FN-HOLDER" });

    Object.assign(h.current, { blockedBy: null });
    await expect(releaseFileScopeWaitingContinuations(h.store, [{
      taskId: h.current.id,
      blockerId: "FN-HOLDER",
    }])).resolves.toEqual(["wi-dispatch"]);
    expect(h.workItem).toMatchObject({ state: "runnable", blockedReason: null, leaseOwner: null });
  });

  it("does not overwrite a terminalized row or same-state successor owner during settlement", async () => {
    const h = harness();
    const runnable = runnablePlanningContinuation(h.current.id);
    h.replaceWorkItem(runnable);
    let finish!: () => void;
    const dispatch = createPlanningContinuationDispatcher({
      store: h.store,
      projectId: "fn-329-project",
      execute: vi.fn(() => new Promise<void>((resolve) => { finish = resolve; })),
      isPlannerLive: () => false,
    });

    await expect(dispatch(h.current, runnable)).resolves.toBe(true);
    h.replaceWorkItem({ ...h.workItem!, state: "running", leaseOwner: "planning-continuation-dispatch:successor:1" });
    Object.assign(h.current, { status: "queued", overlapBlockedBy: "FN-HOLDER" });
    finish();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.workItem).toMatchObject({ state: "running", leaseOwner: "planning-continuation-dispatch:successor:1" });

    h.replaceWorkItem({ ...h.workItem!, state: "succeeded", leaseOwner: null });
    expect(h.workItem).toMatchObject({ state: "succeeded", leaseOwner: null });
  });

  /*
  FNXC:PlanningContinuationDispatch 2026-09-06-00:39:
  Capacity admission can outlive the drain's first task read. The locked point-of-use recheck must
  reject a task that is now in its workflow's renamed completion lane before claiming or dispatching
  the continuation; falling back to the built-in Done id would restart completed work.
  */
  it("rechecks renamed completion lanes before claiming a continuation", async () => {
    const h = harness();
    const runnable = runnablePlanningContinuation(h.current.id);
    h.replaceWorkItem(runnable);
    h.current.column = "shipped";
    const execute = vi.fn().mockResolvedValue(undefined);
    const resolveTerminalColumns = vi.fn().mockResolvedValue(new Set(["shipped"]));
    const dispatch = createPlanningContinuationDispatcher({
      store: h.store,
      projectId: "fn-299-project",
      execute,
      isPlannerLive: () => false,
      resolveTerminalColumns,
    });

    await expect(dispatch(h.current, runnable)).resolves.toBe(true);

    expect(resolveTerminalColumns).toHaveBeenCalledWith(h.current.id);
    expect(execute).not.toHaveBeenCalled();
    expect(h.transitions).not.toHaveBeenCalled();
    expect(h.workItem).toEqual(runnable);
  });

  it("does not treat built-in Done as terminal when the resolved workflow does not", () => {
    expect([...planningContinuationTerminalColumns({ complete: "shipped" })]).toEqual(["shipped"]);
    expect([...planningContinuationTerminalColumns(undefined)]).toEqual(["done"]);
  });

  it("does not mutate task state when dispatch-claim inspection fails before planner ownership", async () => {
    const h = harness();
    const runnable = runnablePlanningContinuation(h.current.id);
    h.replaceWorkItem(runnable);
    let finishExecution!: () => void;
    const execute = vi.fn(() => new Promise<void>((resolve) => { finishExecution = resolve; }));
    const dispatch = createPlanningContinuationDispatcher({
      store: h.store,
      projectId: "fn-299-project",
      execute,
      isPlannerLive: () => false,
    });

    await expect(dispatch(h.current, runnable)).resolves.toBe(true);
    const dispatchClaim = { ...h.workItem! };
    const transitionCountAfterDispatch = h.transitions.mock.calls.length;
    h.listWorkflowWorkItemsForTask.mockRejectedValueOnce(new Error("dispatch claim read unavailable"));

    await expect(h.processor.specifyTask(h.current)).resolves.toBeUndefined();

    expect(h.listWorkflowWorkItemsForTask).toHaveBeenLastCalledWith(h.current.id, { kinds: ["task"] });
    expect(h.current.status).toBe("needs-replan");
    expect(h.store.updateTask).not.toHaveBeenCalled();
    expect(h.store.moveTask).not.toHaveBeenCalled();
    expect(h.store.logEntry).not.toHaveBeenCalled();
    expect(h.transitions).toHaveBeenCalledTimes(transitionCountAfterDispatch);
    expect(h.replace).not.toHaveBeenCalled();
    expect(mockCreateResolvedAgentSession).not.toHaveBeenCalled();
    expect(mockPromptWithFallback).not.toHaveBeenCalled();
    expect(h.workItem).toEqual(dispatchClaim);
    expect(h.workItem && isPlanningContinuationDispatchClaim(h.workItem)).toBe(true);

    finishExecution();
    await Promise.resolve();
  });
});
