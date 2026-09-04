/*
FNXC:MergePush 2026-08-30-09:14:
FN-263's reported failure was a multi-repository land that contacted an ahead remote while
push-after-merge was disabled. These real-Git cases use the production workspace lander so a
local-only result proves no fence, intent, or atomic remote publication can leak through.
*/
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Settings, Task, TaskStore, WorkspaceLeaseHandle } from "@fusion/core";
import { landWorkspaceTask, WorkspaceMergeTechnicalError } from "../merge/merger-ai.js";
import { isPushAfterMergeEnabled, type PushAfterMergeLane } from "../merge/push-after-merge-policy.js";
import { WorkspaceEnvironmentError } from "../merge/workspace-integration-target.js";
import { createWorkspaceFixture, hasGit, type WorkspaceFixture } from "./_workspace-fixture.js";

const describeIfGit = hasGit ? describe : describe.skip;
const TASK_ID = "FN-263";
const BRANCH = "fusion/fn-263";

function configureIdentity(dir: string): void {
  execSync('git config user.email "test@example.com"', { cwd: dir, stdio: "pipe" });
  execSync('git config user.name "Test"', { cwd: dir, stdio: "pipe" });
}

function squashMergeAgent(branch: string, onEnter?: (cwd: string) => Promise<void> | void) {
  return async (cwd: string): Promise<void> => {
    await onEnter?.(cwd);
    configureIdentity(cwd);
    execSync(`git merge --squash ${branch}`, { cwd, stdio: "pipe" });
    execSync("git add -A", { cwd, stdio: "pipe" });
    execSync(`git commit -m "${branch}: squashed"`, { cwd, stdio: "pipe" });
  };
}

function addTaskBranches(fixture: WorkspaceFixture): Task["workspaceWorktrees"] {
  return Object.fromEntries(fixture.repos.map((repoRel) => {
    const { worktreePath, baseCommitSha } = fixture.createLinkedTaskWorktree(repoRel, BRANCH);
    configureIdentity(worktreePath);
    writeFileSync(join(worktreePath, "feature.txt"), `${repoRel} task work\n`);
    execSync("git add feature.txt", { cwd: worktreePath, stdio: "pipe" });
    execSync(`git commit -m "feat(${TASK_ID}): update ${repoRel}"`, { cwd: worktreePath, stdio: "pipe" });
    return [repoRel, { worktreePath, branch: BRANCH, baseCommitSha }];
  }));
}

function makeTask(workspaceWorktrees: Task["workspaceWorktrees"]): Task {
  const entries = Object.entries(workspaceWorktrees ?? {});
  return {
    enabledWorkflowSteps: [],
    id: TASK_ID,
    title: "Workspace push policy",
    description: "",
    column: "in-review",
    branch: BRANCH,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    workspaceWorktrees,
    repositoryScope: {
      repositories: entries.map(([repoRel]) => repoRel).sort(),
      state: "confirmed",
      revision: 1,
      reviewEvidence: Object.fromEntries(entries.map(([repoRel, entry]) => {
        const diff = execSync(`git diff --binary ${entry.baseCommitSha}..${entry.branch}`, {
          cwd: entry.worktreePath,
          encoding: "utf8",
        });
        return [repoRel, {
          fingerprint: createHash("sha256").update(diff).digest("hex"),
          approvedAt: new Date().toISOString(),
        }];
      })),
    },
    modifiedFiles: entries.map(([repoRel]) => `${repoRel}/feature.txt`).sort(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as Task;
}

function createStore(task: Task, settings: Partial<Settings> = {}) {
  const logs: string[] = [];
  let fenceToken = 0n;
  const store = {
    getSettings: vi.fn(async () => ({ autoMerge: false, ...settings })),
    getTask: vi.fn(async () => task),
    updateTask: vi.fn(async (_taskId: string, patch: Partial<Task>) => Object.assign(task, patch)),
    updateTaskAtomic: vi.fn(async (_taskId: string, updater: (current: Task) => Partial<Task> | undefined | Promise<Partial<Task> | undefined>) => {
      const patch = await updater(task);
      if (patch) Object.assign(task, patch);
      return task;
    }),
    mergeWorkspaceWorktreeEntry: vi.fn(async (
      _taskId: string,
      repoRelPath: string,
      patch: Partial<NonNullable<Task["workspaceWorktrees"]>[string]>,
    ) => {
      const existing = task.workspaceWorktrees?.[repoRelPath];
      task.workspaceWorktrees = {
        ...task.workspaceWorktrees,
        [repoRelPath]: { ...existing, ...patch },
      };
      return task;
    }),
    moveTask: vi.fn(async (_taskId: string, column: Task["column"]) => {
      task.column = column;
      return task;
    }),
    logEntry: vi.fn(async (_taskId: string, message: string) => { logs.push(message); }),
    appendAgentLog: vi.fn(async (_taskId: string, message: string) => { logs.push(message); }),
    upsertTaskCommitAssociation: vi.fn().mockResolvedValue(undefined),
    accumulateTokenUsage: vi.fn().mockResolvedValue(undefined),
    recordRunAuditEvent: vi.fn().mockResolvedValue(undefined),
    emit: vi.fn(),
    acquireWorkspaceLease: vi.fn(async (input: Pick<WorkspaceLeaseHandle, "leaseKey" | "kind" | "owner">) => ({
      outcome: "acquired" as const,
      handle: { ...input, fenceToken: ++fenceToken },
    })),
    releaseWorkspaceLease: vi.fn().mockResolvedValue(true),
    recordWorkspaceLeaseFenceRef: vi.fn(),
    recordWorkspaceLandIntent: vi.fn(),
    resolveWorkspaceLandIntent: vi.fn(),
  };
  return { store: store as unknown as TaskStore, logs, mocks: store };
}

function enableRemotePublication(mocks: ReturnType<typeof createStore>["mocks"]): void {
  mocks.recordWorkspaceLeaseFenceRef.mockImplementation(async (input: {
    handle: WorkspaceLeaseHandle;
    fenceRefName: string;
    fenceRefSha: string;
  }) => ({ ...input.handle, fenceRefName: input.fenceRefName, fenceRefSha: input.fenceRefSha }));
  mocks.recordWorkspaceLandIntent.mockResolvedValue({ outcome: "valid" });
  mocks.resolveWorkspaceLandIntent.mockImplementation(async (input: { persistLandedSha: () => Promise<void> }) => {
    await input.persistLandedSha();
    return { outcome: "resolved" };
  });
}

function addBareOrigins(fixture: WorkspaceFixture): Map<string, string> {
  return new Map(fixture.repos.map((repoRel) => {
    const remote = join(fixture.rootDir, `${repoRel}.git`);
    execSync(`git init --bare ${remote}`, { stdio: "pipe" });
    fixture.git(repoRel, `git remote add origin ${remote}`);
    fixture.git(repoRel, "git push -u origin main");
    return [repoRel, remote];
  }));
}

function addEmptyOrigins(fixture: WorkspaceFixture): Map<string, string> {
  return new Map(fixture.repos.map((repoRel) => {
    const remote = join(fixture.rootDir, `${repoRel}.git`);
    execSync(`git init --bare ${remote}`, { stdio: "pipe" });
    fixture.git(repoRel, `git remote add origin ${remote}`);
    return [repoRel, remote];
  }));
}

function advanceLocalIntegration(fixture: WorkspaceFixture): void {
  for (const repoRel of fixture.repos) {
    writeFileSync(join(fixture.repoPath(repoRel), "local.txt"), `${repoRel} local integration work\n`);
    fixture.git(repoRel, "git add local.txt && git commit -m 'local integration advance'");
  }
}

function remoteMain(fixture: WorkspaceFixture, repoRel: string): string {
  return fixture.git(repoRel, "git ls-remote origin refs/heads/main").split(/\s+/)[0]!;
}

describe("push-after-merge policy", () => {
  const lanes: Array<PushAfterMergeLane | undefined> = [undefined, "single-repo", "workspace"];
  const pushAfterMergeValues = [undefined, false, true] as const;
  const mergeStrategies = [undefined, "direct", "pull-request"] as const;

  for (const pushAfterMerge of pushAfterMergeValues) {
    for (const mergeStrategy of mergeStrategies) {
      for (const lane of lanes) {
        it(`returns the correct publication policy for push=${String(pushAfterMerge)}, strategy=${String(mergeStrategy)}, lane=${lane ?? "omitted"}`, () => {
          const settings = { pushAfterMerge, mergeStrategy } as Pick<Settings, "pushAfterMerge" | "mergeStrategy">;
          const expected = pushAfterMerge === true
            && (lane === "workspace" || mergeStrategy !== "pull-request");

          expect(isPushAfterMergeEnabled(settings, { lane })).toBe(expected);
        });
      }
    }
  }
});

describeIfGit("landWorkspaceTask push-after-merge", () => {
  let fixture: WorkspaceFixture | undefined;

  afterEach(() => {
    fixture?.cleanup();
    fixture = undefined;
  });

  it("lands locally by default without publishing workspace refs or intents", async () => {
    fixture = await createWorkspaceFixture(["repo-a", "repo-b"]);
    addBareOrigins(fixture);
    const remoteBefore = new Map(fixture.repos.map((repoRel) => [repoRel, remoteMain(fixture!, repoRel)]));
    const task = makeTask(addTaskBranches(fixture));
    const { store, mocks } = createStore(task);

    const result = await landWorkspaceTask(store, task, fixture.rootDir, {}, {
      mergeAgent: squashMergeAgent(BRANCH),
      reviewAgent: async () => "REVIEW_VERDICT: approve",
    });

    expect(result.allLanded).toBe(true);
    for (const repo of result.repos) {
      expect(fixture.git(repo.repo, "git rev-parse refs/heads/main")).toBe(repo.landedSha);
      expect(remoteMain(fixture, repo.repo)).toBe(remoteBefore.get(repo.repo));
      expect(fixture.git(repo.repo, 'git ls-remote origin "refs/fusion/*"')).toBe("");
    }
    expect(mocks.acquireWorkspaceLease).toHaveBeenCalledTimes(2);
    expect(mocks.releaseWorkspaceLease).toHaveBeenCalledTimes(2);
    expect(mocks.recordWorkspaceLeaseFenceRef).not.toHaveBeenCalled();
    expect(mocks.recordWorkspaceLandIntent).not.toHaveBeenCalled();
    expect(mocks.resolveWorkspaceLandIntent).not.toHaveBeenCalled();
  });

  it("keeps an ahead remote untouched when publication is explicitly disabled", async () => {
    fixture = await createWorkspaceFixture(["repo-a", "repo-b"]);
    const origins = addBareOrigins(fixture);
    for (const repoRel of fixture.repos) {
      const clone = join(fixture.rootDir, `${repoRel}-other`);
      execSync(`git clone --branch main ${origins.get(repoRel)} ${clone}`, { stdio: "pipe" });
      configureIdentity(clone);
      writeFileSync(join(clone, "remote.txt"), `${repoRel} remote work\n`);
      execSync("git add remote.txt && git commit -m 'remote advance' && git push origin main", { cwd: clone, stdio: "pipe" });
    }
    const remoteBefore = new Map(fixture.repos.map((repoRel) => [repoRel, remoteMain(fixture!, repoRel)]));
    const task = makeTask(addTaskBranches(fixture));
    const { store, logs, mocks } = createStore(task, { pushAfterMerge: false });

    const result = await landWorkspaceTask(store, task, fixture.rootDir, {}, {
      mergeAgent: squashMergeAgent(BRANCH),
      reviewAgent: async () => "REVIEW_VERDICT: approve",
    });

    expect(result.allLanded).toBe(true);
    for (const repo of result.repos) {
      expect(fixture.git(repo.repo, "git rev-parse refs/heads/main")).toBe(repo.landedSha);
      expect(remoteMain(fixture, repo.repo)).toBe(remoteBefore.get(repo.repo));
      expect(fixture.git(repo.repo, 'git ls-remote origin "refs/fusion/*"')).toBe("");
    }
    expect(logs.some((message) => /fence publication|stale info/i.test(message))).toBe(false);
    expect(mocks.logEntry.mock.calls.filter(([, message]) => message.includes('"Push to remote after merge" is disabled'))).toHaveLength(1);
  });

  it("publishes every synchronized workspace integration branch with fence refs", async () => {
    fixture = await createWorkspaceFixture(["repo-a", "repo-b"]);
    addBareOrigins(fixture);
    const task = makeTask(addTaskBranches(fixture));
    const { store, mocks } = createStore(task, { pushAfterMerge: true });
    enableRemotePublication(mocks);

    const result = await landWorkspaceTask(store, task, fixture.rootDir, {}, {
      mergeAgent: squashMergeAgent(BRANCH),
      reviewAgent: async () => "REVIEW_VERDICT: approve",
    });

    expect(result.allLanded).toBe(true);
    for (const repo of result.repos) {
      expect(remoteMain(fixture, repo.repo)).toBe(repo.landedSha);
      expect(fixture.git(repo.repo, 'git ls-remote origin "refs/fusion/workspace-lease/*"')).toMatch(/^[0-9a-f]{40,64}\s/);
    }
    expect(mocks.recordWorkspaceLeaseFenceRef).toHaveBeenCalledTimes(2);
    expect(mocks.recordWorkspaceLandIntent).toHaveBeenCalledTimes(2);
    expect(mocks.resolveWorkspaceLandIntent).toHaveBeenCalledTimes(2);
  });

  it("re-observes an ancestor remote tip once before publishing an ahead local integration branch", async () => {
    fixture = await createWorkspaceFixture(["repo-a", "repo-b"]);
    addBareOrigins(fixture);
    advanceLocalIntegration(fixture);
    const task = makeTask(addTaskBranches(fixture));
    const { store, logs, mocks } = createStore(task, { pushAfterMerge: true });
    enableRemotePublication(mocks);

    const result = await landWorkspaceTask(store, task, fixture.rootDir, {}, {
      mergeAgent: squashMergeAgent(BRANCH),
      reviewAgent: async () => "REVIEW_VERDICT: approve",
    });

    expect(result.allLanded).toBe(true);
    for (const repo of result.repos) {
      expect(remoteMain(fixture, repo.repo)).toBe(repo.landedSha);
    }
    expect(logs.filter((message) => message.includes("re-observed remote origin"))).toHaveLength(4);
  });

  it("creates an absent integration branch on an enabled workspace remote", async () => {
    fixture = await createWorkspaceFixture(["repo-a", "repo-b"]);
    addEmptyOrigins(fixture);
    const task = makeTask(addTaskBranches(fixture));
    const { store, mocks } = createStore(task, { pushAfterMerge: true });
    enableRemotePublication(mocks);

    const result = await landWorkspaceTask(store, task, fixture.rootDir, {}, {
      mergeAgent: squashMergeAgent(BRANCH),
      reviewAgent: async () => "REVIEW_VERDICT: approve",
    });

    expect(result.allLanded).toBe(true);
    for (const repo of result.repos) {
      expect(remoteMain(fixture, repo.repo)).toBe(repo.landedSha);
    }
  });

  it("reports an unknown remote commit as an environment repair without advancing local main", async () => {
    fixture = await createWorkspaceFixture(["repo-a"]);
    const origins = addBareOrigins(fixture);
    const clone = join(fixture.rootDir, "repo-a-other");
    execSync(`git clone --branch main ${origins.get("repo-a")} ${clone}`, { stdio: "pipe" });
    configureIdentity(clone);
    writeFileSync(join(clone, "remote.txt"), "remote divergence\n");
    execSync("git add remote.txt && git commit -m 'remote divergence' && git push origin main", { cwd: clone, stdio: "pipe" });
    const localMainBefore = fixture.git("repo-a", "git rev-parse refs/heads/main");
    const task = makeTask(addTaskBranches(fixture));
    const { store, mocks } = createStore(task, { pushAfterMerge: true });
    enableRemotePublication(mocks);

    await expect(landWorkspaceTask(store, task, fixture.rootDir, {}, {
      mergeAgent: squashMergeAgent(BRANCH),
      reviewAgent: async () => "REVIEW_VERDICT: approve",
    })).rejects.toMatchObject<Partial<WorkspaceEnvironmentError>>({
      repository: "repo-a",
      resource: "remote 'origin' branch 'main'",
      action: "reconcile the diverged remote branch and choose Retry",
    });

    expect(fixture.git("repo-a", "git rev-parse refs/heads/main")).toBe(localMainBefore);
    expect(task.workspaceWorktrees?.["repo-a"]?.landFailure?.category).toBe("environment");
  });

  it("does not rescue a superseded fence pin when the integration target is unchanged", async () => {
    fixture = await createWorkspaceFixture(["repo-a"]);
    addBareOrigins(fixture);
    const task = makeTask(addTaskBranches(fixture));
    const { store, mocks } = createStore(task, { pushAfterMerge: true });
    enableRemotePublication(mocks);
    let fenceRefName: string | undefined;
    let fenceRefSha: string | undefined;
    mocks.recordWorkspaceLeaseFenceRef.mockImplementation(async (input: {
      handle: WorkspaceLeaseHandle;
      fenceRefName: string;
      fenceRefSha: string;
    }) => {
      fenceRefName = input.fenceRefName;
      fenceRefSha = input.fenceRefSha;
      return { ...input.handle, fenceRefName, fenceRefSha };
    });

    await expect(landWorkspaceTask(store, task, fixture.rootDir, {}, {
      mergeAgent: squashMergeAgent(BRANCH, async (cwd) => {
        if (!fenceRefName || !fenceRefSha) throw new Error("expected workspace fence pin");
        const tree = execSync("git mktree </dev/null", { cwd, encoding: "utf8" }).trim();
        const successorSha = execSync(`git commit-tree ${tree} -m successor`, { cwd, encoding: "utf8" }).trim();
        execSync(
          `git push --force-with-lease=${fenceRefName}:${fenceRefSha} origin ${successorSha}:${fenceRefName}`,
          { cwd, stdio: "pipe" },
        );
      }),
      reviewAgent: async () => "REVIEW_VERDICT: approve",
    })).rejects.toMatchObject<Partial<WorkspaceMergeTechnicalError>>({
      kind: "repository-fence-publication",
    });
    expect(remoteMain(fixture, "repo-a")).toBe(fixture.git("repo-a", "git rev-parse refs/heads/main"));
  });
});
