/*
 * FNXC:Workspace 2026-08-15-07:05:
 * Real git fixtures prove the guard sees configured main checkouts, including repos with no
 * acquired worktree; mocking status would not exercise the bypass completion previously missed.
 *
 * FNXC:WorkspaceFinalization 2026-08-27-08:42:
 * The guard's blocking subject is now COMMITS only. These cases pin both halves: uncommitted main
 * checkout entries surface as `uncommitted-only` warnings and complete, while task-attributed
 * commits and undelivered work still refuse (`main_checkout_edit` / `no_commits`).
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

function invariantDeps(
  fixture: WorkspaceFixture,
  declaredScope: string[] = [],
  options: { recordRunAuditEvent?: ReturnType<typeof vi.fn>; runContext?: { runId: string; agentId: string; taskId: string } } = {},
) {
  return {
    rootDir: fixture.rootDir,
    store: {
      getSettings: vi.fn().mockResolvedValue(settings),
      parseFileScopeFromPrompt: vi.fn().mockResolvedValue(declaredScope),
      ...(options.recordRunAuditEvent ? { recordRunAuditEvent: options.recordRunAuditEvent } : {}),
    } as unknown as TaskStore,
    workspaceConfig: { repos: fixture.repos },
    getActiveWorktreePaths: () => [],
    getRunContextFor: () => options.runContext,
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

  it("reports staged, untracked, out-of-scope, and zero-acquire main-checkout edits without blocking", async () => {
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
    expect(result.violations).toEqual([]);
    expect(result.warnings.find((finding) => finding.repo === "repo-a" && finding.reason === "uncommitted-only")?.files).toContain("src/outside.ts");
    expect(result.warnings.find((finding) => finding.repo === "repo-b" && finding.reason === "uncommitted-only")?.files).toContain("src/new.ts");
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
    expect(result.violations).toEqual([]);
    expect(result.warnings).toContainEqual(expect.objectContaining({ repo: "repo-a", files: ["src/local.ts"], reason: "uncommitted-only", evidence: "declared-scope-change" }));
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
    expect(result.warnings[0]).toMatchObject({ repo: "repo-a", reason: "uncommitted-only", evidence: "task-era-change" });
  });

  it("completes through uncommitted main-checkout dirt but still refuses undelivered work", async () => {
    fixture = await createWorkspaceFixture(["repo-a"]);
    const acquired = addEmptyWorktree(fixture);
    const activeTask = task({
      workspaceWorktrees: { "repo-a": { ...acquired, branch: "fusion/fn-1001" } },
    });
    const mainFile = path.join(fixture.repoPath("repo-a"), "main-checkout.ts");
    writeFileSync(mainFile, "export const bypass = true;\n");
    const changed = new Date(Date.parse(activeTask.firstExecutionAt!) + 10_000);
    await import("node:fs/promises").then(({ utimes }) => utimes(mainFile, changed, changed));

    // Work exists ONLY in the main checkout: completion is still refused, by the invariant that
    // actually proves delivery (an acquired worktree with commits) rather than by the dirt itself.
    const undelivered = await verifyWorktreeInvariants(invariantDeps(fixture), activeTask);
    expect(undelivered).toMatchObject({ ok: false, reason: "no_commits" });

    writeFileSync(path.join(acquired.worktreePath, "proper-worktree.ts"), "export const proper = true;\n");
    execSync('git config user.email "test@example.com" && git config user.name "Test" && git add proper-worktree.ts && git commit -m "feat: proper worktree edit"', { cwd: acquired.worktreePath });

    // Same dirt, delivery committed in the acquired worktree: the land path stashes and restores
    // that checkout, so completion must not stop for a state the merger is built to absorb.
    expect(await verifyWorktreeInvariants(invariantDeps(fixture), activeTask)).toEqual({ ok: true });

    unlinkSync(mainFile);
    expect(await verifyWorktreeInvariants(invariantDeps(fixture), activeTask)).toEqual({ ok: true });
  });

  it("reproduces the MRG-055 declared-scope main-checkout wedge without blocking completion", async () => {
    fixture = await createWorkspaceFixture(["repo-a"]);
    const acquired = addEmptyWorktree(fixture);
    const activeTask = task({
      workspaceWorktrees: { "repo-a": { ...acquired, branch: "fusion/fn-1001" } },
    });
    const auditEvents = vi.fn().mockResolvedValue(undefined);
    const deps = invariantDeps(fixture, ["src/**"], {
      recordRunAuditEvent: auditEvents,
      runContext: { runId: "run-fn-1001", agentId: "agent-fn-1001", taskId: activeTask.id },
    });
    const engineFile = path.join(fixture.repoPath("repo-a"), "src", "lib", "server", "engine", "engine.ts");
    const localeFile = path.join(fixture.repoPath("repo-a"), "src", "lib", "i18n", "locales", "en.json");
    mkdirSync(path.dirname(engineFile), { recursive: true });
    mkdirSync(path.dirname(localeFile), { recursive: true });
    writeFileSync(engineFile, "export const mainCheckoutEngine = true;\n");
    writeFileSync(localeFile, '{"mainCheckout":true}\n');
    const changed = new Date(Date.parse(activeTask.firstExecutionAt!) + 10_000);
    await import("node:fs/promises").then(({ utimes }) => Promise.all([
      utimes(engineFile, changed, changed),
      utimes(localeFile, changed, changed),
    ]));

    // FNXC:WorkspaceFinalization 2026-08-27-15:50:
    // MRG-055 had delivery in its acquired worktree but status-only files matching File Scope in
    // the shared main checkout. Delivery remains independently required; status-only dirt warns.
    expect(await verifyWorktreeInvariants(deps, activeTask)).toMatchObject({ ok: false, reason: "no_commits" });

    writeFileSync(path.join(acquired.worktreePath, "delivery.ts"), "export const delivered = true;\n");
    execSync('git add delivery.ts && git commit -m "feat(FN-1001): deliver workspace change"', { cwd: acquired.worktreePath });
    auditEvents.mockClear();

    expect(await verifyWorktreeInvariants(deps, activeTask)).toEqual({ ok: true });
    expect(auditEvents).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "worktree:workspace-main-checkout-edit",
      metadata: expect.objectContaining({ outcome: "warned", reason: "uncommitted-only", evidence: "declared-scope-change" }),
    }));
    expect(auditEvents).not.toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "worktree:workspace-main-checkout-edit",
      metadata: expect.objectContaining({ outcome: "blocked" }),
    }));

    const directCommit = path.join(fixture.repoPath("repo-a"), "direct-main.ts");
    writeFileSync(directCommit, "export const bypass = true;\n");
    fixture.git("repo-a", "git add direct-main.ts");
    fixture.git("repo-a", `GIT_AUTHOR_DATE='${changed.toISOString()}' GIT_COMMITTER_DATE='${changed.toISOString()}' git commit -m 'fix(FN-1001): direct main edit'`);

    expect(await verifyWorktreeInvariants(deps, activeTask)).toMatchObject({
      ok: false,
      reason: "main_checkout_edit",
      repo: "repo-a",
      observed: expect.stringContaining("task-attributed-commit"),
    });
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

  /*
  FNXC:WorkspaceFinalization 2026-08-27-16:07:
  FN-202 retains the commit-only refusal while locking every degraded main-checkout evidence path.
  Uncertain attribution must warn or skip, not revive the status-only completion wedge.
  */
  it("warns on an unresolved execution anchor without reintroducing a completion refusal", async () => {
    fixture = await createWorkspaceFixture(["repo-a"]);
    const acquired = addEmptyWorktree(fixture);
    writeFileSync(path.join(acquired.worktreePath, "delivered.ts"), "export const delivered = true;\n");
    execSync('git add delivered.ts && git commit -m "feat(FN-1001): deliver workspace change"', { cwd: acquired.worktreePath });
    const activeTask = task({
      createdAt: "not-a-date",
      firstExecutionAt: "not-a-date",
      executionStartedAt: "not-a-date",
      workspaceWorktrees: { "repo-a": { ...acquired, branch: "fusion/fn-1001" } },
    });
    const operatorFile = path.join(fixture.repoPath("repo-a"), "operator-draft.ts");
    writeFileSync(operatorFile, "export const operatorDraft = true;\n");

    expect(workspaceExecutionAnchor(activeTask)).toBeNull();
    const evidence = await detectWorkspaceMainCheckoutWork({ rootDir: fixture.rootDir, settings }, activeTask, fixture.repos, []);
    expect(evidence.violations).toEqual([]);
    expect(evidence.warnings).toContainEqual(expect.objectContaining({
      repo: "repo-a",
      files: ["operator-draft.ts"],
      reason: "anchor-unresolved",
    }));
    expect(await verifyWorktreeInvariants(invariantDeps(fixture), activeTask)).toEqual({ ok: true });
  });

  it("warns rather than blocks a foreign post-anchor main-checkout commit", async () => {
    fixture = await createWorkspaceFixture(["repo-a"]);
    const acquired = addEmptyWorktree(fixture);
    writeFileSync(path.join(acquired.worktreePath, "delivered.ts"), "export const delivered = true;\n");
    execSync('git add delivered.ts && git commit -m "feat(FN-1001): deliver workspace change"', { cwd: acquired.worktreePath });
    const activeTask = task({ workspaceWorktrees: { "repo-a": { ...acquired, branch: "fusion/fn-1001" } } });
    const foreignFile = path.join(fixture.repoPath("repo-a"), "operator-commit.ts");
    writeFileSync(foreignFile, "export const operatorCommit = true;\n");
    const committedAt = new Date(Date.parse(activeTask.firstExecutionAt!) + 10_000).toISOString();
    fixture.git("repo-a", "git add operator-commit.ts");
    fixture.git("repo-a", `GIT_AUTHOR_DATE='${committedAt}' GIT_COMMITTER_DATE='${committedAt}' git commit -m 'operator: direct main edit'`);
    const sha = fixture.git("repo-a", "git rev-parse HEAD");

    const evidence = await detectWorkspaceMainCheckoutWork({ rootDir: fixture.rootDir, settings }, activeTask, fixture.repos, []);
    expect(evidence.violations).toEqual([]);
    expect(evidence.warnings).toContainEqual(expect.objectContaining({
      repo: "repo-a",
      commits: [sha],
      reason: "pre-existing-dirt",
    }));
    expect(await verifyWorktreeInvariants(invariantDeps(fixture), activeTask)).toEqual({ ok: true });
  });

  it("warns on commit-scan failure without turning unreadable history into a refusal", async () => {
    fixture = await createWorkspaceFixture(["repo-a"]);
    const activeTask = task();
    writeFileSync(path.join(fixture.repoPath("repo-a"), "operator-draft.ts"), "export const operatorDraft = true;\n");
    // An unborn main ref leaves status readable while `git log HEAD` fails, exercising the guard's
    // read-error fallback without mocking the production subprocess boundary.
    fixture.git("repo-a", "git update-ref -d refs/heads/main");

    const evidence = await detectWorkspaceMainCheckoutWork({ rootDir: fixture.rootDir, settings }, activeTask, fixture.repos, []);
    expect(evidence.violations).toEqual([]);
    expect(evidence.warnings).toContainEqual(expect.objectContaining({ repo: "repo-a", reason: "commit-scan-unavailable" }));
  });

  it("skips a recorded workspace worktree that is the configured main checkout", async () => {
    fixture = await createWorkspaceFixture(["repo-a"]);
    const activeTask = task({
      workspaceWorktrees: {
        "repo-a": {
          worktreePath: fixture.repoPath("repo-a"),
          branch: "fusion/fn-1001",
          baseCommitSha: fixture.git("repo-a", "git rev-parse HEAD"),
        },
      },
    });
    writeFileSync(path.join(fixture.repoPath("repo-a"), "operator-draft.ts"), "export const operatorDraft = true;\n");

    const evidence = await detectWorkspaceMainCheckoutWork({ rootDir: fixture.rootDir, settings }, activeTask, fixture.repos, []);
    expect(evidence).toEqual({ violations: [], warnings: [], skipped: ["repo-a"] });
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
    expect(result.violations).toEqual([]);
    expect(result.warnings).toContainEqual(expect.objectContaining({ repo: "repo-a", files: ["deleted.ts"], reason: "uncommitted-only", evidence: "task-era-change" }));
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
