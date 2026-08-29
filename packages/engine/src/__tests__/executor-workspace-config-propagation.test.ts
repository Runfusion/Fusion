import { afterEach, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Task, TaskStore } from "@fusion/core";
import { TaskExecutor } from "../executor.js";
import { resolveWorkspaceConfigOnce } from "../executor/workspace-config-resolver.js";
import { createWorkspaceFixture, hasGit, type WorkspaceFixture } from "./_workspace-fixture.js";

const describeIfGit = hasGit ? describe : describe.skip;
const TASK_ID = "FN-9043";
const BRANCH = "fusion/fn-9043";

function createStore(): TaskStore {
  return Object.assign(new EventEmitter(), { getSettings: async () => ({}) }) as unknown as TaskStore;
}

function makeTask(worktrees: Task["workspaceWorktrees"]): Task {
  return {
    id: TASK_ID, title: "workspace verification", description: "", column: "in-progress",
    dependencies: [], steps: [], currentStep: 0, log: [], createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), branch: BRANCH, workspaceWorktrees: worktrees,
  } as Task;
}

function addWorktree(fx: WorkspaceFixture, repo: string, commit: boolean): { worktreePath: string; baseCommitSha: string } {
  const repoPath = fx.repoPath(repo);
  const baseCommitSha = fx.git(repo, "git rev-parse HEAD");
  const worktreePath = path.join(repoPath, ".worktrees", TASK_ID);
  fx.git(repo, `git worktree add -b ${BRANCH} ${worktreePath} HEAD`);
  if (commit) {
    execSync('git config user.email "test@example.com"', { cwd: worktreePath });
    execSync('git config user.name "Test"', { cwd: worktreePath });
    mkdirSync(path.join(worktreePath, "src"), { recursive: true });
    writeFileSync(path.join(worktreePath, "src", "change.ts"), "export {}\n");
    execSync("git add src/change.ts && git commit -m workspace-change", { cwd: worktreePath });
  }
  return { worktreePath, baseCommitSha };
}

/**
 * FNXC:Workspace 2026-08-14-21:06:
 * Completion must load workspace mode from its natural undefined host state; injecting the field
 * masks the non-git-root regression reported by issue #3435.
 */
describeIfGit("FN-9043 workspace config propagation", () => {
  let fixture: WorkspaceFixture | undefined;
  afterEach(() => fixture?.cleanup());

  it("normalizes an empty workspace config to cached single-repo mode", async () => {
    const rootDir = mkdtempSync(path.join(os.tmpdir(), "fusion-empty-workspace-"));
    try {
      mkdirSync(path.join(rootDir, ".fusion"));
      writeFileSync(path.join(rootDir, ".fusion", "workspace.json"), '{"repos":[]}');
      const host: { workspaceConfig: unknown } = { workspaceConfig: undefined };
      const deps = {
        rootDir,
        workspaceConfigOwner: host,
        getWorkspaceConfig: () => host.workspaceConfig as null | undefined,
        setWorkspaceConfig: (config: unknown) => { host.workspaceConfig = config; },
      };
      expect(await resolveWorkspaceConfigOnce(deps)).toBeNull();
      expect(host.workspaceConfig).toBeNull();
      expect(await resolveWorkspaceConfigOnce(deps)).toBeNull();
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("uses sub-repo invariants when only one acquired repository has commits", async () => {
    fixture = await createWorkspaceFixture();
    const a = addWorktree(fixture, "repo-a", false);
    const b = addWorktree(fixture, "repo-b", true);
    const store = createStore();
    const executor = new TaskExecutor(store, fixture.rootDir);
    expect((executor as any).workspaceConfig).toBeUndefined();

    const result = await (executor as any).verifyWorktreeInvariants(makeTask({
      "repo-a": { ...a, branch: BRANCH },
      "repo-b": { ...b, branch: BRANCH },
    }));

    expect(result).toEqual({ ok: true });
    expect((executor as any).workspaceConfig?.repos).toEqual(["repo-a", "repo-b"]);
  });

  it("accepts commits in the first acquired repository too", async () => {
    fixture = await createWorkspaceFixture();
    const a = addWorktree(fixture, "repo-a", true);
    const b = addWorktree(fixture, "repo-b", false);
    const executor = new TaskExecutor(createStore(), fixture.rootDir);

    await expect((executor as any).verifyWorktreeInvariants(makeTask({
      "repo-a": { ...a, branch: BRANCH },
      "repo-b": { ...b, branch: BRANCH },
    }))).resolves.toEqual({ ok: true });
  });

  it("keeps no_commits blocking when every inspected sub-repo is empty", async () => {
    fixture = await createWorkspaceFixture();
    const a = addWorktree(fixture, "repo-a", false);
    const b = addWorktree(fixture, "repo-b", false);
    const executor = new TaskExecutor(createStore(), fixture.rootDir);

    const result = await (executor as any).verifyWorktreeInvariants(makeTask({
      "repo-a": { ...a, branch: BRANCH },
      "repo-b": { ...b, branch: BRANCH },
    }));

    expect(result).toMatchObject({ ok: false, reason: "no_commits", expected: "> 0" });
    if (!result.ok) expect(result.observed).toBe("repo-a=0, repo-b=0");
  });
});
