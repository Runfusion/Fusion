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
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReviewResult } from "../execution/reviewer.js";

// Narrow AI seam: only reviewStep (the agent boundary) is mocked. Everything else is the real executor.
vi.mock("../execution/reviewer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../execution/reviewer.js")>();
  return { ...actual, reviewStep: vi.fn() };
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

function makeGitCheckout(): string {
  const dir = mkdtempSync(join(tmpdir(), "fusion-review-checkout-"));
  cleanupDirs.push(dir);
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  return dir;
}

function makeStore(task: Task): TaskStore & EventEmitter {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    getTask: vi.fn().mockResolvedValue(task),
    getSettings: vi.fn().mockResolvedValue({ autoMerge: false }),
    updateStep: vi.fn().mockResolvedValue(undefined),
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

  it("zero-acquire workspace task → UNAVAILABLE (caller routes; no fabricated APPROVE)", async () => {
    const task = makeTask({ workspaceWorktrees: {} });
    const executor = workspaceExecutor(makeStore(task));
    const invoke = vi.fn();
    const result = await (executor as any).reviewWorkspacePerRepo(task, invoke);
    expect(result.verdict).toBe("UNAVAILABLE");
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
