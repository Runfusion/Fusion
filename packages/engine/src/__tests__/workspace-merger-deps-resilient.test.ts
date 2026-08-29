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
  const liveTask: Record<string, unknown> = {
    id: TASK_ID, column: "in-review", branch: BRANCH, comments: [], steeringComments: [], steps: [], log: [],
  };
  return Object.assign(emitter, {
    logs,
    getSettings: vi.fn().mockResolvedValue({ autoMerge: false }),
    updateTask: vi.fn(async (_id: string, patch: Record<string, unknown>) => { Object.assign(liveTask, patch); return liveTask; }),
    /* FNXC:EngineTests 2026-08-23-18:42: the AI merge review-reconciliation loop persists its episode
       through the compare-and-set store method and then RE-READS it via getTask to prove the episode
       was not invalidated. A fake missing the method fails the land outright; a fake whose write does
       not round-trip through getTask makes every pass look invalidated and the loop never settles.
       Both are mock drift, not product behaviour, so this fake mutates one live task object. */
    updateTaskAtomic: vi.fn(async (_id: string, updater: (current: Record<string, unknown>) => Record<string, unknown> | undefined) => {
      const patch = await updater(liveTask);
      if (patch) Object.assign(liveTask, patch);
      return liveTask;
    }),
    logEntry: vi.fn((_id: string, message: string) => { logs.push(message); return Promise.resolve(undefined); }),
    appendAgentLog: vi.fn().mockResolvedValue(undefined),
    // mergeAndReview reads store.getTask().comments for prompt context — return a real task shape.
    getTask: vi.fn(async () => liveTask),
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
    /* FNXC:RepositoryScope 2026-08-23-18:41: FN-120 made landing fail closed on any repository that
       carries a diff but is absent from the task's CONFIRMED repository scope, so a workspace merge
       fixture must now state which repositories it meant to change. Both sub-repos here carry the
       branch commit under test; declaring them confirmed states the intent this fixture always had,
       and leaving the scope unset would be asserting the out-of-scope refusal instead of the
       dependency-sync resilience under test. */
    repositoryScope: {
      repositories: Object.keys(workspaceWorktrees ?? {}),
      state: "confirmed",
      confirmedBy: "plan",
      revision: 1,
    },
    /* FNXC:WorkspaceFinalization 2026-08-23-18:41: landing refuses to convert FRESH boundary evidence
       into APPROVED evidence — a qualified file at the merge boundary that the persisted review
       snapshot never saw has no reviewer episode behind it. `addRepoBranchWithEdit` commits exactly
       one `feature.txt` per repo, so this is the snapshot the (approving) review saw. */
    modifiedFiles: Object.keys(workspaceWorktrees ?? {}).map((repository) => `${repository}/feature.txt`),
    /* FNXC:RequiredPreMergeSteps 2026-08-23-00:20: merge-mechanics fixture, not a review-gating one.
       The door refuses a card whose enabled optional pre-merge groups produced no result, and the
       built-in workflow enables Plan and Code Review by default, so an unspecified list failed the
       door before the behaviour under test ran. An explicit empty list states the intent. */
    enabledWorkflowSteps: [],
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
