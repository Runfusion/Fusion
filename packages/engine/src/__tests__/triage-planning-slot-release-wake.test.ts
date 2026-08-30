import "./executor-test-helpers.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskStore } from "@fusion/core";

import {
  clearPreHeldExecutorSlotsForTests,
  projectAdmissionCoordinator,
} from "../concurrency/concurrency.js";
import { planLog } from "../logger.js";
import { TriageProcessor } from "../triage.js";
import { resetExecutorMocks } from "./executor-test-helpers.js";

function task(): Task {
  return {
    id: "FN-242",
    title: "Planning slot wake",
    description: "Plan me",
    column: "todo",
    status: null,
    paused: false,
    userPaused: false,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-08-28T21:00:00.000Z",
    updatedAt: "2026-08-28T21:24:00.000Z",
    columnMovedAt: "2026-08-28T21:24:00.000Z",
  } as Task;
}

function createHarness() {
  const candidate = task();
  const store = {
    getSettings: vi.fn(async () => ({
      pollIntervalMs: 600_000,
      maxConcurrent: 4,
      maxWorktrees: 4,
      worktreeLimitEnabled: false,
      autoMerge: true,
      globalPause: false,
      enginePaused: false,
    })),
    listTasks: vi.fn(async () => []),
    updateTask: vi.fn(async () => undefined),
    logEntry: vi.fn(async () => undefined),
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as TaskStore;
  const onPlanningSlotReleased = vi.fn();
  const processor = new TriageProcessor(store, "/test/fn-242", { onPlanningSlotReleased });
  (processor as unknown as { running: boolean }).running = true;
  vi.spyOn(processor as any, "discoverReadyPlanningTasks").mockResolvedValue([candidate]);
  vi.spyOn(processor as any, "sweepStalePlanningStatuses").mockResolvedValue(undefined);

  return { processor, candidate, onPlanningSlotReleased };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function admitFirstCandidate(beforeStart?: (processor: TriageProcessor) => void) {
  return vi.spyOn(projectAdmissionCoordinator, "admitNext").mockImplementation(async (options: any) => {
    const candidates = await options.refresh();
    const first = candidates[0];
    if (first) {
      beforeStart?.((options as { processor?: TriageProcessor }).processor as TriageProcessor);
      await first.start();
    }
    return { admitted: Boolean(first) } as any;
  });
}

beforeEach(() => {
  resetExecutorMocks();
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.spyOn(planLog, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  projectAdmissionCoordinator.clearReservationsForTests();
  clearPreHeldExecutorSlotsForTests();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("planning-slot release wakes", () => {
  it("wakes when planning admitted through the registered coordinator provider settles", async () => {
    const { processor, onPlanningSlotReleased } = createHarness();
    const completion = deferred<void>();
    const specifyTask = vi.spyOn(processor, "specifyTask").mockReturnValue(completion.promise);
    const requestImmediatePoll = vi.spyOn(processor, "requestImmediatePoll");

    const admitted = await projectAdmissionCoordinator.admitNext({
      projectId: "/test/fn-242",
      maxConcurrent: 4,
      claimed: () => 0,
      claimedTaskIds: () => [],
    });

    expect(admitted).toBe("FN-242");
    expect(specifyTask).toHaveBeenCalledTimes(1);
    expect(requestImmediatePoll).not.toHaveBeenCalled();

    completion.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(requestImmediatePoll).toHaveBeenCalledTimes(1);
    expect(onPlanningSlotReleased).toHaveBeenCalledTimes(1);
    processor.stop();
  });

  it("wakes planning and execution exactly once when specifyTask settles", async () => {
    const { processor, onPlanningSlotReleased } = createHarness();
    const completion = deferred<void>();
    vi.spyOn(processor, "specifyTask").mockReturnValue(completion.promise);
    const requestImmediatePoll = vi.spyOn(processor, "requestImmediatePoll");
    await admitFirstCandidate();

    await (processor as any).poll();
    expect(requestImmediatePoll).not.toHaveBeenCalled();

    completion.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(requestImmediatePoll).toHaveBeenCalledTimes(1);
    expect(onPlanningSlotReleased).toHaveBeenCalledTimes(1);
    processor.stop();
  });

  it("wakes after a rejected planning promise without leaking an unhandled rejection", async () => {
    const { processor, onPlanningSlotReleased } = createHarness();
    const completion = deferred<void>();
    vi.spyOn(processor, "specifyTask").mockReturnValue(completion.promise);
    const requestImmediatePoll = vi.spyOn(processor, "requestImmediatePoll");
    await admitFirstCandidate();

    await (processor as any).poll();
    completion.reject(new Error("planner transport failed"));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(planLog.error).toHaveBeenCalledWith(
      "FN-242: admitted planning promise rejected:",
      expect.any(Error),
    );
    expect(requestImmediatePoll).toHaveBeenCalledTimes(1);
    expect(onPlanningSlotReleased).toHaveBeenCalledTimes(1);
    processor.stop();
  });

  it("wakes when specifyTask returns before opening a session", async () => {
    const { processor, candidate, onPlanningSlotReleased } = createHarness();
    const requestImmediatePoll = vi.spyOn(processor, "requestImmediatePoll");
    vi.spyOn(projectAdmissionCoordinator, "admitNext").mockImplementation(async (options: any) => {
      const candidates = await options.refresh();
      // Model the stale/duplicate ownership arm after admission but before the async method runs.
      (processor as any).processing.add(candidate.id);
      await candidates[0].start();
      return { admitted: true } as any;
    });

    await (processor as any).poll();
    await Promise.resolve();
    await Promise.resolve();

    // The notifier fires once; because this early return lands before poll() unwinds,
    // the existing mid-poll replay invokes requestImmediatePoll again to schedule the debounced pass.
    expect(requestImmediatePoll).toHaveBeenCalled();
    expect(onPlanningSlotReleased).toHaveBeenCalledTimes(1);
    (processor as any).processing.delete(candidate.id);
    processor.stop();
  });

  it("coalesces a burst of returned slots into one debounced poll", async () => {
    const { processor, onPlanningSlotReleased } = createHarness();
    const poll = vi.spyOn(processor as any, "poll").mockResolvedValue(undefined);

    (processor as any).notifyPlanningSlotReleased();
    (processor as any).notifyPlanningSlotReleased();
    (processor as any).notifyPlanningSlotReleased();
    await vi.advanceTimersByTimeAsync(150);

    expect(poll).toHaveBeenCalledTimes(1);
    expect(onPlanningSlotReleased).toHaveBeenCalledTimes(3);
    processor.stop();
  });

  it("does not notify while stopped and an empty poll does not recurse", async () => {
    const { processor, onPlanningSlotReleased } = createHarness();
    const requestImmediatePoll = vi.spyOn(processor, "requestImmediatePoll");
    (processor as any).running = false;

    (processor as any).notifyPlanningSlotReleased();
    expect(requestImmediatePoll).not.toHaveBeenCalled();
    expect(onPlanningSlotReleased).not.toHaveBeenCalled();

    (processor as any).running = true;
    (processor as any).discoverReadyPlanningTasks.mockResolvedValue([]);
    await (processor as any).poll();
    expect(requestImmediatePoll).not.toHaveBeenCalled();
    processor.stop();
  });
});
