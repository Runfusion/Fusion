import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { EventEmitter } from "node:events";
import type { Settings, Task, TaskStore } from "@fusion/core";
import { classifyOwnedLandedEvidence } from "../../merger.js";
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
    baseBranch: "main",
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

describe("done-task verification benign integrity reconcile (real git)", () => {
  it("suppresses unproven warning for no-branch verification-only shape", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fn-4700-ri-benign-"));
    try {
      git(dir, "git init -b main");
      git(dir, 'git config user.email "test@example.com"');
      git(dir, 'git config user.name "Test"');
      git(dir, "git commit --allow-empty -m init");
      const baseSha = git(dir, "git rev-parse HEAD");

      const task = {
        id: "FN-VERIFY",
        title: "verification",
        description: "verification",
        column: "done",
        baseBranch: "main",
        baseCommitSha: baseSha,
        modifiedFiles: ["some/file.ts"],
        mergeDetails: {},
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as Task;

      const classification = await classifyOwnedLandedEvidence(dir, task, { mergeTargetBranch: "main" });
      expect(classification.kind).toBe("no-changes-finalized");

      const events: unknown[] = [];
      const store = makeStore(task, {}, events);
      const manager = new SelfHealingManager(store, { rootDir: dir });

      const reconciled = await manager.reconcileDoneTaskIntegrity();

      expect(reconciled).toBe(1);
      expect(task.modifiedFiles).toEqual([]);
      const logCalls = (store.logEntry as ReturnType<typeof vi.fn>).mock.calls;
      expect(logCalls.some((call) => /done-task finalize evidence is unproven/.test(String(call[1] ?? "")))).toBe(false);
      expect(events.some((event: any) => event?.mutationType === "task:integrity-reconcile-modified-files" && event?.metadata?.reason === "verification-only-finalize")).toBe(true);
      manager.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps warning path when branch exists with foreign-only deltas", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fn-4700-ri-foreign-"));
    try {
      git(dir, "git init -b main");
      git(dir, 'git config user.email "test@example.com"');
      git(dir, 'git config user.name "Test"');
      git(dir, "git commit --allow-empty -m init");

      git(dir, "git checkout -b fusion/fn-verify-foreign");
      writeFileSync(join(dir, "foreign.txt"), "from foreign\n");
      git(dir, "git add foreign.txt");
      git(dir, "git commit -m 'feat(FN-OTHER): foreign' -m 'Fusion-Task-Id: FN-OTHER'");
      git(dir, "git checkout main");

      const task = {
        id: "FN-VERIFY-FOREIGN",
        title: "verification",
        description: "verification",
        column: "done",
        branch: "fusion/fn-verify-foreign",
        baseBranch: "main",
        modifiedFiles: ["some/file.ts"],
        mergeDetails: {},
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

      const reconciled = await manager.reconcileDoneTaskIntegrity();

      expect(reconciled).toBe(0);
      const logCalls = (store.logEntry as ReturnType<typeof vi.fn>).mock.calls;
      expect(logCalls.some((call) => /done-task finalize evidence is unproven/.test(String(call[1] ?? "")))).toBe(true);
      expect(events.some((event: any) => event?.mutationType === "task:integrity-warning" && event?.metadata?.reason === "no-owned-commit-foreign-deltas")).toBe(true);
      manager.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still reconciles owned-commit by restoring commitSha", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fn-4700-ri-owned-"));
    try {
      git(dir, "git init -b main");
      git(dir, 'git config user.email "test@example.com"');
      git(dir, 'git config user.name "Test"');
      git(dir, "git commit --allow-empty -m init");

      git(dir, "git checkout -b fusion/fn-owned");
      writeFileSync(join(dir, "owned.txt"), "owned\n");
      git(dir, "git add owned.txt");
      git(dir, "git commit -m 'feat(FN-OWNED): change' -m 'Fusion-Task-Id: FN-OWNED'");
      const ownedSha = git(dir, "git rev-parse HEAD");
      git(dir, "git checkout main");
      git(dir, `git cherry-pick ${ownedSha}`);

      const task = {
        id: "FN-OWNED",
        title: "owned",
        description: "owned",
        column: "done",
        branch: "fusion/fn-owned",
        baseBranch: "main",
        modifiedFiles: ["owned.txt"],
        mergeDetails: {},
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

      const reconciled = await manager.reconcileDoneTaskIntegrity();

      expect(reconciled).toBe(1);
      expect(task.mergeDetails?.commitSha).toBeTruthy();
      const logCalls = (store.logEntry as ReturnType<typeof vi.fn>).mock.calls;
      expect(logCalls.some((call) => /done-task finalize evidence is unproven/.test(String(call[1] ?? "")))).toBe(false);
      expect(events.some((event: any) => event?.mutationType === "task:integrity-reconcile-modified-files" && event?.metadata?.reason === "recovered-owned-commit")).toBe(true);
      manager.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
