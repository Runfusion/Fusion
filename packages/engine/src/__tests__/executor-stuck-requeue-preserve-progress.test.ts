import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "@fusion/core";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import { activeSessionRegistry, executingTaskLock } from "../agents/active-session-registry.js";
import { markStuckAborted } from "../executor/mark-stuck-aborted.js";
import {
  createMockStore,
  createWorkflowRoutingAgentStore,
  mockCleanup,
  mockExecuteAll,
  mockedCreateFnAgent,
  mockedStepSessionExecutor,
  resetExecutorMocks,
} from "./executor-test-helpers.js";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-217-STUCK",
    title: "Resume stuck work",
    description: "",
    column: "in-progress",
    status: "failed",
    error: "old session error",
    effectiveNodeId: "steps#0:step-execute",
    currentStep: 1,
    steps: [
      { name: "Implemented", status: "done" },
      { name: "Continue", status: "in-progress" },
    ],
    worktree: "/tmp/fn-217-stuck",
    branch: "fusion/fn-217-stuck",
    dependencies: [],
    log: [],
    createdAt: "2026-08-28T00:00:00.000Z",
    updatedAt: "2026-08-28T00:00:00.000Z",
    ...overrides,
  } as Task;
}

function harness(subject: Task) {
  const reexecuteTaskInPlace = vi.fn(async () => undefined);
  const store = {
    getTask: vi.fn(async () => subject),
    getSettings: vi.fn(async () => ({})),
    updateTask: vi.fn(async (_id: string, patch: Partial<Task>) => Object.assign(subject, patch)),
    logEntry: vi.fn(async () => undefined),
  };
  const deps = {
    store,
    activeStepExecutors: new Map(),
    stuckAborted: new Map<string, boolean>(),
    executing: new Set([subject.id]),
    loopRecoveryState: new Map(),
    terminateAllChildren: vi.fn(async () => undefined),
    prepareAbortInFlightTaskWork: vi.fn(() => ({ complete: vi.fn(async () => undefined) })),
    clearPausedAborted: vi.fn(),
    reexecuteTaskInPlace,
  };
  return { deps, store, reexecuteTaskInPlace };
}

beforeEach(() => {
  resetExecutorMocks();
});

afterEach(() => {
  vi.useRealTimers();
  executingTaskLock._clearForTest();
});

describe("stuck-session in-place resume", () => {
  it("resumes the same column, node, and step while preserving checkout and progress", async () => {
    vi.useFakeTimers();
    const subject = task();
    const before = {
      column: subject.column,
      effectiveNodeId: subject.effectiveNodeId,
      currentStep: subject.currentStep,
      steps: structuredClone(subject.steps),
      worktree: subject.worktree,
      branch: subject.branch,
    };
    const { deps, reexecuteTaskInPlace } = harness(subject);
    expect(executingTaskLock.claim(subject.id)).not.toBeNull();

    markStuckAborted(deps as never, subject.id);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(subject).toMatchObject({ ...before, status: null, error: null });
    expect(reexecuteTaskInPlace).toHaveBeenCalledOnce();
    expect(reexecuteTaskInPlace).toHaveBeenCalledWith(subject.id);
    expect(deps.executing.has(subject.id)).toBe(false);
  });

  it("invalidates before a late unwind can persist or clear the resumed attempt", async () => {
    vi.useFakeTimers();
    const subject = task({
      effectiveNodeId: "steps#6:step-execute",
      currentStep: 6,
      steps: [
        { name: "Earlier", status: "done" },
        { name: "Testing", status: "in-progress" },
      ],
    });
    const { deps, store, reexecuteTaskInPlace } = harness(subject);
    const oldLease = executingTaskLock.claim(subject.id);
    if (!oldLease) throw new Error("old execution lease missing");
    let finishAbort!: () => void;
    const abortGate = new Promise<void>((resolve) => { finishAbort = resolve; });
    deps.prepareAbortInFlightTaskWork = vi.fn(() => ({ complete: vi.fn(async () => abortGate) }));
    let successorLease: ReturnType<typeof executingTaskLock.claim> = null;
    reexecuteTaskInPlace.mockImplementation(async () => {
      successorLease = executingTaskLock.claim(subject.id);
      deps.executing.add(subject.id);
    });
    const staleMove = vi.fn(async () => undefined);

    markStuckAborted(deps as never, subject.id);
    vi.advanceTimersByTime(60_000);
    await Promise.resolve();
    const staleUnwind = executingTaskLock.runIfOwner(oldLease, staleMove);
    finishAbort();
    await vi.runAllTimersAsync();

    expect(await staleUnwind).toEqual({ executed: false });
    expect(staleMove).not.toHaveBeenCalled();
    expect(reexecuteTaskInPlace).toHaveBeenCalledOnce();
    expect(successorLease).not.toBeNull();
    expect(successorLease && executingTaskLock.owns(successorLease)).toBe(true);
    expect(subject).toMatchObject({
      column: "in-progress",
      effectiveNodeId: "steps#6:step-execute",
      currentStep: 6,
      worktree: "/tmp/fn-217-stuck",
      branch: "fusion/fn-217-stuck",
    });
    expect(store.logEntry.mock.calls.flat().join(" ")).not.toMatch(/parent moved|unattributed automatic move|no further action needed/i);
  });

  it("waits for destructive step cleanup already in the FIFO before starting a real successor", async () => {
    vi.useFakeTimers();
    const subject = task({
      id: "FN-312-STEP",
      enabledWorkflowSteps: [],
      prompt: "# Task\n## Steps\n### Step 0: Earlier\n- [x] done\n### Step 1: Testing\n- [ ] work",
      baseCommitSha: "base-sha",
    });
    const store = createMockStore();
    store.getTask.mockResolvedValue(subject);
    store.getSettings.mockResolvedValue({
      autoMerge: false,
      runStepsInNewSessions: true,
      maxParallelSteps: 1,
      maxConcurrent: 2,
      maxWorktrees: 4,
    });
    const executor = new TaskExecutor(store as never, "/tmp/test", {
      agentStore: createWorkflowRoutingAgentStore(store).agentStore,
    });
    let rejectSteps!: (error: Error) => void;
    mockExecuteAll
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectSteps = reject; }))
      .mockResolvedValueOnce(undefined);
    let releaseOldCleanup!: () => void;
    mockCleanup
      .mockImplementationOnce(() => new Promise<void>((resolve) => { releaseOldCleanup = resolve; }))
      .mockResolvedValueOnce(undefined);

    const oldRun = (executor as any).runImplementation(subject, vi.fn(), vi.fn());
    await vi.waitFor(() => expect(mockExecuteAll).toHaveBeenCalledOnce());
    rejectSteps(new Error("step-session failure"));
    await vi.waitFor(() => expect(mockCleanup).toHaveBeenCalledOnce());

    (executor as any).markStuckAborted(subject.id);
    vi.advanceTimersByTime(60_000);
    await Promise.resolve();

    expect(mockExecuteAll).toHaveBeenCalledTimes(1);
    expect(executingTaskLock.claim(subject.id)).toBeNull();
    releaseOldCleanup();
    await oldRun;
    await vi.runAllTimersAsync();
    await vi.waitFor(() => expect(mockExecuteAll).toHaveBeenCalledTimes(3));

    // One old step-session plus the real successor's two planned step sessions.
    expect(mockCleanup).toHaveBeenCalledTimes(3);
    expect(store.moveTask).not.toHaveBeenCalledWith(subject.id, "todo", expect.anything());
    expect(subject).toMatchObject({
      column: "in-progress",
      effectiveNodeId: "steps#0:step-execute",
      currentStep: 1,
      worktree: "/tmp/fn-217-stuck",
      branch: "fusion/fn-217-stuck",
    });
  });

  it("skips late destructive step cleanup after invalidation starts a real successor", async () => {
    vi.useFakeTimers();
    const subject = task({
      id: "FN-312-STEP-STALE",
      enabledWorkflowSteps: [],
      prompt: "# Task\n## Steps\n### Step 0: Earlier\n- [x] done\n### Step 1: Testing\n- [ ] work",
      baseCommitSha: "base-sha",
    });
    const store = createMockStore();
    store.getTask.mockResolvedValue(subject);
    store.getSettings.mockResolvedValue({
      autoMerge: false,
      runStepsInNewSessions: true,
      maxParallelSteps: 1,
      maxConcurrent: 2,
      maxWorktrees: 4,
    });
    const executor = new TaskExecutor(store as never, "/tmp/test", {
      agentStore: createWorkflowRoutingAgentStore(store).agentStore,
    });
    let rejectOldSteps!: (error: Error) => void;
    mockExecuteAll
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectOldSteps = reject; }))
      .mockResolvedValue(undefined);
    mockCleanup.mockResolvedValue(undefined);

    const oldRun = (executor as any).runImplementation(subject, vi.fn(), vi.fn());
    await vi.waitFor(() => expect(mockExecuteAll).toHaveBeenCalledOnce());
    (executor as any).markStuckAborted(subject.id);
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(mockExecuteAll).toHaveBeenCalledTimes(3));

    const cleanupCountAfterSuccessor = mockCleanup.mock.calls.length;
    rejectOldSteps(new Error("late old step-session rejection"));
    await oldRun;

    expect(cleanupCountAfterSuccessor).toBe(2);
    expect(mockCleanup).toHaveBeenCalledTimes(cleanupCountAfterSuccessor);
    expect(store.moveTask).not.toHaveBeenCalledWith(subject.id, "todo", expect.anything());
    expect(subject).toMatchObject({
      column: "in-progress",
      currentStep: 1,
      worktree: "/tmp/fn-217-stuck",
      branch: "fusion/fn-217-stuck",
    });
  });

  it("rejects real stale step callbacks after invalidation installs a successor", async () => {
    const subject = task({
      id: "FN-312-STALE-STEP-CALLBACK",
      enabledWorkflowSteps: [],
      prompt: "# Task\n## Steps\n### Step 0: Earlier\n- [x] done\n### Step 1: Testing\n- [ ] work",
      baseCommitSha: "base-sha",
    });
    const store = createMockStore();
    store.getTask.mockResolvedValue(subject);
    store.getSettings.mockResolvedValue({
      autoMerge: false,
      runStepsInNewSessions: true,
      maxParallelSteps: 1,
      maxConcurrent: 2,
      maxWorktrees: 4,
    });
    let finishOldSteps!: () => void;
    const oldStepsGate = new Promise<unknown[]>((resolve) => {
      finishOldSteps = () => resolve([]);
    });
    mockExecuteAll.mockImplementation(() => oldStepsGate);
    const executor = new TaskExecutor(store as never, "/tmp/test", {
      agentStore: createWorkflowRoutingAgentStore(store).agentStore,
    });

    const oldRun = (executor as any).runImplementation(subject, vi.fn(), vi.fn());
    await vi.waitFor(() => expect(mockExecuteAll).toHaveBeenCalledTimes(2));
    const callbacks = mockedStepSessionExecutor.mock.calls[0]?.[0] as any;
    const oldLease = executingTaskLock.currentLease(subject.id);
    if (!oldLease) throw new Error("old execution lease missing");
    expect(await executingTaskLock.invalidate(oldLease)).toMatchObject({ executed: true });
    const successorLease = executingTaskLock.claim(subject.id);
    if (!successorLease) throw new Error("successor execution lease missing");
    const startCount = store.startStep.mock.calls.length;
    const completeCount = store.updateStep.mock.calls.length;
    const tokenWriteCount = store.updateTask.mock.calls.length;

    await expect(callbacks.onStepStart(1)).resolves.toBe(false);
    await callbacks.onStepComplete(1, {
      success: true,
      retries: 0,
      tokenUsage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
    });

    expect(store.startStep).toHaveBeenCalledTimes(startCount);
    expect(store.updateStep).toHaveBeenCalledTimes(completeCount);
    expect(store.updateTask).toHaveBeenCalledTimes(tokenWriteCount);
    expect(executingTaskLock.owns(successorLease)).toBe(true);

    finishOldSteps();
    await oldRun;
    executingTaskLock.release(subject.id, successorLease);
  });

  it("holds invalidation until a real entered step callback finishes token persistence", async () => {
    const subject = task({
      id: "FN-312-ENTERED-STEP-CALLBACK",
      enabledWorkflowSteps: [],
      prompt: "# Task\n## Steps\n### Step 0: Testing\n- [ ] work",
      baseCommitSha: "base-sha",
    });
    const store = createMockStore();
    store.getTask.mockResolvedValue(subject);
    store.getSettings.mockResolvedValue({
      autoMerge: false,
      runStepsInNewSessions: true,
      maxParallelSteps: 1,
      maxConcurrent: 2,
      maxWorktrees: 4,
    });
    let finishOldSteps!: () => void;
    const oldStepsGate = new Promise<unknown[]>((resolve) => {
      finishOldSteps = () => resolve([]);
    });
    mockExecuteAll.mockImplementation(() => oldStepsGate);
    const executor = new TaskExecutor(store as never, "/tmp/test", {
      agentStore: createWorkflowRoutingAgentStore(store).agentStore,
    });

    const oldRun = (executor as any).runImplementation(subject, vi.fn(), vi.fn());
    await vi.waitFor(() => expect(mockExecuteAll).toHaveBeenCalledOnce());
    const callbacks = mockedStepSessionExecutor.mock.calls[0]?.[0] as any;
    const oldLease = executingTaskLock.currentLease(subject.id);
    if (!oldLease) throw new Error("old execution lease missing");
    let finishTokenWrite!: () => void;
    const tokenWriteGate = new Promise<void>((resolve) => { finishTokenWrite = resolve; });
    const updateCount = store.updateTask.mock.calls.length;
    store.updateTask.mockImplementationOnce(async () => {
      await tokenWriteGate;
      return subject;
    });

    const completion = callbacks.onStepComplete(0, {
      success: true,
      retries: 0,
      tokenUsage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
    });
    await vi.waitFor(() => expect(store.updateTask.mock.calls.length).toBe(updateCount + 1));
    let invalidationSettled = false;
    const invalidation = executingTaskLock.invalidate(oldLease).then((result) => {
      invalidationSettled = true;
      return result;
    });
    await Promise.resolve();

    expect(invalidationSettled).toBe(false);
    expect(executingTaskLock.claim(subject.id)).toBeNull();
    finishTokenWrite();
    await completion;
    expect(await invalidation).toMatchObject({ executed: true });
    expect(executingTaskLock.claim(subject.id)).not.toBeNull();

    finishOldSteps();
    await oldRun;
    const successorLease = executingTaskLock.currentLease(subject.id);
    if (successorLease) executingTaskLock.release(subject.id, successorLease);
  });

  it("keeps a successor agent session intact when the real old runImplementation prompt settles late", async () => {
    vi.useFakeTimers();
    const subject = task({
      id: "FN-312-SESSION",
      enabledWorkflowSteps: [],
      prompt: "# Task\n## Steps\n### Step 0: Done\n- [x] done",
      steps: [{ name: "Done", status: "done" }],
      currentStep: 0,
      baseCommitSha: "base-sha",
    });
    const store = createMockStore();
    store.getTask.mockResolvedValue(subject);
    store.getSettings.mockResolvedValue({
      autoMerge: false,
      runStepsInNewSessions: false,
      maxConcurrent: 2,
      maxWorktrees: 4,
    });
    let releaseOldPrompt!: () => void;
    let releaseSuccessorPrompt!: () => void;
    const oldSession = {
      prompt: vi.fn(() => new Promise<void>((resolve) => { releaseOldPrompt = resolve; })),
      dispose: vi.fn(),
      subscribe: vi.fn(() => vi.fn()),
    };
    const successorSession = {
      prompt: vi.fn(() => new Promise<void>((resolve) => { releaseSuccessorPrompt = resolve; })),
      dispose: vi.fn(),
      subscribe: vi.fn(() => vi.fn()),
    };
    mockedCreateFnAgent
      .mockResolvedValueOnce({ session: oldSession } as never)
      .mockResolvedValueOnce({ session: successorSession } as never);
    const executor = new TaskExecutor(store as never, "/tmp/test", {
      agentStore: createWorkflowRoutingAgentStore(store).agentStore,
    });

    const oldRun = (executor as any).runImplementation(subject, vi.fn(), vi.fn());
    await vi.waitFor(() => expect(oldSession.prompt).toHaveBeenCalledOnce());

    (executor as any).markStuckAborted(subject.id);
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(successorSession.prompt).toHaveBeenCalledOnce());
    const successorLease = executingTaskLock.currentLease(subject.id);
    expect(successorLease && executingTaskLock.owns(successorLease)).toBe(true);
    const writerCountAfterSuccessor = store.updateTask.mock.calls.length + store.moveTask.mock.calls.length;

    releaseOldPrompt();
    await oldRun;

    expect((executor as any).activeSessions.get(subject.id)?.session).toBe(successorSession);
    const successorRegistryPaths = activeSessionRegistry.pathsForTask(subject.id);
    expect(successorRegistryPaths).toHaveLength(1);
    expect(activeSessionRegistry.lookupByPath(successorRegistryPaths[0]!)).toMatchObject({
      taskId: subject.id,
      kind: "executor",
    });
    expect((executor as any).executing.has(subject.id)).toBe(true);
    expect(successorLease && executingTaskLock.owns(successorLease)).toBe(true);
    expect(store.updateTask.mock.calls.length + store.moveTask.mock.calls.length).toBe(writerCountAfterSuccessor);
    expect(store.logEntry.mock.calls.flat().join(" ")).not.toMatch(
      /parent moved|unattributed automatic move|no further action needed/i,
    );
    expect(subject).toMatchObject({
      column: "in-progress",
      currentStep: 0,
      worktree: "/tmp/fn-217-stuck",
      branch: "fusion/fn-217-stuck",
    });

    releaseSuccessorPrompt();
    await vi.waitFor(() => expect(executingTaskLock.has(subject.id)).toBe(false));
  });

  it("ignores the old stuck timer after graceful unwind starts a real successor", async () => {
    vi.useFakeTimers();
    const subject = task({
      id: "FN-312-STALE-STUCK-TIMER",
      enabledWorkflowSteps: [],
      prompt: "# Task\n## Steps\n### Step 0: Continue\n- [ ] work",
      baseCommitSha: "base-sha",
    });
    const store = createMockStore();
    store.getTask.mockResolvedValue(subject);
    store.getSettings.mockResolvedValue({
      autoMerge: false,
      runStepsInNewSessions: false,
      maxConcurrent: 2,
      maxWorktrees: 4,
    });
    let releaseOldPrompt!: () => void;
    let releaseSuccessorPrompt!: () => void;
    const oldSession = {
      prompt: vi.fn(() => new Promise<void>((resolve) => { releaseOldPrompt = resolve; })),
      dispose: vi.fn(),
      subscribe: vi.fn(() => vi.fn()),
    };
    const successorSession = {
      prompt: vi.fn(() => new Promise<void>((resolve) => { releaseSuccessorPrompt = resolve; })),
      dispose: vi.fn(),
      subscribe: vi.fn(() => vi.fn()),
    };
    mockedCreateFnAgent
      .mockResolvedValueOnce({ session: oldSession } as never)
      .mockResolvedValueOnce({ session: successorSession } as never);
    const executor = new TaskExecutor(store as never, "/tmp/test", {
      agentStore: createWorkflowRoutingAgentStore(store).agentStore,
    });
    const prepareAbort = vi.spyOn(executor as any, "prepareAbortInFlightTaskWork");

    const oldRun = (executor as any).runImplementation(subject, vi.fn(), vi.fn());
    await vi.waitFor(() => expect(oldSession.prompt).toHaveBeenCalledOnce());
    (executor as any).markStuckAborted(subject.id);

    releaseOldPrompt();
    await oldRun;
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(successorSession.prompt).toHaveBeenCalledOnce());
    const successorLease = executingTaskLock.currentLease(subject.id);
    expect(successorLease && executingTaskLock.owns(successorLease)).toBe(true);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(prepareAbort).not.toHaveBeenCalled();
    expect(successorSession.dispose).not.toHaveBeenCalled();
    expect((executor as any).activeSessions.get(subject.id)?.session).toBe(successorSession);
    expect(successorLease && executingTaskLock.owns(successorLease)).toBe(true);

    releaseSuccessorPrompt();
    await vi.waitFor(() => expect(executingTaskLock.has(subject.id)).toBe(false));
  });

  it("waits for entered single-session cleanup before starting its real successor", async () => {
    vi.useFakeTimers();
    const subject = task({
      id: "FN-312-SESSION-ENTERED",
      enabledWorkflowSteps: [],
      prompt: "# Task\n## Steps\n### Step 0: Testing\n- [ ] work",
      baseCommitSha: "base-sha",
    });
    const store = createMockStore();
    store.getTask.mockResolvedValue(subject);
    store.getSettings.mockResolvedValue({
      autoMerge: false,
      runStepsInNewSessions: false,
      maxConcurrent: 2,
      maxWorktrees: 4,
    });
    let rejectOldPrompt!: (error: Error) => void;
    let releaseSuccessorPrompt!: () => void;
    const oldSession = {
      prompt: vi.fn(() => new Promise<void>((_resolve, reject) => { rejectOldPrompt = reject; })),
      dispose: vi.fn(),
      subscribe: vi.fn(() => vi.fn()),
    };
    const successorSession = {
      prompt: vi.fn(() => new Promise<void>((resolve) => { releaseSuccessorPrompt = resolve; })),
      dispose: vi.fn(),
      subscribe: vi.fn(() => vi.fn()),
    };
    mockedCreateFnAgent
      .mockResolvedValueOnce({ session: oldSession } as never)
      .mockResolvedValueOnce({ session: successorSession } as never);
    const executor = new TaskExecutor(store as never, "/tmp/test", {
      agentStore: createWorkflowRoutingAgentStore(store).agentStore,
    });
    let releaseEnteredCleanup!: () => void;
    const enteredCleanup = new Promise<void>((resolve) => { releaseEnteredCleanup = resolve; });
    const terminateAllChildren = vi.fn()
      .mockImplementationOnce(async () => enteredCleanup)
      .mockResolvedValue(undefined);
    (executor as any).terminateAllChildren = terminateAllChildren;

    const oldRun = (executor as any).runImplementation(subject, vi.fn(), vi.fn());
    await vi.waitFor(() => expect(oldSession.prompt).toHaveBeenCalledOnce());
    (executor as any).pausedAborted.add(subject.id);
    rejectOldPrompt(new Error("engine abort while entering cleanup"));
    await vi.waitFor(() => expect(terminateAllChildren).toHaveBeenCalledOnce());

    (executor as any).markStuckAborted(subject.id);
    vi.advanceTimersByTime(60_000);
    await Promise.resolve();
    expect(successorSession.prompt).not.toHaveBeenCalled();
    expect(executingTaskLock.claim(subject.id)).toBeNull();

    releaseEnteredCleanup();
    await oldRun;
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(successorSession.prompt).toHaveBeenCalledOnce());
    const successorLease = executingTaskLock.currentLease(subject.id);
    expect(successorLease && executingTaskLock.owns(successorLease)).toBe(true);
    expect(terminateAllChildren).toHaveBeenCalledTimes(2);
    expect(subject).toMatchObject({
      column: "in-progress",
      currentStep: 1,
      worktree: "/tmp/fn-217-stuck",
      branch: "fusion/fn-217-stuck",
    });

    releaseSuccessorPrompt();
    await vi.waitFor(() => expect(executingTaskLock.has(subject.id)).toBe(false));
  });

  it("keeps a gracefully settled engine pause abort in WIP without rebounding to hold", async () => {
    const subject = task({
      id: "FN-312-PAUSE-GRACEFUL",
      enabledWorkflowSteps: [],
      prompt: "# Task\n## Steps\n### Step 0: Earlier\n- [x] done\n### Step 1: Testing\n- [ ] work",
      baseCommitSha: "base-sha",
    });
    const store = createMockStore();
    store.getTask.mockResolvedValue(subject);
    store.getSettings.mockResolvedValue({
      autoMerge: false,
      runStepsInNewSessions: false,
      maxConcurrent: 2,
      maxWorktrees: 4,
    });
    const executor = new TaskExecutor(store as never, "/tmp/test", {
      agentStore: createWorkflowRoutingAgentStore(store).agentStore,
    });
    mockedCreateFnAgent.mockResolvedValue({
      session: {
        prompt: vi.fn(async () => {
          (executor as any).pausedAborted.add(subject.id);
        }),
        dispose: vi.fn(),
        subscribe: vi.fn(() => vi.fn()),
      },
    } as never);

    await (executor as any).runImplementation(subject, vi.fn(), vi.fn());

    expect(store.moveTask).not.toHaveBeenCalled();
    expect(store.updateTask.mock.calls).not.toContainEqual([
      subject.id,
      expect.objectContaining({ worktree: null }),
    ]);
    expect(subject).toMatchObject({
      column: "in-progress",
      currentStep: 1,
      worktree: "/tmp/fn-217-stuck",
      branch: "fusion/fn-217-stuck",
    });
    expect(store.logEntry.mock.calls).toContainEqual([
      subject.id,
      "Execution interrupted — session state preserved for in-place resume",
    ]);
  });

  it("waits for an entered post-prompt writer before invalidating and starting the successor", async () => {
    vi.useFakeTimers();
    const subject = task({
      id: "FN-312-CONTINUATION-WRITER",
      enabledWorkflowSteps: [],
      prompt: "# Task\n## Steps\n### Step 0: Earlier\n- [x] done\n### Step 1: Testing\n- [ ] work",
      baseCommitSha: "base-sha",
    });
    const store = createMockStore();
    store.getTask.mockResolvedValue(subject);
    store.getSettings.mockResolvedValue({
      autoMerge: false,
      runStepsInNewSessions: false,
      maxConcurrent: 2,
      maxWorktrees: 4,
    });
    let releaseSuccessorPrompt!: () => void;
    const oldSession = {
      prompt: vi.fn(async () => undefined),
      dispose: vi.fn(),
      subscribe: vi.fn(() => vi.fn()),
    };
    const successorSession = {
      prompt: vi.fn(() => new Promise<void>((resolve) => { releaseSuccessorPrompt = resolve; })),
      dispose: vi.fn(),
      subscribe: vi.fn(() => vi.fn()),
    };
    mockedCreateFnAgent
      .mockResolvedValueOnce({ session: oldSession } as never)
      .mockResolvedValueOnce({ session: successorSession } as never);
    const executor = new TaskExecutor(store as never, "/tmp/test", {
      agentStore: createWorkflowRoutingAgentStore(store).agentStore,
    });
    let releaseWriter!: () => void;
    const writerGate = new Promise<void>((resolve) => { releaseWriter = resolve; });
    const persistTokenUsage = vi.fn()
      .mockImplementationOnce(async () => writerGate)
      .mockResolvedValue(undefined);
    (executor as any).persistTokenUsage = persistTokenUsage;

    const oldRun = (executor as any).runImplementation(subject, vi.fn(), vi.fn());
    await vi.waitFor(() => expect(persistTokenUsage).toHaveBeenCalledOnce());

    (executor as any).markStuckAborted(subject.id);
    vi.advanceTimersByTime(60_000);
    await Promise.resolve();

    expect(successorSession.prompt).not.toHaveBeenCalled();
    expect(executingTaskLock.claim(subject.id)).toBeNull();

    releaseWriter();
    await oldRun;
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(successorSession.prompt).toHaveBeenCalledOnce());
    const successorLease = executingTaskLock.currentLease(subject.id);
    expect(successorLease && executingTaskLock.owns(successorLease)).toBe(true);
    expect(subject).toMatchObject({
      column: "in-progress",
      currentStep: 1,
      worktree: "/tmp/fn-217-stuck",
      branch: "fusion/fn-217-stuck",
    });

    releaseSuccessorPrompt();
    await vi.waitFor(() => expect(executingTaskLock.has(subject.id)).toBe(false));
  });

  it("keeps a real engine pause abort in WIP without removing resumable state", async () => {
    const subject = task({
      id: "FN-312-PAUSE",
      enabledWorkflowSteps: [],
      prompt: "# Task\n## Steps\n### Step 0: Earlier\n- [x] done\n### Step 1: Testing\n- [ ] work",
      baseCommitSha: "base-sha",
    });
    const store = createMockStore();
    store.getTask.mockResolvedValue(subject);
    store.getSettings.mockResolvedValue({
      autoMerge: false,
      runStepsInNewSessions: false,
      maxConcurrent: 2,
      maxWorktrees: 4,
    });
    const executor = new TaskExecutor(store as never, "/tmp/test", {
      agentStore: createWorkflowRoutingAgentStore(store).agentStore,
    });
    mockedCreateFnAgent.mockResolvedValue({
      session: {
        prompt: vi.fn(async () => {
          (executor as any).pausedAborted.add(subject.id);
          throw new Error("engine pause abort");
        }),
        dispose: vi.fn(),
        subscribe: vi.fn(() => vi.fn()),
      },
    } as never);

    await (executor as any).runImplementation(subject, vi.fn(), vi.fn());

    expect(store.moveTask).not.toHaveBeenCalled();
    expect(store.updateTask.mock.calls).not.toContainEqual([
      subject.id,
      expect.objectContaining({ worktree: null }),
    ]);
    expect(subject).toMatchObject({
      column: "in-progress",
      currentStep: 1,
      worktree: "/tmp/fn-217-stuck",
      branch: "fusion/fn-217-stuck",
    });
    expect(store.logEntry.mock.calls).toContainEqual([
      subject.id,
      "Execution interrupted — session state preserved for in-place resume",
      undefined,
      expect.anything(),
    ]);
  });

  it("repeated silence repeatedly resumes and never terminalizes or asks for approval", async () => {
    vi.useFakeTimers();
    const subject = task();
    const { deps, store, reexecuteTaskInPlace } = harness(subject);

    for (let round = 0; round < 2; round += 1) {
      deps.executing.add(subject.id);
      expect(executingTaskLock.claim(subject.id)).not.toBeNull();
      markStuckAborted(deps as never, subject.id);
      await vi.advanceTimersByTimeAsync(60_000);
    }

    expect(reexecuteTaskInPlace).toHaveBeenCalledTimes(2);
    expect(subject.status).toBeNull();
    expect(subject.error).toBeNull();
    expect(subject.paused).not.toBe(true);
    expect(subject).not.toHaveProperty("awaitingApprovalReason");
    expect(JSON.stringify(store.updateTask.mock.calls)).not.toMatch(/STUCK_(?:LOOP_EXHAUSTED|NO_PROGRESS_CHURN)|decompose/i);
  });

  it.each([
    { globalPause: true, enginePaused: false },
    { globalPause: false, enginePaused: true },
  ])("preserves the forced-resume continuation without dispatch while engine execution is paused", async (settings) => {
    vi.useFakeTimers();
    const subject = task();
    const { deps, store, reexecuteTaskInPlace } = harness(subject);
    store.getSettings.mockResolvedValue(settings);
    expect(executingTaskLock.claim(subject.id)).not.toBeNull();

    markStuckAborted(deps as never, subject.id);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(reexecuteTaskInPlace).not.toHaveBeenCalled();
    expect(executingTaskLock.has(subject.id)).toBe(false);
    expect(deps.executing.has(subject.id)).toBe(false);
    expect(subject).toMatchObject({
      column: "in-progress",
      effectiveNodeId: "steps#0:step-execute",
      currentStep: 1,
      worktree: "/tmp/fn-217-stuck",
      branch: "fusion/fn-217-stuck",
      status: null,
      error: null,
    });
    expect(store.logEntry).toHaveBeenCalledWith(
      subject.id,
      "Forced stuck-session ownership invalidated — continuation preserved until engine execution resumes",
    );
  });

  it("invalidates ownership but refuses dispatch when a control read rejects", async () => {
    vi.useFakeTimers();
    const subject = task({ id: "FN-312-CONTROL-READ-FAILURE" });
    const { deps, store, reexecuteTaskInPlace } = harness(subject);
    store.getTask.mockRejectedValueOnce(new Error("task store unavailable"));
    const oldLease = executingTaskLock.claim(subject.id);
    expect(oldLease).not.toBeNull();

    markStuckAborted(deps as never, subject.id);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(oldLease && executingTaskLock.owns(oldLease)).toBe(false);
    expect(executingTaskLock.has(subject.id)).toBe(false);
    expect(deps.executing.has(subject.id)).toBe(false);
    expect(reexecuteTaskInPlace).not.toHaveBeenCalled();
    const successor = executingTaskLock.claim(subject.id);
    expect(successor).not.toBeNull();
    if (successor) executingTaskLock.release(subject.id, successor);
  });

  it("leaves a user-paused task under manual control", async () => {
    vi.useFakeTimers();
    const subject = task({ paused: true, userPaused: true, status: "paused" });
    const { deps, store, reexecuteTaskInPlace } = harness(subject);
    expect(executingTaskLock.claim(subject.id)).not.toBeNull();

    markStuckAborted(deps as never, subject.id);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(reexecuteTaskInPlace).not.toHaveBeenCalled();
    expect(store.updateTask).not.toHaveBeenCalled();
    expect(deps.executing.has(subject.id)).toBe(false);
    expect(executingTaskLock.has(subject.id)).toBe(false);
    expect(subject).toMatchObject({ column: "in-progress", paused: true, userPaused: true, status: "paused" });
  });
});
