/*
FNXC:Workspace 2026-06-22-00:30:
U2 KTD3 — per-repo review (BOTH call sites) + conjunction aggregation tests. The reviewer is an AGENT
spawned with `cwd = worktree`; per-repo review means ONE reviewer agent per sub-repo with the CALLERS
looping the single-cwd `reviewStep`. These tests assert the LOOP + aggregation, not the reviewer's content:
`reviewStep` is mocked (the narrow AI seam — FN-5048: no mock-the-world, no real AI spawn) and we record
the cwd of each call. Coverage:
- conjunction: two-repo task → two reviewer passes (one per repo cwd); review record reflects both; reviewed
  only when BOTH pass; one repo REVISE → aggregate REVISE tagged with that repo.
- finding tag: a finding in repo B is repo-tagged in the aggregated review body.
- in-session seam (createReviewStepTool / fn_review_step): DELETED in U10 (R9) along with the tool.
  The per-sub-repo loop and externalReviewCheckout resolution it covered are the SAME shared helpers the
  surviving step-inversion seam exercises below, so the invariant keeps full coverage on the graph path.
- step-inversion seam (createAuthoritativeWorkflowSeams().stepReview, executor.ts:5668): same — each sub-repo, not root.
- regression: single-repo (non-workspace) task → exactly one reviewStep call at the singular worktree.
*/
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReviewResult } from "../execution/reviewer.js";

// Narrow AI seam: only reviewStep (the agent boundary) is mocked. Everything else is the real executor.
vi.mock("../execution/reviewer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../execution/reviewer.js")>();
  return { ...actual, reviewStep: vi.fn() };
});

vi.mock("../executor/worktree-capture-modified-files.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../executor/worktree-capture-modified-files.js")>();
  return {
    ...actual,
    // FNXC:RepositoryScope 2026-08-21-00:58: workspace review must use fresh capture;
    // this narrow Git seam supplies deterministic per-checkout evidence to the aggregation tests.
    captureModifiedFiles: vi.fn(async (cwd: string) => capturedFilesByCwd[cwd] ?? []),
  };
});

import { reviewStep as mockedReviewStepFn } from "../execution/reviewer.js";
import { TaskExecutor } from "../executor.js";
import { FOREACH_ACTIVE_CONTEXT_KEY } from "../workflows/workflow-node-handlers.js";
import type { Task, TaskStore, WorkspaceConfig } from "@fusion/core";

const mockedReviewStep = vi.mocked(mockedReviewStepFn);

const ROOT = "/tmp/ws-root"; // NON-git workspace root — must never be a review cwd in workspace mode.
const WT_A = "/tmp/ws-root/repo-a/.worktrees/fn-1";
const WT_B = "/tmp/ws-root/repo-b/.worktrees/fn-1";
const cleanupDirs: string[] = [];
let capturedFilesByCwd: Record<string, string[]> = {};

function makeGitCheckout(): string {
  const dir = mkdtempSync(join(tmpdir(), "fusion-review-checkout-"));
  cleanupDirs.push(dir);
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  return dir;
}

function makeFingerprintableCheckout(): { path: string; baseCommitSha: string } {
  const path = makeGitCheckout();
  execFileSync("git", ["config", "user.email", "fusion@example.test"], { cwd: path });
  execFileSync("git", ["config", "user.name", "Fusion"], { cwd: path });
  writeFileSync(join(path, "changed.ts"), "export const before = true;\n");
  execFileSync("git", ["add", "changed.ts"], { cwd: path });
  execFileSync("git", ["commit", "-m", "base"], { cwd: path, stdio: "ignore" });
  const baseCommitSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: path, encoding: "utf8" }).trim();
  writeFileSync(join(path, "changed.ts"), "export const after = true;\n");
  return { path, baseCommitSha };
}

function makeStore(task: Task): TaskStore & EventEmitter {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    getTask: vi.fn().mockResolvedValue(task),
    getSettings: vi.fn().mockResolvedValue({ autoMerge: false }),
    updateStep: vi.fn().mockResolvedValue(undefined),
    updateTaskAtomic: vi.fn(async (_id: string, updater: (current: Task) => Partial<Task> | null) => {
      const patch = updater(task);
      if (patch) Object.assign(task, patch);
      return task;
    }),
    logEntry: vi.fn().mockResolvedValue(undefined),
    getRunContextFor: vi.fn(),
    // mergeEffectiveSettings degrades to base on any resolver error; these reject → base used.
    getTaskWorkflowSelection: vi.fn().mockRejectedValue(new Error("no workflow")),
    getWorkflowDefinition: vi.fn().mockRejectedValue(new Error("no workflow")),
    getWorkflowSettingValues: vi.fn().mockRejectedValue(new Error("no workflow")),
  }) as unknown as TaskStore & EventEmitter;
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-1",
    title: "WS",
    description: "",
    column: "in-progress",
    dependencies: [],
    steps: [
      { name: "Step 0", status: "done" },
      { name: "Step 1", status: "in-progress" },
    ],
    currentStep: 1,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
    // FNXC:RepositoryScope 2026-08-20-23:07: existing conjunction fixtures represent two modified, explicitly scoped repos.
    repositoryScope: overrides.repositoryScope ?? (overrides.workspaceWorktrees && Object.keys(overrides.workspaceWorktrees).length > 0
      ? { repositories: Object.keys(overrides.workspaceWorktrees), state: "confirmed", revision: 1 }
      : undefined),
    modifiedFiles: overrides.modifiedFiles ?? (overrides.workspaceWorktrees && Object.keys(overrides.workspaceWorktrees).flatMap((repo) => [`${repo}/src/changed.ts`])),
  } as Task;
}

const TWO_REPO_WORKTREES = {
  "repo-a": { worktreePath: WT_A, branch: "fusion/fn-1", baseCommitSha: "aaa" },
  "repo-b": { worktreePath: WT_B, branch: "fusion/fn-1", baseCommitSha: "bbb" },
};

/** Script reviewStep to return a per-cwd verdict and record the cwd it was called with. */
function scriptReviewByCwd(byCwd: Record<string, ReviewResult>): string[] {
  const seenCwds: string[] = [];
  mockedReviewStep.mockImplementation((async (cwd: string) => {
    seenCwds.push(cwd);
    return byCwd[cwd] ?? { verdict: "APPROVE", review: `ok ${cwd}`, summary: `ok ${cwd}` };
  }) as any);
  return seenCwds;
}

function workspaceExecutor(store: TaskStore & EventEmitter): TaskExecutor {
  const executor = new TaskExecutor(store, ROOT);
  (executor as any).workspaceConfig = { repos: ["repo-a", "repo-b"] } as WorkspaceConfig;
  return executor;
}

beforeEach(() => {
  capturedFilesByCwd = { [WT_A]: ["src/changed.ts"], [WT_B]: ["src/changed.ts"] };
  mockedReviewStep.mockReset();
});
afterEach(() => {
  vi.clearAllMocks();
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("U2 KTD3 — reviewWorkspacePerRepo conjunction + tagging (the shared loop both call sites use)", () => {
  // FNXC:Workspace 2026-06-21-15:00: F7 — the per-repo callback is single-arg `(cwd)` now; tests map
  // cwd→repo themselves (the loop no longer passes repoRel through to runForCwd).
  const repoOfCwd = (cwd: string): string => (cwd === WT_A ? "repo-a" : cwd === WT_B ? "repo-b" : cwd);

  it("conjunction: two repos both APPROVE → aggregate APPROVE, one reviewer pass per repo cwd", async () => {
    const task = makeTask({ workspaceWorktrees: TWO_REPO_WORKTREES });
    const executor = workspaceExecutor(makeStore(task));
    const seen: string[] = [];
    const result = await (executor as any).reviewWorkspacePerRepo(task, async (cwd: string) => {
      seen.push(cwd);
      return { verdict: "APPROVE", review: `clean in ${repoOfCwd(cwd)}`, summary: `clean ${repoOfCwd(cwd)}` };
    });
    expect(seen).toEqual([WT_A, WT_B]); // one pass per sub-repo cwd, never ROOT
    expect(result.verdict).toBe("APPROVE");
    expect(result.review).toContain("repo-a");
    expect(result.review).toContain("repo-b");
  });

  it("conjunction: one repo REVISE → aggregate REVISE, tagged with the failing repo", async () => {
    const task = makeTask({ workspaceWorktrees: TWO_REPO_WORKTREES });
    const executor = workspaceExecutor(makeStore(task));
    const result = await (executor as any).reviewWorkspacePerRepo(task, async (cwd: string) => {
      const repo = repoOfCwd(cwd);
      return repo === "repo-b"
        ? { verdict: "REVISE", review: `bug in ${repo}`, summary: `revise ${repo}` }
        : { verdict: "APPROVE", review: `clean ${repo}`, summary: `clean ${repo}` };
    });
    expect(result.verdict).toBe("REVISE");
    expect(result.review).toContain("repo-b"); // finding repo-tagged
    expect(result.review).toContain("bug in repo-b");
    expect(result.summary).toMatch(/^repo-b:/);
  });

  // FNXC:Workspace 2026-06-21-15:00: F3 — break on the FIRST non-APPROVE repo.
  it("F3: repo-a APPROVE + repo-b REVISE (no throw) → aggregate REVISE tagged repo-b", async () => {
    const task = makeTask({ workspaceWorktrees: TWO_REPO_WORKTREES });
    const executor = workspaceExecutor(makeStore(task));
    const result = await (executor as any).reviewWorkspacePerRepo(task, async (cwd: string) => {
      const repo = repoOfCwd(cwd);
      return repo === "repo-a"
        ? { verdict: "APPROVE", review: "clean repo-a", summary: "clean a" }
        : { verdict: "REVISE", review: "bug repo-b", summary: "revise b" };
    });
    expect(result.verdict).toBe("REVISE");
    expect(result.summary).toMatch(/^repo-b:/);
  });

  it("F3: repo-a REVISE + repo-b throws → REVISE preserved (break before repo-b; NOT masked to UNAVAILABLE)", async () => {
    const task = makeTask({ workspaceWorktrees: TWO_REPO_WORKTREES });
    const executor = workspaceExecutor(makeStore(task));
    const seen: string[] = [];
    const result = await (executor as any).reviewWorkspacePerRepo(task, async (cwd: string) => {
      seen.push(cwd);
      if (cwd === WT_B) throw new Error("repo-b reviewer blew up");
      return { verdict: "REVISE", review: "bug repo-a", summary: "revise a" };
    });
    // repo-a recorded the first non-APPROVE and the loop BROKE, so repo-b's reviewer is never invoked.
    expect(seen).toEqual([WT_A]);
    expect(result.verdict).toBe("REVISE");
    expect(result.summary).toMatch(/^repo-a:/);
  });

  it("reviews only the modified scoped repository and records a clean peer as not reviewed", async () => {
    capturedFilesByCwd = { [WT_A]: ["src/changed.ts"], [WT_B]: [] };
    const task = makeTask({ workspaceWorktrees: TWO_REPO_WORKTREES, repositoryScope: { repositories: ["repo-a", "repo-b"], state: "confirmed", revision: 1 }, modifiedFiles: ["repo-a/src/changed.ts"] });
    const executor = workspaceExecutor(makeStore(task));
    const seen: string[] = [];
    const result = await (executor as any).reviewWorkspacePerRepo(task, async (cwd: string) => {
      seen.push(cwd);
      return { verdict: "APPROVE", review: "reviewed change", summary: "approved" };
    });
    expect(seen).toEqual([WT_A]);
    expect(result.verdict).toBe("APPROVE");
    expect(result.review).toContain("[repo-b] NOT_REVIEWED");
    expect(result.repositoryReviewOutcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({ repository: "repo-a", status: "REVIEWED", verdict: "APPROVE" }),
      expect.objectContaining({ repository: "repo-b", status: "NOT_REVIEWED", output: "No changes — not reviewed." }),
    ]));
    expect(result.repositoryScopeRevision).toBe(1);
  });

  /*
  FNXC:RepositoryScope 2026-08-20-23:23:
  MRG-041 acquires every workspace repository before planning, but only explicit intent plus
  diff evidence authorizes review. An acquired modified checkout outside that intent cannot
  consume a reviewer session or contribute a verdict.
  */
  it("never reviews an acquired modified repository outside explicit scope", async () => {
    capturedFilesByCwd = { [WT_A]: ["src/changed.ts"], [WT_B]: ["src/unrelated.ts"] };
    const task = makeTask({
      workspaceWorktrees: TWO_REPO_WORKTREES,
      repositoryScope: { repositories: ["repo-a"], state: "confirmed", revision: 1 },
      modifiedFiles: ["repo-a/src/changed.ts", "repo-b/src/unrelated.ts"],
    });
    const executor = workspaceExecutor(makeStore(task));
    const seen: string[] = [];
    const result = await (executor as any).reviewWorkspacePerRepo(task, async (cwd: string) => {
      seen.push(cwd);
      return { verdict: "APPROVE", review: "reviewed intended change", summary: "approved" };
    });

    expect(result.verdict).toBe("APPROVE");
    expect(seen).toEqual([WT_A]);
    expect(result.review).not.toContain("repo-b");
  });

  it("clean scoped repository is recorded as not reviewed without invoking a reviewer", async () => {
    capturedFilesByCwd = { [WT_A]: [], [WT_B]: [] };
    const task = makeTask({ workspaceWorktrees: TWO_REPO_WORKTREES, repositoryScope: { repositories: ["repo-a", "repo-b"], state: "confirmed", revision: 1 }, modifiedFiles: [] });
    const executor = workspaceExecutor(makeStore(task));
    const invoke = vi.fn();
    const result = await (executor as any).reviewWorkspacePerRepo(task, invoke);
    expect(result.verdict).toBe("UNAVAILABLE");
    expect(result.review).toContain("No changes — not reviewed");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("unproven zero-acquire workspace task → non-retryable UNAVAILABLE without invoking a reviewer", async () => {
    const task = makeTask({ workspaceWorktrees: {}, repositoryScope: { repositories: ["repo-a"], state: "confirmed", revision: 1 } });
    const executor = workspaceExecutor(makeStore(task));
    const invoke = vi.fn();
    const result = await (executor as any).reviewWorkspacePerRepo(task, invoke);
    expect(result.verdict).toBe("UNAVAILABLE");
    expect(result.retryable).toBe(false);
    expect(result.review).toContain("re-invocation cannot change");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("commit-free zero-acquire workspace task approves honestly without invoking a reviewer", async () => {
    const task = makeTask({ workspaceWorktrees: {}, noCommitsExpected: true, repositoryScope: { repositories: ["repo-a"], state: "confirmed", revision: 1 } });
    const executor = workspaceExecutor(makeStore(task));
    const invoke = vi.fn();
    const result = await (executor as any).reviewWorkspacePerRepo(task, invoke);
    expect(result.verdict).toBe("APPROVE");
    expect(result.review).toContain("no diff was reviewed");
    expect(result.review).toContain("explicit noCommitsExpected=true");
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("U2 KTD3 — step-inversion review seam (executor.ts:5668) loops per sub-repo", () => {
  it("workspace task: stepReview spawns one reviewer per sub-repo cwd, not active.worktreePath/root", async () => {
    const task = makeTask({ workspaceWorktrees: TWO_REPO_WORKTREES, worktree: ROOT });
    const store = makeStore(task);
    const executor = workspaceExecutor(store);
    const seen = scriptReviewByCwd({
      [WT_A]: { verdict: "APPROVE", review: "a", summary: "a" },
      [WT_B]: { verdict: "APPROVE", review: "b", summary: "b" },
    });
    const seams = executor.createAuthoritativeWorkflowSeams({ autoMerge: false } as any);
    // Drive the foreach-active step-review handler directly with a scripted active context.
    const context = {
      [FOREACH_ACTIVE_CONTEXT_KEY]: { stepIndex: 1, worktreePath: ROOT, baselineSha: "base" },
    } as any;
    const result = await seams.stepReview!(task as any, context, { type: "code", advisory: true } as any);
    expect(seen).toEqual([WT_A, WT_B]);
    expect(seen).not.toContain(ROOT);
    expect(result.verdict).toBe("APPROVE");
  });

  it("clears a matching remediation target when step-review approves the current scope", async () => {
    const repoA = makeFingerprintableCheckout();
    const repoB = makeFingerprintableCheckout();
    capturedFilesByCwd = { [repoA.path]: ["changed.ts"], [repoB.path]: ["changed.ts"] };
    const task = makeTask({
      workspaceWorktrees: {
        "repo-a": { worktreePath: repoA.path, branch: "fusion/fn-1", baseCommitSha: repoA.baseCommitSha },
        "repo-b": { worktreePath: repoB.path, branch: "fusion/fn-1", baseCommitSha: repoB.baseCommitSha },
      },
      repositoryScope: {
        repositories: ["repo-a", "repo-b"], state: "confirmed", revision: 2,
        reviewRemediation: { scopeRevision: 2, repository: "repo-b", inputSignature: "revise" },
      },
    });
    const executor = workspaceExecutor(makeStore(task));
    scriptReviewByCwd({
      [repoA.path]: { verdict: "APPROVE", review: "a", summary: "a" },
      [repoB.path]: { verdict: "APPROVE", review: "b", summary: "b" },
    });
    const seams = executor.createAuthoritativeWorkflowSeams({ autoMerge: false } as any);
    const context = { [FOREACH_ACTIVE_CONTEXT_KEY]: { stepIndex: 1, worktreePath: WT_A, baselineSha: "base" } } as any;

    await seams.stepReview!(task as any, context, { type: "code", advisory: false } as any);

    expect(task.repositoryScope?.reviewEvidence).toMatchObject({ "repo-a": expect.any(Object), "repo-b": expect.any(Object) });
    expect(task.repositoryScope?.reviewRemediation).toBeUndefined();
  });

  it("clears a matching remediation target when a custom review node approves the current scope", async () => {
    const repoA = makeFingerprintableCheckout();
    const repoB = makeFingerprintableCheckout();
    capturedFilesByCwd = { [repoA.path]: ["changed.ts"], [repoB.path]: ["changed.ts"] };
    const task = makeTask({
      workspaceWorktrees: {
        "repo-a": { worktreePath: repoA.path, branch: "fusion/fn-1", baseCommitSha: repoA.baseCommitSha },
        "repo-b": { worktreePath: repoB.path, branch: "fusion/fn-1", baseCommitSha: repoB.baseCommitSha },
      },
      repositoryScope: {
        repositories: ["repo-a", "repo-b"], state: "confirmed", revision: 2,
        reviewRemediation: { scopeRevision: 2, repository: "repo-a", inputSignature: "revise" },
      },
    });
    const executor = workspaceExecutor(makeStore(task));
    vi.spyOn(executor as any, "ensureGraphCustomNodeWorktree").mockResolvedValue(task);
    vi.spyOn(executor as any, "executeWorkflowStep").mockResolvedValue({ success: true, verdict: "APPROVE", output: "approved" });

    const result = await (executor as any).runGraphCustomNode(
      { id: "custom-code-review", kind: "prompt", config: { reviewKind: "code", prompt: "review" } },
      task,
      {},
      undefined,
    );

    expect(result).toMatchObject({ outcome: "success" });
    expect(task.repositoryScope?.reviewEvidence).toMatchObject({ "repo-a": expect.any(Object), "repo-b": expect.any(Object) });
    expect(task.repositoryScope?.reviewRemediation).toBeUndefined();
  });

  /*
  FNXC:RepositoryScope 2026-08-20-23:40:
  Plan Review is a task-document gate, not a per-repository diff gate. Even after workspace
  acquisition, one scoped coordinator produces exactly one review session before implementation.
  */
  it("discards a stale step-review callback after a repository scope revision", async () => {
    const task = makeTask({
      workspaceWorktrees: { "repo-a": TWO_REPO_WORKTREES["repo-a"] },
      repositoryScope: { repositories: ["repo-a"], state: "confirmed", revision: 2 },
      modifiedFiles: ["repo-a/src/changed.ts"],
    });
    const store = makeStore(task);
    const executor = workspaceExecutor(store);
    /*
    FNXC:RepositoryScope 2026-08-21-02:48:
    Model the P0 race precisely: evidence commits at revision 2, then an operator
    scope mutation wins before the step-inversion graph can mark its APPROVE done.
    */
    vi.mocked(store.updateTaskAtomic).mockImplementationOnce(async (_id, updater) => {
      const patch = await updater(task);
      if (patch) Object.assign(task, patch);
      task.repositoryScope = { ...task.repositoryScope!, repositories: ["repo-a", "repo-b"], revision: 3, reviewEvidence: undefined };
      return task;
    });
    mockedReviewStep.mockImplementation(async () =>
      ({ verdict: "APPROVE", review: "approved before scope mutation", summary: "approved" }));
    const seams = executor.createAuthoritativeWorkflowSeams({ autoMerge: false } as any);
    const context = { [FOREACH_ACTIVE_CONTEXT_KEY]: { stepIndex: 1, worktreePath: WT_A, baselineSha: "base" } } as any;

    const result = await seams.stepReview!(task as any, context, { type: "code", advisory: false } as any);

    expect(result.verdict).toBe("UNAVAILABLE");
    expect(result.summary).toContain("scope changed during review");
    expect(store.updateStep).not.toHaveBeenCalled();
    expect(task.repositoryScope?.reviewEvidence).toBeUndefined();
  });

  it("discards a stale custom-node callback after a repository scope revision", async () => {
    const task = makeTask({
      workspaceWorktrees: { "repo-a": TWO_REPO_WORKTREES["repo-a"] },
      repositoryScope: { repositories: ["repo-a"], state: "confirmed", revision: 2 },
      modifiedFiles: ["repo-a/src/changed.ts"],
    });
    const store = makeStore(task);
    const executor = workspaceExecutor(store);
    /* FNXC:RepositoryScope 2026-08-21-02:48: The custom-node route receives the same post-evidence/pre-completion scope mutation. */
    vi.mocked(store.updateTaskAtomic).mockImplementationOnce(async (_id, updater) => {
      const patch = await updater(task);
      if (patch) Object.assign(task, patch);
      task.repositoryScope = { ...task.repositoryScope!, repositories: ["repo-a", "repo-b"], revision: 3, reviewEvidence: undefined };
      return task;
    });
    vi.spyOn(executor as any, "ensureGraphCustomNodeWorktree").mockResolvedValue(task);
    vi.spyOn(executor as any, "executeWorkflowStep").mockResolvedValue({ success: true, verdict: "APPROVE", output: "approved before scope mutation" });

    const result = await (executor as any).runGraphCustomNode(
      { id: "custom-code-review", kind: "prompt", config: { reviewKind: "code", prompt: "review" } },
      task,
      {},
      undefined,
    );

    /* FNXC:RepositoryScope 2026-08-21-03:05: Advisory Code Review cannot convert scope supersession into a passing edge. */
    expect(result).toMatchObject({ outcome: "failure", value: "workspace-review-unavailable" });
    expect(task.repositoryScope?.reviewEvidence).toBeUndefined();
  });

  it("dispatches workspace Plan Review once through the scoped coordinator", async () => {
    const task = makeTask({
      workspaceWorktrees: TWO_REPO_WORKTREES,
      repositoryScope: { repositories: ["repo-a"], state: "confirmed", revision: 2 },
      modifiedFiles: [],
      worktree: ROOT,
    });
    const store = makeStore(task);
    const executor = workspaceExecutor(store);
    const seen = scriptReviewByCwd({ [WT_A]: { verdict: "APPROVE", review: "plan is sound", summary: "approved plan" } });
    const seams = executor.createAuthoritativeWorkflowSeams({ autoMerge: false } as any);
    const context = { [FOREACH_ACTIVE_CONTEXT_KEY]: { stepIndex: 1, worktreePath: ROOT } } as any;

    const result = await seams.stepReview!(task as any, context, { type: "plan", advisory: true } as any);

    expect(result.verdict).toBe("APPROVE");
    expect(seen).toEqual([WT_A]);
    expect(mockedReviewStep).toHaveBeenCalledTimes(1);
    expect(mockedReviewStep.mock.calls[0]?.[5]).toContain("Repository scope (task-level; review this plan once): repo-a");
  });

  it("preserves fn_task_done's persisted no-op eligibility through the production step-review seam", async () => {
    // fn_task_done persists this flag before it schedules the graph handoff; the
    // later review must not reclassify the same zero-acquire task as unproven.
    const task = makeTask({
      workspaceWorktrees: {},
      repositoryScope: { repositories: ["repo-a"], state: "confirmed", revision: 1 },
      noCommitsExpected: true,
      summary: "PREMISE STALE: implementation already exists on HEAD",
    });
    const store = makeStore(task);
    const executor = workspaceExecutor(store);
    const seams = executor.createAuthoritativeWorkflowSeams({ autoMerge: false } as any);
    const context = {
      [FOREACH_ACTIVE_CONTEXT_KEY]: { stepIndex: 1, worktreePath: ROOT, baselineSha: "base" },
    } as any;

    const result = await seams.stepReview!(task as any, context, { type: "code", advisory: false } as any);

    expect(result.verdict).toBe("APPROVE");
    expect(result.review).toContain("no diff was reviewed");
    expect(mockedReviewStep).not.toHaveBeenCalled();
  });

  it("passes unified user comments and legacy steering into workflow graph stepReview", async () => {
    const task = makeTask({
      worktree: WT_A,
      comments: [
        ...Array.from({ length: 21 }, (_, index) => ({
          id: `c-old-${index}`,
          text: `Older graph-review requirement ${index}`,
          author: "user" as const,
          createdAt: `2026-06-21T09:${String(index).padStart(2, "0")}:00.000Z`,
        })),
        { id: "c-user", text: "Unified graph-review requirement", author: "user", createdAt: "2026-06-21T10:00:00.000Z" },
        { id: "c-agent", text: "agent-only unified note", author: "agent", createdAt: "2026-06-21T10:01:00.000Z" },
      ],
      steeringComments: [
        { id: "s-user", text: "Legacy graph-review steering", author: "user", createdAt: "2026-06-21T10:02:00.000Z" },
        { id: "s-agent", text: "agent-only steering note", author: "agent", createdAt: "2026-06-21T10:03:00.000Z" },
      ],
    } as any);
    const store = makeStore(task);
    const executor = new TaskExecutor(store, ROOT);
    scriptReviewByCwd({ [WT_A]: { verdict: "APPROVE", review: "a", summary: "a" } });
    const seams = executor.createAuthoritativeWorkflowSeams({ autoMerge: false } as any);
    const context = { [FOREACH_ACTIVE_CONTEXT_KEY]: { stepIndex: 1, worktreePath: WT_A, baselineSha: "base" } } as any;

    await seams.stepReview!(task as any, context, { type: "code", advisory: true } as any);

    const options = mockedReviewStep.mock.calls[0]?.[7] as any;
    expect(options.userComments).toHaveLength(23);
    expect(options.userComments).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "c-old-0", text: "Older graph-review requirement 0", author: "user" }),
      expect.objectContaining({ id: "c-user", text: "Unified graph-review requirement", author: "user" }),
      expect.objectContaining({ id: "s-user", text: "Legacy graph-review steering", author: "user" }),
    ]));
    expect(options.userComments).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "c-agent" }),
      expect.objectContaining({ id: "s-agent" }),
    ]));
  });

  it("regression: single-repo stepReview reviews the active worktree once", async () => {
    const task = makeTask({ worktree: WT_A });
    const store = makeStore(task);
    const executor = new TaskExecutor(store, ROOT); // no workspaceConfig
    const seen = scriptReviewByCwd({ [WT_A]: { verdict: "APPROVE", review: "a", summary: "a" } });
    const seams = executor.createAuthoritativeWorkflowSeams({ autoMerge: false } as any);
    const context = { [FOREACH_ACTIVE_CONTEXT_KEY]: { stepIndex: 1, worktreePath: WT_A, baselineSha: "base" } } as any;
    await seams.stepReview!(task as any, context, { type: "code", advisory: true } as any);
    expect(seen).toEqual([WT_A]);
  });

  it("explicit external review checkout overrides the active graph worktree", async () => {
    const externalCheckout = makeGitCheckout();
    const expectedCheckout = realpathSync(externalCheckout);
    const task = makeTask({ worktree: WT_A, customFields: { reviewCheckoutPath: externalCheckout } } as any);
    const store = makeStore(task);
    const executor = new TaskExecutor(store, ROOT);
    const seen = scriptReviewByCwd({ [expectedCheckout]: { verdict: "APPROVE", review: "external", summary: "external" } });
    const seams = executor.createAuthoritativeWorkflowSeams({ autoMerge: false } as any);
    const context = { [FOREACH_ACTIVE_CONTEXT_KEY]: { stepIndex: 1, worktreePath: WT_A, baselineSha: "base" } } as any;
    await seams.stepReview!(task as any, context, { type: "code", advisory: true } as any);
    expect(seen).toEqual([expectedCheckout]);
  });
});

describe("sourceMetadata.externalReviewCheckout for workflow stepReview", () => {
  it("sourceMetadata.externalReviewCheckout overrides the active graph worktree for stepReview", async () => {
    const externalCheckout = makeGitCheckout();
    const expectedCheckout = realpathSync(externalCheckout);
    const task = makeTask({ worktree: WT_A, sourceMetadata: { externalReviewCheckout: externalCheckout } } as any);
    const store = makeStore(task);
    const executor = new TaskExecutor(store, ROOT);
    const seen = scriptReviewByCwd({ [expectedCheckout]: { verdict: "APPROVE", review: "external", summary: "external" } });
    const seams = executor.createAuthoritativeWorkflowSeams({ autoMerge: false } as any);
    const context = { [FOREACH_ACTIVE_CONTEXT_KEY]: { stepIndex: 1, worktreePath: WT_A, baselineSha: "base" } } as any;
    await seams.stepReview!(task as any, context, { type: "code", advisory: true } as any);
    expect(seen).toEqual([expectedCheckout]);
  });

  it("no metadata → stepReview reviews the task worktree (default fallback)", async () => {
    const task = makeTask({ worktree: WT_A });
    const store = makeStore(task);
    const executor = new TaskExecutor(store, ROOT);
    const seen = scriptReviewByCwd({ [WT_A]: { verdict: "APPROVE", review: "a", summary: "a" } });
    const seams = executor.createAuthoritativeWorkflowSeams({ autoMerge: false } as any);
    const context = { [FOREACH_ACTIVE_CONTEXT_KEY]: { stepIndex: 1, worktreePath: WT_A, baselineSha: "base" } } as any;
    await seams.stepReview!(task as any, context, { type: "code", advisory: true } as any);
    expect(seen).toEqual([WT_A]);
  });

  it("invalid external metadata (non-existent path) → stepReview falls back to task worktree", async () => {
    const task = makeTask({ worktree: WT_A, sourceMetadata: { externalReviewCheckout: "/nonexistent/path/918b" } } as any);
    const store = makeStore(task);
    const executor = new TaskExecutor(store, ROOT);
    const seen = scriptReviewByCwd({ [WT_A]: { verdict: "APPROVE", review: "a", summary: "a" } });
    const seams = executor.createAuthoritativeWorkflowSeams({ autoMerge: false } as any);
    const context = { [FOREACH_ACTIVE_CONTEXT_KEY]: { stepIndex: 1, worktreePath: WT_A, baselineSha: "base" } } as any;
    await seams.stepReview!(task as any, context, { type: "code", advisory: true } as any);
    expect(seen).toEqual([WT_A]);
  });

  it("workspace-mode task without explicit metadata: stepReview still reviews per sub-repo", async () => {
    const task = makeTask({ workspaceWorktrees: TWO_REPO_WORKTREES, worktree: ROOT });
    const store = makeStore(task);
    const executor = workspaceExecutor(store);
    const seen = scriptReviewByCwd({
      [WT_A]: { verdict: "APPROVE", review: "a", summary: "a" },
      [WT_B]: { verdict: "APPROVE", review: "b", summary: "b" },
    });
    const seams = executor.createAuthoritativeWorkflowSeams({ autoMerge: false } as any);
    const context = { [FOREACH_ACTIVE_CONTEXT_KEY]: { stepIndex: 1, worktreePath: ROOT, baselineSha: "base" } } as any;
    await seams.stepReview!(task as any, context, { type: "code", advisory: true } as any);
    expect(seen).toEqual([WT_A, WT_B]);
    expect(seen).not.toContain(ROOT);
  });
});
