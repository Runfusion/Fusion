import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Settings, Task, TaskStore } from "@fusion/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearPhantomExecutorBinding } from "../executor/clear-phantom-executor-binding.js";
import { SelfHealingManager } from "../self-healing.js";

const roots: string[] = [];

function blockedTask(rootDir: string, id: string, column: string): Task {
  const worktree = join(rootDir, ".fusion", "worktrees", id.toLowerCase());
  mkdirSync(worktree, { recursive: true });
  const blockedAt = "2026-08-28T00:00:00.000Z";
  return {
    id,
    title: `${column} external freeze`,
    description: "Production-shaped external-block recovery fixture",
    column,
    status: "blocked",
    error: "BLOCKED: host-environment/ENOSPC: no space left on device, write",
    paused: true,
    pausedReason: "external-block",
    worktree,
    branch: `fusion/${id.toLowerCase()}`,
    baseCommitSha: "base-sha",
    steps: [
      { name: "Completed", status: "done" },
      { name: "Testing & Verification", status: "in-progress" },
    ],
    currentStep: 1,
    dependencies: [],
    workflowStepResults: [],
    log: [],
    createdAt: blockedAt,
    updatedAt: blockedAt,
    columnMovedAt: blockedAt,
    externalBlock: {
      origin: "host-environment",
      code: "ENOSPC",
      message: "no space left on device, write",
      source: "agent-declaration",
      blockedAt,
      resume: {
        column,
        nodeId: "steps#1:step-execute",
        currentStep: 1,
        worktree,
        branch: `fusion/${id.toLowerCase()}`,
      },
    },
  } as Task;
}

function cloneTask(task: Task): Task {
  return structuredClone(task);
}

function freezeProjection(task: Task) {
  return {
    column: task.column,
    steps: task.steps,
    currentStep: task.currentStep,
    worktree: task.worktree,
    branch: task.branch,
    paused: task.paused,
    pausedReason: task.pausedReason,
    externalBlock: task.externalBlock,
  };
}

function createStatefulStore(tasks: Task[], rootDir: string): TaskStore & EventEmitter {
  const emitter = new EventEmitter();
  const byId = new Map(tasks.map((task) => [task.id, cloneTask(task)]));
  const settings = {
    autoMerge: true,
    globalPause: false,
    enginePaused: false,
    maintenanceIntervalMs: 0,
    taskStuckTimeoutMs: 1,
    inReviewStalledThresholdMs: 1,
    inReviewStallDeadlockThreshold: 1,
    maxPostReviewFixes: 1,
    maxWorktrees: 4,
  } as unknown as Settings;

  return Object.assign(emitter, {
    getRootDir: vi.fn(() => rootDir),
    getSettings: vi.fn(async () => settings),
    updateSettings: vi.fn(async () => settings),
    listTasks: vi.fn(async (options: { column?: string } = {}) => [...byId.values()]
      .filter((task) => !options.column || task.column === options.column)
      .map(cloneTask)),
    getTask: vi.fn(async (id: string) => {
      const task = byId.get(id);
      if (!task) throw new Error(`Task not found: ${id}`);
      return cloneTask(task);
    }),
    updateTask: vi.fn(async (id: string, patch: Partial<Task>) => {
      const task = byId.get(id);
      if (!task) throw new Error(`Task not found: ${id}`);
      Object.assign(task, patch);
      return cloneTask(task);
    }),
    updateTaskAtomic: vi.fn(async (id: string, updater: (task: Task) => Partial<Task> | null) => {
      const task = byId.get(id);
      if (!task) return { updated: false, reason: "not-found" };
      const patch = updater(cloneTask(task));
      if (!patch) return { updated: false, reason: "predicate" };
      Object.assign(task, patch);
      return { updated: true, task: cloneTask(task) };
    }),
    moveTask: vi.fn(async (id: string, column: string) => {
      const task = byId.get(id);
      if (!task) throw new Error(`Task not found: ${id}`);
      task.column = column as Task["column"];
      return cloneTask(task);
    }),
    logEntry: vi.fn(async (id: string, action: string) => {
      const task = byId.get(id);
      if (task) task.log = [...(task.log ?? []), { timestamp: new Date().toISOString(), action }];
    }),
    recordRunAuditEvent: vi.fn(async () => undefined),
    getRunAuditEventsAsync: vi.fn(async () => []),
    getAgentLogs: vi.fn(async () => []),
    getBranchGroup: vi.fn(async () => null),
    getBootstrappedAt: vi.fn(() => null),
    isBackendMode: vi.fn(() => false),
    getAsyncLayer: vi.fn(() => null),
    reconcileActiveTimingForEngineDowntime: vi.fn(async () => ({ shiftedTaskIds: [], downtimeMs: 0 })),
    pruneOperationalLogsAsync: vi.fn(async () => ({ deletedTotal: 0, deletedByTable: {} })),
    clearStaleExecutionStartBranchReferences: vi.fn(() => []),
    parseFileScopeFromPrompt: vi.fn(async () => []),
    getCompletionHandoffAcceptedMarker: vi.fn(() => null),
    transitionQueuedEpisode: vi.fn(async () => ({ appended: false })),
    peekMergeQueue: vi.fn(() => []),
    refreshDatabaseHealth: vi.fn(async () => undefined),
    __tasks: byId,
  }) as unknown as TaskStore & EventEmitter;
}

/*
FNXC:ExternalBlockRecovery 2026-08-28-05:33:
External blocks must survive the production startup and maintenance orchestration, not only isolated
helper predicates. The harness deliberately makes hold, WIP, and review rows stale enough for every
recovery family, then proves the durable freeze and resource holders remain byte-identical.
*/
describe("external-block self-healing immunity", () => {
  afterEach(() => {
    vi.useRealTimers();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("preserves hold, WIP, and review freezes across startup and repeated maintenance", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-28T06:00:00.000Z"));
    const rootDir = mkdtempSync(join(tmpdir(), "fusion-fn-209-freeze-"));
    roots.push(rootDir);
    execFileSync("git", ["init", "-q", rootDir]);
    const tasks = [
      blockedTask(rootDir, "FN-209-HOLD", "todo"),
      blockedTask(rootDir, "FN-209-WIP", "in-progress"),
      blockedTask(rootDir, "FN-209-REVIEW", "in-review"),
    ];
    const expected = new Map(tasks.map((task) => [task.id, structuredClone(freezeProjection(task))]));
    const store = createStatefulStore(tasks, rootDir);
    const holders = new Map(tasks.map((task) => [task.worktree!, task.id]));
    const clearBinding = vi.fn(() => true);
    const recoverCompletedTask = vi.fn(async () => true);
    const manager = new SelfHealingManager(store, {
      rootDir,
      getExecutingTaskIds: () => new Set<string>(),
      listWorktreeHolders: () => [...holders].map(([worktreePath, taskId]) => ({ taskId, worktreePath })),
      clearPhantomExecutorBinding: clearBinding,
      recoverCompletedTask,
    });
    const swept = [
      vi.spyOn(manager, "recoverStrandedCompletedTodoTasks"),
      vi.spyOn(manager, "recoverPausedAbortFailures"),
      vi.spyOn(manager, "recoverOrphanedExecutions"),
      vi.spyOn(manager, "reapLeakedConcurrencySlots"),
    ];

    try {
      await manager.runStartupRecovery();
      for (let cycle = 0; cycle < 3; cycle += 1) {
        await (manager as unknown as { runMaintenance(): Promise<void> }).runMaintenance();
      }
    } finally {
      manager.stop();
    }

    for (const spy of swept) expect(spy).toHaveBeenCalled();
    for (const task of tasks) {
      const live = await store.getTask(task.id);
      expect(freezeProjection(live)).toEqual(expected.get(task.id));
    }
    expect(holders).toEqual(new Map(tasks.map((task) => [task.worktree!, task.id])));
    expect(clearBinding).not.toHaveBeenCalled();
    expect(recoverCompletedTask).not.toHaveBeenCalled();
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(store.updateTask).not.toHaveBeenCalled();
    expect(store.updateTaskAtomic).not.toHaveBeenCalled();
    expect(store.logEntry).not.toHaveBeenCalledWith(
      expect.stringMatching(/^FN-209-/),
      expect.stringMatching(/Auto-recovered|Auto-revived|Auto-retry|kicked back to todo/i),
    );
  });

  it("refuses to clear executor ownership for a durable external freeze", () => {
    const activeWorktrees = new Map([["FN-209", new Set(["/worktrees/fn-209"])]]);
    const executing = new Set(["FN-209"]);
    const deps = {
      hasLiveSessionSurface: vi.fn(() => false),
      getActiveWorktreePaths: vi.fn(() => ["/worktrees/fn-209"]),
      activeWorktrees,
      executing,
      recoveringCompleted: new Set<string>(),
      resumingUnpaused: new Set<string>(),
      approvalSuspended: new Set<string>(),
      approvalResumeAfterUnwind: new Set<string>(),
      processWideGraphRouting: new Set<string>(),
      effectiveColumnAgentByTask: new Map<string, string>(),
    };

    expect(clearPhantomExecutorBinding(deps, "FN-209", { externallyBlocked: true })).toBe(false);
    expect(activeWorktrees.has("FN-209")).toBe(true);
    expect(executing.has("FN-209")).toBe(true);
    expect(deps.getActiveWorktreePaths).not.toHaveBeenCalled();
  });
});
