/*
 * Surface enumeration: this covers the engine git-evidence surface; no desktop/mobile UI applies.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { execSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Settings, Task, TaskStore } from "@fusion/core";
import { EventEmitter } from "node:events";
import { SelfHealingManager } from "../self-healing.js";

const describeIfGit = spawnSync("git", ["--version"], { stdio: "pipe" }).status === 0 ? describe : describe.skip;
const git = (cwd: string, command: string) => execSync(command, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();

type TaskMap = Map<string, Task>;

function makeTask(overrides: Partial<Task> & Pick<Task, "id">): Task {
  return {
    id: overrides.id, title: overrides.id, description: overrides.id, column: "in-review",
    dependencies: [], steps: [], currentStep: 0, log: [],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...overrides,
  } as Task;
}

function createStore(tasks: TaskMap): TaskStore & EventEmitter {
  const emitter = new EventEmitter();
  const settings = { globalPause: false, enginePaused: false, autoMerge: true, taskStuckTimeoutMs: 60_000 } as Settings;
  return Object.assign(emitter, {
    getSettings: vi.fn(async () => settings),
    getTask: vi.fn(async (id: string) => tasks.get(id)),
    listTasks: vi.fn(async ({ column }: { column?: string } = {}) => [...tasks.values()].filter((task) => !column || task.column === column)),
    updateTask: vi.fn(async (id: string, patch: Partial<Task>) => {
      const next = { ...tasks.get(id)!, ...patch, updatedAt: new Date().toISOString() } as Task;
      tasks.set(id, next); return next;
    }),
    updateTaskAtomic: vi.fn(async (id: string, updater: (task: Task) => Partial<Task> | null) => {
      const patch = updater(tasks.get(id)!);
      if (!patch) return null;
      const next = { ...tasks.get(id)!, ...patch, updatedAt: new Date().toISOString() } as Task;
      tasks.set(id, next); return next;
    }),
    moveTask: vi.fn(async (id: string, column: string) => {
      tasks.set(id, { ...tasks.get(id)!, column, updatedAt: new Date().toISOString() } as Task);
    }),
    logEntry: vi.fn(async () => undefined),
    recordRunAuditEvent: vi.fn(async () => undefined),
  }) as unknown as TaskStore & EventEmitter;
}

describeIfGit("absent branch git evidence", () => {
  const repos: string[] = [];
  afterEach(() => repos.splice(0).forEach((repo) => rmSync(repo, { recursive: true, force: true })));

  it("refuses every canonical active merge status before evidence lookup", async () => {
    for (const status of ["reviewing", "landing"] as const) {
      const task = {
        id: `FN-TEST-${status}`,
        title: "Active merger",
        description: "Active merger",
        column: "in-review",
        branch: "fusion/fn-test-active",
        status,
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as Task;
      const updateTask = vi.fn();
      const store = {
        getTask: vi.fn(async () => task),
        getSettings: vi.fn(async () => ({ globalPause: false, enginePaused: false, autoMerge: true })),
        updateTask,
      } as unknown as TaskStore;
      const manager = new SelfHealingManager(store, { rootDir: process.cwd() });

      await expect(manager.reconcileLandedReviewTask(task.id, { source: "manual" })).resolves.toEqual({
        outcome: "ineligible",
        reason: "executing",
      });
      expect(updateTask).not.toHaveBeenCalled();
    }
  });

  it("reconciles a proven deleted branch through the sweep without rev-parse warning", async () => {
    const repo = mkdtempSync(path.join(os.tmpdir(), "fn-9304-"));
    repos.push(repo);
    git(repo, "git init -b main && git config user.email test@example.com && git config user.name Test");
    writeFileSync(path.join(repo, "file.txt"), "base\n");
    git(repo, "git add . && git commit -m base");
    writeFileSync(path.join(repo, "file.txt"), "landed\n");
    git(repo, "git add . && git commit -m landed -m 'Fusion-Task-Id: FN-TEST-SWEEP'");
    const sha = git(repo, "git rev-parse HEAD");
    git(repo, "git branch fusion/fn-test-sweep && git branch -D fusion/fn-test-sweep");
    const tasks: TaskMap = new Map([["FN-TEST-SWEEP", makeTask({ id: "FN-TEST-SWEEP", branch: "fusion/fn-test-sweep", baseBranch: "main", status: null })]]);
    const store = createStore(tasks);
    const manager = new SelfHealingManager(store, { rootDir: repo, getExecutingTaskIds: () => new Set() });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await manager.recoverBranchMisboundInReviewTasks();
    await manager.recoverBranchMisboundInReviewTasks();

    expect(tasks.get("FN-TEST-SWEEP")).toMatchObject({ column: "done", branch: null, mergeDetails: { mergeConfirmed: true, commitSha: sha } });
    expect((store as any).recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ mutationType: "task:reconcile-absent-branch-landed" }));
    expect(warn.mock.calls.flat().join(" ")).not.toMatch(/rev-parse|unknown revision/);
    warn.mockRestore();
  });

  it("leaves an unproven deleted branch in review and emits one no-action audit", async () => {
    const repo = mkdtempSync(path.join(os.tmpdir(), "fn-9304-"));
    repos.push(repo);
    git(repo, "git init -b main && git config user.email test@example.com && git config user.name Test && git commit --allow-empty -m base");
    git(repo, "git branch fusion/fn-test-unproven && git branch -D fusion/fn-test-unproven");
    const tasks: TaskMap = new Map([["FN-TEST-UNPROVEN", makeTask({ id: "FN-TEST-UNPROVEN", branch: "fusion/fn-test-unproven", baseBranch: "main", status: null })]]);
    const store = createStore(tasks);
    const manager = new SelfHealingManager(store, { rootDir: repo, getExecutingTaskIds: () => new Set() });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await manager.recoverBranchMisboundInReviewTasks();
    await manager.recoverBranchMisboundInReviewTasks();

    expect(tasks.get("FN-TEST-UNPROVEN")?.column).toBe("in-review");
    expect((store as any).recordRunAuditEvent).toHaveBeenCalledTimes(1);
    expect((store as any).recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ mutationType: "task:reconcile-absent-branch-unproven" }));
    expect(warn.mock.calls.flat().join(" ")).not.toMatch(/rev-parse|unknown revision/);
    warn.mockRestore();
  });

  it("classifies a deleted branch and retains base trailer proof", async () => {
    const repo = mkdtempSync(path.join(os.tmpdir(), "fn-9304-"));
    repos.push(repo);
    git(repo, "git init -b main && git config user.email test@example.com && git config user.name Test");
    writeFileSync(path.join(repo, "file.txt"), "base\n");
    git(repo, "git add . && git commit -m base");
    writeFileSync(path.join(repo, "file.txt"), "landed\n");
    git(repo, "git add . && git commit -m landed -m 'Fusion-Task-Id: FN-TEST-ABSENT'");
    const sha = git(repo, "git rev-parse HEAD");
    git(repo, "git branch fusion/fn-test-absent && git branch -D fusion/fn-test-absent");

    const manager = new SelfHealingManager({} as TaskStore, { rootDir: repo });
    const result = await (manager as any).isBranchTipMisboundToTask({ branch: "fusion/fn-test-absent", taskId: "FN-TEST-ABSENT", baseBranch: "main" });
    expect(result).toMatchObject({ branchMissing: true, misbound: false, branchTip: "", landed: { sha } });
  });
});
