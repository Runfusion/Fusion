import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@fusion/core", async () => {
  const actual = await vi.importActual<typeof import("@fusion/core")>("@fusion/core");
  return {
    ...actual,
    // The fixture's origin is a local bare repository; the production adapters
    // still need a GitHub repository identity to exercise their GitHub boundary.
    getCurrentRepo: vi.fn(() => ({ owner: "fixture-owner", repo: "fixture-repo" })),
    getPushRepo: vi.fn(() => ({ owner: "fixture-owner", repo: "fixture-repo" })),
  };
});

import {
  createGroupPrCallback,
  createPrNodeGithubOps,
  processPullRequestMergeTask,
  refreshAutomatedPrHead,
} from "../task-lifecycle.js";

const fixtures: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function makeFixture(head = "fusion/fn-refresh-fixture"): { root: string; remote: string; integration: string; head: string } {
  const root = mkdtempSync(join(tmpdir(), "fusion-pr-refresh-"));
  fixtures.push(root);
  const remote = join(root, "remote.git");
  const project = join(root, "project");
  const integration = join(root, "integration");
  git(root, "init", "--bare", remote);
  git(root, "clone", remote, project);
  git(project, "config", "user.email", "test@example.com");
  git(project, "config", "user.name", "Fusion Test");
  writeFileSync(join(project, "base.txt"), "base\n");
  git(project, "add", "base.txt");
  git(project, "commit", "-m", "base");
  git(project, "branch", "-M", "main");
  git(project, "push", "-u", "origin", "main");
  git(project, "checkout", "-b", head);
  writeFileSync(join(project, "feature.txt"), "feature\n");
  git(project, "add", "feature.txt");
  git(project, "commit", "-m", "feature");
  git(project, "checkout", "main");

  git(root, "clone", remote, integration);
  git(integration, "config", "user.email", "test@example.com");
  git(integration, "config", "user.name", "Fusion Test");
  git(integration, "checkout", "main");
  writeFileSync(join(integration, "sentinel.txt"), "late integration security fix\n");
  git(integration, "add", "sentinel.txt");
  git(integration, "commit", "-m", "security sentinel");
  git(integration, "push", "origin", "main");

  return { root: project, remote, integration, head };
}

function makeConflictingFixture(head: string) {
  const fixture = makeFixture(head);
  git(fixture.root, "checkout", head);
  writeFileSync(join(fixture.root, "base.txt"), "head conflicts with integration\n");
  git(fixture.root, "add", "base.txt");
  git(fixture.root, "commit", "-m", "conflicting head change");
  git(fixture.root, "checkout", "main");
  writeFileSync(join(fixture.integration, "base.txt"), "integration conflicts with head\n");
  git(fixture.integration, "add", "base.txt");
  git(fixture.integration, "commit", "-m", "conflicting integration change");
  git(fixture.integration, "push", "origin", "main");
  return fixture;
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

function assertPublishedSentinel(remote: string, head: string, sentinel = "sentinel.txt"): void {
  expect(git(remote, "show", `refs/heads/${head}:${sentinel}`)).toBe("late integration security fix");
}

function makeLifecycleStore(task: Record<string, unknown>) {
  return {
    getTask: async () => task,
    getSettings: async () => ({ baseBranch: "main" }),
    getTaskWorkflowSelection: () => undefined,
    getWorkflowDefinition: async () => undefined,
    getWorkflowSettingValues: () => ({}),
    getWorkflowSettingsProjectId: () => "fixture-project",
    getBranchGroup: async () => null,
    listTasksByBranchGroup: async () => [],
    getActiveMergingTask: async () => null,
    updateTask: async () => undefined,
    updatePrInfo: async (_id: string, prInfo: unknown) => { Object.assign(task, { prInfo }); },
    updateBranchGroup: async () => undefined,
    logEntry: async () => undefined,
    moveTask: async () => task,
    emit: () => undefined,
  };
}

describe("refreshAutomatedPrHead local git fixture", () => {
  it("publishes a stale automated head only after it contains the late integration sentinel", async () => {
    const { root, remote, head } = makeFixture();

    /*
    FNXC:PullRequestFreshness 2026-08-09-03:20:
    An automated PR head created before a later integration security fix must be
    rebased and lease-published before any GitHub create boundary can observe it.
    */
    const refreshed = await refreshAutomatedPrHead({
      projectRoot: root,
      headBranch: head,
      targetBranch: "main",
    });

    expect(refreshed.refreshed).toBe(true);
    expect(git(remote, "show", `refs/heads/${head}:feature.txt`)).toBe("feature");
    expect(git(remote, "show", `refs/heads/${head}:sentinel.txt`)).toBe("late integration security fix");
    expect(git(root, "branch", "--show-current")).toBe("main");
    expect(git(root, "worktree", "list", "--porcelain")).not.toContain("/.worktrees/pr-refresh-");
  });

  it("refuses a head checked out at the primary project root", async () => {
    const { root, head } = makeFixture("fusion/fn-8838-root-refusal");
    git(root, "checkout", head);

    await expect(refreshAutomatedPrHead({ projectRoot: root, headBranch: head, targetBranch: "main" }))
      .rejects.toThrow(/project root/);
    expect(git(root, "branch", "--show-current")).toBe(head);
  });

  it("uses a verified existing task worktree without creating a temporary checkout", async () => {
    const { root, remote, head } = makeFixture("fusion/fn-8838-verified-worktree");
    const taskWorktree = join(root, "task-worktree");
    git(root, "worktree", "add", taskWorktree, head);

    const refreshed = await refreshAutomatedPrHead({
      projectRoot: root,
      headBranch: head,
      targetBranch: "main",
      preferredWorktree: taskWorktree,
    });

    expect(refreshed.refreshed).toBe(true);
    assertPublishedSentinel(remote, head);
    expect(git(taskWorktree, "branch", "--show-current")).toBe(head);
    expect(git(root, "worktree", "list", "--porcelain")).not.toContain("/.worktrees/pr-refresh-");
  });

  it("materializes a remote-only head and refuses a missing head without GitHub boundaries", async () => {
    const remoteOnly = makeFixture("fusion/fn-8838-remote-only");
    git(remoteOnly.root, "push", "origin", remoteOnly.head);
    git(remoteOnly.root, "branch", "-D", remoteOnly.head);

    await expect(refreshAutomatedPrHead({
      projectRoot: remoteOnly.root,
      headBranch: remoteOnly.head,
      targetBranch: "main",
    })).resolves.toEqual(expect.objectContaining({ refreshed: true }));
    assertPublishedSentinel(remoteOnly.remote, remoteOnly.head);

    const missing = makeFixture("fusion/fn-8838-missing");
    await expect(refreshAutomatedPrHead({
      projectRoot: missing.root,
      headBranch: "fusion/fn-8838-does-not-exist",
      targetBranch: "main",
    })).rejects.toThrow(/missing local and origin head/);
  });

  it("restores the canonical local head when a force-with-lease publication is rejected", async () => {
    const { root, remote, head } = makeFixture("fusion/fn-8838-lease-rejection");
    // Make this an existing remote head, so the refresh publication must use a lease.
    git(root, "push", "origin", head);
    const originalHead = git(root, "rev-parse", `refs/heads/${head}`);
    const remoteMain = git(remote, "rev-parse", "refs/heads/main");
    const hook = join(root, ".git", "hooks", "pre-push");
    writeFileSync(hook, `#!/bin/sh\ngit --git-dir='${remote}' update-ref 'refs/heads/${head}' '${remoteMain}'\n`);
    chmodSync(hook, 0o755);

    /*
    FNXC:PullRequestFreshness 2026-08-09-04:52:
    A remote writer can win after refresh observes the old OID but before its
    guarded push reaches origin. The rejected lease must restore the shared
    local ref, preventing a later unguarded push from publishing the rebase.
    */
    await expect(refreshAutomatedPrHead({ projectRoot: root, headBranch: head, targetBranch: "main" }))
      .rejects.toThrow(/stale info|lease|failed to push/i);

    expect(git(root, "rev-parse", `refs/heads/${head}`)).toBe(originalHead);
    expect(git(remote, "rev-parse", `refs/heads/${head}`)).toBe(remoteMain);
    expect(git(root, "worktree", "list", "--porcelain")).not.toContain("/.worktrees/pr-refresh-");
  });

  it("refuses to overwrite a head that advanced before refresh observes its push lease", async () => {
    const { root, integration, remote, head } = makeFixture("fusion/fn-8838-pre-observation-race");
    git(root, "push", "origin", head);
    const originalHead = git(root, "rev-parse", `refs/heads/${head}`);
    git(integration, "fetch", "origin", `${head}:${head}`);
    git(integration, "checkout", head);
    writeFileSync(join(integration, "concurrent.txt"), "concurrent head update\n");
    git(integration, "add", "concurrent.txt");
    git(integration, "commit", "-m", "concurrent head update");
    git(integration, "push", "origin", head);
    const concurrentHead = git(remote, "rev-parse", `refs/heads/${head}`);

    /*
    FNXC:PullRequestFreshness 2026-08-09-05:32:
    A head update that reaches origin before refresh reads its lease must survive.
    The refresher may not replace that unincorporated commit with its rebased tip.
    */
    await expect(refreshAutomatedPrHead({ projectRoot: root, headBranch: head, targetBranch: "main" }))
      .rejects.toThrow(/changed before publication/);

    expect(git(root, "rev-parse", `refs/heads/${head}`)).toBe(originalHead);
    expect(git(remote, "rev-parse", `refs/heads/${head}`)).toBe(concurrentHead);
    expect(git(remote, "show", `refs/heads/${head}:concurrent.txt`)).toBe("concurrent head update");
  });

  it("refreshes each production PR creator before its recording GitHub fake sees the head", async () => {
    const groupFixture = makeFixture("fusion/group-refresh-fixture");
    const groupGithub = {
      findPrForBranch: vi.fn(async () => null),
      createPr: vi.fn(async () => {
        assertPublishedSentinel(groupFixture.remote, groupFixture.head);
        return { number: 1, url: "https://example.test/pr/1", status: "open" as const };
      }),
    };
    await createGroupPrCallback(groupGithub as never)({
      cwd: groupFixture.root,
      group: { id: "BG-fixture", branchName: groupFixture.head } as never,
      members: [{ id: "FN-8838", title: "fixture" }] as never,
      headBranch: groupFixture.head,
      baseBranch: "main",
    });

    const workflowFixture = makeFixture("fusion/fn-8838-workflow");
    const workflowGithub = {
      createPr: vi.fn(async () => {
        assertPublishedSentinel(workflowFixture.remote, workflowFixture.head);
        return { number: 2, url: "https://example.test/pr/2", status: "open" as const };
      }),
      getPrStatus: vi.fn(async () => ({ number: 2, url: "https://example.test/pr/2", status: "open" as const })),
      mergePr: vi.fn(async () => ({ number: 2, url: "https://example.test/pr/2", status: "merged" as const })),
      replyToReviewThread: vi.fn(),
      resolveReviewThread: vi.fn(),
      getViewerLogin: vi.fn(),
      getPrReviewThreadsDetailed: vi.fn(),
    };
    const workflowOps = createPrNodeGithubOps(workflowGithub as never);
    const task = { id: "FN-8838-WORKFLOW", title: "fixture", description: "fixture", worktree: workflowFixture.root };
    const entity = { id: "pr-fixture", sourceId: task.id, repo: "fixture-owner/fixture-repo", headBranch: workflowFixture.head, baseBranch: "main", prNumber: 2, headOid: "old" };
    await workflowOps.createPr({ task, entity } as never);

    writeFileSync(join(workflowFixture.integration, "merge-sentinel.txt"), "late integration security fix\n");
    git(workflowFixture.integration, "add", "merge-sentinel.txt");
    git(workflowFixture.integration, "commit", "-m", "merge sentinel");
    git(workflowFixture.integration, "push", "origin", "main");
    workflowGithub.mergePr.mockImplementation(async () => {
      assertPublishedSentinel(workflowFixture.remote, workflowFixture.head, "merge-sentinel.txt");
      return { number: 2, url: "https://example.test/pr/2", status: "merged" as const };
    });
    const persisted: string[] = [];
    await workflowOps.mergePr({ task, entity, persistRefreshedHead: async (oid) => { persisted.push(oid); } } as never);
    expect(workflowGithub.getPrStatus).toHaveBeenCalledTimes(1);
    expect(persisted).toHaveLength(1);

    const lifecycleFixture = makeFixture("fusion/fn-8838-lifecycle");
    const lifecycleTask = {
      id: "FN-8838-LIFECYCLE",
      title: "fixture",
      description: "fixture",
      branch: lifecycleFixture.head,
      worktree: lifecycleFixture.root,
      column: "in-review",
    };
    let lifecycleMergeReady = false;
    const lifecycleGithub = {
      findPrForBranch: vi.fn(async () => null),
      createPr: vi.fn(async () => {
        assertPublishedSentinel(lifecycleFixture.remote, lifecycleFixture.head);
        return { number: 3, url: "https://example.test/pr/3", status: "open" as const };
      }),
      getPrMergeStatus: vi.fn(async () => ({
        prInfo: { number: 3, url: "https://example.test/pr/3", status: "open" as const },
        reviewDecision: null,
        checks: [],
        mergeReady: lifecycleMergeReady,
        blockingReasons: lifecycleMergeReady ? [] : ["checks pending"],
      })),
      mergePr: vi.fn(async () => ({ number: 3, url: "https://example.test/pr/3", status: "merged" as const })),
    };
    const lifecycleResult = await processPullRequestMergeTask(
      makeLifecycleStore(lifecycleTask) as never,
      lifecycleFixture.root,
      lifecycleTask.id,
      lifecycleGithub as never,
      () => undefined,
    );
    expect(lifecycleResult).toBe("waiting");
    expect(lifecycleGithub.createPr).toHaveBeenCalledTimes(1);

    writeFileSync(join(lifecycleFixture.integration, "lifecycle-merge-sentinel.txt"), "late integration security fix\n");
    git(lifecycleFixture.integration, "add", "lifecycle-merge-sentinel.txt");
    git(lifecycleFixture.integration, "commit", "-m", "lifecycle merge sentinel");
    git(lifecycleFixture.integration, "push", "origin", "main");
    lifecycleMergeReady = true;
    lifecycleGithub.mergePr.mockImplementation(async () => {
      assertPublishedSentinel(lifecycleFixture.remote, lifecycleFixture.head, "lifecycle-merge-sentinel.txt");
      return { number: 3, url: "https://example.test/pr/3", status: "merged" as const };
    });
    const lifecycleMergeResult = await processPullRequestMergeTask(
      makeLifecycleStore(lifecycleTask) as never,
      lifecycleFixture.root,
      lifecycleTask.id,
      lifecycleGithub as never,
      () => undefined,
    );
    expect(lifecycleMergeResult).toBe("merged");
    expect(lifecycleGithub.mergePr).toHaveBeenCalledTimes(1);
  });

  it("refreshes shared-group creation and merge boundaries before GitHub sees either head", async () => {
    const fixture = makeFixture("fusion/groups/fn-8838-refresh");
    const task = {
      id: "FN-8838-GROUP",
      title: "group fixture",
      description: "fixture",
      branch: fixture.head,
      worktree: fixture.root,
      column: "in-review",
      branchContext: { assignmentMode: "shared", groupId: "BG-8838", source: "planning" },
    };
    const group = {
      id: "BG-8838",
      sourceType: "planning",
      sourceId: "P-8838",
      branchName: fixture.head,
      prState: "none",
      status: "open",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    let mergeReady = false;
    const store = {
      ...makeLifecycleStore(task),
      getBranchGroup: async () => group,
      listTasksByBranchGroup: async () => [task],
    };
    const github = {
      findPrForBranch: vi.fn(async () => null),
      createPr: vi.fn(async () => {
        assertPublishedSentinel(fixture.remote, fixture.head);
        return { number: 4, url: "https://example.test/pr/4", status: "open" as const };
      }),
      getPrMergeStatus: vi.fn(async () => ({
        prInfo: { number: 4, url: "https://example.test/pr/4", status: "open" as const },
        reviewDecision: "APPROVED" as const,
        checks: [],
        mergeReady,
        blockingReasons: mergeReady ? [] : ["checks pending"],
      })),
      mergePr: vi.fn(async () => ({ number: 4, url: "https://example.test/pr/4", status: "merged" as const })),
    };

    await expect(processPullRequestMergeTask(store as never, fixture.root, task.id, github as never, () => undefined)).resolves.toBe("waiting");
    expect(github.createPr).toHaveBeenCalledTimes(1);

    writeFileSync(join(fixture.integration, "group-merge-sentinel.txt"), "late integration security fix\n");
    git(fixture.integration, "add", "group-merge-sentinel.txt");
    git(fixture.integration, "commit", "-m", "group merge sentinel");
    git(fixture.integration, "push", "origin", "main");
    mergeReady = true;
    github.mergePr.mockImplementation(async () => {
      assertPublishedSentinel(fixture.remote, fixture.head, "group-merge-sentinel.txt");
      return { number: 4, url: "https://example.test/pr/4", status: "merged" as const };
    });

    await expect(processPullRequestMergeTask(store as never, fixture.root, task.id, github as never, () => undefined)).resolves.toBe("merged");
    expect(github.mergePr).toHaveBeenCalledWith(expect.objectContaining({ expectedHeadOid: expect.any(String) }));
  });

  it("fails closed at every PR-create adapter when rebase conflicts", async () => {
    /*
    FNXC:PullRequestFreshness 2026-08-09-04:26:
    A rebase conflict is a hard stop at all automated create boundaries. GitHub
    must never receive a normal-looking PR whose stale head omits base changes.
    */
    const promotionFixture = makeConflictingFixture("fusion/groups/fn-8838-conflict-promotion");
    const promotionGithub = { findPrForBranch: vi.fn(async () => null), createPr: vi.fn() };
    await expect(createGroupPrCallback(promotionGithub as never)({
      cwd: promotionFixture.root,
      group: { id: "BG-conflict", sourceType: "planning", sourceId: "P-conflict" } as never,
      members: [],
      headBranch: promotionFixture.head,
      baseBranch: "main",
    })).rejects.toThrow(/rebase/);
    expect(promotionGithub.createPr).not.toHaveBeenCalled();

    const workflowFixture = makeConflictingFixture("fusion/fn-8838-conflict-workflow");
    const workflowGithub = {
      createPr: vi.fn(), getPrStatus: vi.fn(), mergePr: vi.fn(), replyToReviewThread: vi.fn(),
      resolveReviewThread: vi.fn(), getViewerLogin: vi.fn(), getPrReviewThreadsDetailed: vi.fn(),
    };
    await expect(createPrNodeGithubOps(workflowGithub as never).createPr({
      task: { id: "FN-8838-CONFLICT-WORKFLOW", title: "fixture", description: "fixture", worktree: workflowFixture.root },
      entity: { id: "pr-conflict", sourceId: "FN-8838-CONFLICT-WORKFLOW", repo: "fixture-owner/fixture-repo", headBranch: workflowFixture.head, baseBranch: "main" },
    } as never)).rejects.toThrow(/rebase/);
    expect(workflowGithub.createPr).not.toHaveBeenCalled();

    const workflowMergeFixture = makeConflictingFixture("fusion/fn-8838-conflict-workflow-merge");
    const workflowMergeGithub = {
      createPr: vi.fn(), getPrStatus: vi.fn(), mergePr: vi.fn(), replyToReviewThread: vi.fn(),
      resolveReviewThread: vi.fn(), getViewerLogin: vi.fn(), getPrReviewThreadsDetailed: vi.fn(),
    };
    await expect(createPrNodeGithubOps(workflowMergeGithub as never).mergePr({
      task: { id: "FN-8838-CONFLICT-WORKFLOW-MERGE", worktree: workflowMergeFixture.root },
      entity: { id: "pr-conflict-merge", sourceId: "FN-8838-CONFLICT-WORKFLOW-MERGE", repo: "fixture-owner/fixture-repo", headBranch: workflowMergeFixture.head, baseBranch: "main", prNumber: 5 },
    } as never)).rejects.toThrow(/rebase/);
    expect(workflowMergeGithub.getPrStatus).not.toHaveBeenCalled();
    expect(workflowMergeGithub.mergePr).not.toHaveBeenCalled();

    const lifecycleFixture = makeConflictingFixture("fusion/fn-8838-conflict-lifecycle");
    const lifecycleGithub = {
      findPrForBranch: vi.fn(async () => null), createPr: vi.fn(), getPrMergeStatus: vi.fn(), mergePr: vi.fn(),
    };
    const lifecycleTask = { id: "FN-8838-CONFLICT-LIFECYCLE", title: "fixture", description: "fixture", branch: lifecycleFixture.head, worktree: lifecycleFixture.root, column: "in-review" };
    await expect(processPullRequestMergeTask(
      makeLifecycleStore(lifecycleTask) as never, lifecycleFixture.root, lifecycleTask.id, lifecycleGithub as never, () => undefined,
    )).rejects.toThrow(/rebase/);
    expect(lifecycleGithub.createPr).not.toHaveBeenCalled();
  });
});
