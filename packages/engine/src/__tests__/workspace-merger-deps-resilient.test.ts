/*
FNXC:Workspace 2026-06-24-23:50 (resilient workspace land — dependency-sync failure):
A workspace per-repo land must NOT be blocked by one sub-repo whose clean-room `npm install`
fails (e.g. a corrupt `-@0.0.1` lockfile entry npm 11 rejects). The git squash does not need
installed deps; only dep-dependent merge verification degrades. landWorkspaceTask sets
`nonFatalDependencySync` on landOneRepo so the install throw is caught, logged, and the land
proceeds. The single-repo land path keeps the documented HARD-fail (flag defaults off).

We drive the REAL landWorkspaceTask / landOneRepo against a REAL git fixture with injected
agents (the squash is a plain `git merge --squash`, no AI), and MOCK installWorktreeDependencies
to throw — so no real/slow/networked npm runs (FN-5048).
*/
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import type { Task, TaskStore } from "@fusion/core";

vi.mock("../merge/merge-dependency-sync.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../merge/merge-dependency-sync.js")>();
  return { ...actual, installWorktreeDependencies: vi.fn() };
});

import { installWorktreeDependencies } from "../merge/merge-dependency-sync.js";
import { landWorkspaceTask, landOneRepo } from "../merge/merger-ai.js";
import { createRunAuditor, generateSyntheticRunId } from "../util/run-audit.js";
import { createWorkspaceFixture, hasGit, type WorkspaceFixture } from "./_workspace-fixture.js";

const describeIfGit = hasGit ? describe : describe.skip;
const TASK_ID = "FN-3001";
const BRANCH = "fusion/fn-3001";
const NPM_FAILURE = new Error("Dependency sync failed for FN-3001: npm error EINVALIDPACKAGENAME Invalid package name \"-\" of package \"-@0.0.1\"");

function configureIdentity(dir: string): void {
  execSync('git config user.email "test@example.com"', { cwd: dir, stdio: "pipe" });
  execSync('git config user.name "Test"', { cwd: dir, stdio: "pipe" });
}

function createStore(): TaskStore & { logs: string[] } {
  const emitter = new EventEmitter();
  const logs: string[] = [];
  return Object.assign(emitter, {
    logs,
    getSettings: vi.fn().mockResolvedValue({ autoMerge: false }),
    updateTask: vi.fn().mockResolvedValue(undefined),
    logEntry: vi.fn((_id: string, message: string) => { logs.push(message); return Promise.resolve(undefined); }),
    appendAgentLog: vi.fn().mockResolvedValue(undefined),
    // mergeAndReview reads store.getTask().comments for prompt context — return a real task shape.
    getTask: vi.fn().mockResolvedValue({ id: TASK_ID, column: "in-review", branch: BRANCH, comments: [], steeringComments: [], steps: [], log: [] }),
    moveTask: vi.fn().mockResolvedValue({ id: TASK_ID, column: "done" } as Task),
    upsertTaskCommitAssociation: vi.fn().mockResolvedValue(undefined),
    accumulateTokenUsage: vi.fn().mockResolvedValue(undefined),
  }) as unknown as TaskStore & { logs: string[] };
}

function addRepoBranchWithEdit(fx: WorkspaceFixture, repoRel: string, content: string): void {
  const repoDir = fx.repoPath(repoRel);
  const wt = path.join(repoDir, ".wt-branch");
  fx.git(repoRel, `git worktree add -b ${BRANCH} ${wt} HEAD`);
  configureIdentity(wt);
  writeFileSync(path.join(wt, "feature.txt"), content, "utf-8");
  execSync("git add feature.txt", { cwd: wt, stdio: "pipe" });
  execSync(`git commit -m "feat(${TASK_ID}): add feature in ${repoRel}"`, { cwd: wt, stdio: "pipe" });
  fx.git(repoRel, `git worktree remove --force ${wt}`);
}

const squashMergeAgent = async (cwd: string): Promise<void> => {
  configureIdentity(cwd);
  try { execSync(`git merge --squash ${BRANCH}`, { cwd, stdio: "pipe" }); } catch { /* conflicts handled below */ }
  const unmerged = execSync("git ls-files -u", { cwd, encoding: "utf-8" }).trim();
  if (unmerged.length > 0) throw new Error("merge conflict: unresolved paths in clean room");
  const staged = execSync("git diff --cached --name-only", { cwd, encoding: "utf-8" }).trim();
  if (staged.length === 0) return;
  execSync(`git commit -m "${BRANCH}: squashed"`, { cwd, stdio: "pipe" });
};
const approveReviewAgent = async (): Promise<string> => "REVIEW_VERDICT: approve";

function makeTask(workspaceWorktrees: Task["workspaceWorktrees"]): Task {
  return {
    id: TASK_ID, title: "Workspace merge task", description: "", column: "in-review",
    branch: BRANCH, dependencies: [], steps: [], currentStep: 0, log: [], workspaceWorktrees,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  } as Task;
}

describeIfGit("workspace land — dependency-sync failure resilience", () => {
  let fx: WorkspaceFixture;
  afterEach(() => fx?.cleanup());

  it("lands ALL sub-repos even when clean-room dependency sync fails (non-fatal)", async () => {
    vi.mocked(installWorktreeDependencies).mockRejectedValue(NPM_FAILURE);
    fx = await createWorkspaceFixture(["repo-a", "repo-b"]);
    addRepoBranchWithEdit(fx, "repo-a", "a feature\n");
    addRepoBranchWithEdit(fx, "repo-b", "b feature\n");

    const tipABefore = fx.git("repo-a", "git rev-parse refs/heads/main");
    const store = createStore();
    const task = makeTask({
      "repo-a": { worktreePath: fx.repoPath("repo-a"), branch: BRANCH },
      "repo-b": { worktreePath: fx.repoPath("repo-b"), branch: BRANCH },
    });

    const result = await landWorkspaceTask(store, task, fx.rootDir, {}, {
      mergeAgent: squashMergeAgent,
      reviewAgent: approveReviewAgent,
    });

    // Despite every per-repo install throwing, both repos land and the integration ref advances.
    expect(result.allLanded).toBe(true);
    for (const r of result.repos) expect(r.status).toBe("landed");
    expect(fx.git("repo-a", "git rev-parse refs/heads/main")).not.toBe(tipABefore);
    // The degradation is surfaced, not swallowed silently.
    expect(store.logs.some((m) => /dependency sync FAILED/i.test(m) && /deps unavailable/i.test(m))).toBe(true);
  });

  it("single-repo land (flag off) still HARD-fails on a dependency-sync failure", async () => {
    vi.mocked(installWorktreeDependencies).mockRejectedValue(NPM_FAILURE);
    fx = await createWorkspaceFixture(["repo-a"]);
    addRepoBranchWithEdit(fx, "repo-a", "a feature\n");
    const store = createStore();
    const audit = createRunAuditor(store, { runId: generateSyntheticRunId("ai-merge", TASK_ID), agentId: "merger", taskId: TASK_ID, phase: "merge" });

    // landOneRepo WITHOUT nonFatalDependencySync → the documented hard-fail must propagate.
    await expect(
      landOneRepo(fx.repoPath("repo-a"), BRANCH, "main", {
        taskId: TASK_ID, settings: { autoMerge: false } as never, audit,
        log: async () => undefined, setStatus: async () => undefined, maxPasses: 1,
        mergeAgent: squashMergeAgent, reviewAgent: approveReviewAgent, stashResolveAgent: async () => undefined,
        includeTaskId: true, trailers: [], store,
        // nonFatalDependencySync intentionally omitted (defaults off)
      }),
    ).rejects.toThrow(/Invalid package name/);
  });
});
