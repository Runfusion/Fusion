import { afterEach, describe, expect, it, vi } from "vitest";
import { execSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { Settings, Task, TaskStore } from "@fusion/core";
import { SelfHealingManager } from "../self-healing.js";

const hasGit = spawnSync("git", ["--version"], { stdio: "pipe" }).status === 0;
const describeIfGit = hasGit ? describe : describe.skip;

function git(repo: string, command: string): string {
  return execSync(command, { cwd: repo, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function parseShortstat(output: string): { filesChanged: number; insertions: number; deletions: number } {
  const normalized = output.trim().replace(/\n/g, " ");
  return {
    filesChanged: Number.parseInt(normalized.match(/(\d+) files? changed/)?.[1] ?? "0", 10),
    insertions: Number.parseInt(normalized.match(/(\d+) insertions?\(\+\)/)?.[1] ?? "0", 10),
    deletions: Number.parseInt(normalized.match(/(\d+) deletions?\(-\)/)?.[1] ?? "0", 10),
  };
}

function parseNameOnly(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function makeTask(id: string, repo: string, sha: string, mergeDetails: Task["mergeDetails"]): Task {
  return {
    id,
    title: id,
    description: id,
    column: "done",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    baseBranch: "main",
    worktree: repo,
    mergeDetails: { commitSha: sha, mergeConfirmed: true, mergeCommitMessage: "msg", ...mergeDetails },
  } as Task;
}

function createStore(tasks: Map<string, Task>): TaskStore & EventEmitter {
  const emitter = new EventEmitter();
  const settings = { globalPause: false, enginePaused: false, maintenanceIntervalMs: 0, taskStuckTimeoutMs: 60_000, autoMerge: false } as Settings;
  return Object.assign(emitter, {
    getSettings: vi.fn(async () => settings),
    listTasks: vi.fn(async ({ column }: { column?: string } = {}) => [...tasks.values()].filter((t) => !column || t.column === column)),
    getTask: vi.fn(async (id: string) => tasks.get(id)),
    updateTask: vi.fn(async (id: string, updates: Partial<Task>) => {
      const cur = tasks.get(id)!;
      const next = { ...cur, ...updates, mergeDetails: updates.mergeDetails ?? cur.mergeDetails, updatedAt: new Date().toISOString() } as Task;
      tasks.set(id, next);
      return next;
    }),
    logEntry: vi.fn(async (id: string, message: string) => {
      const cur = tasks.get(id)!;
      tasks.set(id, { ...cur, log: [...(cur.log ?? []), { timestamp: new Date().toISOString(), action: message }] as any });
    }),
    moveTask: vi.fn(),
    walCheckpoint: vi.fn(() => ({ busy: 0, log: 0, checkpointed: 0 })),
    clearStaleExecutionStartBranchReferences: vi.fn(() => []),
    updateSettings: vi.fn(),
    mergeTask: vi.fn(),
    getRootDir: vi.fn(() => ""),
    recordRunAuditEvent: vi.fn(),
  }) as unknown as TaskStore & EventEmitter;
}

describeIfGit("SelfHealingManager recoverDoneTaskMergeMetadata stale stats", () => {
  const repos: string[] = [];
  afterEach(() => {
    for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true });
  });

  function setupRepo() {
    const repo = mkdtempSync(path.join(os.tmpdir(), "fn-4526-"));
    repos.push(repo);
    git(repo, "git init -b main");
    git(repo, 'git config user.email "test@example.com"');
    git(repo, 'git config user.name "Test"');
    writeFileSync(path.join(repo, "a.ts"), "const a = 1;\n", "utf-8");
    writeFileSync(path.join(repo, "b.ts"), "const b = 1;\n", "utf-8");
    git(repo, "git add a.ts b.ts && git commit -m 'init'");
    writeFileSync(path.join(repo, "a.ts"), "const a = 2;\nconst c = 3;\n", "utf-8");
    writeFileSync(path.join(repo, "b.ts"), "const b = 2;\n", "utf-8");
    git(repo, "git add a.ts b.ts && git commit -m 'landed' -m 'Fusion-Task-Id: FN-4526-STATS'");
    return { repo, sha: git(repo, "git rev-parse HEAD") };
  }

  it("repairs stale confirmed stats from live shortstat without changing SHA", async () => {
    const { repo, sha } = setupRepo();
    const expected = parseShortstat(git(repo, `git show --shortstat --format= ${sha}`));
    const task = makeTask("FN-4526-STATS", repo, sha, { filesChanged: 99, insertions: 999, deletions: 999, landedFiles: ["a.ts", "b.ts", "c.ts"] });
    const tasks = new Map([[task.id, task]]);
    const store = createStore(tasks);
    const manager = new SelfHealingManager(store, { rootDir: repo, getExecutingTaskIds: () => new Set() });

    await manager.recoverDoneTaskMergeMetadata();

    const repaired = tasks.get(task.id)!;
    expect(repaired.mergeDetails?.commitSha).toBe(sha);
    expect(repaired.mergeDetails?.filesChanged).toBe(expected.filesChanged);
    expect(repaired.mergeDetails?.insertions).toBe(expected.insertions);
    expect(repaired.mergeDetails?.deletions).toBe(expected.deletions);
    expect((store.logEntry as any).mock.calls.some((call: any[]) => String(call[1]).includes("stale mergeDetails repaired"))).toBe(true);
  });

  it("FN-4646: repairs stale landed file snapshot and modifiedFiles from live commit", async () => {
    const { repo, sha } = setupRepo();
    const expected = parseShortstat(git(repo, `git show --shortstat --format= ${sha}`));
    const expectedFiles = parseNameOnly(git(repo, `git show --name-only --format= ${sha}`));
    const task = makeTask("FN-4526-STATS", repo, sha, {
      filesChanged: 99,
      insertions: 999,
      deletions: 999,
      landedFiles: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"],
    });
    task.modifiedFiles = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"];
    const tasks = new Map([[task.id, task]]);
    const store = createStore(tasks);
    const manager = new SelfHealingManager(store, { rootDir: repo, getExecutingTaskIds: () => new Set() });

    await manager.recoverDoneTaskMergeMetadata();

    const repaired = tasks.get(task.id)!;
    expect(repaired.mergeDetails?.landedFiles).toEqual(expectedFiles);
    expect(repaired.modifiedFiles).toEqual(expectedFiles);
    expect(repaired.mergeDetails?.filesChanged).toBe(expected.filesChanged);
    expect((store.logEntry as any).mock.calls.some((call: any[]) => String(call[1]).includes("files 5 → 2"))).toBe(true);
  });

  it("does not rewrite when stats are already correct", async () => {
    const { repo, sha } = setupRepo();
    const expected = parseShortstat(git(repo, `git show --shortstat --format= ${sha}`));
    const task = makeTask("FN-4526-STATS", repo, sha, { ...expected, landedFiles: parseNameOnly(git(repo, `git show --name-only --format= ${sha}`)) });
    const tasks = new Map([[task.id, task]]);
    const store = createStore(tasks);
    const manager = new SelfHealingManager(store, { rootDir: repo, getExecutingTaskIds: () => new Set() });

    await manager.recoverDoneTaskMergeMetadata();

    expect((store.updateTask as any).mock.calls).toHaveLength(0);
  });

  it("repairs stale stats in unconfirmed branch when SHA matches landed commit", async () => {
    const { repo, sha } = setupRepo();
    const expected = parseShortstat(git(repo, `git show --shortstat --format= ${sha}`));
    const task = makeTask("FN-4526-STATS", repo, sha, { filesChanged: 777, insertions: 888, deletions: 999, mergeConfirmed: false });
    const tasks = new Map([[task.id, task]]);
    const store = createStore(tasks);
    const manager = new SelfHealingManager(store, { rootDir: repo, getExecutingTaskIds: () => new Set() });

    await manager.recoverDoneTaskMergeMetadata();

    const repaired = tasks.get(task.id)!;
    expect(repaired.mergeDetails?.commitSha).toBe(sha);
    expect(repaired.mergeDetails?.filesChanged).toBe(expected.filesChanged);
    expect(repaired.mergeDetails?.insertions).toBe(expected.insertions);
    expect(repaired.mergeDetails?.deletions).toBe(expected.deletions);
    expect(repaired.mergeDetails?.mergeConfirmed).toBe(true);
  });
});
