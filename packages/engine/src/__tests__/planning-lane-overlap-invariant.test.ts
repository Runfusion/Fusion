import { describe, expect, it, vi } from "vitest";
import type { Settings, Task, TaskStore } from "@fusion/core";
import { blockOuterDispatchWhenFileScopeLeaseHeld } from "../executor/file-scope-lease-dispatch-gate.js";
import { GridlockDetector } from "../healing/gridlock-detector.js";
import { classifyFileScopeLease } from "../scheduler.js";

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    description: id,
    column: "todo",
    priority: "normal",
    dependencies: [],
    steps: [],
    currentStep: 0,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  } as Task;
}

function overlapStore(tasks: Task[]) {
  const transitionQueuedEpisode = vi.fn(async () => ({ appended: true }));
  const store = {
    getSettings: vi.fn(async () => ({
      maxConcurrent: 30,
      maxWorktrees: 3,
      groupOverlappingFiles: true,
      overlapIgnorePaths: [],
    } as Settings)),
    listTasks: vi.fn(async () => tasks),
    parseFileScopeFromPrompt: vi.fn(async () => ["packages/core/src/shared.ts"]),
    getTaskWorkflowSelection: vi.fn(() => undefined),
    getTaskWorkflowSelectionAsync: vi.fn(async () => undefined),
    getWorkflowDefinition: vi.fn(async () => undefined),
    getCompletionHandoffAcceptedMarker: vi.fn(async () => null),
    transitionQueuedEpisode,
  } as unknown as TaskStore;
  return { store, transitionQueuedEpisode };
}

describe("planning-lane file-overlap invariant", () => {
  it("scheduler classification gives two checkout-free planning cards no lease", () => {
    const first = task("FN-PLAN-1", { status: "planning" });
    const second = task("FN-PLAN-2", { status: "planning", createdAt: "2026-09-01T00:00:01.000Z" });

    expect(classifyFileScopeLease(first, [first, second])).toMatchObject({ kind: "none" });
    expect(classifyFileScopeLease(second, [first, second])).toMatchObject({ kind: "none" });
    expect(first.overlapBlockedBy).toBeUndefined();
    expect(second.overlapBlockedBy).toBeUndefined();
  });

  it("executor pre-dispatch ignores a checkout-free planning peer but blocks on WIP", async () => {
    const candidate = task("FN-CANDIDATE", { createdAt: "2026-09-01T00:00:02.000Z" });
    const planner = task("FN-PLANNER", { status: "planning" });
    const planningHarness = overlapStore([planner, candidate]);

    await expect(blockOuterDispatchWhenFileScopeLeaseHeld(
      { store: planningHarness.store, getRunContextFor: () => undefined },
      candidate,
    )).resolves.toBe(false);
    expect(planningHarness.transitionQueuedEpisode).not.toHaveBeenCalled();

    const wip = task("FN-WIP", { column: "in-progress" });
    const wipHarness = overlapStore([wip, candidate]);
    await expect(blockOuterDispatchWhenFileScopeLeaseHeld(
      { store: wipHarness.store, getRunContextFor: () => undefined },
      candidate,
    )).resolves.toBe(true);
    expect(wipHarness.transitionQueuedEpisode).toHaveBeenCalledWith(
      candidate.id,
      expect.objectContaining({ overlapBlockedBy: wip.id }),
    );
  });

  it("gridlock detection ignores checkout-free planning overlap", async () => {
    const planner = task("FN-PLAN-1", { status: "planning" });
    const candidate = task("FN-PLAN-2", { createdAt: "2026-09-01T00:00:01.000Z" });
    const { store } = overlapStore([planner, candidate]);
    const detector = new GridlockDetector(store);

    await expect(detector.detectGridlock()).resolves.toBeNull();
  });

  it("retains the dormant negative control on legacy and renamed hold lanes", () => {
    const legacy = task("FN-LEGACY", { worktree: "/worktrees/FN-LEGACY" });
    const renamed = task("FN-RENAMED", { column: "drafting", worktree: "/worktrees/FN-RENAMED" });

    expect(classifyFileScopeLease(legacy, [])).toMatchObject({ kind: "dormant" });
    expect(classifyFileScopeLease(renamed, [], {
      isWipColumn: false,
      isReviewColumn: false,
      isTerminalColumn: false,
    })).toMatchObject({ kind: "dormant" });
    expect(classifyFileScopeLease(task("FN-RENAMED-PLAN", { column: "drafting", status: "planning" }), [], {
      isWipColumn: false,
      isReviewColumn: false,
      isTerminalColumn: false,
    })).toMatchObject({ kind: "none" });
  });
});
