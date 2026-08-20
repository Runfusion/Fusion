import { afterEach, describe, expect, it, vi } from "vitest";
import { addWorkspaceRepo, loadWorkspaceConfig, type WorkspaceConfig } from "@fusion/core";
import { createWorkspaceFixture, hasGit, type WorkspaceFixture } from "./_workspace-fixture.js";

const acquisition = vi.hoisted(() => ({ acquire: vi.fn() }));
vi.mock("../worktree/worktree-acquisition.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../worktree/worktree-acquisition.js")>();
  return { ...actual, acquireWorkspaceRepoWorktree: acquisition.acquire };
});

import { createAcquireRepoWorktreeTool, isLateAcquireColumnBlocked } from "../agent-tools.js";
import { buildRunImplementationDeps } from "../executor/deps-bags.js";
import { invalidateWorkspaceConfigCache } from "../executor/workspace-config-resolver.js";
import { lifecycleIr, RENAMED_VOCAB } from "./_workflow-vocabulary-fixture.js";

const fixtures: WorkspaceFixture[] = [];
afterEach(() => {
  acquisition.acquire.mockReset();
  fixtures.splice(0).forEach((fixture) => fixture.cleanup());
});

function task(id = "FN-9163") {
  return { id, column: "in-progress", workspaceWorktrees: {} } as any;
}

function toolFor(currentTask: any, repos: string[], resolveWorkspaceRepos?: () => Promise<string[]>) {
  return createAcquireRepoWorktreeTool({
    workspaceRootDir: "/workspace",
    workspaceRepos: repos,
    resolveWorkspaceRepos,
    task: currentTask,
    store: {
      getTask: vi.fn(async () => currentTask),
      logEntry: vi.fn(async () => undefined),
    } as any,
    settings: {},
    onAcquired: vi.fn(),
  });
}

/*
FNXC:Workspace 2026-08-20-02:25:
A late workspace member must be admitted by the same tool instance after its disk authority changes;
review/landing states instead require a follow-up so the merge loop cannot miss a repository.
*/
describe.runIf(hasGit)("workspace membership acquired mid-flight", () => {
  it("refuses renamed review and terminal lifecycle columns", () => {
    const workflowIr = lifecycleIr(RENAMED_VOCAB, "workspace-renamed", { mergeOrchestration: true });
    if (workflowIr.version !== "v2") throw new Error("expected v2 workflow fixture");
    workflowIr.columns.push({ id: "retired", name: "Archived", traits: [{ trait: "archived" }] });

    expect(isLateAcquireColumnBlocked(workflowIr, RENAMED_VOCAB.wip)).toBe(false);
    expect(isLateAcquireColumnBlocked(workflowIr, RENAMED_VOCAB.review)).toBe(true);
    expect(isLateAcquireColumnBlocked(workflowIr, RENAMED_VOCAB.complete)).toBe(true);
    expect(isLateAcquireColumnBlocked(workflowIr, "retired")).toBe(true);
    expect(isLateAcquireColumnBlocked(workflowIr, "in-review")).toBe(true);
    expect(isLateAcquireColumnBlocked(workflowIr, "done")).toBe(true);
    expect(isLateAcquireColumnBlocked(workflowIr, "archived")).toBe(true);
  });

  it("refreshes a running host from disk and admits the newly added repository", async () => {
    const fixture = await createWorkspaceFixture(["repo-a", "repo-b"]);
    fixtures.push(fixture);
    await (await import("@fusion/core")).saveWorkspaceConfig(fixture.rootDir, { repos: ["repo-a"] });
    const host = {
      rootDir: fixture.rootDir,
      options: { messageStore: undefined },
      workspaceConfig: { repos: ["repo-a"] } as WorkspaceConfig,
      invalidateWorkspaceConfig() {
        this.workspaceConfig = undefined;
        invalidateWorkspaceConfigCache(this);
      },
    };
    const deps = buildRunImplementationDeps(host, { BRANCH_CONFLICT_TRIPWIRE_THRESHOLD: 1, MAX_AUTO_RECOVERY_ATTEMPTS: 1 });
    await addWorkspaceRepo(fixture.rootDir, "repo-b");
    acquisition.acquire.mockResolvedValue({ worktreePath: "/worktrees/repo-b", branch: "fusion/FN-9163", alreadyAcquired: false });
    const currentTask = task();
    const acquire = toolFor(currentTask, ["repo-a"], async () => (await deps.refreshWorkspaceConfig()).repos);

    const result = await acquire.execute("call", { repo: "repo-b" } as never);

    expect(result.isError).not.toBe(true);
    expect(acquisition.acquire).toHaveBeenCalledWith(expect.objectContaining({ repoRelPath: "repo-b" }));
    expect(host.workspaceConfig).toEqual({ repos: ["repo-a", "repo-b"] });
  });

  it("publishes a successful refresh even when an overlapping invalidation stales the resolver epoch", async () => {
    const fixture = await createWorkspaceFixture(["repo-a"]);
    fixtures.push(fixture);
    const host = {
      rootDir: fixture.rootDir,
      options: { messageStore: undefined },
      workspaceConfig: { repos: ["repo-a"] } as WorkspaceConfig,
      invalidateWorkspaceConfig() { this.workspaceConfig = undefined; invalidateWorkspaceConfigCache(this); },
    };
    const deps = buildRunImplementationDeps(host, { BRANCH_CONFLICT_TRIPWIRE_THRESHOLD: 1, MAX_AUTO_RECOVERY_ATTEMPTS: 1 });
    const refresh = deps.refreshWorkspaceConfig();
    // Simulates the settings listener invalidating while the disk read is pending.
    host.invalidateWorkspaceConfig();

    await expect(refresh).resolves.toEqual({ repos: ["repo-a"] });
    expect(host.workspaceConfig).toEqual({ repos: ["repo-a"] });
  });

  it("keeps snapshot and already-acquired members when a refresh cannot add members", async () => {
    const currentTask = task();
    currentTask.workspaceWorktrees = { "repo-b": { worktreePath: "/existing", branch: "fusion/FN-9163" } };
    acquisition.acquire.mockResolvedValue({ worktreePath: "/existing", branch: "fusion/FN-9163", alreadyAcquired: true });
    const acquire = toolFor(currentTask, ["repo-a"], async () => { throw new Error("temporary read failure"); });

    await expect(acquire.execute("call", { repo: "repo-a" } as never)).resolves.not.toMatchObject({ isError: true });
    await expect(acquire.execute("call", { repo: "repo-b" } as never)).resolves.not.toMatchObject({ isError: true });
  });

  it("refuses a newly discovered repository once review or landing has begun", async () => {
    const currentTask = task();
    currentTask.column = "in-review";
    const acquire = toolFor(currentTask, ["repo-a", "repo-b"], async () => ["repo-a", "repo-b"]);

    const refused = await acquire.execute("call", { repo: "repo-b" } as never);
    expect(refused).toMatchObject({ isError: true });
    expect(refused.content[0]?.text).toContain("follow-up task");
    expect(acquisition.acquire).not.toHaveBeenCalled();

    currentTask.workspaceWorktrees = { "repo-b": { worktreePath: "/existing", branch: "fusion/FN-9163" } };
    acquisition.acquire.mockResolvedValue({ worktreePath: "/existing", branch: "fusion/FN-9163", alreadyAcquired: true });
    await expect(acquire.execute("call", { repo: "repo-b" } as never)).resolves.not.toMatchObject({ isError: true });
  });

  it("retains the prior host snapshot for empty disk membership", async () => {
    const fixture = await createWorkspaceFixture(["repo-a"]);
    fixtures.push(fixture);
    const host = {
      rootDir: fixture.rootDir,
      options: { messageStore: undefined },
      workspaceConfig: { repos: ["repo-a"] } as WorkspaceConfig,
      invalidateWorkspaceConfig() { this.workspaceConfig = undefined; invalidateWorkspaceConfigCache(this); },
    };
    const deps = buildRunImplementationDeps(host, { BRANCH_CONFLICT_TRIPWIRE_THRESHOLD: 1, MAX_AUTO_RECOVERY_ATTEMPTS: 1 });
    await (await import("@fusion/core")).saveWorkspaceConfig(fixture.rootDir, { repos: [] });

    await expect(deps.refreshWorkspaceConfig()).resolves.toEqual({ repos: ["repo-a"] });
    expect(host.workspaceConfig).toEqual({ repos: ["repo-a"] });
    expect(await loadWorkspaceConfig(fixture.rootDir)).toEqual({ repos: [] });
  });
});
