/*
FNXC:Workspace 2026-06-22-00:30:
U2 KTD4 — per-repo fn_task_done completion verification: per-repo scope-leak guard + per-repo worktree-invariant
verify. These drive the REAL TaskExecutor methods against a REAL two-repo git fixture under a NON-git workspace
root (createWorkspaceFixture), so a leaked singular-root capture/verify would silently pass and the test would
catch it. Narrow seams (FN-5048): we set `(executor as any).workspaceConfig` directly and stub only the store
methods the guards read (parseFileScopeFromPrompt, logEntry, getRunContextFor) — no mock-the-world child_process.

Coverage:
- scope-leak error: an uncommitted in-scope vs OFF-scope change in repo A → evaluateTaskDoneScopeLeak blocks,
  message NAMES repo-a (per-repo guard fires; singular root would silently pass).
- verify error: a worktree HEAD off fusion/<id> → verifyWorktreeInvariants blocks (wrong_branch, repo-tagged).
- all-clean: a two-repo task with only in-scope changes → scope-leak does NOT block.
- helper: deriveRepoForPath / deriveRepoScopeSubset / splitRepoScopedPath unit cases (wolf-server/src/** → wolf-server;
  non-matching first segment → unscoped).
- regression: single-repo (non-workspace) task → singular scope-leak path unchanged.
*/
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Task, TaskStore, WorkspaceConfig, Settings } from "@fusion/core";
import { TaskExecutor } from "../executor.js";
import {
  deriveRepoForPath,
  deriveRepoScopeSubset,
  splitRepoScopedPath,
  UNSCOPED_REPO,
} from "../workspace-paths.js";
import { createWorkspaceFixture, hasGit, type WorkspaceFixture } from "./_workspace-fixture.js";

const describeIfGit = hasGit ? describe : describe.skip;

const TASK_ID = "FN-1001";
const BRANCH = "fusion/fn-1001";

// reviewLevel=1 + block enforcement is the only mode that BLOCKS (else warn).
const SETTINGS: Settings = { autoMerge: false, planOnlyScopeLeakEnforcement: "block" } as Settings;
const PROMPT = "## Review Level: 1 (Plan Only)\n";

function createStore(declaredScope: string[]): TaskStore & EventEmitter {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    parseFileScopeFromPrompt: vi.fn().mockResolvedValue(declaredScope),
    logEntry: vi.fn().mockResolvedValue(undefined),
    getRunContextFor: vi.fn(),
    getSettings: vi.fn().mockResolvedValue(SETTINGS),
  }) as unknown as TaskStore & EventEmitter;
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: TASK_ID,
    title: "WS",
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

function configureIdentity(dir: string): void {
  execSync('git config user.email "test@example.com"', { cwd: dir, stdio: "pipe" });
  execSync('git config user.name "Test"', { cwd: dir, stdio: "pipe" });
}

/** Add a fusion/<id> worktree to a sub-repo with one committed in-scope edit; return its handle. */
function addRepoWorktree(fx: WorkspaceFixture, repoRel: string, fileName: string): { worktreePath: string; baseCommitSha: string } {
  const repoDir = fx.repoPath(repoRel);
  const baseCommitSha = fx.git(repoRel, "git rev-parse HEAD");
  const worktreePath = path.join(repoDir, ".worktrees", "fn-ws-1");
  fx.git(repoRel, `git worktree add -b ${BRANCH} ${worktreePath} HEAD`);
  configureIdentity(worktreePath);
  mkdirSync(path.dirname(path.join(worktreePath, fileName)), { recursive: true });
  writeFileSync(path.join(worktreePath, fileName), "// in-scope\n", "utf-8");
  execSync(`git add ${fileName}`, { cwd: worktreePath, stdio: "pipe" });
  execSync(`git commit -m "feat(${TASK_ID}): edit ${fileName}"`, { cwd: worktreePath, stdio: "pipe" });
  return { worktreePath, baseCommitSha };
}

function workspaceExecutor(fx: WorkspaceFixture, store: TaskStore & EventEmitter): TaskExecutor {
  const executor = new TaskExecutor(store, fx.rootDir);
  (executor as any).workspaceConfig = { repos: fx.repos } as WorkspaceConfig;
  return executor;
}

describe("U2 — workspace-paths repo-prefix helper (unit)", () => {
  const repos = ["wolf-server", "repo-a", "apps/web"];
  it("deriveRepoForPath: first-segment match → that repo", () => {
    expect(deriveRepoForPath("wolf-server/src/index.ts", repos)).toBe("wolf-server");
    expect(deriveRepoForPath("repo-a/src/a.ts", repos)).toBe("repo-a");
  });
  it("deriveRepoForPath: longest nested-key match wins", () => {
    expect(deriveRepoForPath("apps/web/page.tsx", repos)).toBe("apps/web");
  });
  it("deriveRepoForPath: non-matching first segment → unscoped", () => {
    expect(deriveRepoForPath(".changeset/x.md", repos)).toBe(UNSCOPED_REPO);
    expect(deriveRepoForPath("other/thing.ts", repos)).toBe(UNSCOPED_REPO);
    expect(deriveRepoForPath("repo-ab/x.ts", repos)).toBe(UNSCOPED_REPO); // segment-wise, not substring
  });
  it("splitRepoScopedPath: strips the repo prefix for the repo-local remainder", () => {
    expect(splitRepoScopedPath("wolf-server/src/x.ts", repos)).toEqual({ repo: "wolf-server", relativePath: "src/x.ts" });
    expect(splitRepoScopedPath("other/x.ts", repos)).toEqual({ repo: UNSCOPED_REPO, relativePath: "other/x.ts" });
  });
  it("deriveRepoScopeSubset: returns repo-local scope patterns for one repo", () => {
    const scope = ["wolf-server/src/**", "repo-a/lib/x.ts", "apps/web/page.tsx"];
    expect(deriveRepoScopeSubset(scope, "wolf-server")).toEqual(["src/**"]);
    expect(deriveRepoScopeSubset(scope, "repo-a")).toEqual(["lib/x.ts"]);
    // repo-root scope entry maps to whole-repo **
    expect(deriveRepoScopeSubset(["repo-a"], "repo-a")).toEqual(["**"]);
  });
});

describeIfGit("U2 KTD4 — per-repo scope-leak guard in fn_task_done", () => {
  let fx: WorkspaceFixture;
  afterEach(() => fx?.cleanup());

  it("error: an off-scope change in repo A blocks completion and NAMES repo-a", async () => {
    fx = await createWorkspaceFixture();
    const a = addRepoWorktree(fx, "repo-a", "src/a.ts");
    const b = addRepoWorktree(fx, "repo-b", "src/b.ts");
    // Off-scope STAGED-but-uncommitted change in repo-a (outside declared `repo-a/src/**`).
    // captureUncommittedModifiedFiles reads `git diff`/`--cached`, so the leak must be tracked
    // (staged) to register — an untracked file is invisible to the guard by design.
    writeFileSync(path.join(a.worktreePath, "OFFSCOPE.md"), "// leak\n", "utf-8");
    execSync("git add OFFSCOPE.md", { cwd: a.worktreePath, stdio: "pipe" });
    // Declared scope is repo-prefixed and only covers src/** in each repo.
    const store = createStore(["repo-a/src/**", "repo-b/src/**"]);
    const executor = workspaceExecutor(fx, store);
    const task = makeTask({
      branch: BRANCH,
      workspaceWorktrees: {
        "repo-a": { worktreePath: a.worktreePath, branch: BRANCH, baseCommitSha: a.baseCommitSha },
        "repo-b": { worktreePath: b.worktreePath, branch: BRANCH, baseCommitSha: b.baseCommitSha },
      },
    });

    const result = await (executor as any).evaluateTaskDoneScopeLeak(task, fx.rootDir, PROMPT, SETTINGS);
    expect(result.blocked).toBe(true);
    expect(result.message).toContain("repo-a");
    expect(result.message).toContain("OFFSCOPE.md");
  });

  it("all-clean: only in-scope changes in both repos → not blocked", async () => {
    fx = await createWorkspaceFixture();
    const a = addRepoWorktree(fx, "repo-a", "src/a.ts");
    const b = addRepoWorktree(fx, "repo-b", "src/b.ts");
    const store = createStore(["repo-a/src/**", "repo-b/src/**"]);
    const executor = workspaceExecutor(fx, store);
    const task = makeTask({
      branch: BRANCH,
      workspaceWorktrees: {
        "repo-a": { worktreePath: a.worktreePath, branch: BRANCH, baseCommitSha: a.baseCommitSha },
        "repo-b": { worktreePath: b.worktreePath, branch: BRANCH, baseCommitSha: b.baseCommitSha },
      },
    });

    const result = await (executor as any).evaluateTaskDoneScopeLeak(task, fx.rootDir, PROMPT, SETTINGS);
    expect(result.blocked).toBe(false);
  });

  // FNXC:Workspace 2026-06-21-15:00: F5 — per-repo `.changeset/` carve-out honored in workspace mode.
  // A legit sub-repo changeset (`repo-a/.changeset/x.md`) must NOT be flagged off-scope: the always-allowed
  // filter now runs against the repo-LOCAL remainder (`.changeset/x.md`), so the carve-out matches. Before
  // the fix the file was prefixed BEFORE filtering, the `.changeset/` startsWith never matched, and
  // fn_task_done was wrongly REFUSED.
  it("F5: a sub-repo `.changeset/` file is NOT flagged off-scope (always-allowed honored)", async () => {
    fx = await createWorkspaceFixture();
    const a = addRepoWorktree(fx, "repo-a", "src/a.ts");
    const b = addRepoWorktree(fx, "repo-b", "src/b.ts");
    // A per-repo changeset OUTSIDE the declared `repo-a/src/**` scope — only the always-allowed
    // carve-out can keep this from being a leak.
    mkdirSync(path.join(a.worktreePath, ".changeset"), { recursive: true });
    writeFileSync(path.join(a.worktreePath, ".changeset", "tidy-foo.md"), "---\n'@x': patch\n---\n", "utf-8");
    execSync("git add .changeset/tidy-foo.md", { cwd: a.worktreePath, stdio: "pipe" });
    const store = createStore(["repo-a/src/**", "repo-b/src/**"]);
    const executor = workspaceExecutor(fx, store);
    const task = makeTask({
      branch: BRANCH,
      workspaceWorktrees: {
        "repo-a": { worktreePath: a.worktreePath, branch: BRANCH, baseCommitSha: a.baseCommitSha },
        "repo-b": { worktreePath: b.worktreePath, branch: BRANCH, baseCommitSha: b.baseCommitSha },
      },
    });

    const result = await (executor as any).evaluateTaskDoneScopeLeak(task, fx.rootDir, PROMPT, SETTINGS);
    expect(result.blocked).toBe(false);
  });

  // FNXC:Workspace 2026-06-21-15:00: F2 — scoped task that acquired ZERO sub-repo worktrees is blocked.
  // declaredScope is non-empty but `workspaceWorktrees` is empty → scope cannot be verified at all. The
  // guard must refuse fn_task_done rather than silently aggregating zero off-scope files and passing.
  it("F2: scoped task with zero acquired worktrees → blocked (cannot verify scope)", async () => {
    fx = await createWorkspaceFixture();
    const store = createStore(["repo-a/src/**"]);
    const executor = workspaceExecutor(fx, store);
    const task = makeTask({ branch: BRANCH, workspaceWorktrees: {} });

    const result = await (executor as any).evaluateTaskDoneScopeLeak(task, fx.rootDir, PROMPT, SETTINGS);
    expect(result.blocked).toBe(true);
    expect(result.message).toContain("acquired no sub-repo worktrees");
  });

  // FNXC:Workspace 2026-06-21-15:00: F1 — fail CLOSED on a mid-loop capture throw.
  // If one repo's capture throws (scope is UNVERIFIED for that repo), the guard must BLOCK naming the
  // repo — not let the outer `.catch()` fail open and proceed with an incomplete scope check.
  it("F1: a mid-loop capture throw → blocked (fail-closed), names the repo", async () => {
    fx = await createWorkspaceFixture();
    const a = addRepoWorktree(fx, "repo-a", "src/a.ts");
    const b = addRepoWorktree(fx, "repo-b", "src/b.ts");
    const store = createStore(["repo-a/src/**", "repo-b/src/**"]);
    const executor = workspaceExecutor(fx, store);
    // Narrow seam: force the per-repo uncommitted capture to throw for repo-a's worktree only.
    const realCapture = (executor as any).captureUncommittedModifiedFiles.bind(executor);
    vi.spyOn(executor as any, "captureUncommittedModifiedFiles").mockImplementation(async (wt: unknown) => {
      if (wt === a.worktreePath) throw new Error("simulated capture failure");
      return realCapture(wt as string);
    });
    const task = makeTask({
      branch: BRANCH,
      workspaceWorktrees: {
        "repo-a": { worktreePath: a.worktreePath, branch: BRANCH, baseCommitSha: a.baseCommitSha },
        "repo-b": { worktreePath: b.worktreePath, branch: BRANCH, baseCommitSha: b.baseCommitSha },
      },
    });

    const result = await (executor as any).evaluateTaskDoneScopeLeak(task, fx.rootDir, PROMPT, SETTINGS);
    expect(result.blocked).toBe(true);
    expect(result.message).toContain("repo-a");
    expect(result.message).toContain("refusing fn_task_done");
  });
});

describeIfGit("U2 KTD4 — per-repo worktree-invariant verify in fn_task_done", () => {
  let fx: WorkspaceFixture;
  afterEach(() => fx?.cleanup());

  it("error: a worktree off fusion/<id> blocks completion via per-repo verify", async () => {
    fx = await createWorkspaceFixture();
    const a = addRepoWorktree(fx, "repo-a", "src/a.ts");
    const b = addRepoWorktree(fx, "repo-b", "src/b.ts");
    execSync("git checkout -b drifted-branch", { cwd: b.worktreePath, stdio: "pipe" });
    const store = createStore(["repo-a/src/**", "repo-b/src/**"]);
    const executor = workspaceExecutor(fx, store);
    const task = makeTask({
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
  });
});

describeIfGit("U2 — single-repo (non-workspace) task: scope-leak unchanged", () => {
  let fx: WorkspaceFixture;
  afterEach(() => fx?.cleanup());

  it("regression: singular scope-leak path still flags an off-scope change in the singular worktree", async () => {
    fx = await createWorkspaceFixture();
    const repoDir = fx.repoPath("repo-a");
    const worktreePath = path.join(repoDir, ".worktrees", "fn-001");
    const base = execSync("git rev-parse HEAD", { cwd: repoDir, encoding: "utf-8" }).trim();
    execSync(`git worktree add -b fusion/fn-001 ${worktreePath} HEAD`, { cwd: repoDir, stdio: "pipe" });
    configureIdentity(worktreePath);
    // Off-scope STAGED change (declared scope is `src/**`). Tracked so the guard sees it.
    writeFileSync(path.join(worktreePath, "OFFSCOPE.md"), "// leak\n", "utf-8");
    execSync("git add OFFSCOPE.md", { cwd: worktreePath, stdio: "pipe" });

    const store = createStore(["src/**"]);
    const executor = new TaskExecutor(store, repoDir); // no workspaceConfig → singular path
    const task = makeTask({ id: "FN-001", branch: "fusion/fn-001", worktree: worktreePath, baseCommitSha: base });

    const result = await (executor as any).evaluateTaskDoneScopeLeak(task, worktreePath, PROMPT, SETTINGS);
    expect(result.blocked).toBe(true);
    expect(result.message).toContain("OFFSCOPE.md");
    // Singular message carries no repo tag.
    expect(result.message).not.toContain("repo=");
  });
});
