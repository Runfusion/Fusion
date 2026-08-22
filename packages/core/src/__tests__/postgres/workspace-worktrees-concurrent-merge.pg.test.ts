import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
      repositoryScope: {
        repositories: ["repo-a"],
        state: "confirmed",
        revision: 1,
        reviewEvidence: { "repo-a": { fingerprint: "old", approvedAt: new Date().toISOString() } },
        reviewRemediation: { scopeRevision: 1, repository: "repo-a", inputSignature: "old-review" },
      },
    });

    const updated = await store.updateTaskRepositoryScope(task.id, {
      repositories: ["repo-b"],
      confirmedBy: "operator",
    });

    expect(updated.repositoryScope).toMatchObject({ repositories: ["repo-b"] });
    expect(updated.repositoryScope?.reviewEvidence).toBeUndefined();
    expect(updated.repositoryScope?.reviewRemediation).toBeUndefined();
  });

  it("clears singular state in the same per-key update", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "workspace singular state" });
    await store.updateTask(task.id, { worktree: "/tmp/legacy", branch: "fusion/legacy" });

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
