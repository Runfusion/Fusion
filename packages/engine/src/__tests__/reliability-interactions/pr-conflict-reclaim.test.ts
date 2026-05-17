import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type { Settings, Task, TaskStore } from "@fusion/core";
import { SelfHealingManager } from "../../self-healing.js";
import * as branchConflicts from "../../branch-conflicts.js";
import * as worktreePool from "../../worktree-pool.js";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-4763",
    title: "t",
    description: "d",
    column: "in-review",
    branch: "fusion/fn-4763",
    worktree: "/tmp/test/.worktrees/fn-4763",
    paused: true,
    pausedReason: "branch-conflict-unrecoverable",
    userPaused: false,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    prInfo: { url: "u", number: 1, status: "open", title: "p", headBranch: "h", baseBranch: "b", commentCount: 0, mergeable: "conflicting" },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Task;
}

function store(t: Task): TaskStore & EventEmitter {
  const emitter = new EventEmitter();
  const settings = { globalPause: false, enginePaused: false, autoRecovery: { mode: "deterministic-only", maxRetries: 3 } } as Settings;
  return Object.assign(emitter, {
    getSettings: vi.fn(async () => settings),
    getTask: vi.fn((id: string) => (id === t.id ? t : null)),
    listTasks: vi.fn(async ({ column }: { column?: string } = {}) => (column ? [t] : [t])),
    updateTask: vi.fn(async (_id: string, updates: Partial<Task>) => Object.assign(t, updates)),
    moveTask: vi.fn(async (_id: string, column: Task["column"]) => {
      t.column = column;
      return t;
    }),
    logEntry: vi.fn(async () => undefined),
    appendAgentLog: vi.fn(async () => undefined),
    clearStaleExecutionStartBranchReferences: vi.fn(() => []),
    recordRunAuditEvent: vi.fn(async () => undefined),
    walCheckpoint: vi.fn(() => ({ busy: 0, log: 0, checkpointed: 0 })),
    getRootDir: vi.fn(() => "/tmp/test"),
  }) as unknown as TaskStore & EventEmitter;
}

describe("reliability interaction: pr conflict reclaim", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(worktreePool, "isUsableTaskWorktree").mockResolvedValue(true);
  });

  it("reclaims conflicting PR candidate during maintenance helper", async () => {
    const t = task();
    const s = store(t);
    vi.spyOn(branchConflicts, "inspectBranchConflict").mockResolvedValue({ kind: "stale" } as any);
    const manager = new SelfHealingManager(s as any, { rootDir: "/tmp/test" } as any);
    const count = await manager.reclaimPrConflicts();
    expect(count).toBe(0);
    expect(branchConflicts.inspectBranchConflict).toHaveBeenCalled();
  });

  it("skips checked-out task during pr conflict reclaim", async () => {
    const t = task({ checkedOutBy: "agent-1" });
    const s = store(t);
    const manager = new SelfHealingManager(s as any, { rootDir: "/tmp/test" } as any);
    const result = await manager.reclaimPrConflictForTask(t.id);
    expect(result).toEqual({ outcome: "skipped", reason: "checked-out" });
  });
});
