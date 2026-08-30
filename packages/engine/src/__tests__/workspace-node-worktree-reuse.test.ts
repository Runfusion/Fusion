import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskDetail } from "@fusion/core";

const reviewWorkspacePerRepoMock = vi.hoisted(() => vi.fn());
vi.mock("../executor/workspace-review-per-repo.js", () => ({
  isApprovalFamilyVerdict: (verdict: string) => verdict === "APPROVE" || verdict === "APPROVE_WITH_ADVISORIES",
  reviewWorkspacePerRepo: reviewWorkspacePerRepoMock,
}));

import { runGraphCustomNode } from "../executor/run-graph-custom-node.js";

const roots: string[] = [];

afterEach(async () => {
  reviewWorkspacePerRepoMock.mockReset();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function task(root: string, paths: Record<string, string | undefined>): TaskDetail {
  const now = "2026-08-28T00:00:00.000Z";
  return {
    id: "FN-207",
    title: "Workspace review reuse",
    description: "Review the existing scoped checkouts",
    column: "in-review",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    status: null,
    paused: false,
    userPaused: false,
    createdAt: now,
    updatedAt: now,
    repositoryScope: { state: "confirmed", revision: 1, repositories: ["repo-a", "repo-b"] },
    workspaceWorktrees: Object.fromEntries(Object.entries(paths).map(([repo, worktreePath]) => [
      repo,
      worktreePath ? { worktreePath, branch: `fusion/fn-207-${repo}`, baseCommitSha: "base" } : {},
    ])),
    modifiedFiles: ["repo-a/src/a.ts", "repo-b/src/b.ts"],
    prompt: "# Task\n",
    worktree: undefined,
    branch: undefined,
    workspaceRoot: root,
  } as TaskDetail;
}

function deps(root: string, row: TaskDetail) {
  const store = {
    getTask: vi.fn(async () => row),
    logEntry: vi.fn(async () => undefined),
    updateTask: vi.fn(async (_id: string, patch: Partial<TaskDetail>) => Object.assign(row, patch)),
    updateTaskAtomic: vi.fn(async (_id: string, mutate: (current: TaskDetail) => Partial<TaskDetail> | null) => {
      const patch = mutate(row);
      if (patch) Object.assign(row, patch);
      return row;
    }),
    publishWorkspaceCodeReviewEvidence: vi.fn(async (_id: string, input: {
      expectedScopeRevision: number;
      reviewEvidence: NonNullable<NonNullable<TaskDetail["repositoryScope"]>["reviewEvidence"]>;
      clearReviewRemediation: boolean;
      modifiedFiles?: string[];
    }) => {
      const scope = row.repositoryScope;
      if (!scope) return { task: row, published: false as const, reason: "scope-absent" as const };
      if (scope.revision !== input.expectedScopeRevision) {
        return { task: row, published: false as const, reason: "scope-superseded" as const };
      }
      row.repositoryScope = {
        ...scope,
        reviewEvidence: input.reviewEvidence,
        ...(input.clearReviewRemediation && scope.reviewRemediation?.scopeRevision === input.expectedScopeRevision
          ? { reviewRemediation: undefined }
          : {}),
      };
      if (input.modifiedFiles !== undefined) row.modifiedFiles = input.modifiedFiles;
      return { task: row, published: true as const };
    }),
  };
  return {
    store,
    rootDir: root,
    workspaceConfig: { repos: ["repo-a", "repo-b"] },
    options: {},
    graphUnattendedRuns: new Set<string>(),
    getRunContextFor: () => undefined,
    adoptColumnAgentForNode: vi.fn(async () => undefined),
    buildInjectedRuntimeEnv: vi.fn(async () => ({ env: {}, pathEntryCount: 0, injectedKeyCount: 0 })),
    ensureGraphCustomNodeWorktree: vi.fn(async (current: TaskDetail) => current),
    executeScriptWorkflowStep: vi.fn(async () => ({ success: true, output: "APPROVE", verdict: "APPROVE" })),
    executeWorkflowStep: vi.fn(async () => ({ success: true, output: "APPROVE", verdict: "APPROVE" })),
    pauseForCliApproval: vi.fn(),
    resolveWorkflowInputMarkerForGraphNode: vi.fn(async () => undefined),
    runAwaitInputNode: vi.fn(),
    runCliAgentNode: vi.fn(),
    runRawCliCommand: vi.fn(),
  };
}

const CODE_REVIEW_NODE = {
  id: "code-review-step",
  kind: "prompt",
  config: { name: "Code Review", prompt: "Review code.", reviewKind: "code", toolMode: "readonly" },
} as const;

const PLAN_REVIEW_WRITE_NODE = {
  id: "plan-review-step",
  kind: "prompt",
  config: { name: "Plan Review", prompt: "Review plan.", reviewKind: "plan", toolMode: "coding" },
} as const;

async function workspacePaths(root: string) {
  const paths = {
    "repo-a": join(root, ".fusion", "worktrees", "fn-207", "repo-a"),
    "repo-b": join(root, ".fusion", "worktrees", "fn-207", "repo-b"),
  };
  await Promise.all(Object.values(paths).map((path) => mkdir(path, { recursive: true })));
  return paths;
}

describe("workspace graph-node checkout reuse", () => {
  it("reuses every present scoped checkout without acquisition noise", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-fn207-workspace-"));
    roots.push(root);
    const paths = await workspacePaths(root);
    const row = task(root, paths);
    const harness = deps(root, row);
    reviewWorkspacePerRepoMock.mockImplementation(async (live: TaskDetail, review: (path: string) => Promise<unknown>) => {
      await Promise.all(live.repositoryScope!.repositories.map((repo) => review(live.workspaceWorktrees![repo]!.worktreePath!)));
      return {
        verdict: "APPROVE", review: "approved", summary: "approved", retryable: false,
        repositoryScopeRevision: 1,
        repositoryReviewOutcomes: [],
        repositoryDiffFingerprints: { "repo-a": "fp-a", "repo-b": "fp-b" },
        repositoryModifiedFiles: ["repo-a/src/a.ts", "repo-b/src/b.ts"],
      };
    });

    const result = await runGraphCustomNode(harness as never, CODE_REVIEW_NODE as never, row, {} as never);

    expect(result.outcome).toBe("success");
    expect(harness.ensureGraphCustomNodeWorktree).not.toHaveBeenCalled();
    expect(harness.executeWorkflowStep).toHaveBeenCalledTimes(2);
    expect(harness.store.logEntry.mock.calls.flat().join(" ")).not.toContain("acquiring");
  });

  it("acquires when a scoped repository has never been recorded", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-fn207-workspace-"));
    roots.push(root);
    const paths = await workspacePaths(root);
    const row = task(root, { "repo-a": paths["repo-a"], "repo-b": undefined });
    const harness = deps(root, row);
    harness.ensureGraphCustomNodeWorktree.mockImplementation(async () => {
      row.workspaceWorktrees!["repo-b"] = { worktreePath: paths["repo-b"], branch: "fusion/fn-207-repo-b", baseCommitSha: "base" };
      return row;
    });
    reviewWorkspacePerRepoMock.mockResolvedValue({ verdict: "APPROVE", review: "approved", summary: "approved", retryable: false });

    await runGraphCustomNode(harness as never, CODE_REVIEW_NODE as never, row, {} as never);

    expect(harness.ensureGraphCustomNodeWorktree).toHaveBeenCalledTimes(1);
  });

  it("reacquires every configured checkout when a recorded Code Review child vanished", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-fn207-workspace-"));
    roots.push(root);
    const paths = await workspacePaths(root);
    await rm(paths["repo-b"], { recursive: true, force: true });
    const row = task(root, paths);
    const harness = deps(root, row);
    harness.ensureGraphCustomNodeWorktree.mockImplementation(async () => {
      await mkdir(paths["repo-b"], { recursive: true });
      return row;
    });
    reviewWorkspacePerRepoMock.mockResolvedValue({ verdict: "APPROVE", review: "approved", summary: "approved", retryable: false });

    await runGraphCustomNode(harness as never, CODE_REVIEW_NODE as never, row, {} as never);

    expect(harness.ensureGraphCustomNodeWorktree).toHaveBeenCalledTimes(1);
  });

  it("allows Plan Review to reacquire a recorded checkout that vanished", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-fn207-workspace-"));
    roots.push(root);
    const paths = await workspacePaths(root);
    await rm(paths["repo-b"], { recursive: true, force: true });
    const row = task(root, paths);
    const harness = deps(root, row);
    harness.ensureGraphCustomNodeWorktree.mockImplementation(async () => {
      await mkdir(paths["repo-b"], { recursive: true });
      return row;
    });

    await runGraphCustomNode(harness as never, PLAN_REVIEW_WRITE_NODE as never, row, {} as never);

    expect(harness.ensureGraphCustomNodeWorktree).toHaveBeenCalledTimes(1);
    expect(harness.store.logEntry).toHaveBeenCalledWith(
      row.id,
      expect.stringContaining("acquiring configured workspace checkout 'repo-b'"),
      undefined,
      undefined,
    );
  });
});
