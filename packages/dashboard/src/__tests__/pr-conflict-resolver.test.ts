// @vitest-environment node

import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Settings, Task, TaskStore } from "@fusion/core";

const { mockRunGitCommand, mockCreateResolvedAgentSession } = vi.hoisted(() => ({
  mockRunGitCommand: vi.fn(),
  mockCreateResolvedAgentSession: vi.fn(),
}));

vi.mock("../routes/resolve-diff-base.js", () => ({
  runGitCommand: mockRunGitCommand,
}));

vi.mock("@fusion/engine", () => ({
  createResolvedAgentSession: mockCreateResolvedAgentSession,
}));

import { resolvePrConflicts } from "../pr-conflict-resolver.js";

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-001",
    title: "Task",
    description: "desc",
    column: "in-review",
    status: "in-review",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    comments: [],
    ...overrides,
  } as Task;
}

function createStore(task: Task): TaskStore {
  return {
    getTask: vi.fn().mockResolvedValue(task),
    logEntry: vi.fn().mockResolvedValue(undefined),
  } as unknown as TaskStore;
}

const settings = {
  defaultProvider: "mock",
  defaultModelId: "scripted",
} as Settings;

async function createRootDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "fusion-pr-conflict-resolver-"));
}

describe("resolvePrConflicts", () => {
  const rootDirs: string[] = [];

  afterEach(async () => {
    vi.clearAllMocks();
    await Promise.all(rootDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("treats an already-merged base as resolved without making an empty commit", async () => {
    const rootDir = await createRootDir();
    rootDirs.push(rootDir);
    const store = createStore(createTask());
    mockRunGitCommand
      .mockResolvedValueOnce("") // worktree add
      .mockResolvedValueOnce("") // checkout task branch
      .mockResolvedValueOnce("Already up to date.\n") // merge --no-commit --no-ff base
      .mockResolvedValueOnce("") // add -A
      .mockResolvedValueOnce("") // diff --cached --quiet => empty index
      .mockResolvedValueOnce(""); // worktree remove

    const result = await resolvePrConflicts({
      taskId: "FN-001",
      baseRef: "main",
      rootDir,
      store,
      settings,
    });

    expect(result).toMatchObject({
      resolved: true,
      pushed: false,
      conflictedFiles: [],
    });
    expect(result.message).toContain("already merged");
    expect(mockRunGitCommand).not.toHaveBeenCalledWith(expect.arrayContaining(["commit"]), expect.anything(), expect.anything());
    expect(mockRunGitCommand).not.toHaveBeenCalledWith(expect.arrayContaining(["push"]), expect.anything(), expect.anything());
    expect(store.logEntry).toHaveBeenCalledWith("FN-001", "Skipped PR conflict-free merge commit", "main already merged into fusion/fn-001");
  });

  it("commits and pushes a conflict-free merge when staged changes exist", async () => {
    const rootDir = await createRootDir();
    rootDirs.push(rootDir);
    const store = createStore(createTask());
    mockRunGitCommand
      .mockResolvedValueOnce("") // worktree add
      .mockResolvedValueOnce("") // checkout task branch
      .mockResolvedValueOnce("") // merge --no-commit --no-ff base
      .mockResolvedValueOnce("") // add -A
      .mockRejectedValueOnce(Object.assign(new Error("diff has changes"), { code: 1 })) // diff --cached --quiet => staged changes
      .mockResolvedValueOnce("") // commit
      .mockResolvedValueOnce("") // push
      .mockResolvedValueOnce(""); // worktree remove

    const result = await resolvePrConflicts({
      taskId: "FN-001",
      baseRef: "main",
      rootDir,
      store,
      settings,
    });

    expect(result).toMatchObject({
      resolved: true,
      pushed: true,
      conflictedFiles: [],
    });
    expect(mockRunGitCommand).toHaveBeenCalledWith([
      "commit",
      "-m",
      "fix(FN-5949): merge main into FN-001",
      "-m",
      "Fusion-Task-Id: FN-001",
    ], expect.stringContaining("conflict-fn-001"), 60000);
    expect(mockRunGitCommand).toHaveBeenCalledWith(["push", "-u", "origin", "fusion/fn-001"], expect.stringContaining("conflict-fn-001"), 60000);
    expect(store.logEntry).toHaveBeenCalledWith("FN-001", "Pushed PR branch after conflict-free merge", "fusion/fn-001");
  });
});
