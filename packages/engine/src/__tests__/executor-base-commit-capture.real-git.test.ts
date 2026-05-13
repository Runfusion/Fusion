import { afterEach, describe, expect, it, vi } from "vitest";
import { execSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { Task, TaskStore } from "@fusion/core";
import { TaskExecutor } from "../executor.js";

const hasGit = spawnSync("git", ["--version"], { stdio: "pipe" }).status === 0;
const describeIfGit = hasGit ? describe : describe.skip;

function git(repo: string, command: string): string {
  return execSync(command, { cwd: repo, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function createStore(): TaskStore & EventEmitter {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    updateTask: vi.fn().mockResolvedValue(undefined),
    on: emitter.on.bind(emitter),
  }) as unknown as TaskStore & EventEmitter;
}

function makeTask(baseCommitSha?: string): Task {
  return {
    id: "FN-TEST-4383",
    title: "Test",
    description: "Test",
    column: "in-progress",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...(baseCommitSha ? { baseCommitSha } : {}),
  } as Task;
}

describeIfGit("captureBaseCommitSha (real git)", () => {
  const repos: string[] = [];

  afterEach(() => {
    for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true });
  });

  it("FN-4309/FN-4383: preserves baseCommitSha across sessions and keeps commit distance", async () => {
    const repo = mkdtempSync(path.join(os.tmpdir(), "fn-4383-"));
    repos.push(repo);
    git(repo, "git init -b main");
    git(repo, 'git config user.email "test@example.com"');
    git(repo, 'git config user.name "Test"');

    writeFileSync(path.join(repo, "file.txt"), "init\n", "utf-8");
    git(repo, "git add file.txt && git commit -m 'init'");

    git(repo, "git checkout -b fusion/fn-test-4383");
    for (let i = 1; i <= 17; i += 1) {
      writeFileSync(path.join(repo, `branch-${i}.txt`), `branch ${i}\n`, "utf-8");
      git(repo, `git add branch-${i}.txt && git commit -m 'branch ${i}'`);
    }

    const store = createStore();
    const executor = new TaskExecutor(store, repo);
    const audit = { git: vi.fn().mockResolvedValue(undefined) };

    await (executor as any).captureBaseCommitSha(makeTask(), repo, audit);
    const firstBase = (store.updateTask as any).mock.calls[0][1].baseCommitSha as string;
    expect(firstBase).toBeTruthy();

    writeFileSync(path.join(repo, "branch-18.txt"), "branch 18\n", "utf-8");
    git(repo, "git add branch-18.txt && git commit -m 'branch 18'");

    await (executor as any).captureBaseCommitSha(makeTask(firstBase), repo, audit);

    expect((store.updateTask as any).mock.calls).toHaveLength(1);

    const distance = Number(git(repo, `git rev-list --count ${firstBase}..HEAD`));
    expect(distance).toBeGreaterThan(0);
  });
});
