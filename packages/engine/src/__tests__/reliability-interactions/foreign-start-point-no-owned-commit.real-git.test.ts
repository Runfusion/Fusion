import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { EventEmitter } from "node:events";
import type { Settings, Task, TaskStore } from "@fusion/core";
import { aiMergeTask } from "../../merger.js";
import { SelfHealingManager } from "../../self-healing.js";

function git(dir: string, cmd: string): string {
  return execSync(cmd, { cwd: dir, stdio: "pipe" }).toString().trim();
}

function makeStore(task: Task, settings: Partial<Settings> = {}, events: unknown[] = []): TaskStore & EventEmitter {
  const emitter = new EventEmitter();
  const mergedSettings = {
    autoMerge: true,
    globalPause: false,
    enginePaused: false,
    mergeStrategy: "direct",
    directMergeCommitStrategy: "auto",
    includeTaskIdInCommit: false,
    commitAuthorEnabled: false,
    useAiMergeCommitSummary: false,
    mergeIntegrationWorktree: "cwd-main" as const,
    ...settings,
  } as Settings;
  return Object.assign(emitter, {
    getSettings: vi.fn(async () => mergedSettings),
    getTask: vi.fn(async () => task),
    listTasks: vi.fn(async ({ column }: { column?: string } = {}) => (column ? [task].filter((t) => t.column === column) : [task])),
    updateTask: vi.fn(async (_id: string, updates: Partial<Task>) => Object.assign(task, updates)),
    moveTask: vi.fn(async (_id: string, column: Task["column"]) => {
      task.column = column;
      return task;
    }),
    logEntry: vi.fn(async () => undefined),
    appendAgentLog: vi.fn(async () => undefined),
    updateSettings: vi.fn(async () => mergedSettings),
    clearStaleExecutionStartBranchReferences: vi.fn(() => []),
    recordRunAuditEvent: vi.fn(async (event: unknown) => {
      events.push(event);
    }),
    walCheckpoint: vi.fn(() => ({ busy: 0, log: 0, checkpointed: 0 })),
    archiveTaskAndCleanup: vi.fn(async () => ({})),
    mergeTask: vi.fn(async () => undefined),
    getRootDir: vi.fn(() => ""),
  }) as unknown as TaskStore & EventEmitter;
}

describe("foreign start-point no-owned-commit interactions (real git)", () => {
  it("merger no-op gate blocks done and auto-requeues to todo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fn-4656-ri-merge-"));
    try {
      git(dir, "git init -b main");
      git(dir, 'git config user.email "test@example.com"');
      git(dir, 'git config user.name "Test"');
      writeFileSync(join(dir, "README.md"), "init\n");
      git(dir, "git add README.md && git commit -m 'init'");

      git(dir, "git checkout -b fusion/fn-a");
      writeFileSync(join(dir, "foreign.txt"), "from fn-a\n");
      git(dir, "git add foreign.txt");
      git(dir, "git commit -m 'feat(FN-A): foreign' -m 'Fusion-Task-Id: FN-A'");
      const foreignBaseSha = git(dir, "git rev-parse HEAD");

      git(dir, "git checkout main");
      git(dir, "git checkout -b fusion/fn-b");
      git(dir, "git checkout main");

      const task = {
        id: "FN-B",
        title: "t",
        description: "d",
        column: "in-review",
        branch: "fusion/fn-b",
        baseBranch: "main",
        baseCommitSha: foreignBaseSha,
        modifiedFiles: ["foreign.txt"],
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as Task;
      const events: unknown[] = [];
      const store = makeStore(task, {}, events);

      const result = await aiMergeTask(store, dir, task.id);

      expect(result.merged).toBe(false);
      expect(task.column).toBe("todo");
      expect(events.some((event: any) => event?.mutationType === "task:finalize-unproven-blocked")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("self-healing no-op pass requeues unproven candidates to todo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fn-4656-ri-heal-"));
    try {
      git(dir, "git init -b main");
      git(dir, 'git config user.email "test@example.com"');
      git(dir, 'git config user.name "Test"');
      git(dir, "git commit --allow-empty -m init");

      git(dir, "git checkout -b fusion/fn-a");
      writeFileSync(join(dir, "foreign.txt"), "from fn-a\n");
      git(dir, "git add foreign.txt");
      git(dir, "git commit -m 'feat(FN-A): foreign' -m 'Fusion-Task-Id: FN-A'");
      const foreignBaseSha = git(dir, "git rev-parse HEAD");

      git(dir, "git checkout main");
      git(dir, "git checkout -b fusion/fn-b");
      git(dir, "git checkout main");

      const task = {
        id: "FN-B2",
        title: "t",
        description: "d",
        column: "in-review",
        branch: "fusion/fn-b",
        baseBranch: "main",
        baseCommitSha: foreignBaseSha,
        modifiedFiles: ["foreign.txt"],
        paused: false,
        status: undefined,
        worktree: `${dir}/.worktrees/fn-b2`,
        mergeDetails: undefined,
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as Task;
      const events: unknown[] = [];
      const store = makeStore(task, {}, events);
      const manager = new SelfHealingManager(store, { rootDir: dir });

      const recovered = await manager.finalizeNoOpReviewTasks();

      expect(recovered).toBe(0);
      expect(task.column).toBe("in-review");
      expect(events.some((event: any) => event?.mutationType === "task:finalize-no-op-review-no-action")).toBe(true);
      manager.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
