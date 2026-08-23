import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Task, TaskStore } from "@fusion/core";
import { landWorkspaceTask } from "../merge/merger-ai.js";
import { createWorkspaceFixture, hasGit, type WorkspaceFixture } from "./_workspace-fixture.js";

const policy = vi.hoisted(() => vi.fn());
vi.mock("../merge/merge-trait.js", () => ({ resolveMergePolicy: policy }));

const describeIfGit = hasGit ? describe : describe.skip;
const TASK_ID = "FN-9050";
const BRANCH = "fusion/fn-9050";

function addBranch(fx: WorkspaceFixture, repo: string, file = "feature.txt"): void {
  const root = fx.repoPath(repo);
  const worktree = join(root, ".fn-9050-scope");
  fx.git(repo, `git worktree add -b ${BRANCH} ${worktree} HEAD`);
  execSync('git config user.email "test@example.com" && git config user.name Test', { cwd: worktree, stdio: "pipe" });
  mkdirSync(join(worktree, file, ".."), { recursive: true });
  writeFileSync(join(worktree, file), `${repo}\n`);
  execSync("git add -A && git commit -q -m feature", { cwd: worktree, stdio: "pipe" });
  fx.git(repo, `git worktree remove --force ${worktree}`);
}

function storeFor(task: Task, scope: string[]): TaskStore & { updates: Array<Record<string, unknown>>; audit: any[] } {
  const emitter = new EventEmitter();
  const updates: Array<Record<string, unknown>> = [];
  const audit: any[] = [];
  return Object.assign(emitter, {
    updates, audit,
    getTask: vi.fn(async () => task),
    getSettings: vi.fn(async () => ({ autoMerge: false, merger: { mode: "ai", maxReviewPasses: 0 } })),
    parseFileScopeFromPrompt: vi.fn(async () => scope),
    updateTask: vi.fn(async (_id: string, patch: Record<string, unknown>) => { updates.push(patch); Object.assign(task, patch); return task; }),
    updateTaskAtomic: vi.fn(async (_id: string, updater: (current: Task) => Record<string, unknown> | null | undefined | Promise<Record<string, unknown> | null | undefined>) => {
      const patch = await updater(task);
      if (patch) Object.assign(task, patch);
      return task;
    }),
    appendAgentLog: vi.fn(async () => undefined),
    logEntry: vi.fn(async () => undefined),
    moveTask: vi.fn(async () => task),
    upsertTaskCommitAssociation: vi.fn(async () => undefined),
    accumulateTokenUsage: vi.fn(async () => undefined),
    recordRunAuditEvent: vi.fn(async (event: unknown) => { audit.push(event); }),
  }) as unknown as TaskStore & { updates: Array<Record<string, unknown>>; audit: any[] };
}

function reviewEvidence(workspaceWorktrees: NonNullable<Task["workspaceWorktrees"]>): NonNullable<Task["repositoryScope"]>["reviewEvidence"] {
  return Object.fromEntries(Object.entries(workspaceWorktrees).map(([repo, entry]) => {
    const mergeBase = execSync(`git merge-base HEAD ${entry.branch}`, { cwd: entry.worktreePath, encoding: "utf8" }).trim();
    const diff = execSync(`git diff --binary ${entry.baseCommitSha ?? mergeBase}..${entry.branch}`, { cwd: entry.worktreePath, encoding: "utf8" });
    return [repo, { fingerprint: createHash("sha256").update(diff).digest("hex"), approvedAt: new Date().toISOString() }];
  }));
}

function squashAgent(branch: string) {
  return async (cwd: string): Promise<void> => {
    execSync(`git merge --squash ${branch}`, { cwd, stdio: "pipe" });
    execSync("git add -A && git commit -q -m squash", { cwd, stdio: "pipe" });
  };
}

/**
 * FNXC:AIMerge 2026-08-15-05:36:
 * Workspace lands must check each clean-room range against that repository's
 * local File Scope subset, so a sibling repository cannot consume its scope.
 */
describeIfGit("landWorkspaceTask file-scope gates", () => {
  let fx: WorkspaceFixture;
  afterEach(() => {
    policy.mockReset();
    fx?.cleanup();
  });

  it("lands the declared repo then blocks the foreign-only repo without advancing its integration ref", async () => {
    policy.mockResolvedValue({ fileScope: "strict", fileScopeRules: [] });
    fx = await createWorkspaceFixture(["repo-a", "repo-b"]);
    addBranch(fx, "repo-a");
    /*
     * FNXC:AIMerge 2026-08-15-05:50:
     * A local sibling-prefixed name proves repo-b cannot borrow repo-a's
     * declaration through the normal repo-local path matcher.
     */
    addBranch(fx, "repo-b", "repo-a/feature.txt");
    const task = {
      id: TASK_ID, title: "workspace scope", description: "", column: "in-review", branch: BRANCH, enabledWorkflowSteps: [], /* FNXC:RequiredPreMergeSteps 2026-08-23-18:07: merge-mechanics fixture; an unspecified list makes the door refuse on default-on Plan/Code Review before the behaviour under test runs. */
      comments: [], steeringComments: [], dependencies: [], steps: [], log: [], currentStep: 0,
      workspaceWorktrees: {
        "repo-a": { worktreePath: fx.repoPath("repo-a"), branch: BRANCH },
        "repo-b": { worktreePath: fx.repoPath("repo-b"), branch: BRANCH },
      },
      repositoryScope: {
        repositories: ["repo-a", "repo-b"], state: "confirmed", revision: 1,
        // FNXC:RepositoryScope 2026-08-21-01:36: merge gate fixtures carry
        // the Code Review fingerprint required for each fresh land candidate.
        reviewEvidence: reviewEvidence({
          "repo-a": { worktreePath: fx.repoPath("repo-a"), branch: BRANCH },
          "repo-b": { worktreePath: fx.repoPath("repo-b"), branch: BRANCH },
        }),
      },
      modifiedFiles: ["repo-a/feature.txt", "repo-b/repo-a/feature.txt"],
    } as Task;
    const store = storeFor(task, ["repo-a/feature.txt"]);
    const beforeA = fx.git("repo-a", "git rev-parse main");
    const beforeB = fx.git("repo-b", "git rev-parse main");

    const result = await landWorkspaceTask(store, task, fx.rootDir, {}, {
      mergeAgent: squashAgent(BRANCH), reviewAgent: async () => "REVIEW_VERDICT: approve",
    });

    expect(result.allLanded).toBe(false);
    expect(result.repos.find((repo) => repo.repo === "repo-a")?.status).toBe("landed");
    expect(result.repos.find((repo) => repo.repo === "repo-b")?.status).toBe("failed");
    expect(fx.git("repo-a", "git rev-parse main")).not.toBe(beforeA);
    expect(fx.git("repo-b", "git rev-parse main")).toBe(beforeB);
    expect(store.audit.some((event) => event.mutationType === "merge:file-scope-violation")).toBe(true);
  });

  it("refuses landing when an acquired repository changed outside confirmed scope", async () => {
    policy.mockResolvedValue({ fileScope: "strict", fileScopeRules: [] });
    fx = await createWorkspaceFixture(["repo-a", "repo-b"]);
    addBranch(fx, "repo-a");
    addBranch(fx, "repo-b", "unapproved.ts");
    const task = {
      id: TASK_ID, title: "workspace scope", description: "", column: "in-review", branch: BRANCH, enabledWorkflowSteps: [], /* FNXC:RequiredPreMergeSteps 2026-08-23-18:07: merge-mechanics fixture; an unspecified list makes the door refuse on default-on Plan/Code Review before the behaviour under test runs. */
      comments: [], steeringComments: [], dependencies: [], steps: [], log: [], currentStep: 0,
      workspaceWorktrees: {
        "repo-a": { worktreePath: fx.repoPath("repo-a"), branch: BRANCH },
        "repo-b": { worktreePath: fx.repoPath("repo-b"), branch: BRANCH },
      },
      repositoryScope: {
        repositories: ["repo-a"], state: "confirmed", revision: 1,
        reviewEvidence: reviewEvidence({ "repo-a": { worktreePath: fx.repoPath("repo-a"), branch: BRANCH } }),
      },
      modifiedFiles: ["repo-a/feature.txt"],
    } as Task;
    const store = storeFor(task, ["repo-a/feature.txt"]);
    const beforeA = fx.git("repo-a", "git rev-parse main");

    await expect(landWorkspaceTask(store, task, fx.rootDir, {}, {
      mergeAgent: squashAgent(BRANCH), reviewAgent: async () => "REVIEW_VERDICT: approve",
    })).rejects.toThrow("modified outside confirmed scope");

    expect(fx.git("repo-a", "git rev-parse main")).toBe(beforeA);
    expect(store.updates).not.toContainEqual(expect.objectContaining({ modifiedFiles: expect.anything() }));
  });

  it("uses unprefixed scope as a repo-local fallback instead of blocking every workspace repo", async () => {
    policy.mockResolvedValue({ fileScope: "strict", fileScopeRules: [] });
    fx = await createWorkspaceFixture(["repo-a"]);
    addBranch(fx, "repo-a");
    const task = {
      id: TASK_ID, title: "workspace scope", description: "", column: "in-review", branch: BRANCH, enabledWorkflowSteps: [], /* FNXC:RequiredPreMergeSteps 2026-08-23-18:07: merge-mechanics fixture; an unspecified list makes the door refuse on default-on Plan/Code Review before the behaviour under test runs. */
      comments: [], steeringComments: [], dependencies: [], steps: [], log: [], currentStep: 0,
      workspaceWorktrees: { "repo-a": { worktreePath: fx.repoPath("repo-a"), branch: BRANCH } },
      repositoryScope: {
        repositories: ["repo-a"], state: "confirmed", revision: 1,
        reviewEvidence: reviewEvidence({ "repo-a": { worktreePath: fx.repoPath("repo-a"), branch: BRANCH } }),
      },
      modifiedFiles: ["repo-a/feature.txt"],
    } as Task;
    const store = storeFor(task, ["feature.txt"]);

    const result = await landWorkspaceTask(store, task, fx.rootDir, {}, {
      mergeAgent: squashAgent(BRANCH), reviewAgent: async () => "REVIEW_VERDICT: approve",
    });

    expect(result.allLanded).toBe(true);
    expect(result.repos[0]?.status).toBe("landed");
  });
});
