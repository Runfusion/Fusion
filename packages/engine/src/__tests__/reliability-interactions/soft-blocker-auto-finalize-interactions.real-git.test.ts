import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { EventEmitter } from "node:events";
import type { Settings, Task, TaskStore } from "@fusion/core";
import { SelfHealingManager } from "../../self-healing.js";

const MAX_AUTO_MERGE_RETRIES = 3;

function git(dir: string, cmd: string): string {
  return execSync(cmd, { cwd: dir, stdio: "pipe" }).toString().trim();
}

function makeStore(tasks: Task[], events: unknown[] = [], settings?: Partial<Settings>): TaskStore & EventEmitter {
  const emitter = new EventEmitter();
  const baseSettings = { globalPause: false, enginePaused: false, ...settings } as Settings;
  return Object.assign(emitter, {
    getSettings: async () => baseSettings,
    listTasks: async ({ column }: { column?: string } = {}) => (column ? tasks.filter((t) => t.column === column) : tasks),
    updateTask: async (id: string, updates: Partial<Task>) => {
      const task = tasks.find((candidate) => candidate.id === id);
      if (task) Object.assign(task, updates);
    },
    moveTask: async (id: string, column: Task["column"]) => {
      const task = tasks.find((candidate) => candidate.id === id);
      if (task) task.column = column;
    },
    logEntry: async () => undefined,
    getTask: async (id: string) => tasks.find((candidate) => candidate.id === id) ?? null,
    walCheckpoint: () => ({ busy: 0, log: 0, checkpointed: 0 }),
    archiveTaskAndCleanup: async () => ({}),
    clearStaleExecutionStartBranchReferences: () => [],
    updateSettings: async () => baseSettings,
    mergeTask: async () => undefined,
    getRootDir: () => "",
    recordRunAuditEvent: async (event: unknown) => {
      events.push(event);
    },
  }) as unknown as TaskStore & EventEmitter;
}

function seedLandedContent(dir: string, branch: string, taskId: string, fileName = "file.txt"): string {
  git(dir, `git checkout -b ${branch}`);
  writeFileSync(join(dir, fileName), `${taskId} content\n`);
  git(dir, `git add ${fileName}`);
  git(dir, `git commit -m 'test(${taskId}): landed content' -m 'Fusion-Task-Id: ${taskId}'`);
  const taskCommit = git(dir, "git rev-parse HEAD");
  git(dir, "git checkout main");
  git(dir, `git cherry-pick ${taskCommit}`);
  return taskCommit;
}

function seedUnlandedContent(dir: string, branch: string, taskId: string, fileName = "pending.txt"): void {
  git(dir, `git checkout -b ${branch}`);
  writeFileSync(join(dir, fileName), `${taskId} pending\n`);
  git(dir, `git add ${fileName}`);
  git(dir, `git commit -m 'test(${taskId}): pending content' -m 'Fusion-Task-Id: ${taskId}'`);
  git(dir, "git checkout main");
}

function makeTask(overrides: Partial<Task> = {}): Task {
  const now = new Date().toISOString();
  return {
    id: "FN-4653",
    title: "t",
    description: "d",
    column: "in-review",
    paused: true,
    status: "failed",
    error: "stale failure",
    mergeRetries: MAX_AUTO_MERGE_RETRIES,
    mergeDetails: undefined,
    branch: "fusion/fn-4653",
    baseBranch: "main",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as Task;
}

describe("soft-blocker auto-finalize reliability interactions (real git)", () => {
  it("auto-finalizes paused+failed in-review tasks once landed content is proven", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fn-4653-ri-merge-"));
    try {
      git(dir, "git init -b main");
      git(dir, 'git config user.email "test@example.com"');
      git(dir, 'git config user.name "Test"');
      git(dir, "git commit --allow-empty -m init");

      seedLandedContent(dir, "fusion/fn-4653", "FN-4653");

      const task = makeTask();
      const auditEvents: unknown[] = [];
      const store = makeStore([task], auditEvents);
      const manager = new SelfHealingManager(store, { rootDir: dir, getExecutingTaskIds: () => new Set() });

      const recovered = await manager.recoverAlreadyMergedReviewTasks();

      expect(recovered).toBe(1);
      expect(task.column).toBe("done");
      expect(task.paused).toBe(false);
      expect(task.status).toBeNull();
      expect(task.error).toBeNull();
      expect(task.mergeDetails?.mergeConfirmed).toBe(true);
      expect(
        auditEvents.some((event: any) => event?.mutationType === "task:auto-recover-finalize-already-on-main"),
      ).toBe(true);

      manager.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves hard blockers, then finalizes via recoverMergedReviewTasks when blocker clears", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fn-4653-ri-hard-handoff-"));
    try {
      git(dir, "git init -b main");
      git(dir, 'git config user.email "test@example.com"');
      git(dir, 'git config user.name "Test"');
      git(dir, "git commit --allow-empty -m init");

      seedLandedContent(dir, "fusion/fn-4653-hard", "FN-4653-HARD", "hard.txt");

      const task = makeTask({
        id: "FN-4653-HARD",
        branch: "fusion/fn-4653-hard",
        steps: [{ name: "Step 1", status: "pending" }],
      });
      const auditEvents: unknown[] = [];
      const store = makeStore([task], auditEvents);
      const manager = new SelfHealingManager(store, { rootDir: dir, getExecutingTaskIds: () => new Set() });

      const firstSweep = await manager.recoverAlreadyMergedReviewTasks();

      expect(firstSweep).toBe(0);
      expect(task.column).toBe("in-review");
      expect(task.paused).toBe(true);
      expect(task.status).toBe("failed");
      expect(task.error).toContain("task has incomplete steps");
      expect(task.mergeDetails?.mergeConfirmed).toBe(true);
      expect(
        auditEvents.some((event: any) => event?.mutationType === "task:auto-recover-finalize-already-on-main"),
      ).toBe(false);

      task.steps = [];
      task.error = "stale failure";

      const secondSweep = await manager.recoverMergedReviewTasks();

      expect(secondSweep).toBe(1);
      expect(task.column).toBe("done");
      expect(task.paused).toBe(false);
      expect(task.status).toBeNull();
      expect(task.error).toBeNull();
      expect(
        auditEvents.some((event: any) => event?.mutationType === "task:auto-recover-finalize-already-on-main"),
      ).toBe(true);

      manager.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("finalizes soft-blocked landed-content tasks during restart-time self-healing sweeps", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fn-4653-ri-restart-positive-"));
    try {
      git(dir, "git init -b main");
      git(dir, 'git config user.email "test@example.com"');
      git(dir, 'git config user.name "Test"');
      git(dir, "git commit --allow-empty -m init");

      seedLandedContent(dir, "fusion/fn-4653-restart", "FN-4653-RESTART", "restart.txt");

      const task = makeTask({ id: "FN-4653-RESTART", branch: "fusion/fn-4653-restart" });
      const store = makeStore([task]);
      const manager = new SelfHealingManager(store, { rootDir: dir, getExecutingTaskIds: () => new Set() });

      const recovered = await manager.recoverAlreadyMergedReviewTasks();
      expect(recovered).toBe(1);
      expect(task.column).toBe("done");
      expect(task.paused).toBe(false);
      expect(task.status).toBeNull();

      manager.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not false-positive finalize when content is not landed on main", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fn-4653-ri-restart-negative-"));
    try {
      git(dir, "git init -b main");
      git(dir, 'git config user.email "test@example.com"');
      git(dir, 'git config user.name "Test"');
      git(dir, "git commit --allow-empty -m init");

      seedUnlandedContent(dir, "fusion/fn-4653-restart-pending", "FN-4653-RESTART-PENDING");

      const task = makeTask({
        id: "FN-4653-RESTART-PENDING",
        branch: "fusion/fn-4653-restart-pending",
      });
      const store = makeStore([task]);
      const manager = new SelfHealingManager(store, { rootDir: dir, getExecutingTaskIds: () => new Set() });

      const recovered = await manager.recoverAlreadyMergedReviewTasks();
      expect(recovered).toBe(0);
      expect(task.column).toBe("in-review");
      expect(task.paused).toBe(true);
      expect(task.status).toBe("failed");

      manager.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("composes scheduler inReviewWithWorktree filtering with auto-finalize and stale blockedBy cleanup", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fn-4653-ri-scheduler-"));
    try {
      git(dir, "git init -b main");
      git(dir, 'git config user.email "test@example.com"');
      git(dir, 'git config user.name "Test"');
      git(dir, "git commit --allow-empty -m init");

      seedLandedContent(dir, "fusion/fn-4653-scheduler", "FN-4653-SCHED", "scheduler.txt");

      const upstream = makeTask({
        id: "FN-4653-SCHED",
        branch: "fusion/fn-4653-scheduler",
        worktree: "/tmp/fake-worktree",
      });
      const downstream = makeTask({
        id: "FN-4653-SCHED-DOWNSTREAM",
        column: "todo",
        paused: false,
        status: null,
        error: null,
        branch: "fusion/fn-4653-scheduler-downstream",
        blockedBy: "FN-4653-SCHED",
      });

      const store = makeStore([upstream, downstream]);
      const manager = new SelfHealingManager(store, { rootDir: dir, getExecutingTaskIds: () => new Set() });

      const inReviewWithWorktree = (task: Task) =>
        task.column === "in-review" && Boolean(task.worktree) && !task.paused && task.status !== "failed";

      expect(inReviewWithWorktree(upstream)).toBe(false);

      const recovered = await manager.recoverAlreadyMergedReviewTasks();
      expect(recovered).toBe(1);
      expect(upstream.column).toBe("done");
      expect(inReviewWithWorktree(upstream)).toBe(false);

      const cleared = await manager.clearStaleBlockedBy();
      expect(cleared).toBeGreaterThanOrEqual(0);
      expect(downstream.blockedBy ?? null).toBeNull();

      manager.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
