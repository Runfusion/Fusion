/*
FNXC:WorkspaceLifecycleParity 2026-08-21-00:12:
A workspace task that changes one explicitly scoped repository must make the same review decision
as its mono-repository equivalent. Acquisition of a clean peer is deliberately included here to
prove it neither receives a reviewer session nor changes the approval outcome.
*/
import { afterEach, describe, expect, it, vi } from "vitest";
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Settings, Task, TaskStore } from "@fusion/core";
import { evaluateTaskDoneScopeLeak } from "../executor/worktree-task-done-scope-leak.js";
import { verifyWorktreeInvariants } from "../executor/worktree-verify-invariants.js";
import { reviewWorkspacePerRepo } from "../executor/workspace-review-per-repo.js";
import { createWorkspaceFixture, hasGit, type WorkspaceFixture } from "./_workspace-fixture.js";

const describeIfGit = hasGit ? describe : describe.skip;

function task(overrides: Partial<Task>): Task {
  return {
    id: "FN-094", title: "parity", description: "", column: "in-review", dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "2026-08-21T00:00:00.000Z", updatedAt: "2026-08-21T00:00:00.000Z", ...overrides,
  } as Task;
}

describe("FN-094 workspace lifecycle parity", () => {
  it("reviews one scoped modified repository exactly like the mono-repository case", async () => {
    const review = vi.fn(async () => ({ verdict: "APPROVE" as const, review: "approved", summary: "approved" }));
    const workspace = task({
      repositoryScope: { repositories: ["repo-a", "repo-b"], state: "confirmed", revision: 2 },
      modifiedFiles: ["repo-a/src/changed.ts"],
      workspaceWorktrees: {
        "repo-a": { worktreePath: "/workspace/repo-a/.worktrees/fn-094", branch: "fusion/fn-094" },
        "repo-b": { worktreePath: "/workspace/repo-b/.worktrees/fn-094", branch: "fusion/fn-094" },
      },
    });
    const result = await reviewWorkspacePerRepo(workspace, review, { workspaceRepos: ["repo-a", "repo-b"], workspaceRootDir: "/workspace", captureModifiedFiles: async (repoRel) => repoRel === "repo-a" ? ["src/changed.ts"] : [] });

    expect(result.verdict).toBe("APPROVE");
    expect(review).toHaveBeenCalledTimes(1);
    expect(review).toHaveBeenCalledWith("/workspace/repo-a/.worktrees/fn-094");
    expect(result.review).toContain("[repo-b] NOT_REVIEWED");
    expect(result.review).toContain("No changes — not reviewed");
  });

  it("does not dispatch Code Review from a proposed scope", async () => {
    const review = vi.fn();
    const result = await reviewWorkspacePerRepo(task({
      repositoryScope: { repositories: ["repo-a"], state: "proposed", revision: 1 },
      workspaceWorktrees: { "repo-a": { worktreePath: "/workspace/repo-a/.worktrees/fn-094", branch: "fusion/fn-094" } },
    }), review, { workspaceRepos: ["repo-a"], workspaceRootDir: "/workspace", captureModifiedFiles: async () => ["src/changed.ts"] });

    expect(result.verdict).toBe("UNAVAILABLE");
    expect(result.retryable).toBe(false);
    expect(review).not.toHaveBeenCalled();
  });

  it("refuses an ordinary all-clean scoped implementation without inventing a blocking clean-peer verdict", async () => {
    const review = vi.fn();
    const result = await reviewWorkspacePerRepo(task({
      repositoryScope: { repositories: ["repo-a"], state: "confirmed", revision: 1 },
      workspaceWorktrees: { "repo-a": { worktreePath: "/workspace/repo-a/.worktrees/fn-094", branch: "fusion/fn-094" } },
    }), review, { workspaceRepos: ["repo-a"], workspaceRootDir: "/workspace", captureModifiedFiles: async () => [] });

    expect(result.verdict).toBe("UNAVAILABLE");
    expect(result.retryable).toBe(false);
    expect(review).not.toHaveBeenCalled();
    expect(result.review).toContain("No changes — not reviewed");
  });
});

describeIfGit("FN-202 workspace completion parity", () => {
  let fixture: WorkspaceFixture;

  afterEach(() => fixture?.cleanup());

  function completionDeps(workspaceConfig: unknown | null) {
    return {
      rootDir: fixture.rootDir,
      store: {
        getSettings: vi.fn().mockResolvedValue({}),
        getTask: vi.fn().mockResolvedValue(undefined),
        parseFileScopeFromPrompt: vi.fn().mockResolvedValue(["src/**"]),
        logEntry: vi.fn().mockResolvedValue(undefined),
      } as unknown as TaskStore,
      workspaceConfig,
      getActiveWorktreePaths: () => [],
      getRunContextFor: () => undefined,
      emitWorktreeReanchoredAudit: async () => undefined,
    };
  }

  function committedWorkspaceTask(): { task: Task; mainDirt: string; changed: Date } {
    const start = new Date(Date.now() + 1_000).toISOString();
    const linked = fixture.createLinkedTaskWorktree("repo-a", "fusion/fn-094");
    const delivery = path.join(linked.worktreePath, "src", "delivered.ts");
    mkdirSync(path.dirname(delivery), { recursive: true });
    // FNXC:WorkspaceFinalization 2026-08-27-15:50:
    // Completion proves delivery from the acquired task worktree while main-checkout status dirt
    // stays a warning. A real linked branch keeps both completion fences on production Git paths.
    writeFileSync(delivery, "export const delivered = true;\n");
    execSync("git add src/delivered.ts && git commit -m 'feat(FN-094): delivery'", { cwd: linked.worktreePath, stdio: "pipe" });
    const mainDirt = path.join(fixture.repoPath("repo-a"), "src", "main-checkout.ts");
    mkdirSync(path.dirname(mainDirt), { recursive: true });
    writeFileSync(mainDirt, "export const operatorDirt = true;\n");
    const changed = new Date(Date.parse(start) + 10_000);
    return {
      task: task({
        id: "FN-094",
        firstExecutionAt: start,
        executionStartedAt: start,
        worktree: linked.worktreePath,
        branch: "fusion/fn-094",
        workspaceWorktrees: { "repo-a": { ...linked, branch: "fusion/fn-094" } },
        repositoryScope: { repositories: ["repo-a"], state: "confirmed", revision: 1 },
        modifiedFiles: ["repo-a/src/delivered.ts"],
        createdAt: start,
        updatedAt: start,
      }),
      mainDirt,
      changed,
    };
  }

  it("allows committed acquired delivery while a dirty main checkout passes both completion fences", async () => {
    fixture = await createWorkspaceFixture(["repo-a"]);
    const { task: workspaceTask, mainDirt, changed } = committedWorkspaceTask();
    await import("node:fs/promises").then(({ utimes }) => utimes(mainDirt, changed, changed));
    const invariants = completionDeps({ repos: fixture.repos });

    expect(await verifyWorktreeInvariants(invariants, workspaceTask)).toEqual({ ok: true });
    expect(await evaluateTaskDoneScopeLeak({
      store: invariants.store,
      workspaceConfig: { repos: fixture.repos },
      getRunContextFor: () => undefined,
      captureUncommittedModifiedFiles: async () => [],
      captureModifiedFiles: async () => [],
    }, workspaceTask, fixture.rootDir, "## File Scope\n- src/**", {} as Settings)).toEqual({ blocked: false });
  });

  it("does not scan main checkouts when workspace configuration is absent", async () => {
    fixture = await createWorkspaceFixture(["repo-a"]);
    const { task: monoTask } = committedWorkspaceTask();
    const deps = completionDeps(null);
    deps.rootDir = path.join(fixture.rootDir, "not-a-workspace");

    const result = await verifyWorktreeInvariants(deps, monoTask, monoTask.worktree);
    expect(result).not.toMatchObject({ reason: "main_checkout_edit" });
  });

  it("keeps workspace and single-repository dirty-checkout preference resolution in matched pairs", () => {
    const mergerSource = readFileSync(new URL("../merge/merger-ai.ts", import.meta.url), "utf8");
    const engineSource = readFileSync(new URL("../project-engine.ts", import.meta.url), "utf8");
    const mergeResolution = "options.allowDirtyLocalCheckoutSync ?? (settings.merger?.allowDirtyLocalCheckoutSync === true)";
    const dispatchResolution = "allowDirtyLocalCheckoutSync: settings.merger?.allowDirtyLocalCheckoutSync === true";

    expect(mergerSource.split(mergeResolution)).toHaveLength(3);
    expect(engineSource.split(dispatchResolution)).toHaveLength(3);
  });
});
