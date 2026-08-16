/*
FNXC:Workspace 2026-06-21-23:30:
U1 per-repo capture + contamination + worktree-invariant tests (KTD1/KTD2). These drive the REAL TaskExecutor methods against a REAL two-repo git fixture under a NON-git workspace root (createWorkspaceFixture), so any leaked rootDir git preflight would actually fail and a hand-built `git diff` against an undefined base would blow up.

Seam choice (FN-5048): we set `(executor as any).workspaceConfig` directly (loadWorkspaceConfig has its own unit) and create real `fusion/<id>` worktrees per sub-repo with real commits — no mock-the-world child_process. Capture is exercised through `captureWorkspaceModifiedFiles` (the helper the post-session path at executor.ts:7900 calls) and verification through `verifyWorktreeInvariants`. Real git is used only where the invariant requires it.

Coverage:
- happy: edits in repo A + B → aggregated modifiedFiles carry repo-prefixed paths from BOTH, each diffed against its own baseCommitSha.
- edge: a repo with baseCommitSha undefined → capture still works via resolveDiffBaseRef's merge-base fallback (no `git diff undefined..HEAD`).
- contamination: a foreign commit (feat(FN-OTHER):) in a sub-repo's range → the filterFilesToOwnTaskCommits divergence audit fires (task:worktree-contamination-detected) for that repo, and the foreign file is excluded from attributed files.
- error: a worktree HEAD off fusion/<id> → verifyWorktreeInvariants returns {ok:false, reason:'wrong_branch', repo, observed, expected} (NOT {ok:true}); the reason enum is preserved for the :10889 consumer.
- regression: a single-repo (non-workspace) task → capture/verify identical to today.
*/
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Task, TaskStore, WorkspaceConfig } from "@fusion/core";
import { TaskExecutor } from "../executor.js";
import { createWorkspaceFixture, hasGit, type WorkspaceFixture } from "./_workspace-fixture.js";

const describeIfGit = hasGit ? describe : describe.skip;

function createStore(overrides: Partial<Record<string, unknown>> = {}): TaskStore & EventEmitter {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    updateTask: vi.fn().mockResolvedValue(undefined),
    logEntry: vi.fn().mockResolvedValue(undefined),
    getSettings: vi.fn().mockResolvedValue({ autoMerge: false }),
    getRunContextFor: vi.fn(),
    // verifyWorktreeInvariants resolves the live external-execution route through store.getTask
    // (FNXC:ExternalExecutionCheckout 2026-08-09-23:53); undefined falls back to the passed task.
    getTask: vi.fn().mockResolvedValue(undefined),
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

// Capture attribution requires a digit-form task id (`FN-\d+`); the branch-attribution
// subject parser only attributes `feat(FN-1001):` style subjects, so the KTD2-era
// `FN-WS-1` placeholder would never attribute a commit. Use a real numeric id here.
const TASK_ID = "FN-1001";
const BRANCH = "fusion/fn-1001";

/** Configure git identity in a freshly-created worktree (worktrees don't inherit user.* on all platforms). */
function configureIdentity(dir: string): void {
  execSync('git config user.email "test@example.com"', { cwd: dir, stdio: "pipe" });
  execSync('git config user.name "Test"', { cwd: dir, stdio: "pipe" });
}

/**
 * Add a real fusion/<id> worktree to a sub-repo, commit one own-attributed edit
 * onto that branch, and return { worktreePath, baseCommitSha } for task.workspaceWorktrees.
 * baseCommitSha is the sub-repo's pre-edit HEAD so the diff range is base..HEAD.
 */
function addRepoWorktreeWithOwnEdit(
  fx: WorkspaceFixture,
  repoRel: string,
  fileName: string,
): { worktreePath: string; baseCommitSha: string } {
  const repoDir = fx.repoPath(repoRel);
  const baseCommitSha = fx.git(repoRel, "git rev-parse HEAD");
  const worktreePath = path.join(repoDir, ".worktrees", "fn-ws-1");
  fx.git(repoRel, `git worktree add -b ${BRANCH} ${worktreePath} HEAD`);
  configureIdentity(worktreePath);
  mkdirSync(path.dirname(path.join(worktreePath, fileName)), { recursive: true });
  writeFileSync(path.join(worktreePath, fileName), "// own change\n", "utf-8");
  execSync(`git add ${fileName}`, { cwd: worktreePath, stdio: "pipe" });
  execSync(`git commit -m "feat(${TASK_ID}): edit ${fileName}"`, { cwd: worktreePath, stdio: "pipe" });
  return { worktreePath, baseCommitSha };
}

function workspaceExecutor(fx: WorkspaceFixture, store = createStore()): TaskExecutor {
  const executor = new TaskExecutor(store, fx.rootDir);
  (executor as any).workspaceConfig = { repos: fx.repos } as WorkspaceConfig;
  return executor;
}

describeIfGit("U1 KTD1 — per-repo capture aggregates repo-prefixed paths", () => {
  let fx: WorkspaceFixture;
  afterEach(() => fx?.cleanup());

  it("happy: edits in repo A + B are diffed against their own base and repo-prefixed", async () => {
    fx = await createWorkspaceFixture();
    const a = addRepoWorktreeWithOwnEdit(fx, "repo-a", "src/a.ts");
    const b = addRepoWorktreeWithOwnEdit(fx, "repo-b", "src/b.ts");
    const executor = workspaceExecutor(fx);
    const task = makeTask(TASK_ID, {
      branch: BRANCH,
      workspaceWorktrees: {
        "repo-a": { worktreePath: a.worktreePath, branch: BRANCH, baseCommitSha: a.baseCommitSha },
        "repo-b": { worktreePath: b.worktreePath, branch: BRANCH, baseCommitSha: b.baseCommitSha },
      },
    });

    const files = await (executor as any).captureWorkspaceModifiedFiles(task);
    expect(files).toContain("repo-a/src/a.ts");
    expect(files).toContain("repo-b/src/b.ts");
    expect(files).toHaveLength(2);
  });

  it("edge: a repo with undefined baseCommitSha still captures via merge-base fallback (no `git diff undefined..HEAD`)", async () => {
    fx = await createWorkspaceFixture();
    const a = addRepoWorktreeWithOwnEdit(fx, "repo-a", "src/a.ts");
    const executor = workspaceExecutor(fx);
    const task = makeTask(TASK_ID, {
      branch: BRANCH,
      workspaceWorktrees: {
        // baseCommitSha intentionally undefined → resolveDiffBaseRef merge-base(HEAD, main).
        "repo-a": { worktreePath: a.worktreePath, branch: BRANCH },
      },
    });

    const files = await (executor as any).captureWorkspaceModifiedFiles(task);
    expect(files).toEqual(["repo-a/src/a.ts"]);
  });

  it("contamination: a foreign commit in a sub-repo range fires the divergence audit and is excluded from attributed files", async () => {
    fx = await createWorkspaceFixture();
    const a = addRepoWorktreeWithOwnEdit(fx, "repo-a", "src/a.ts");
    // Land a FOREIGN commit (different FN-id) onto the same fusion/<id> branch range.
    const foreignFile = "src/foreign.ts";
    writeFileSync(path.join(a.worktreePath, "src", "foreign.ts"), "// foreign\n", "utf-8");
    execSync(`git add ${foreignFile}`, { cwd: a.worktreePath, stdio: "pipe" });
    execSync('git commit -m "feat(FN-OTHER): sneaky foreign change"', { cwd: a.worktreePath, stdio: "pipe" });

    const dbAudit = vi.fn().mockResolvedValue(undefined);
    const audit = {
      database: dbAudit,
      filesystem: vi.fn().mockResolvedValue(undefined),
      git: vi.fn().mockResolvedValue(undefined),
    };
    const executor = workspaceExecutor(fx);
    const task = makeTask(TASK_ID, {
      branch: BRANCH,
      workspaceWorktrees: {
        "repo-a": { worktreePath: a.worktreePath, branch: BRANCH, baseCommitSha: a.baseCommitSha },
      },
    });

    const files = await (executor as any).captureWorkspaceModifiedFiles(task, audit as any, "post-session");
    // Own file attributed, foreign file excluded from the attributed set.
    expect(files).toEqual(["repo-a/src/a.ts"]);
    expect(files).not.toContain("repo-a/src/foreign.ts");
    // The contamination/divergence audit fired for this repo (raw 2 files vs attributed 1).
    const contaminationCall = dbAudit.mock.calls.find(
      ([evt]) => evt?.type === "task:worktree-contamination-detected",
    );
    expect(contaminationCall).toBeTruthy();
    expect(contaminationCall![0].metadata.rawDiffFileCount).toBeGreaterThan(contaminationCall![0].metadata.attributedFileCount);
  });
});

describeIfGit("U1 KTD2 — verifyWorktreeInvariants iterates per worktree, preserving the result union", () => {
  let fx: WorkspaceFixture;
  afterEach(() => fx?.cleanup());

  it("happy: every worktree on fusion/<id> with matching toplevel → {ok:true}", async () => {
    fx = await createWorkspaceFixture();
    const a = addRepoWorktreeWithOwnEdit(fx, "repo-a", "src/a.ts");
    const b = addRepoWorktreeWithOwnEdit(fx, "repo-b", "src/b.ts");
    const executor = workspaceExecutor(fx);
    const task = makeTask(TASK_ID, {
      branch: BRANCH,
      workspaceWorktrees: {
        "repo-a": { worktreePath: a.worktreePath, branch: BRANCH, baseCommitSha: a.baseCommitSha },
        "repo-b": { worktreePath: b.worktreePath, branch: BRANCH, baseCommitSha: b.baseCommitSha },
      },
    });

    const result = await (executor as any).verifyWorktreeInvariants(task);
    expect(result).toEqual({ ok: true });
  });

  it("error: a worktree HEAD off fusion/<id> → {ok:false, reason:'wrong_branch', repo, observed, expected} (NOT {ok:true})", async () => {
    fx = await createWorkspaceFixture();
    const a = addRepoWorktreeWithOwnEdit(fx, "repo-a", "src/a.ts");
    const b = addRepoWorktreeWithOwnEdit(fx, "repo-b", "src/b.ts");
    // Drift repo-b's worktree off fusion/<id> onto a different branch.
    execSync("git checkout -b some-other-branch", { cwd: b.worktreePath, stdio: "pipe" });
    const executor = workspaceExecutor(fx);
    const task = makeTask(TASK_ID, {
      branch: BRANCH,
      workspaceWorktrees: {
        "repo-a": { worktreePath: a.worktreePath, branch: BRANCH, baseCommitSha: a.baseCommitSha },
        "repo-b": { worktreePath: b.worktreePath, branch: BRANCH, baseCommitSha: b.baseCommitSha },
      },
    });

    const result = await (executor as any).verifyWorktreeInvariants(task);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("wrong_branch");
    expect(result.repo).toBe("repo-b");
    expect(result.observed).toBe("some-other-branch");
    expect(result.expected).toBe(BRANCH);
  });

  /*
  FN-9060 (ebd345da0f) intentionally replaced the old vacuous {ok:true} for an UNPROVEN zero-acquire
  workspace map: completion verification and per-repo review now classify the empty map through the
  shared classifyWorkspaceZeroAcquire predicate, so an unproven empty map fails closed as no_commits
  and only proven commit-free work (noCommitsExpected / no-op sentinel / prompt-derived eligibility)
  verifies clean. Assert both halves of that contract.
  */
  it("regression (FN-9060): an UNPROVEN zero-acquire workspace task (empty map) fails closed as no_commits", async () => {
    fx = await createWorkspaceFixture();
    const executor = workspaceExecutor(fx);
    const task = makeTask(TASK_ID, { branch: BRANCH, workspaceWorktrees: {} });
    const result = await (executor as any).verifyWorktreeInvariants(task);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("no_commits");
  });

  it("regression (FN-9060): a PROVEN commit-free zero-acquire workspace task (noCommitsExpected) verifies clean", async () => {
    fx = await createWorkspaceFixture();
    const executor = workspaceExecutor(fx);
    const task = makeTask(TASK_ID, { branch: BRANCH, workspaceWorktrees: {}, noCommitsExpected: true });
    const result = await (executor as any).verifyWorktreeInvariants(task);
    expect(result).toEqual({ ok: true });
  });
});

describeIfGit("U1 — single-repo (non-workspace) task: capture/verify unchanged", () => {
  let fx: WorkspaceFixture;
  afterEach(() => fx?.cleanup());

  it("regression: non-workspace verifyWorktreeInvariants still runs the singular path and passes for a real worktree", async () => {
    fx = await createWorkspaceFixture();
    // Single-repo executor rooted at repo-a itself (no workspaceConfig).
    const repoDir = fx.repoPath("repo-a");
    const worktreePath = path.join(repoDir, ".worktrees", "fn-001");
    const base = execSync("git rev-parse HEAD", { cwd: repoDir, encoding: "utf-8" }).trim();
    execSync(`git worktree add -b fusion/fn-001 ${worktreePath} HEAD`, { cwd: repoDir, stdio: "pipe" });
    configureIdentity(worktreePath);
    writeFileSync(path.join(worktreePath, "single.ts"), "// x\n", "utf-8");
    execSync("git add single.ts", { cwd: worktreePath, stdio: "pipe" });
    execSync('git commit -m "feat(FN-001): single"', { cwd: worktreePath, stdio: "pipe" });

    const store = createStore();
    const executor = new TaskExecutor(store, repoDir); // no workspaceConfig → singular path
    const task = makeTask("FN-001", { branch: "fusion/fn-001", worktree: worktreePath, baseCommitSha: base });

    const result = await (executor as any).verifyWorktreeInvariants(task);
    expect(result).toEqual({ ok: true });
  });
});
