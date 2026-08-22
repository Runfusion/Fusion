/*
 * FNXC:Workspace 2026-08-15-07:05:
 * Real git fixtures prove the guard sees configured main checkouts, including repos with no
 * acquired worktree; mocking status would not exercise the bypass completion previously missed.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { execSync } from "node:child_process";
import { mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Settings, Task, TaskStore } from "@fusion/core";
import { detectWorkspaceMainCheckoutWork, workspaceExecutionAnchor } from "../executor/workspace-main-checkout-guard.js";
import { verifyWorktreeInvariants } from "../executor/worktree-verify-invariants.js";
import { createWorkspaceFixture, hasGit, type WorkspaceFixture } from "./_workspace-fixture.js";

const describeIfGit = hasGit ? describe : describe.skip;
const settings = {} as Settings;
function task(overrides: Partial<Task> = {}): Task {
  const start = new Date(Date.now() + 1_000).toISOString();
  return { id: "FN-1001", title: "guard", description: "", column: "in-progress", dependencies: [], steps: [], currentStep: 0, log: [], createdAt: start, updatedAt: start, firstExecutionAt: start, executionStartedAt: start, ...overrides } as Task;
}

function invariantDeps(fixture: WorkspaceFixture, declaredScope: string[] = []) {
  return {
    rootDir: fixture.rootDir,
    store: {
      getSettings: vi.fn().mockResolvedValue(settings),
      parseFileScopeFromPrompt: vi.fn().mockResolvedValue(declaredScope),
    } as unknown as TaskStore,
    workspaceConfig: { repos: fixture.repos },
    getActiveWorktreePaths: () => [],
    getRunContextFor: () => undefined,
    emitWorktreeReanchoredAudit: async () => undefined,
  };
}

function addEmptyWorktree(fixture: WorkspaceFixture, repo = "repo-a"): { worktreePath: string; baseCommitSha: string } {
  const baseCommitSha = fixture.git(repo, "git rev-parse HEAD");
  const worktreePath = path.join(fixture.repoPath(repo), ".worktrees", "fn-1001");
  fixture.git(repo, `git worktree add -b fusion/fn-1001 ${worktreePath} HEAD`);
  return { worktreePath, baseCommitSha };
}

describeIfGit("workspace main-checkout guard", () => {
  let fixture: WorkspaceFixture;
  afterEach(() => fixture?.cleanup());

  it("blocks staged, untracked, out-of-scope, and zero-acquire main-checkout edits", async () => {
    fixture = await createWorkspaceFixture();
    mkdirSync(path.join(fixture.repoPath("repo-a"), "src"), { recursive: true });
    writeFileSync(path.join(fixture.repoPath("repo-a"), "src", "outside.ts"), "export {};\n");
    fixture.git("repo-a", "git add src/outside.ts");
    mkdirSync(path.join(fixture.repoPath("repo-b"), "src"), { recursive: true });
    writeFileSync(path.join(fixture.repoPath("repo-b"), "src", "new.ts"), "export {};\n");
    const activeTask = task();
    const changed = new Date(Date.parse(activeTask.firstExecutionAt!) + 10_000);
    await import("node:fs/promises").then(({ utimes }) => Promise.all([
      utimes(path.join(fixture.repoPath("repo-a"), "src", "outside.ts"), changed, changed),
      utimes(path.join(fixture.repoPath("repo-b"), "src", "new.ts"), changed, changed),
    ]));
    const result = await detectWorkspaceMainCheckoutWork({ rootDir: fixture.rootDir, settings }, activeTask, fixture.repos, ["repo-a/docs/**"]);
    expect(result.violations.find((finding) => finding.repo === "repo-a")?.files).toContain("src/outside.ts");
    expect(result.violations.find((finding) => finding.repo === "repo-b")?.files).toContain("src/new.ts");
  });

  it("treats repo-local File Scope as declared scope for a single workspace repository", async () => {
    fixture = await createWorkspaceFixture(["repo-a"]);
    const activeTask = task();
    const file = path.join(fixture.repoPath("repo-a"), "src", "local.ts");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "export {};\n");
    const changed = new Date(Date.parse(activeTask.firstExecutionAt!) + 10_000);
    await import("node:fs/promises").then(({ utimes }) => utimes(file, changed, changed));

    const result = await detectWorkspaceMainCheckoutWork({ rootDir: fixture.rootDir, settings }, activeTask, fixture.repos, ["src/**"]);
    expect(result.violations).toContainEqual(expect.objectContaining({ repo: "repo-a", files: ["src/local.ts"], evidence: "declared-scope-change" }));
  });

  it("uses firstExecutionAt instead of the later retry attempt anchor", async () => {
    fixture = await createWorkspaceFixture(["repo-a"]);
    const first = new Date(Date.now() + 1_000).toISOString();
    mkdirSync(path.join(fixture.repoPath("repo-a"), "src"), { recursive: true });
    const retryFile = path.join(fixture.repoPath("repo-a"), "src", "retry.ts");
    writeFileSync(retryFile, "export {};\n");
    await import("node:fs/promises").then(({ utimes }) => utimes(retryFile, new Date(Date.parse(first) + 10_000), new Date(Date.parse(first) + 10_000)));
    const retry = new Date(Date.now() + 60_000).toISOString();
    const result = await detectWorkspaceMainCheckoutWork({ rootDir: fixture.rootDir, settings }, task({ firstExecutionAt: first, executionStartedAt: retry }), fixture.repos, []);
    expect(workspaceExecutionAnchor(task({ firstExecutionAt: first, executionStartedAt: retry }))).toBeLessThan(Date.parse(retry));
    expect(result.violations[0]).toMatchObject({ repo: "repo-a", evidence: "task-era-change" });
  });

  it("runs before no_commits in the production completion invariant and clears after remediation", async () => {
    fixture = await createWorkspaceFixture(["repo-a"]);
    const acquired = addEmptyWorktree(fixture);
    const activeTask = task({
      workspaceWorktrees: { "repo-a": { ...acquired, branch: "fusion/fn-1001" } },
    });
    writeFileSync(path.join(acquired.worktreePath, "proper-worktree.ts"), "export const proper = true;\n");
    execSync('git config user.email "test@example.com" && git config user.name "Test" && git add proper-worktree.ts && git commit -m "feat: proper worktree edit"', { cwd: acquired.worktreePath });
    const mainFile = path.join(fixture.repoPath("repo-a"), "main-checkout.ts");
    writeFileSync(mainFile, "export const bypass = true;\n");
    const changed = new Date(Date.parse(activeTask.firstExecutionAt!) + 10_000);
    await import("node:fs/promises").then(({ utimes }) => utimes(mainFile, changed, changed));

    const blocked = await verifyWorktreeInvariants(invariantDeps(fixture), activeTask);
    expect(blocked).toMatchObject({ ok: false, reason: "main_checkout_edit", repo: "repo-a" });
    expect(blocked.ok ? "" : blocked.observed).toContain("main-checkout.ts");

    unlinkSync(mainFile);
    const remediated = await verifyWorktreeInvariants(invariantDeps(fixture), activeTask);
    expect(remediated).toEqual({ ok: true });
  });

  it("detects clean-tree direct main commits without a base range", async () => {
    fixture = await createWorkspaceFixture(["repo-a"]);
    const activeTask = task({ workspaceWorktrees: {} });
    const file = path.join(fixture.repoPath("repo-a"), "committed.ts");
    writeFileSync(file, "export const direct = true;\n");
    const commitDate = new Date(Date.parse(activeTask.firstExecutionAt!) + 10_000).toISOString();
    fixture.git("repo-a", "git add committed.ts");
    fixture.git("repo-a", `GIT_AUTHOR_DATE='${commitDate}' GIT_COMMITTER_DATE='${commitDate}' git commit -m 'fix(FN-1001): direct main edit'`);
    const sha = fixture.git("repo-a", "git rev-parse HEAD");
    expect(fixture.git("repo-a", "git merge-base HEAD main")).toBe(sha);

    const result = await verifyWorktreeInvariants(invariantDeps(fixture), activeTask);
    expect(result).toMatchObject({ ok: false, reason: "main_checkout_edit", repo: "repo-a" });
    expect(result.ok ? "" : result.observed).toContain(sha.slice(0, 12));
    expect(result.ok ? "" : result.observed).toContain("task-attributed-commit");
  });

  it("ignores pre-execution task-attributed commits and skips configured non-repositories", async () => {
    fixture = await createWorkspaceFixture(["repo-a"]);
    const activeTask = task({ workspaceWorktrees: {} });
    const file = path.join(fixture.repoPath("repo-a"), "backdated.ts");
    writeFileSync(file, "export const direct = true;\n");
    fixture.git("repo-a", "git add backdated.ts");
    fixture.git("repo-a", "GIT_AUTHOR_DATE='2000-01-01T00:00:00Z' GIT_COMMITTER_DATE='2000-01-01T00:00:00Z' git commit -m 'fix(FN-1001): skewed' ");
    // This task-ID commit predates execution and is already at the recorded base. Historical
    // attribution alone must not permanently block workspace completion.
    const acquired = addEmptyWorktree(fixture);
    activeTask.workspaceWorktrees = { "repo-a": { ...acquired, branch: "fusion/fn-1001" } };
    const direct = await detectWorkspaceMainCheckoutWork(
      { rootDir: fixture.rootDir, settings }, activeTask, ["repo-a", "repo-a/not-a-repo"], [],
    );
    expect(direct.violations).not.toContainEqual(expect.objectContaining({ repo: "repo-a", evidence: "task-attributed-commit" }));
    expect(direct.skipped).toContain("repo-a/not-a-repo");
  });

  it("classifies task-era deletions from their parent directory mtime", async () => {
    fixture = await createWorkspaceFixture(["repo-a"]);
    const activeTask = task();
    const deleted = path.join(fixture.repoPath("repo-a"), "deleted.ts");
    writeFileSync(deleted, "export {};\n");
    fixture.git("repo-a", "git add deleted.ts && GIT_AUTHOR_DATE='2000-01-01T00:00:00Z' GIT_COMMITTER_DATE='2000-01-01T00:00:00Z' git commit -m baseline-deleted");
    unlinkSync(deleted);
    const parent = path.dirname(deleted);
    const changed = new Date(Date.parse(activeTask.firstExecutionAt!) + 10_000);
    await import("node:fs/promises").then(({ utimes }) => utimes(parent, changed, changed));
    const result = await detectWorkspaceMainCheckoutWork({ rootDir: fixture.rootDir, settings }, activeTask, fixture.repos, []);
    expect(result.violations).toContainEqual(expect.objectContaining({ repo: "repo-a", files: ["deleted.ts"], evidence: "task-era-change" }));
  });

  it("warns rather than blocks provably old operator dirt and ignores nested worktrees", async () => {
    fixture = await createWorkspaceFixture(["repo-a"]);
    const file = path.join(fixture.repoPath("repo-a"), "old.txt");
    writeFileSync(file, "operator dirt\n");
    const old = new Date(Date.now() - 120_000);
    await import("node:fs/promises").then(({ utimes }) => utimes(file, old, old));
    const nested = path.join(fixture.repoPath("repo-a"), ".worktrees", "task", "nested.ts");
    mkdirSync(path.dirname(nested), { recursive: true });
    writeFileSync(nested, "ignored\n");
    const activeTask = task({ firstExecutionAt: new Date(Date.now() + 600_000).toISOString(), executionStartedAt: new Date(Date.now() + 600_000).toISOString() });
    const result = await detectWorkspaceMainCheckoutWork({ rootDir: fixture.rootDir, settings }, activeTask, fixture.repos, []);
    expect(result.violations).toEqual([]);
    expect(result.warnings).toContainEqual(expect.objectContaining({ repo: "repo-a", reason: "pre-existing-dirt", files: ["old.txt"] }));
    rmSync(path.dirname(path.dirname(nested)), { recursive: true, force: true });
  });
});
