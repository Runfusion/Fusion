import {afterEach, describe, expect, it, vi} from "vitest";

const {removeWorktree, execFile} = vi.hoisted(() => ({
  removeWorktree: vi.fn().mockResolvedValue(undefined),
  execFile: vi.fn((...args: unknown[]) => (args.at(-1) as (error: Error | null) => void)(null)),
}));
vi.mock("../worktree/worktree-backend.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../worktree/worktree-backend.js")>()),
  removeWorktree,
}));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile,
}));

import {
  getArchiveWorkspaceWorktreeDisposer,
  getArchiveWorktreeDisposer,
  LiveTaskWorktreeRemovalRefusedError,
  registerArchiveWorktreeDisposer,
  type TaskStore,
} from "@fusion/core";
import {installBaselineArchiveWorktreeDisposer} from "../healing/archive-worktree-disposer-install.js";

/*
FNXC:WorkflowLifecycle 2026-08-15-06:35:
The executor-less baseline disposer is a defensive final fence. Test both workspace and singular
paths because a force removal in either path irreversibly loses work that another process owns.
*/
describe("baseline archive disposer live-task guard", () => {
  const unregister: (() => void)[] = [];
  afterEach(() => {
    while (unregister.length) unregister.pop()!();
    vi.clearAllMocks();
  });

  function store(): TaskStore {
    return {rootDir: "/repo", getTaskWorkflowSelectionAsync: async () => undefined} as unknown as TaskStore;
  }

  const live = {id: "FN-live", column: "in-progress", workspaceWorktrees: {
    "repo-a": {worktreePath: "/repo/repo-a/.worktrees/a", branch: "fusion/a"},
    "repo-b": {worktreePath: "/repo/repo-b/.worktrees/b", branch: "fusion/b"},
  }} as never;
  const plan = [
    {repoRel: "repo-a", worktreePath: "/repo/repo-a/.worktrees/a", branch: "fusion/a", repoRootDir: "/repo/repo-a", aliasRepoRels: []},
    {repoRel: "repo-b", worktreePath: "/repo/repo-b/.worktrees/b", branch: "fusion/b", repoRootDir: "/repo/repo-b", aliasRepoRels: []},
  ];

  it("does not force-remove any live workspace worktree", async () => {
    const taskStore = store();
    unregister.push(installBaselineArchiveWorktreeDisposer(taskStore, {rootDir: "/repo", getSettings: async () => ({})}));
    const disposer = getArchiveWorkspaceWorktreeDisposer(taskStore)!;

    const result = await disposer(live, plan, {} as never);

    expect(removeWorktree).not.toHaveBeenCalled();
    expect(execFile).not.toHaveBeenCalled();
    expect(result.removed).toEqual([]);
    expect(result.failed).toHaveLength(2);
    expect(result.failed.every(({error}) => error instanceof LiveTaskWorktreeRemovalRefusedError)).toBe(true);
    expect(live.workspaceWorktrees).toHaveProperty("repo-a");
    expect(live.workspaceWorktrees).toHaveProperty("repo-b");
  });

  it("permits explicit human force removal and dead task cleanup", async () => {
    const taskStore = store();
    unregister.push(installBaselineArchiveWorktreeDisposer(taskStore, {rootDir: "/repo", getSettings: async () => ({}), allowLiveRemoval: () => true}));
    const forced = await getArchiveWorkspaceWorktreeDisposer(taskStore)!(structuredClone(live), plan, {} as never);
    expect(forced.removed).toEqual(["repo-a", "repo-b"]);
    expect(removeWorktree).toHaveBeenCalledTimes(2);
    expect(execFile).toHaveBeenCalledTimes(2);

    const deadStore = store();
    unregister.push(installBaselineArchiveWorktreeDisposer(deadStore, {rootDir: "/repo", getSettings: async () => ({})}));
    const dead = {...structuredClone(live), id: "FN-dead", column: "done"};
    await getArchiveWorkspaceWorktreeDisposer(deadStore)!(dead, plan, {} as never);
    expect(removeWorktree).toHaveBeenCalledTimes(4);
  });

  it("throws for a live singular worktree and retains an executor disposer", async () => {
    const taskStore = store();
    unregister.push(installBaselineArchiveWorktreeDisposer(taskStore, {rootDir: "/repo", getSettings: async () => ({})}));
    await expect(getArchiveWorktreeDisposer(taskStore)!({id: "FN-single", column: "in-progress", worktree: "/repo/.worktrees/live"} as never, {} as never)).rejects.toBeInstanceOf(LiveTaskWorktreeRemovalRefusedError);
    expect(removeWorktree).not.toHaveBeenCalled();

    const executorStore = store();
    const executor = vi.fn();
    const removeExecutor = registerArchiveWorktreeDisposer(executorStore, executor);
    unregister.push(removeExecutor, installBaselineArchiveWorktreeDisposer(executorStore, {rootDir: "/repo", getSettings: async () => ({})}));
    expect(getArchiveWorktreeDisposer(executorStore)).toBe(executor);
  });
});
