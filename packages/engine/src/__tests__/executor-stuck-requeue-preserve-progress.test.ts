import { afterEach, describe, expect, it, vi } from "vitest";
import type { Task } from "@fusion/core";
import { markStuckAborted } from "../executor/mark-stuck-aborted.js";

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
    awaitAbortInFlightTaskWork: vi.fn(async () => undefined),
    clearPausedAborted: vi.fn(),
    reexecuteTaskInPlace,
  };
  return { deps, store, reexecuteTaskInPlace };
}

afterEach(() => vi.useRealTimers());

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

    markStuckAborted(deps as never, subject.id);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(subject).toMatchObject({ ...before, status: null, error: null });
    expect(reexecuteTaskInPlace).toHaveBeenCalledOnce();
    expect(reexecuteTaskInPlace).toHaveBeenCalledWith(subject.id);
    expect(deps.executing.has(subject.id)).toBe(false);
  });

  it("repeated silence repeatedly resumes and never terminalizes or asks for approval", async () => {
    vi.useFakeTimers();
    const subject = task();
    const { deps, store, reexecuteTaskInPlace } = harness(subject);

    for (let round = 0; round < 2; round += 1) {
      deps.executing.add(subject.id);
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

  it("leaves a user-paused task under manual control", async () => {
    vi.useFakeTimers();
    const subject = task({ paused: true, userPaused: true, status: "paused" });
    const { deps, store, reexecuteTaskInPlace } = harness(subject);

    markStuckAborted(deps as never, subject.id);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(reexecuteTaskInPlace).not.toHaveBeenCalled();
    expect(store.updateTask).not.toHaveBeenCalled();
    expect(subject).toMatchObject({ column: "in-progress", paused: true, userPaused: true, status: "paused" });
  });
});
