import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createSharedPgTaskStoreTestHarness, pgDescribe, type SharedPgTaskStoreHarness } from "../../__test-utils__/pg-test-harness.js";
import { isWorkspaceTask, type Task } from "../../types.js";

const pgTest = pgDescribe;

/*
FNXC:RepositoryScope 2026-08-23-15:58:
Review evidence CANNOT be seeded in the same updateTask write that publishes a repository scope:
`updateTaskUnlockedImpl` deliberately drops `reviewEvidence`/`reviewRemediation` whenever the
written scope revision differs from the stored one, because a new revision may never inherit an
approval taken against the old repository intent. Production attaches evidence exactly this way —
`recordWorkspaceReviewEvidence` re-writes the SAME revision through `updateTaskAtomic` — so these
fixtures publish the scope first and attach the review episode at the unchanged revision. Seeding
both in one write silently produced a task with no evidence, which made "retains approval" assert
against a scope that never had an approval to retain.
*/
async function attachReviewEpisode(
  store: SharedPgTaskStoreHarness extends { store: () => infer S } ? S : never,
  taskId: string,
  episode: Partial<NonNullable<Task["repositoryScope"]>>,
): Promise<void> {
  await store.updateTaskAtomic(taskId, (current: Task) => ({
    repositoryScope: { ...current.repositoryScope!, ...episode },
  }));
}

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

  it("persists explicit scope without treating acquired entries as intent or clobbering them", async () => {
    const first = h.store();
    const second = h.store();
    const task = await first.createTask({ description: "repository scope is explicit" });
    await first.mergeWorkspaceWorktreeEntry(task.id, "repo-a", { worktreePath: "/tmp/repo-a", branch: "fusion/a" });

    await Promise.all([
      first.updateTaskRepositoryScope(task.id, { repositories: ["repo-b", "repo-a", "repo-a"], confirmedBy: "operator" }),
      second.mergeWorkspaceWorktreeEntry(task.id, "repo-b", { worktreePath: "/tmp/repo-b", branch: "fusion/b" }),
    ]);

    const current = await first.getTask(task.id);
    expect(current.repositoryScope).toMatchObject({ repositories: ["repo-a", "repo-b"], confirmedBy: "operator" });
    expect(current.workspaceWorktrees).toEqual({
      "repo-a": { worktreePath: "/tmp/repo-a", branch: "fusion/a" },
      "repo-b": { worktreePath: "/tmp/repo-b", branch: "fusion/b" },
    });
  });

  it("clears review remediation with approval evidence when scope intent changes", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "scope change clears stale remediation" });
    await store.updateTask(task.id, {
      repositoryScope: { repositories: ["repo-a"], state: "confirmed", revision: 1 },
    });
    await attachReviewEpisode(store, task.id, {
      reviewEvidence: { "repo-a": { fingerprint: "old", approvedAt: new Date().toISOString() } },
      reviewRemediation: { scopeRevision: 1, repository: "repo-a", inputSignature: "old-review" },
    });

    const updated = await store.updateTaskRepositoryScope(task.id, {
      repositories: ["repo-b"],
      confirmedBy: "operator",
    });

    expect(updated.repositoryScope).toMatchObject({ repositories: ["repo-b"] });
    expect(updated.repositoryScope?.reviewEvidence).toBeUndefined();
    expect(updated.repositoryScope?.reviewRemediation).toBeUndefined();
  });

  it("retains approval when an identical normalized repository scope is republished", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "idempotent repository scope" });
    await store.updateTask(task.id, {
      repositoryScope: { repositories: ["repo-a", "repo-b"], state: "confirmed", revision: 4 },
    });
    await attachReviewEpisode(store, task.id, {
      reviewEvidence: { "repo-a": { fingerprint: "reviewed", approvedAt: new Date().toISOString() } },
    });

    const updated = await store.updateTaskRepositoryScope(task.id, {
      repositories: ["repo-b", "repo-a", "repo-a"], state: "confirmed",
    });

    expect(updated.repositoryScope).toMatchObject({
      repositories: ["repo-a", "repo-b"], revision: 4,
      reviewEvidence: { "repo-a": { fingerprint: "reviewed" } },
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
});

void describe;
