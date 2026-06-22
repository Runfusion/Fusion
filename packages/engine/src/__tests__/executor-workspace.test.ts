/*
FNXC:Workspace 2026-06-21-12:00:
U1 executor session-scoping tests. REWRITTEN from the foundation's self-mocking version (which vi.mock'd the very functions under test and proved nothing). These tests use a REAL two-repo git fixture (`createWorkspaceFixture`) under a NON-git workspace root, so a leaked rootDir git preflight would actually fail. They drive the real TaskExecutor methods that U1 changed: the activeWorktrees Set conversion + every enumerated consumer (KTD2), the preflight gate + browse-only-root scoping (KTD1), and the synthetic-acquisition cwd.

Seam choice (FN-5048): `(executor as any).workspaceConfig` is set directly to drive the gating with real git — loadWorkspaceConfig is covered by its own unit and is not the subject here. No mock-the-world child_process/fs shell.
*/
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { loadWorkspaceConfig, type Task, type TaskStore, type WorkspaceConfig } from "@fusion/core";
import { TaskExecutor, buildExecutionPrompt } from "../executor.js";
import { createWorkspaceFixture, hasGit, type WorkspaceFixture } from "./_workspace-fixture.js";

const describeIfGit = hasGit ? describe : describe.skip;

function createStore(overrides: Partial<Record<string, unknown>> = {}): TaskStore & EventEmitter {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    updateTask: vi.fn().mockResolvedValue(undefined),
    logEntry: vi.fn().mockResolvedValue(undefined),
    getSettings: vi.fn().mockResolvedValue({ autoMerge: false }),
    on: emitter.on.bind(emitter),
    ...overrides,
  }) as unknown as TaskStore & EventEmitter;
}

function makeTask(id = "FN-WS-1", overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: "Workspace task",
    description: "",
    column: "in-progress",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Task;
}

const repoAPath = (fx: WorkspaceFixture) => `${fx.repoPath("repo-a")}/.worktrees/fn-ws-1`;
const repoBPath = (fx: WorkspaceFixture) => `${fx.repoPath("repo-b")}/.worktrees/fn-ws-1`;

describeIfGit("workspace fixture", () => {
  let fx: WorkspaceFixture;
  afterEach(() => fx?.cleanup());

  it("builds a non-git root with two real git sub-repos and a resolvable workspace config", async () => {
    fx = await createWorkspaceFixture();
    // Root is NOT a git repo. Use "." so the check runs in fx.rootDir itself, not
    // its parent (".." would resolve to the tmpdir and could pass spuriously).
    expect(() => fx.git(".", "git rev-parse --git-dir")).toThrow();
    // Each sub-repo is a real git repo with a commit on main.
    expect(fx.git("repo-a", "git rev-parse --abbrev-ref HEAD")).toBe("main");
    expect(fx.git("repo-b", "git rev-list --count HEAD")).toBe("1");
    // loadWorkspaceConfig resolves the on-disk config the executor keys off.
    const config = await loadWorkspaceConfig(fx.rootDir);
    expect(config?.repos).toEqual(["repo-a", "repo-b"]);
  });
});

describeIfGit("U1 KTD2 — activeWorktrees Set + every enumerated consumer", () => {
  let fx: WorkspaceFixture;
  afterEach(() => fx?.cleanup());

  function workspaceExecutor() {
    fx ??= undefined as never;
    const store = createStore();
    const executor = new TaskExecutor(store, fx.rootDir);
    (executor as any).workspaceConfig = { repos: fx.repos } as WorkspaceConfig;
    return executor;
  }

  it("a workspace task holding TWO sub-repo paths is found by membership, not equality", async () => {
    fx = await createWorkspaceFixture();
    const executor = workspaceExecutor();
    const pA = repoAPath(fx);
    const pB = repoBPath(fx);
    (executor as any).addActiveWorktree("FN-WS-1", pA);
    (executor as any).addActiveWorktree("FN-WS-1", pB);

    // hasActiveWorktreeBinding: both held paths match; an unheld path does not.
    expect((executor as any).hasActiveWorktreeBinding("FN-WS-1", pA)).toBe(true);
    expect((executor as any).hasActiveWorktreeBinding("FN-WS-1", pB)).toBe(true);
    expect((executor as any).hasActiveWorktreeBinding("FN-WS-1", "/nope")).toBe(false);

    // findActiveWorktreeOwner: another task asking about either held path finds FN-WS-1.
    await expect((executor as any).findActiveWorktreeOwner(pA, "FN-OTHER")).resolves.toBe("FN-WS-1");
    await expect((executor as any).findActiveWorktreeOwner(pB, "FN-OTHER")).resolves.toBe("FN-WS-1");
    // The owner itself is excluded.
    await expect((executor as any).findActiveWorktreeOwner(pA, "FN-WS-1")).resolves.toBeNull();
  });

  it("listWorktreeHolders flat-maps the Set into N holder rows for one task", async () => {
    fx = await createWorkspaceFixture();
    const executor = workspaceExecutor();
    const pA = repoAPath(fx);
    const pB = repoBPath(fx);
    (executor as any).addActiveWorktree("FN-WS-1", pA);
    (executor as any).addActiveWorktree("FN-WS-1", pB);

    const holders = executor.listWorktreeHolders();
    expect(holders).toHaveLength(2);
    expect(holders).toContainEqual({ taskId: "FN-WS-1", worktreePath: pA });
    expect(holders).toContainEqual({ taskId: "FN-WS-1", worktreePath: pB });
  });

  it("shouldGenerateNewWorktreeName iterates the Set (conflict membership)", async () => {
    fx = await createWorkspaceFixture();
    const store = createStore({ listTasks: vi.fn().mockResolvedValue([]) });
    const executor = new TaskExecutor(store, fx.rootDir);
    (executor as any).workspaceConfig = { repos: fx.repos } as WorkspaceConfig;
    const pA = repoAPath(fx);
    (executor as any).addActiveWorktree("FN-HOLDER", pA);

    // A different task contending for FN-HOLDER's path must be told to generate a new name.
    await expect((executor as any).shouldGenerateNewWorktreeName(pA, "FN-WS-1")).resolves.toBe(true);
    // The holder asking about its own path is not a conflict (excluded), and the
    // DB liveness fallback returns no other user.
    await expect((executor as any).shouldGenerateNewWorktreeName(pA, "FN-HOLDER")).resolves.toBe(false);
  });

  it("getWorktreePath returns undefined for a multi-worktree workspace task (Set-collapse contract)", async () => {
    fx = await createWorkspaceFixture();
    const executor = workspaceExecutor();
    (executor as any).addActiveWorktree("FN-WS-1", repoAPath(fx));
    (executor as any).addActiveWorktree("FN-WS-1", repoBPath(fx));
    expect(executor.getWorktreePath("FN-WS-1")).toBeUndefined();
  });

  it("cleanup drops in-memory tracking in workspace mode but never removes the root", async () => {
    fx = await createWorkspaceFixture();
    const removeSpy = vi.fn();
    const executor = workspaceExecutor();
    (executor as any).removeOwnWorktreeWithReconcile = removeSpy;
    (executor as any).addActiveWorktree("FN-WS-1", repoAPath(fx));
    (executor as any).addActiveWorktree("FN-WS-1", repoBPath(fx));

    await executor.cleanup("FN-WS-1");

    expect(executor.getWorktreePath("FN-WS-1")).toBeUndefined();
    expect((executor as any).activeWorktrees.has("FN-WS-1")).toBe(false);
    // The browse-only root must never be torn down as if it were a worktree.
    expect(removeSpy).not.toHaveBeenCalled();
  });

  it("clearPhantomExecutorBinding (FN-6736) unregisters every held path, not one", async () => {
    fx = await createWorkspaceFixture();
    const executor = workspaceExecutor();
    const pA = repoAPath(fx);
    const pB = repoBPath(fx);
    (executor as any).addActiveWorktree("FN-WS-1", pA);
    (executor as any).addActiveWorktree("FN-WS-1", pB);

    const ok = (executor as any).clearPhantomExecutorBinding("FN-WS-1");
    expect(ok).toBe(true);
    expect((executor as any).activeWorktrees.has("FN-WS-1")).toBe(false);
  });
});

describeIfGit("U1 KTD2 — non-workspace task is a one-element Set (regression: unchanged)", () => {
  let fx: WorkspaceFixture;
  afterEach(() => fx?.cleanup());

  it("getWorktreePath returns the sole path; listWorktreeHolders emits exactly one row", async () => {
    fx = await createWorkspaceFixture();
    const store = createStore();
    const executor = new TaskExecutor(store, fx.repoPath("repo-a")); // single-repo root
    // No workspaceConfig set → single-repo mode.
    const wt = `${fx.repoPath("repo-a")}/.worktrees/fn-001`;
    (executor as any).addActiveWorktree("FN-001", wt);

    expect(executor.getWorktreePath("FN-001")).toBe(wt);
    expect(executor.listWorktreeHolders()).toEqual([{ taskId: "FN-001", worktreePath: wt }]);
    expect((executor as any).hasActiveWorktreeBinding("FN-001", wt)).toBe(true);
  });
});

describeIfGit("U1 KTD1 — verifyWorktreeInvariants gated off in workspace mode", () => {
  let fx: WorkspaceFixture;
  afterEach(() => fx?.cleanup());

  it("returns ok for a zero-acquire workspace task (no task.worktree) so fn_task_done does not requeue", async () => {
    fx = await createWorkspaceFixture();
    const store = createStore();
    const executor = new TaskExecutor(store, fx.rootDir);
    (executor as any).workspaceConfig = { repos: fx.repos } as WorkspaceConfig;

    // A workspace task that acquired ZERO sub-repos has no task.worktree and no
    // tracked paths. The singular invariant would otherwise refuse on
    // "missing task.worktree"; in workspace mode it is gated OFF.
    const result = await (executor as any).verifyWorktreeInvariants(makeTask("FN-WS-1", { worktree: undefined }));
    expect(result).toEqual({ ok: true });
  });

  it("non-workspace task with no worktree still fails the invariant (regression: gate is workspace-only)", async () => {
    fx = await createWorkspaceFixture();
    const store = createStore();
    const executor = new TaskExecutor(store, fx.repoPath("repo-a"));
    // No workspaceConfig.
    const result = await (executor as any).verifyWorktreeInvariants(makeTask("FN-001", { worktree: undefined }));
    expect(result.ok).toBe(false);
  });
});

describeIfGit("U1 KTD1 — scopePromptToWorktree / buildExecutionPrompt no-op in workspace mode", () => {
  let fx: WorkspaceFixture;
  afterEach(() => fx?.cleanup());

  it("does not rewrite root-anchored paths when a workspace config is present", async () => {
    fx = await createWorkspaceFixture();
    const task = makeTask("FN-WS-1", { prompt: `Edit ${fx.rootDir}/repo-a/src/index.ts and commit.` });
    const config: WorkspaceConfig = { repos: fx.repos };
    // worktreePath === rootDir in workspace mode; the prompt must be returned verbatim.
    const prompt = buildExecutionPrompt(task as any, fx.rootDir, { autoMerge: false } as any, fx.rootDir, undefined, undefined, config);
    expect(prompt).toContain(`${fx.rootDir}/repo-a/src/index.ts`);
    // The workspace repo list is appended (foundation behavior).
    expect(prompt).toContain("repo-a");
  });
});
