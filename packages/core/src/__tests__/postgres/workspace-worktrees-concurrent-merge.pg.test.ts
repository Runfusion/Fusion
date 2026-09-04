import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createSharedPgTaskStoreTestHarness, pgDescribe, type SharedPgTaskStoreHarness } from "../../__test-utils__/pg-test-harness.js";
import { isWorkspaceTask } from "../../types.js";

const pgTest = pgDescribe;

/*
FNXC:Workspace 2026-08-15-07:51:
These tests use distinct TaskStore handles against one PostgreSQL database. An in-process mutex
would make the concurrent cases pass accidentally; only the task advisory transaction lock makes
both independently issued per-repo merges retain their sibling entries.
*/
pgTest("workspace worktree per-repo atomic merge (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_workspace_merge" });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("creates and re-syncs the complete configured workspace scope", async () => {
    const store = h.store();
    await mkdir(join(h.rootDir(), ".fusion"), { recursive: true });
    await writeFile(join(h.rootDir(), ".fusion", "workspace.json"), JSON.stringify({ repos: ["repo-b", "repo-a"] }));

    const task = await store.createTask({ description: "workspace scope is configuration-owned" });
    expect(task.repositoryScope).toMatchObject({
      repositories: ["repo-a", "repo-b"],
      state: "confirmed",
      confirmedBy: "workspace",
      revision: 1,
    });

    const resynced = await store.updateTaskRepositoryScope(task.id, {
      repositories: ["repo-a"],
      state: "confirmed",
      confirmedBy: "workspace",
    });
    expect(resynced.repositoryScope).toMatchObject({
      repositories: ["repo-a", "repo-b"],
      confirmedBy: "workspace",
    });
  });

  it("retains both different repo keys from genuinely concurrent store handles", async () => {
    const first = h.store();
    const second = h.store();
    const task = await first.createTask({ description: "concurrent workspace merges" });

    await Promise.all([
      first.mergeWorkspaceWorktreeEntry(task.id, "repo-a", { worktreePath: "/tmp/repo-a", branch: "fusion/a", baseCommitSha: "base-a" }),
      second.mergeWorkspaceWorktreeEntry(task.id, "repo-b", { worktreePath: "/tmp/repo-b", branch: "fusion/b", baseCommitSha: "base-b" }),
    ]);

    const current = await first.getTask(task.id);
    expect(current.workspaceWorktrees).toEqual({
      "repo-a": { worktreePath: "/tmp/repo-a", branch: "fusion/a", baseCommitSha: "base-a" },
      "repo-b": { worktreePath: "/tmp/repo-b", branch: "fusion/b", baseCommitSha: "base-b" },
    });
  });

  it("preserves an existing entry while a sibling is added concurrently", async () => {
    const first = h.store();
    const second = h.store();
    const task = await first.createTask({ description: "landed SHA and acquisition" });
    await first.mergeWorkspaceWorktreeEntry(task.id, "repo-a", {
      worktreePath: "/tmp/repo-a", branch: "fusion/a", baseCommitSha: "base-a",
    });

    await Promise.all([
      first.mergeWorkspaceWorktreeEntry(task.id, "repo-a", { landedSha: "landed-a" }, { requireExistingEntry: true }),
      second.mergeWorkspaceWorktreeEntry(task.id, "repo-b", { worktreePath: "/tmp/repo-b", branch: "fusion/b" }),
    ]);

    expect((await first.getTask(task.id)).workspaceWorktrees).toEqual({
      "repo-a": { worktreePath: "/tmp/repo-a", branch: "fusion/a", baseCommitSha: "base-a", landedSha: "landed-a" },
      "repo-b": { worktreePath: "/tmp/repo-b", branch: "fusion/b" },
    });
  });

  it("clears singular state in the same per-key update", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "workspace singular state" });
    // FNXC:BranchWriteProvenance 2026-08-23-15:55: branch writes require an explicit origin; this
    // fixture replays the engine's legacy singular worktree/branch routing.
    await store.updateTask(task.id, { worktree: "/tmp/legacy", branch: "fusion/legacy", branchWriteOrigin: "engine" });

    const updated = await store.mergeWorkspaceWorktreeEntry(task.id, "repo-a", {
      worktreePath: "/tmp/repo-a", branch: "fusion/a",
    }, { clearSingularWorktree: true });

    expect(updated.worktree).toBeUndefined();
    expect(updated.branch).toBeUndefined();
    expect(isWorkspaceTask(updated)).toBe(true);
  });

  it("atomically repairs legacy singular routing while retaining every repo entry", async () => {
    const first = h.store();
    const second = h.store();
    const task = await first.createTask({ description: "workspace stale root routing" });
    const entries = {
      "repo-a": { worktreePath: "/tmp/repo-a/.worktrees/fn-legacy", branch: "fusion/a", baseCommitSha: "base-a" },
      "repo-b": { worktreePath: "/tmp/repo-b/.worktrees/fn-legacy", branch: "fusion/b", baseCommitSha: "base-b" },
    };
    await first.mergeWorkspaceWorktreeEntry(task.id, "repo-a", entries["repo-a"]);
    await first.mergeWorkspaceWorktreeEntry(task.id, "repo-b", entries["repo-b"]);
    await first.updateTask(task.id, {
      worktree: "/tmp/.worktrees/fn-legacy",
      branch: "fusion/legacy",
      // FNXC:BranchWriteProvenance 2026-08-23-15:55: branch writes require an explicit origin.
      branchWriteOrigin: "engine",
      executionStartBranch: "fusion/legacy",
      baseCommitSha: "root-base",
    });

    const normalized = await first.normalizeWorkspaceTaskWorktreeMetadata(task.id);
    expect(normalized.worktree).toBeUndefined();
    expect(normalized.branch).toBeUndefined();
    expect(normalized.executionStartBranch).toBeUndefined();
    expect(normalized.baseCommitSha).toBeUndefined();
    expect(normalized.workspaceWorktrees).toEqual(entries);

    /* FNXC:WorkspaceRootRouting 2026-08-19-12:15: A concurrent per-key merge after normalization
    must retain the complete map. */
    await Promise.all([
      first.normalizeWorkspaceTaskWorktreeMetadata(task.id),
      second.mergeWorkspaceWorktreeEntry(task.id, "repo-a", { landedSha: "landed-a" }, { requireExistingEntry: true }),
    ]);
    expect((await first.getTask(task.id)).workspaceWorktrees).toEqual({
      "repo-a": { ...entries["repo-a"], landedSha: "landed-a" },
      "repo-b": entries["repo-b"],
    });
  });

  it("does not create an absent required entry or clobber siblings", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "required entry no-op" });
    await store.mergeWorkspaceWorktreeEntry(task.id, "repo-a", { worktreePath: "/tmp/repo-a", branch: "fusion/a" });

    const unchanged = await store.mergeWorkspaceWorktreeEntry(task.id, "repo-b", { landedSha: "ignored" }, { requireExistingEntry: true });
    expect(unchanged.workspaceWorktrees).toEqual({ "repo-a": { worktreePath: "/tmp/repo-a", branch: "fusion/a" } });
  });

  it.each([undefined, {}] as const)("creates one entry from %j workspace state", async (workspaceWorktrees) => {
    const store = h.store();
    const task = await store.createTask({ description: "empty workspace state" });
    if (workspaceWorktrees) await store.updateTask(task.id, { workspaceWorktrees });

    const updated = await store.mergeWorkspaceWorktreeEntry(task.id, "repo-a", { worktreePath: "/tmp/repo-a", branch: "fusion/a" });
    expect(updated.workspaceWorktrees).toEqual({ "repo-a": { worktreePath: "/tmp/repo-a", branch: "fusion/a" } });
  });

  it("does not pin a planning lifecycle lock while callback preparation is pending", async () => {
    const preparingStore = h.store();
    const planningStore = h.store();
    const task = await preparingStore.createTask({ description: "slow workspace preparation" });
    let entered!: () => void;
    let release!: () => void;
    const preparationEntered = new Promise<void>((resolve) => { entered = resolve; });
    const preparationRelease = new Promise<void>((resolve) => { release = resolve; });

    const preparation = preparingStore.mergeWorkspaceWorktreeEntry(task.id, "repo-a", async () => {
      entered();
      await preparationRelease;
      return { worktreePath: "/tmp/repo-a", branch: "fusion/a" };
    });
    await preparationEntered;

    // FNXC:WorkspaceWorktree 2026-08-23-06:25:
    // FN-179 requires filesystem preparation to run outside the task mutex, so a
    // planning-lock holder can complete before slow git/init work is released.
    // Hold preparation past the production advisory-lock timeout. If preparation
    // still held the task mutex, either planning-lock caller would time out here.
    const lifecycleWaiter = planningStore.withPlanningLifecycleLock(task.id, async () => "acquired");
    const scopeWaiter = planningStore.updateTaskRepositoryScope(task.id, undefined);
    await new Promise((resolve) => setTimeout(resolve, 5_100));
    await expect(lifecycleWaiter).resolves.toBe("acquired");
    await expect(scopeWaiter).resolves.toMatchObject({ id: task.id });

    release();
    await expect(preparation).resolves.toMatchObject({
      workspaceWorktrees: { "repo-a": { worktreePath: "/tmp/repo-a", branch: "fusion/a" } },
    });
  });
});

void describe;
