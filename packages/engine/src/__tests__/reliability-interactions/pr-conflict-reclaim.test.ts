import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type { Settings, Task, TaskStore } from "@fusion/core";
import { SelfHealingManager } from "../../self-healing.js";
import * as branchConflicts from "../../execution/branch-conflicts.js";
import * as worktreePool from "../../worktree/worktree-pool.js";
import { activeSessionRegistry } from "../../agents/active-session-registry.js";

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
    activeSessionRegistry.clear();
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

  it("skips active heartbeat-style session during pr conflict reclaim", async () => {
    const t = task();
    const s = store(t);
    activeSessionRegistry.registerPath(t.worktree!, { taskId: t.id, kind: "executor", ownerKey: t.id });
    const manager = new SelfHealingManager(s as any, { rootDir: "/tmp/test" } as any);
    const result = await manager.reclaimPrConflictForTask(t.id);
    expect(result).toEqual({ outcome: "skipped", reason: "active-session" });
  });

  it("keeps paused-review reclaim path resumable", async () => {
    const t = task({ updatedAt: new Date(Date.now() - 11 * 60_000).toISOString() });
    const s = store(t);
    vi.spyOn(branchConflicts, "inspectBranchConflict").mockResolvedValue({ kind: "reclaimable", livePath: t.worktree, tipSha: "abc123", taskAttributedCommitCount: 2, strandedCommits: [{ sha: "abc123" }] } as any);
    const manager = new SelfHealingManager(s as any, { rootDir: "/tmp/test" } as any);
    const result = await manager.reclaimPrConflictForTask(t.id);
    expect(result.outcome).toBe("reclaimed");
    expect(t.column).toBe("todo");
  });
});
