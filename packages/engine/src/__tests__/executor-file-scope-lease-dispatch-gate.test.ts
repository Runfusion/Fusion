import { describe, expect, it, vi } from "vitest";
import type { Settings, Task, TaskStore } from "@fusion/core";
import { blockOuterDispatchWhenFileScopeLeaseHeld } from "../executor/file-scope-lease-dispatch-gate.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-CANDIDATE",
    title: "candidate",
    description: "",
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-01-02T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    ...overrides,
  } as Task;
}

function createStore(tasks: Task[], scopes: Record<string, string[]>, settings: Partial<Settings> = {}): TaskStore {
  return {
    getSettings: vi.fn(async () => ({ groupOverlappingFiles: true, ...settings })),
    listTasks: vi.fn(async () => tasks),
    parseFileScopeFromPrompt: vi.fn(async (taskId: string) => scopes[taskId] ?? []),
    getCompletionHandoffAcceptedMarker: vi.fn(async () => null),
    transitionQueuedEpisode: vi.fn(async (taskId: string, transition: { blockedBy: string | null; overlapBlockedBy: string | null; signature: string }) => {
      const task = tasks.find((candidate) => candidate.id === taskId)!;
      Object.assign(task, {
        status: "queued",
        blockedBy: transition.blockedBy,
        overlapBlockedBy: transition.overlapBlockedBy,
        queuedLogEpisodeSignature: transition.signature,
      });
      return { appended: true, task };
    }),
    moveTask: vi.fn(),
    moveTaskIf: vi.fn(),
  } as unknown as TaskStore;
}

describe("blockOuterDispatchWhenFileScopeLeaseHeld", () => {
  it("holds a fresh dispatch behind an overlapping active lease without moving its column", async () => {
    const holder = makeTask({ id: "FN-HOLDER", column: "in-progress", createdAt: "2026-01-01T00:00:00.000Z" });
    const candidate = makeTask({ blockedBy: "FN-DEP" });
    const store = createStore([holder, candidate], {
      [holder.id]: ["packages/core/src/store.ts"],
      [candidate.id]: ["packages/core/src/store.ts"],
    });

    const blocked = await blockOuterDispatchWhenFileScopeLeaseHeld({
      store,
      getRunContextFor: () => undefined,
    }, candidate);

    expect(blocked).toBe(true);
    expect(store.transitionQueuedEpisode).toHaveBeenCalledWith(candidate.id, expect.objectContaining({
      signature: `file-scope:${holder.id}`,
      blockedBy: "FN-DEP",
      overlapBlockedBy: holder.id,
    }));
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(store.moveTaskIf).not.toHaveBeenCalled();
  });

  it("does not hold a task that already owns a worktree", async () => {
    const holder = makeTask({ id: "FN-HOLDER", column: "in-progress" });
    const candidate = makeTask({ worktree: "/wt/fn-candidate" });
    const store = createStore([holder, candidate], {
      [holder.id]: ["packages/core/src/store.ts"],
      [candidate.id]: ["packages/core/src/store.ts"],
    });

    await expect(blockOuterDispatchWhenFileScopeLeaseHeld({ store, getRunContextFor: () => undefined }, candidate)).resolves.toBe(false);
    expect(store.transitionQueuedEpisode).not.toHaveBeenCalled();
  });

  it("does not re-hold a workspace task that already owns repository checkouts", async () => {
    const holder = makeTask({ id: "FN-HOLDER", column: "in-progress" });
    const candidate = makeTask({ workspaceWorktrees: { "repo-a": { worktreePath: "/wt/fn-candidate/repo-a" } } as Task["workspaceWorktrees"] });
    const store = createStore([holder, candidate], {
      [holder.id]: ["repo-a/src/shared.ts"],
      [candidate.id]: ["repo-a/src/shared.ts"],
    });

    await expect(blockOuterDispatchWhenFileScopeLeaseHeld({ store, getRunContextFor: () => undefined }, candidate)).resolves.toBe(false);
    expect(store.transitionQueuedEpisode).not.toHaveBeenCalled();
  });

  it("holds a fresh workspace task with no repository checkouts", async () => {
    const holder = makeTask({ id: "FN-HOLDER", column: "in-progress" });
    const candidate = makeTask({ workspaceWorktrees: {} });
    const store = createStore([holder, candidate], {
      [holder.id]: ["repo-a/src/shared.ts"],
      [candidate.id]: ["repo-a/src/shared.ts"],
    });

    await expect(blockOuterDispatchWhenFileScopeLeaseHeld({ store, getRunContextFor: () => undefined }, candidate)).resolves.toBe(true);
    expect(store.transitionQueuedEpisode).toHaveBeenCalledOnce();
  });

  it("uses a workspace review checkout as an active holder", async () => {
    const holder = makeTask({
      id: "FN-HOLDER",
      column: "in-review",
      workspaceWorktrees: { "repo-a": { worktreePath: "/wt/fn-holder/repo-a" } } as Task["workspaceWorktrees"],
    });
    const candidate = makeTask();
    const store = createStore([holder, candidate], {
      [holder.id]: ["repo-a/src/shared.ts"],
      [candidate.id]: ["repo-a/src/shared.ts"],
    });

    await expect(blockOuterDispatchWhenFileScopeLeaseHeld({ store, getRunContextFor: () => undefined }, candidate)).resolves.toBe(true);
    expect(store.transitionQueuedEpisode).toHaveBeenCalledWith(candidate.id, expect.objectContaining({ overlapBlockedBy: holder.id }));
  });

  it("does not apply overlap admission when grouping is disabled", async () => {
    const holder = makeTask({ id: "FN-HOLDER", column: "in-progress" });
    const candidate = makeTask();
    const store = createStore([holder, candidate], {
      [holder.id]: ["packages/core/src/store.ts"],
      [candidate.id]: ["packages/core/src/store.ts"],
    }, { groupOverlappingFiles: false });

    await expect(blockOuterDispatchWhenFileScopeLeaseHeld({ store, getRunContextFor: () => undefined }, candidate)).resolves.toBe(false);
    expect(store.transitionQueuedEpisode).not.toHaveBeenCalled();
  });

  it("leaves stale overlap bookkeeping for the scheduler when no live holder overlaps", async () => {
    const holder = makeTask({ id: "FN-HOLDER", column: "in-progress" });
    const candidate = makeTask({ overlapBlockedBy: "FN-STALE" });
    const store = createStore([holder, candidate], {
      [holder.id]: ["packages/engine/src/scheduler.ts"],
      [candidate.id]: ["packages/core/src/store.ts"],
    });

    await expect(blockOuterDispatchWhenFileScopeLeaseHeld({ store, getRunContextFor: () => undefined }, candidate)).resolves.toBe(false);
    expect(candidate.overlapBlockedBy).toBe("FN-STALE");
    expect(store.transitionQueuedEpisode).not.toHaveBeenCalled();
  });
});
