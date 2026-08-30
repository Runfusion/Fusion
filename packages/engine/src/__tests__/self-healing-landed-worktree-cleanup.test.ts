import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskStore } from "@fusion/core";

const { cleanupLandedTaskWorktreeMock, existsSyncMock } = vi.hoisted(() => ({
  cleanupLandedTaskWorktreeMock: vi.fn(),
  existsSyncMock: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: existsSyncMock };
});
vi.mock("../merge/post-landing-worktree-cleanup.js", () => ({
  cleanupLandedTaskWorktree: cleanupLandedTaskWorktreeMock,
}));

import { SelfHealingManager } from "../self-healing.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-251",
    title: "cleanup landed worktree",
    description: "cleanup landed worktree",
    column: "done",
    branch: "fusion/fn-251",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    mergeDetails: { mergeConfirmed: true, commitSha: "landed-sha" },
    ...overrides,
  } as Task;
}

function createStore(task: Task) {
  const tasks = new Map([[task.id, task]]);
  const events: string[] = [];
  const store = Object.assign(new EventEmitter(), {
    getSettings: vi.fn(async () => ({ globalPause: false, enginePaused: false })),
    getTask: vi.fn(async (id: string) => tasks.get(id)),
    listTasks: vi.fn(async (options?: { column?: string }) => {
      const values = [...tasks.values()];
      return options?.column ? values.filter((entry) => entry.column === options.column) : values;
    }),
    listWorkflowDefinitions: vi.fn(async () => []),
    getTaskWorkflowSelection: vi.fn(() => undefined),
    getTaskWorkflowSelectionAsync: vi.fn(async () => undefined),
    getCompletionHandoffAcceptedMarker: vi.fn(async () => null),
    parseFileScopeFromPrompt: vi.fn(async () => []),
    transitionQueuedEpisode: vi.fn(),
    updateTask: vi.fn(async (id: string, patch: Partial<Task>) => {
      if (patch.worktree === null) events.push("cleanup");
      const next = { ...tasks.get(id)!, ...patch } as Task;
      tasks.set(id, next);
      return next;
    }),
    moveTask: vi.fn(async (id: string, column: string) => {
      events.push("move");
      const next = { ...tasks.get(id)!, column } as Task;
      tasks.set(id, next);
      return next;
    }),
    logEntry: vi.fn(async () => undefined),
    recordRunAuditEvent: vi.fn(async () => undefined),
  }) as unknown as TaskStore & EventEmitter;
  return { store, tasks, events };
}

describe("self-healing landed worktree cleanup", () => {
  beforeEach(() => {
    existsSyncMock.mockReset();
    existsSyncMock.mockReturnValue(false);
    cleanupLandedTaskWorktreeMock.mockReset();
    cleanupLandedTaskWorktreeMock.mockResolvedValue({ outcome: "removed", removed: true });
  });

  it("routes every direct complete-lane finalizer through the shared cleanup seam", async () => {
    const source = await (await import("node:fs/promises")).readFile(
      new URL("../self-healing.ts", import.meta.url),
      "utf8",
    );

    expect(source).not.toMatch(/const\s+movedTask\s*=\s*await this\.store\.moveTask\(task\.id, completeLane\)/);
    expect(source).toContain('"self-healing-finalize-no-op-review"');
    expect(source).toContain('"recover-stuck-merge-deadlocks"');
    expect(source).toContain('"recover-branch-misbound-in-review"');
    expect(source).toContain("cleanupLandedTaskWorktree");
  });

  it.each([
    "self-healing-finalize-no-op-review",
    "recover-stuck-merge-deadlocks",
  ])("cleans before the representative %s complete-lane move", async (source) => {
    const task = makeTask({ column: "in-review", worktree: "/repo/.worktrees/fn-251" });
    const { store, events } = createStore(task);
    const manager = new SelfHealingManager(store, { rootDir: "/repo" });
    cleanupLandedTaskWorktreeMock.mockImplementationOnce(async (input: { store: TaskStore; taskId: string }) => {
      events.push("remove");
      await input.store.updateTask(input.taskId, { worktree: null });
      return { outcome: "removed", removed: true };
    });

    await (manager as any).moveToCompleteLaneAfterLandedCleanup(task, "done", source);

    expect(events).toEqual(["remove", "cleanup", "move"]);
    expect(cleanupLandedTaskWorktreeMock).toHaveBeenCalledWith(expect.objectContaining({
      rootDir: "/repo",
      taskId: task.id,
      worktreePath: "/repo/.worktrees/fn-251",
      landedSha: "landed-sha",
      source,
    }));
  });

  it("keeps legacy direct finalizers inert when there is no durable landing proof", async () => {
    const task = makeTask({ mergeDetails: undefined, worktree: "/repo/.worktrees/fn-251" });
    const { store, events } = createStore(task);
    const manager = new SelfHealingManager(store, { rootDir: "/repo" });

    await (manager as any).moveToCompleteLaneAfterLandedCleanup(task, "done", "self-healing-finalize-no-op-review");

    expect(cleanupLandedTaskWorktreeMock).not.toHaveBeenCalled();
    expect(events).toEqual(["move"]);
  });

  it("uses the branch fallback as the proof-gated completion convergence backstop", async () => {
    const task = makeTask({ worktree: null });
    const { store, tasks } = createStore(task);
    const manager = new SelfHealingManager(store, { rootDir: "/repo" });
    vi.spyOn(manager as any, "reconcileTaskWorktreeMetadata").mockResolvedValue(0);
    const findWorktreePath = vi.spyOn(manager as any, "findWorktreePathForBranch").mockResolvedValue("/repo/.worktrees/fn-251");
    vi.spyOn(manager as any, "clearCompletionBranchIfSubsumed").mockResolvedValue(false);
    existsSyncMock.mockImplementation((path: string) => path === "/repo/.worktrees/fn-251");
    cleanupLandedTaskWorktreeMock.mockImplementationOnce(async (input: { store: TaskStore; taskId: string }) => {
      await input.store.updateTask(input.taskId, { worktree: null });
      return { outcome: "removed", removed: true };
    });

    const result = await manager.reconcileCompletedTask(task.id);

    expect(result.worktreeRemoved).toBe(true);
    expect(findWorktreePath).toHaveBeenCalledWith("fusion/fn-251");
    expect(cleanupLandedTaskWorktreeMock).toHaveBeenCalledWith(expect.objectContaining({
      source: "self-healing-completion-convergence",
      worktreePath: "/repo/.worktrees/fn-251",
      landedSha: "landed-sha",
    }));
    expect(tasks.get(task.id)?.worktree).toBeNull();
  });

  it("retries an absent landed worktree pointer through completion convergence", async () => {
    const task = makeTask({ worktree: "/repo/.worktrees/fn-251" });
    const { store, tasks } = createStore(task);
    const manager = new SelfHealingManager(store, { rootDir: "/repo" });
    vi.spyOn(manager as any, "reconcileTaskWorktreeMetadata").mockResolvedValue(0);
    vi.spyOn(manager as any, "findWorktreePathForBranch").mockResolvedValue(undefined);
    vi.spyOn(manager as any, "clearCompletionBranchIfSubsumed").mockResolvedValue(false);
    existsSyncMock.mockReturnValue(false);
    cleanupLandedTaskWorktreeMock.mockImplementationOnce(async (input: { store: TaskStore; taskId: string }) => {
      await input.store.updateTask(input.taskId, { worktree: null });
      return { outcome: "nothing-to-remove", removed: false };
    });

    const result = await manager.reconcileCompletedTask(task.id);

    expect(result.worktreeRemoved).toBe(false);
    expect(cleanupLandedTaskWorktreeMock).toHaveBeenCalledWith(expect.objectContaining({
      source: "self-healing-completion-convergence",
      worktreePath: "/repo/.worktrees/fn-251",
    }));
    expect(tasks.get(task.id)?.worktree).toBeNull();
  });

  it("retains a preserved completion worktree and does not use the strict fallback", async () => {
    const task = makeTask({ worktree: "/repo/.worktrees/fn-251" });
    const { store, tasks } = createStore(task);
    const manager = new SelfHealingManager(store, { rootDir: "/repo" });
    vi.spyOn(manager as any, "reconcileTaskWorktreeMetadata").mockResolvedValue(0);
    vi.spyOn(manager as any, "clearCompletionBranchIfSubsumed").mockResolvedValue(false);
    existsSyncMock.mockReturnValue(true);
    cleanupLandedTaskWorktreeMock.mockResolvedValueOnce({
      outcome: "preserved-deliverable",
      removed: false,
      preservedReason: "deliverable",
    });

    const result = await manager.reconcileCompletedTask(task.id);

    expect(result.worktreeRemoved).toBe(false);
    expect(tasks.get(task.id)?.worktree).toBe("/repo/.worktrees/fn-251");
    expect(cleanupLandedTaskWorktreeMock).toHaveBeenCalledOnce();
  });
});
