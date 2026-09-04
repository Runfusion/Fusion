import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "@fusion/core";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import { executingTaskLock } from "../agents/active-session-registry.js";
import {
  createMockStore,
  createWorkflowRoutingAgentStore,
  mockExecuteAll,
  resetExecutorMocks,
} from "./executor-test-helpers.js";
import { evaluateLifecycleDirectionPostcondition } from "@fusion/core";
import {
  recoverAbortedStepSessionInPlace,
  type StepSessionAbortTrigger,
} from "../executor/recover-aborted-step-session.js";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-9253",
    title: "Contain aborted step session",
    description: "",
    column: "renamed-wip",
    status: "failed",
    error: "session failure",
    effectiveNodeId: "steps#0:step-execute",
    currentStep: 1,
    steps: [
      { name: "Preflight", status: "done" },
      { name: "Implementation", status: "in-progress" },
    ],
    worktree: "/tmp/fn-9253",
    branch: "fusion/fn-9253",
    dependencies: [],
    log: [],
    createdAt: "2026-09-04T00:00:00.000Z",
    updatedAt: "2026-09-04T00:00:00.000Z",
    ...overrides,
  } as Task;
}

function harness(subject: Task, settings: { globalPause?: boolean; enginePaused?: boolean } = {}) {
  const moveTask = vi.fn();
  const updateTask = vi.fn(async (_id: string, patch: Partial<Task>) => Object.assign(subject, patch));
  const logEntry = vi.fn(async () => undefined);
  const markGraphExecuteSelfRequeued = vi.fn();
  const recordRunAuditEvent = vi.fn();
  const store = {
    getTask: vi.fn(async () => subject),
    getSettings: vi.fn(async () => settings),
    updateTask,
    logEntry,
    moveTask,
    recordRunAuditEvent,
  };
  return { store, updateTask, moveTask, logEntry, markGraphExecuteSelfRequeued, recordRunAuditEvent };
}

describe("aborted step-session recovery", () => {
  beforeEach(() => {
    resetExecutorMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function productionTask(overrides: Partial<Task> = {}) {
    return task({
      id: "FN-9253-PRODUCTION",
      column: "renamed-wip",
      status: null,
      error: null,
      enabledWorkflowSteps: [],
      prompt: "# test\n## Steps\n### Step 0: Preflight\n- [x] done\n### Step 1: Implement\n- [ ] work",
      baseCommitSha: "abc123",
      ...overrides,
    });
  }

  async function executeAbortTrigger(
    trigger: "graceful-pause-abort" | "step-failure" | "pause-abort" | "session-failure",
    options: {
      globalPause?: boolean;
      enginePaused?: boolean;
      stuck?: boolean;
      taskOverrides?: Partial<Task>;
    } = {},
  ) {
    const store = createMockStore();
    const subject = productionTask(options.taskOverrides);
    const before = structuredClone({
      steps: subject.steps,
      currentStep: subject.currentStep,
      effectiveNodeId: subject.effectiveNodeId,
      worktree: subject.worktree,
      branch: subject.branch,
    });
    store.getTask.mockResolvedValue(subject);
    store.getSettings.mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15_000,
      groupOverlappingFiles: false,
      autoMerge: false,
      runStepsInNewSessions: true,
      maxParallelSteps: 1,
      ...options,
    });
    const executor = new TaskExecutor(store as never, "/tmp/test", {
      agentStore: createWorkflowRoutingAgentStore(store).agentStore,
    });
    let settleExecuteAll!: (value: unknown[]) => void;
    let rejectExecuteAll!: (error: Error) => void;
    const executeAll = new Promise<unknown[]>((resolve, reject) => {
      settleExecuteAll = resolve;
      rejectExecuteAll = reject;
    });

    mockExecuteAll.mockImplementation(async () => {
      if (trigger === "graceful-pause-abort" || trigger === "pause-abort") {
        (executor as any).pausedAborted.add(subject.id);
      }
      if (options.stuck) (executor as any).stuckAborted.set(subject.id, true);
      return executeAll;
    });

    const initialRun = (executor as any).runImplementation(subject, vi.fn(), vi.fn());
    await vi.waitFor(() => expect(mockExecuteAll).toHaveBeenCalledOnce());
    // FNXC:LifecycleContainment 2026-09-04-03:34: Isolate abort-path writes from normal step-session setup so paused recovery can prove it performs no recovery write.
    store.updateTask.mockClear();
    store.moveTask.mockClear();
    const resumedAfterLockRelease = vi.fn(async () => {
      expect(executingTaskLock.has(subject.id)).toBe(false);
    });
    vi.spyOn(executor, "execute").mockImplementation(resumedAfterLockRelease as never);
    if (trigger === "pause-abort" || trigger === "session-failure") {
      rejectExecuteAll(new Error(trigger));
    } else if (trigger === "step-failure") {
      settleExecuteAll([{ stepIndex: 1, success: false, error: "failed", retries: 0 }]);
    } else {
      settleExecuteAll([]);
    }
    await expect(initialRun).resolves.toBeUndefined();
    await vi.runOnlyPendingTimersAsync();
    return { store, subject, before, resumedAfterLockRelease, executor };
  }

  it.each([
    "graceful-pause-abort",
    "step-failure",
    "pause-abort",
    "session-failure",
  ] as const)("routes the real %s step-session branch through in-place recovery after lock release", async (trigger) => {
    const { store, subject, before, resumedAfterLockRelease } = await executeAbortTrigger(trigger);

    expect(store.moveTask).not.toHaveBeenCalled();
    expect(subject).toMatchObject(before);
    expect(store.updateTask.mock.calls).toContainEqual([subject.id, { status: null, error: null }]);
    expect(resumedAfterLockRelease).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: subject.id }));
  });

  it("suppresses the stuck-requeue dispatch while the engine is paused", async () => {
    const { store, resumedAfterLockRelease } = await executeAbortTrigger("session-failure", {
      stuck: true,
      globalPause: true,
    });

    expect(store.moveTask).not.toHaveBeenCalled();
    expect(resumedAfterLockRelease).not.toHaveBeenCalled();
  });

  it.each([
    { taskOverrides: { paused: true, status: "paused" }, label: "paused" },
    { taskOverrides: { userPaused: true, status: "paused" }, label: "user-paused" },
  ])("keeps real graceful-abort recovery held for a $label task", async ({ taskOverrides }) => {
    const { store, subject, before, resumedAfterLockRelease } = await executeAbortTrigger(
      "graceful-pause-abort",
      { taskOverrides },
    );

    expect(store.moveTask).not.toHaveBeenCalled();
    expect(store.updateTask).not.toHaveBeenCalled();
    expect(resumedAfterLockRelease).not.toHaveBeenCalled();
    expect(subject).toMatchObject(before);
  });

  it.each([{ globalPause: true }, { enginePaused: true }])(
    "clears real abort failure state but defers redispatch while engine work is paused",
    async (settings) => {
      const { store, subject, before, resumedAfterLockRelease } = await executeAbortTrigger(
        "session-failure",
        settings,
      );

      expect(store.moveTask).not.toHaveBeenCalled();
      expect(store.updateTask.mock.calls).toContainEqual([subject.id, { status: null, error: null }]);
      expect(resumedAfterLockRelease).not.toHaveBeenCalled();
      expect(subject).toMatchObject(before);
    },
  );

  it.each([
    { column: "custom-wip", label: "renamed WIP with renamed hold" },
    { column: "custom-wip-without-hold", label: "workflow without a hold lane" },
    { column: "custom-hold", label: "task already in its hold lane" },
  ])("repairs the real failure branch in place for a $label", async ({ column }) => {
    const { store, subject, before, resumedAfterLockRelease } = await executeAbortTrigger("step-failure", {
      taskOverrides: { column },
    });

    expect(store.moveTask).not.toHaveBeenCalled();
    expect(store.updateTask.mock.calls).toContainEqual([subject.id, { status: null, error: null }]);
    expect(resumedAfterLockRelease).toHaveBeenCalledTimes(1);
    expect(subject).toMatchObject(before);
  });

  it.each<StepSessionAbortTrigger>([
    "graceful-pause-abort",
    "step-failure",
    "pause-abort",
    "session-failure",
  ])("repairs %s in place without clearing progress or moving lanes", async (trigger) => {
    const subject = task();
    const before = structuredClone({
      steps: subject.steps,
      currentStep: subject.currentStep,
      effectiveNodeId: subject.effectiveNodeId,
      worktree: subject.worktree,
      branch: subject.branch,
    });
    const { store, updateTask, moveTask, markGraphExecuteSelfRequeued, logEntry } = harness(subject);

    await expect(recoverAbortedStepSessionInPlace({
      store: store as never,
      markGraphExecuteSelfRequeued,
      getRunContextFor: () => undefined,
    }, subject.id, trigger)).resolves.toBe("resumed-in-place");

    expect(moveTask).not.toHaveBeenCalled();
    expect(updateTask).toHaveBeenCalledExactlyOnceWith(subject.id, { status: null, error: null });
    expect(markGraphExecuteSelfRequeued).toHaveBeenCalledExactlyOnceWith(subject.id);
    expect(logEntry).toHaveBeenCalledWith(subject.id, expect.stringContaining(`Step-session ${trigger} repaired in place`), undefined, undefined);
    expect(subject).toMatchObject(before);
  });

  it.each([
    { overrides: { paused: true, status: "paused" }, label: "paused" },
    { overrides: { userPaused: true, status: "paused" }, label: "user-paused" },
  ])("leaves a $label task to its existing resume owner", async ({ overrides }) => {
    const subject = task(overrides);
    const { store, updateTask, moveTask, markGraphExecuteSelfRequeued } = harness(subject);

    await expect(recoverAbortedStepSessionInPlace({
      store: store as never,
      markGraphExecuteSelfRequeued,
      getRunContextFor: () => undefined,
    }, subject.id, "pause-abort")).resolves.toBe("held-paused");

    expect(updateTask).not.toHaveBeenCalled();
    expect(moveTask).not.toHaveBeenCalled();
    expect(markGraphExecuteSelfRequeued).not.toHaveBeenCalled();
  });

  it.each([{ globalPause: true }, { enginePaused: true }])("clears stale failure state but defers dispatch under engine pause", async (settings) => {
    const subject = task({ column: "hold-without-wip" });
    const { store, updateTask, moveTask, markGraphExecuteSelfRequeued } = harness(subject, settings);

    await expect(recoverAbortedStepSessionInPlace({
      store: store as never,
      markGraphExecuteSelfRequeued,
      getRunContextFor: () => undefined,
    }, subject.id, "session-failure")).resolves.toBe("held-engine-paused");

    expect(updateTask).toHaveBeenCalledExactlyOnceWith(subject.id, { status: null, error: null });
    expect(moveTask).not.toHaveBeenCalled();
    expect(markGraphExecuteSelfRequeued).toHaveBeenCalledOnce();
  });

  it.each([
    vi.fn(() => { throw new Error("sink failure"); }),
    vi.fn(() => Promise.reject(new Error("sink rejection"))),
    vi.fn(() => new Promise(() => undefined)),
  ])("isolates hostile audit sinks", async (recordRunAuditEvent) => {
    const subject = task();
    const { store, moveTask } = harness(subject);
    store.recordRunAuditEvent = recordRunAuditEvent;

    await expect(recoverAbortedStepSessionInPlace({
      store: store as never,
      markGraphExecuteSelfRequeued: vi.fn(),
      getRunContextFor: () => undefined,
    }, subject.id, "session-failure")).resolves.toBe("resumed-in-place");

    expect(moveTask).not.toHaveBeenCalled();
    expect(recordRunAuditEvent).toHaveBeenCalledOnce();
  });

  it("proves F5 rejects the removed engine move while optionless moves fail open", () => {
    const input = {
      taskId: "FN-9253",
      from: { columnId: "renamed-wip", flags: { countsTowardWip: true } },
      to: { columnId: "renamed-hold", flags: { hold: true } },
      mergeBlockerReason: null,
      lifecycleReason: "self-healing-session-recovery",
    };

    expect(evaluateLifecycleDirectionPostcondition({ ...input, moveSource: "engine" })?.detail).toContain("Forbidden lifecycle path F5");
    expect(evaluateLifecycleDirectionPostcondition(input)).toBeNull();
  });
});
