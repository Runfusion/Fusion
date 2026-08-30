// @vitest-environment node
import { execFile } from "node:child_process";
import express from "express";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Task, TaskStore } from "@fusion/core";
import { buildBootstrapPrompt } from "@fusion/core";
import { describe, expect, it, vi } from "vitest";

import { inspectBareBranchCollision } from "../../../engine/src/execution/branch-conflicts.js";
import { createApiRoutes } from "../routes.js";
import { request as performRequest } from "../test-request.js";

const execFileAsync = promisify(execFile);
const taskId = "FN-400";
const taskBranch = "fusion/fn-400";

const WORKFLOW_IR = {
  version: "v2",
  name: "Reset branch cleanup",
  columns: [
    { id: "triage", name: "Planning", traits: [{ trait: "intake" }] },
    { id: "in-progress", name: "In progress", traits: [{ trait: "wip" }] },
  ],
  nodes: [{ id: "start", kind: "start", column: "triage" }],
  edges: [],
};

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return result.stdout.trim();
}

async function branchExists(root: string, branch: string): Promise<boolean> {
  try {
    await git(root, "rev-parse", "--verify", `refs/heads/${branch}`);
    return true;
  } catch {
    return false;
  }
}

async function createRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "fusion-reset-branch-real-git-"));
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.email", "reset@example.com");
  await git(root, "config", "user.name", "Reset Test");
  await writeFile(join(root, "base.txt"), "base\n");
  await git(root, "add", "base.txt");
  await git(root, "commit", "-m", "initial");
  return root;
}

async function addTaskWorktree(root: string, path = join(root, ".worktrees", "fn-400")): Promise<string> {
  await mkdir(join(root, ".worktrees"), { recursive: true });
  await git(root, "worktree", "add", "-b", taskBranch, path, "main");
  await writeFile(join(path, "task.txt"), "task work\n");
  await git(path, "add", "task.txt");
  await git(path, "commit", "-m", "task work", "-m", `Fusion-Task-Id: ${taskId}`);
  return path;
}

async function writePrompt(root: string): Promise<string> {
  const taskDir = join(root, ".fusion", "tasks", taskId);
  await mkdir(taskDir, { recursive: true });
  const prompt = join(taskDir, "PROMPT.md");
  await writeFile(prompt, "# Existing plan\n");
  return prompt;
}

function taskFixture(overrides: Partial<Task> = {}): Task {
  return {
    id: taskId,
    title: "Reset branch fixture",
    description: "Discard all local work",
    column: "in-progress",
    status: "failed",
    dependencies: [],
    steps: [{ name: "Implement", status: "done" }],
    currentStep: 0,
    branch: taskBranch,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Task;
}

function createStore(root: string, task: Task) {
  const publication = vi.fn(async (_id: string, intake: string) => ({
    ...task,
    column: intake,
    status: undefined,
    worktree: undefined,
    branch: undefined,
    steps: [],
    currentStep: 0,
  }));
  const store = {
    getRootDir: vi.fn().mockReturnValue(root),
    getSettings: vi.fn().mockResolvedValue({ worktreesDir: ".worktrees" }),
    getTask: vi.fn().mockResolvedValue(task),
    listTasks: vi.fn().mockResolvedValue([task]),
    withPlanningLifecycleLock: vi.fn(async (_id: string, callback: () => Promise<Task>) => callback()),
    getTaskWorkflowSelectionAsync: vi.fn().mockResolvedValue({ workflowId: "wf-reset" }),
    getWorkflowDefinition: vi.fn().mockResolvedValue({ id: "wf-reset", name: "Reset", ir: WORKFLOW_IR }),
    resetTaskPublication: publication,
    logEntry: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    off: vi.fn(),
    getProjectScopedPluginMcpServers: vi.fn().mockResolvedValue([]),
  } as unknown as TaskStore;
  return { store, publication };
}

function app(store: TaskStore) {
  const instance = express();
  instance.use(express.json());
  instance.use("/api", createApiRoutes(store));
  return instance;
}

async function reset(store: TaskStore) {
  return performRequest(app(store), "POST", `/api/tasks/${taskId}/reset`, JSON.stringify({ confirm: true }), { "content-type": "application/json" });
}

async function collision(root: string, conflictingWorktreePath: string) {
  return inspectBareBranchCollision({
    repoDir: root,
    branchName: taskBranch,
    requestingTaskId: taskId,
    conflictingWorktreePath,
    startPoint: "main",
    integrationRef: "main",
  });
}

describe("POST /api/tasks/:id/reset branch cleanup with real git", () => {
  it("deletes committed task work so the next acquisition sees a missing branch", async () => {
    const root = await createRepo();
    const worktree = await addTaskWorktree(root);
    const prompt = await writePrompt(root);
    const task = taskFixture({ worktree });
    const { store, publication } = createStore(root, task);

    expect((await collision(root, worktree)).kind).toBe("live-foreign");
    const response = await reset(store);

    expect(response.status).toBe(200);
    expect(await branchExists(root, taskBranch)).toBe(false);
    expect(await collision(root, worktree)).toEqual({ kind: "missing" });
    expect(existsSync(worktree)).toBe(false);
    await expect(readFile(prompt, "utf8")).resolves.toBe(buildBootstrapPrompt(task.id, task.title, task.description));
    expect(publication).toHaveBeenCalledOnce();
    expect(store.logEntry).toHaveBeenCalledWith(taskId, expect.stringContaining(`Reset deleted task branches: ${taskBranch}`));
  });

  it("deletes a leftover canonical branch when the task records no worktree or branch", async () => {
    const root = await createRepo();
    const worktree = await addTaskWorktree(root);
    await git(root, "worktree", "remove", worktree);
    await writePrompt(root);
    const { store } = createStore(root, taskFixture({ worktree: undefined, branch: undefined }));

    expect((await reset(store)).status).toBe(200);
    expect(await branchExists(root, taskBranch)).toBe(false);
  });

  it("removes a canonical registered worktree after a user reopen clears its row pointer", async () => {
    const root = await createRepo();
    const worktree = await addTaskWorktree(root);
    const prompt = await writePrompt(root);
    const task = taskFixture({ worktree: undefined });
    const { store, publication } = createStore(root, task);

    const response = await reset(store);

    expect(response.status).toBe(200);
    expect(existsSync(worktree)).toBe(false);
    expect(await branchExists(root, taskBranch)).toBe(false);
    expect(await collision(root, worktree)).toEqual({ kind: "missing" });
    await expect(readFile(prompt, "utf8")).resolves.toBe(buildBootstrapPrompt(task.id, task.title, task.description));
    expect(publication).toHaveBeenCalledOnce();
  });

  it("accepts a registered canonical worktree when its recorded branch is absent", async () => {
    const root = await createRepo();
    const worktree = await addTaskWorktree(root);
    await writePrompt(root);
    const task = taskFixture({ worktree: undefined, branch: undefined });
    const { store, publication } = createStore(root, task);

    const response = await reset(store);

    expect(response.status).toBe(200);
    expect(existsSync(worktree)).toBe(false);
    expect(await branchExists(root, taskBranch)).toBe(false);
    expect(publication).toHaveBeenCalledOnce();
    expect(store.logEntry).toHaveBeenCalledWith(taskId, `Reset recovered canonical worktree ownership at ${worktree}`);
  });

  it("deletes foreach step-instance branches with the working branch", async () => {
    const root = await createRepo();
    const worktree = await addTaskWorktree(root);
    await git(root, "branch", `${taskBranch}-step-0`, "main");
    await git(root, "branch", `${taskBranch}-step-1`, "main");
    await writePrompt(root);
    const { store } = createStore(root, taskFixture({ worktree }));

    expect((await reset(store)).status).toBe(200);
    await expect(Promise.all([taskBranch, `${taskBranch}-step-0`, `${taskBranch}-step-1`].map((branch) => branchExists(root, branch)))).resolves.toEqual([false, false, false]);
  });

  it("retains an operator-supplied branch non-blockingly and logs the reason", async () => {
    const root = await createRepo();
    const worktree = await addTaskWorktree(root);
    await writePrompt(root);
    const task = taskFixture({
      worktree,
      branchContext: { branchOverride: { by: "operator", at: "2026-08-28T00:00:00.000Z", branch: taskBranch } },
    });
    const { store } = createStore(root, task);

    expect((await reset(store)).status).toBe(200);
    expect(await branchExists(root, taskBranch)).toBe(true);
    expect(store.logEntry).toHaveBeenCalledWith(taskId, expect.stringContaining(`${taskBranch} [operator-supplied]`));
  });

  it("never deletes an unrelated local branch", async () => {
    const root = await createRepo();
    const worktree = await addTaskWorktree(root);
    await git(root, "branch", "operator/keep-me", "main");
    await writePrompt(root);
    const { store } = createStore(root, taskFixture({ worktree }));

    expect((await reset(store)).status).toBe(200);
    expect(await branchExists(root, "operator/keep-me")).toBe(true);
  });

  it("fails closed while a foreign worktree holds the task branch", async () => {
    const root = await createRepo();
    const holder = await addTaskWorktree(root, join(root, ".worktrees", "fn-400-stale"));
    const prompt = await writePrompt(root);
    const task = taskFixture({ worktree: undefined });
    const { store, publication } = createStore(root, task);

    const response = await reset(store);
    expect(response.status).toBe(409);
    expect(response.body.error).toContain(taskBranch);
    expect(response.body.error).toContain(holder);
    expect(await branchExists(root, taskBranch)).toBe(true);
    expect((await collision(root, holder)).kind).toBe("live-foreign");
    expect(existsSync(prompt)).toBe(true);
    expect(existsSync(holder)).toBe(true);
    expect(publication).not.toHaveBeenCalled();
  });

  it("succeeds when the foreign holder is removed and Reset is retried", async () => {
    const root = await createRepo();
    const holder = await addTaskWorktree(root, join(root, ".worktrees", "fn-400-stale"));
    const prompt = await writePrompt(root);
    const task = taskFixture({ worktree: undefined });
    const { store, publication } = createStore(root, task);

    expect((await reset(store)).status).toBe(409);
    await git(root, "worktree", "remove", holder);
    expect((await reset(store)).status).toBe(200);
    expect(await branchExists(root, taskBranch)).toBe(false);
    expect(await collision(root, holder)).toEqual({ kind: "missing" });
    await expect(readFile(prompt, "utf8")).resolves.toBe(buildBootstrapPrompt(task.id, task.title, task.description));
    expect(publication).toHaveBeenCalledOnce();
  });

  it("resets an already-absent recorded worktree while preserving the existing-directory ownership proof", async () => {
    const root = await createRepo();
    const worktree = await addTaskWorktree(root);
    const prompt = await writePrompt(root);
    const staleTask = taskFixture({ worktree });
    await rm(worktree, { recursive: true, force: true });
    await git(root, "worktree", "prune");
    const stale = createStore(root, staleTask);

    expect((await reset(stale.store)).status).toBe(200);
    expect(await branchExists(root, taskBranch)).toBe(false);
    expect(await collision(root, worktree)).toEqual({ kind: "missing" });
    await expect(readFile(prompt, "utf8")).resolves.toBe(buildBootstrapPrompt(staleTask.id, staleTask.title, staleTask.description));
    expect(stale.publication).toHaveBeenCalledOnce();

    const guardedRoot = await createRepo();
    const guardedWorktree = await addTaskWorktree(guardedRoot);
    await rm(guardedWorktree, { recursive: true, force: true });
    await git(guardedRoot, "worktree", "prune");
    await mkdir(guardedWorktree, { recursive: true });
    const guardedPrompt = await writePrompt(guardedRoot);
    const guarded = createStore(guardedRoot, taskFixture({ worktree: guardedWorktree }));
    const refused = await reset(guarded.store);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/managed task ownership cannot be proven/);
    expect(existsSync(guardedPrompt)).toBe(true);
    expect(guarded.publication).not.toHaveBeenCalled();
  });
});
