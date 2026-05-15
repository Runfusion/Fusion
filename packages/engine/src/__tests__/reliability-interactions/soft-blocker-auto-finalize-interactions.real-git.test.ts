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

function makeStore(task: Task, events: unknown[] = [], settings?: Partial<Settings>): TaskStore & EventEmitter {
  const emitter = new EventEmitter();
  const baseSettings = { globalPause: false, enginePaused: false, ...settings } as Settings;
  return Object.assign(emitter, {
    getSettings: async () => baseSettings,
    listTasks: async ({ column }: { column?: string } = {}) => (column ? [task].filter((t) => t.column === column) : [task]),
    updateTask: async (_id: string, updates: Partial<Task>) => Object.assign(task, updates),
    moveTask: async (_id: string, column: Task["column"]) => {
      task.column = column;
    },
    logEntry: async () => undefined,
    getTask: async () => task,
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
      const store = makeStore(task, auditEvents);
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
});
