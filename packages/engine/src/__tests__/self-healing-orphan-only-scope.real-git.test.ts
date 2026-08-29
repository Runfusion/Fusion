import { afterEach, describe, expect, it, vi } from "vitest";
import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { Settings, Task, TaskStore, AgentLogEntry } from "@fusion/core";
import { SelfHealingManager } from "../self-healing.js";

const hasGit = spawnSync("git", ["--version"], { stdio: "pipe" }).status === 0;
const describeIfGit = hasGit ? describe : describe.skip;

function git(repo: string, command: string): string {
  return execSync(command, { cwd: repo, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

type TaskMap = Map<string, Task>;

function makeTask(overrides: Partial<Task> & Pick<Task, "id">): Task {
  const { id, ...rest } = overrides;
  return {
    id,
    title: id,
    description: id,
    column: "in-review",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...rest,
  } as Task;
}

function createStore(tasks: TaskMap, logsByTask: Map<string, AgentLogEntry[]>): TaskStore & EventEmitter {
  const emitter = new EventEmitter();
  const settings: Settings = { globalPause: false, enginePaused: false, maintenanceIntervalMs: 0 } as Settings;
  return Object.assign(emitter, {
    getSettings: vi.fn(async () => settings),
    listTasks: vi.fn(async ({ column }: { column?: string } = {}) => [...tasks.values()].filter((t) => !column || t.column === column)),
    updateTask: vi.fn(async (id: string, updates: Partial<Task>) => {
      const current = tasks.get(id)!;
      tasks.set(id, { ...current, ...updates, updatedAt: new Date().toISOString() } as Task);
      return tasks.get(id);
    }),
    moveTask: vi.fn(async (id: string, column: Task["column"]) => {
      const current = tasks.get(id)!;
      tasks.set(id, { ...current, column, updatedAt: new Date().toISOString() } as Task);
    }),
    logEntry: vi.fn(async (id: string, action: string) => {
      const current = tasks.get(id)!;
      tasks.set(id, { ...current, log: [...(current.log ?? []), { timestamp: new Date().toISOString(), action }] as any } as Task);
    }),
    getAgentLogs: vi.fn(async (taskId: string) => logsByTask.get(taskId) ?? []),
    walCheckpoint: vi.fn(() => ({ busy: 0, log: 0, checkpointed: 0 })),
    archiveTaskAndCleanup: vi.fn(async () => ({})),
    clearStaleExecutionStartBranchReferences: vi.fn(() => []),
    getTask: vi.fn(async (id: string) => tasks.get(id)),
    updateSettings: vi.fn(async () => settings),
    mergeTask: vi.fn(async () => undefined),
    getRootDir: vi.fn(() => ""),
  }) as unknown as TaskStore & EventEmitter;
}

describeIfGit("recoverOrphanOnlyScopeViolations (real git)", () => {
  const repos: string[] = [];

  afterEach(() => {
    for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true });
  });

  function setupRepo(): string {
    const repo = mkdtempSync(path.join(os.tmpdir(), "fn-4379-"));
    repos.push(repo);
    git(repo, "git init -b main");
    git(repo, 'git config user.email "test@example.com"');
    git(repo, 'git config user.name "Test"');
    git(repo, "git commit --allow-empty -m 'init'");
    return repo;
  }

  it("finalizes orphan-only scope violation as no-op when task work is already on main (FN-4350)", async () => {
    const repo = setupRepo();
    mkdirSync(path.join(repo, "packages/dashboard/app/components"), { recursive: true });
    writeFileSync(path.join(repo, "packages/dashboard/app/components/QuickChatFAB.tsx"), "export const QuickChatFAB = () => null;\n", "utf-8");
    git(repo, "git add packages/dashboard/app/components/QuickChatFAB.tsx && git commit -m 'landed task work' -m 'Fusion-Task-Id: FN-TEST-4379'");
    const landedSha = git(repo, "git rev-parse HEAD");

    const worktreePath = path.join(repo, ".worktrees", "fn-test-4379");
    mkdirSync(path.dirname(worktreePath), { recursive: true });
    git(repo, `git worktree add ${JSON.stringify(worktreePath)} -b fusion/fn-test-4379`);
    mkdirSync(path.join(worktreePath, "packages/dashboard/app/components/__tests__"), { recursive: true });
    writeFileSync(path.join(worktreePath, "packages/dashboard/app/components/__tests__/QuickChatFAB.test.tsx"), "test('orphan', () => {});\n", "utf-8");

    const task = makeTask({
      id: "FN-TEST-4379",
      status: "failed",
      paused: false,
      scopeOverride: false,
      baseBranch: "main",
      branch: "fusion/fn-test-4379",
      worktree: worktreePath,
      error: "File-scope invariant violation for FN-TEST-4379: staged files [packages/dashboard/app/components/__tests__/QuickChatFAB.test.tsx] have zero overlap with declared File Scope [packages/dashboard/app/components/QuickChatFAB.tsx]. Refile genuinely out-of-scope work as a follow-up task via fn_task_create before retrying this merge.",
    });
    const tasks: TaskMap = new Map([[task.id, task]]);
    const logsByTask = new Map<string, AgentLogEntry[]>([[
      task.id,
      [{
        timestamp: new Date().toISOString(),
        taskId: task.id,
        type: "tool_error",
        text: "FileScopeViolationError",
        detail: [
          `taskId: ${task.id}`,
          "declaredScope:",
          "- packages/dashboard/app/components/QuickChatFAB.tsx",
          "stagedFiles:",
          "- packages/dashboard/app/components/__tests__/QuickChatFAB.test.tsx",
        ].join("\n"),
      }],
    ]]);

    const store = createStore(tasks, logsByTask);
    const manager = new SelfHealingManager(store, { rootDir: repo, getExecutingTaskIds: () => new Set() });

    const recovered = await manager.recoverOrphanOnlyScopeViolations();

    expect(recovered).toBe(1);
    const updated = tasks.get(task.id)!;
    expect(updated.column).toBe("done");
    expect(updated.status).toBeNull();
    expect(updated.mergeDetails?.commitSha).toBe(landedSha);
    expect(updated.mergeDetails?.mergeConfirmed).toBe(true);
    expect(updated.mergeDetails?.resolutionStrategy).toBe("orphan-discard-no-op");
    expect(existsSync(worktreePath)).toBe(false);
    expect(git(repo, "git log --oneline -- packages/dashboard/app/components/__tests__/QuickChatFAB.test.tsx")).toBe("");
  }, 20000);
});
