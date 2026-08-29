import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { EventEmitter } from "node:events";
import type { Settings, Task, TaskStore } from "@fusion/core";
import { SelfHealingManager } from "../../self-healing.js";

function git(dir: string, cmd: string): string {
  return execSync(cmd, { cwd: dir, stdio: "pipe" }).toString().trim();
}

function makeStore(task: Task, events: unknown[] = []): TaskStore & EventEmitter {
  const emitter = new EventEmitter();
  const settings = { globalPause: false, enginePaused: false } as Settings;
  return Object.assign(emitter, {
    getSettings: async () => settings,
    listTasks: async ({ column }: { column?: string } = {}) => (column ? [task].filter((t) => t.column === column) : [task]),
    updateTask: async (_id: string, updates: Partial<Task>) => Object.assign(task, updates),
    moveTask: async (_id: string, column: Task["column"]) => { task.column = column; },
    logEntry: async () => undefined,
    getTask: async () => task,
    walCheckpoint: () => ({ busy: 0, log: 0, checkpointed: 0 }),
    archiveTaskAndCleanup: async () => ({}),
    clearStaleExecutionStartBranchReferences: () => [],
    updateSettings: async () => settings,
    mergeTask: async () => undefined,
    getRootDir: () => "",
    recordRunAuditEvent: async (event: unknown) => { events.push(event); },
  }) as unknown as TaskStore & EventEmitter;
}

describe("landed-content soft-blocker reliability interactions (real git)", () => {
  it("auto-finalizes paused+failed in-review tasks once landed content is proven", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fn-4648-ri-"));
    try {
      git(dir, "git init -b main");
      git(dir, 'git config user.email "test@example.com"');
      git(dir, 'git config user.name "Test"');
      git(dir, "git commit --allow-empty -m init");

      git(dir, "git checkout -b fusion/fn-4648");
      writeFileSync(join(dir, "file.txt"), "task content\n");
      git(dir, "git add file.txt");
      git(dir, "git commit -m 'feat(FN-4648): task change' -m 'Fusion-Task-Id: FN-4648'");
      const taskCommit = git(dir, "git rev-parse HEAD");
      git(dir, "git checkout main");
      git(dir, `git cherry-pick ${taskCommit}`);

      const task = {
        id: "FN-4648",
        title: "t",
        description: "d",
        column: "in-review",
        paused: true,
        status: "failed",
        error: "stale failure",
        mergeRetries: 3,
        mergeDetails: undefined,
        branch: "fusion/fn-4648",
        baseBranch: "main",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as Task;
      const auditEvents: unknown[] = [];
      const store = makeStore(task, auditEvents);
      const manager = new SelfHealingManager(store, { rootDir: dir, getExecutingTaskIds: () => new Set() });

      const recovered = await manager.recoverAlreadyMergedReviewTasks();

      expect(recovered).toBe(1);
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

  it("keeps task in-review when landed content exists but hard blockers remain", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fn-4648-ri-hard-"));
    try {
      git(dir, "git init -b main");
      git(dir, 'git config user.email "test@example.com"');
      git(dir, 'git config user.name "Test"');
      git(dir, "git commit --allow-empty -m init");

      git(dir, "git checkout -b fusion/fn-4648-hard");
      writeFileSync(join(dir, "hard.txt"), "task content\n");
      git(dir, "git add hard.txt");
      git(dir, "git commit -m 'feat(FN-4648): hard blocker case' -m 'Fusion-Task-Id: FN-4648-HARD'");
      const taskCommit = git(dir, "git rev-parse HEAD");
      git(dir, "git checkout main");
      git(dir, `git cherry-pick ${taskCommit}`);

      const task = {
        id: "FN-4648-HARD",
        title: "t",
        description: "d",
        column: "in-review",
        paused: true,
        status: "failed",
        error: "stale failure",
        mergeRetries: 3,
        mergeDetails: undefined,
        branch: "fusion/fn-4648-hard",
        baseBranch: "main",
        dependencies: [],
        steps: [{ name: "Step 1", status: "pending" }],
        currentStep: 0,
        log: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as Task;
      const store = makeStore(task);
      const manager = new SelfHealingManager(store, { rootDir: dir, getExecutingTaskIds: () => new Set() });

      const recovered = await manager.recoverAlreadyMergedReviewTasks();

      expect(recovered).toBe(0);
      expect(task.column).toBe("in-review");
      expect(task.status).toBe("failed");
      expect(task.error).toContain("task has incomplete steps");
      manager.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
