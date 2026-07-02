import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import type { Settings, Task, TaskStore } from "@fusion/core";
import { SelfHealingManager, STALE_ACTIVE_BRANCH_EXECUTION_GRACE_MS } from "../../self-healing.js";
import { activeSessionRegistry } from "../../active-session-registry.js";

function sh(command: string, cwd: string): string {
  return String(execSync(command, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }) ?? "");
}

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "fn-4949-"));
  sh("git init", root);
  sh("git config user.email 'test@example.com'", root);
  sh("git config user.name 'Test User'", root);
  writeFileSync(join(root, "README.md"), "base\n", "utf-8");
  sh("git add README.md", root);
  sh("git commit -m 'init'", root);
  sh("git branch -M main", root);
  return root;
}

function createFusionBranch(repo: string, taskId: string): string {
  const branch = `fusion/${taskId.toLowerCase()}`;
  sh(`git checkout -b ${branch}`, repo);
  sh("git checkout main", repo);
  return branch;
}

function makeTask(taskId: string, branch: string, worktree: string | null, executionStartedAt: string): Task {
  return {
    id: taskId,
    title: "test",
    description: "test",
    column: "in-progress",
    branch,
    worktree: worktree ?? undefined,
    executionStartedAt,
    paused: false,
    userPaused: false,
    checkedOutBy: undefined,
    pausedReason: undefined,
    dependencies: [],
    steps: Array.from({ length: 7 }, (_, index) => ({ name: `step-${index + 1}`, status: "done" })),
    currentStep: 7,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as unknown as Task;
}

function makeStore(task: Task): TaskStore & EventEmitter & { auditEvents: any[] } {
  const emitter = new EventEmitter();
  const settings = {
    autoMerge: true,
    globalPause: false,
    enginePaused: false,
    baseBranch: "main",
    mergeStrategy: "direct",
    autoRecovery: { mode: "deterministic-only", maxRetries: 3 },
  } as unknown as Settings;
  const auditEvents: any[] = [];
  return Object.assign(emitter, {
    auditEvents,
    getSettings: vi.fn(async () => settings),
    getTask: vi.fn(async () => task),
    listTasks: vi.fn(async () => [task]),
    updateTask: vi.fn(async (_id: string, updates: Partial<Task>) => Object.assign(task, updates)),
    moveTask: vi.fn(async (_id: string, column: Task["column"]) => {
      task.column = column;
      return task;
    }),
    logEntry: vi.fn(async () => undefined),
    appendAgentLog: vi.fn(async () => undefined),
    updateSettings: vi.fn(async () => settings),
    clearStaleExecutionStartBranchReferences: vi.fn(() => []),
    recordRunAuditEvent: vi.fn(async (event: any) => {
      auditEvents.push(event);
    }),
    walCheckpoint: vi.fn(() => ({ busy: 0, log: 0, checkpointed: 0 })),
    archiveTaskAndCleanup: vi.fn(async () => ({})),
    mergeTask: vi.fn(async () => undefined),
    getRootDir: vi.fn(() => "/tmp/test"),
    /*
    FNXC:SqliteFinalRemoval 2026-06-25-16:30:
    TaskStore contract now exposes isBackendMode()/getAsyncLayer(). Mock must
    implement these so backend-mode guards take the SQLite path. See
    scripts/lib/test-quarantine.md mock-drift rescue path.
    */
    isBackendMode: vi.fn(() => false),
    getAsyncLayer: vi.fn(() => null),
  }) as unknown as TaskStore & EventEmitter & { auditEvents: any[] };
}

describe("FN-4924 / FN-4949: reclaim-stale-active-branches defers in-flight executor work", () => {
  const tempRoots: string[] = [];

  beforeEach(() => {
    activeSessionRegistry.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    activeSessionRegistry.clear();
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("defers when execution started recently (before reclaim)", async () => {
    const repo = makeRepo();
    tempRoots.push(repo);
    const branch = createFusionBranch(repo, "FN-4924");
    const worktree = join(repo, ".worktrees", "fn-4924");
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, "dirty.txt"), "dirty\n", "utf-8");

    const task = makeTask("FN-4924", branch, worktree, new Date(Date.now() - 60_000).toISOString());
    const store = makeStore(task);
    const manager = new SelfHealingManager(store as any, { rootDir: repo } as any);
    vi.spyOn(manager as any, "inspectOrphanedBranch").mockResolvedValue({
      branch,
      tipSha: "abc123def456",
      uniqueCommitCount: 0,
      subjects: [],
    });

    const recovered = await manager.reclaimStaleActiveBranches();

    expect(recovered).toBe(0);
    expect((store.updateTask as any).mock.calls.some((call: any[]) => call[1]?.worktree === null && call[1]?.branch === null)).toBe(false);
    expect(sh(`git rev-parse --verify ${branch}`, repo).trim().length).toBeGreaterThan(0);
    expect(store.auditEvents.some((event) => event.mutationType === "branch:stale-active-reclaim-deferred" && event.metadata?.reason === "recent-execution-started")).toBe(true);

    manager.stop();
  });

  it("defers when worktree is in activeSessionRegistry", async () => {
    const repo = makeRepo();
    tempRoots.push(repo);
    const branch = createFusionBranch(repo, "FN-4925");
    const worktree = join(repo, ".worktrees", "fn-4925");
    mkdirSync(worktree, { recursive: true });

    const oldStart = new Date(Date.now() - STALE_ACTIVE_BRANCH_EXECUTION_GRACE_MS - 60_000).toISOString();
    const task = makeTask("FN-4925", branch, worktree, oldStart);
    const store = makeStore(task);
    activeSessionRegistry.registerPath(worktree, { taskId: task.id, kind: "executor", ownerKey: task.id });

    const manager = new SelfHealingManager(store as any, { rootDir: repo } as any);
    const inspectSpy = vi.spyOn(manager as any, "inspectOrphanedBranch");

    const recovered = await manager.reclaimStaleActiveBranches();

    expect(recovered).toBe(0);
    expect(inspectSpy).not.toHaveBeenCalled();
    expect(store.auditEvents.some((event) => event.mutationType === "branch:stale-active-reclaim-deferred" && event.metadata?.reason === "active-session")).toBe(true);
    manager.stop();
  });

  it("still reclaims legitimate stale active branch without in-flight signals", async () => {
    const repo = makeRepo();
    tempRoots.push(repo);
    const branch = createFusionBranch(repo, "FN-4926");

    const oldStart = new Date(Date.now() - STALE_ACTIVE_BRANCH_EXECUTION_GRACE_MS - 60_000).toISOString();
    const task = makeTask("FN-4926", branch, null, oldStart);
    const store = makeStore(task);
    const manager = new SelfHealingManager(store as any, { rootDir: repo } as any);
    vi.spyOn(manager as any, "inspectOrphanedBranch").mockResolvedValue({
      branch,
      tipSha: "abc123def456",
      uniqueCommitCount: 0,
      subjects: [],
    });

    const recovered = await manager.reclaimStaleActiveBranches();

    expect(recovered).toBe(1);
    expect((store.updateTask as any).mock.calls.some((call: any[]) => call[1]?.worktree === null && call[1]?.branch === null && call[1]?.baseCommitSha === null)).toBe(true);
    expect(() => sh(`git rev-parse --verify ${branch}`, repo)).toThrow();
    expect(store.auditEvents.some((event) => event.mutationType === "branch:stale-active-reclaim" && event.target === branch)).toBe(true);
    manager.stop();
  });

  it("reproduces FN-4924 loop conditions and defers reclaim", async () => {
    const repo = makeRepo();
    tempRoots.push(repo);
    const branch = createFusionBranch(repo, "FN-4924");
    const worktree = join(repo, ".worktrees", "fn-4924-loop");
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, "session-progress.txt"), "pending commit\n", "utf-8");

    const task = makeTask("FN-4924", branch, worktree, new Date(Date.now() - 2 * 60_000).toISOString());
    const store = makeStore(task);
    const manager = new SelfHealingManager(store as any, { rootDir: repo } as any);
    vi.spyOn(manager as any, "inspectOrphanedBranch").mockResolvedValue({
      branch,
      tipSha: "abc123def456",
      uniqueCommitCount: 0,
      subjects: [],
    });

    const recovered = await manager.reclaimStaleActiveBranches();

    expect(recovered).toBe(0);
    expect((store.updateTask as any).mock.calls.some((call: any[]) => call[1]?.worktree === null && call[1]?.branch === null)).toBe(false);
    expect(store.auditEvents.some((event) => event.mutationType === "branch:stale-active-reclaim-deferred")).toBe(true);
    manager.stop();
  });
});
