import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Settings, TaskDetail } from "@fusion/core";

const reviewWorkspacePerRepoMock = vi.hoisted(() => vi.fn());
vi.mock("../executor/workspace-review-per-repo.js", () => ({
  isApprovalFamilyVerdict: (verdict: string) => verdict === "APPROVE" || verdict === "APPROVE_WITH_ADVISORIES",
  reviewWorkspacePerRepo: reviewWorkspacePerRepoMock,
}));

import { runGraphCustomNode } from "../executor/run-graph-custom-node.js";

const roots: string[] = [];

const DOCUMENTATION_NODE = {
  id: "documentation-delivery-step",
  kind: "prompt",
  config: {
    name: "Documentation & Delivery",
    prompt: "Inspect the delivered files.",
    toolMode: "readonly",
  },
} as const;

const CODE_REVIEW_NODE = {
  id: "code-review-step",
  kind: "prompt",
  config: {
    name: "Code Review",
    prompt: "Review the delivered files.",
    reviewKind: "code",
    toolMode: "readonly",
  },
} as const;

const PLAN_REVIEW_NODE = {
  id: "plan-review-step",
  kind: "prompt",
  config: {
    name: "Plan Review",
    prompt: "Review the plan.",
    reviewKind: "plan",
    toolMode: "readonly",
  },
} as const;

const DETERMINISTIC_GATE = {
  id: "deterministic-verification",
  kind: "gate",
  config: {
    name: "Verification",
    workflowAction: "deterministic-verification",
    toolMode: "readonly",
  },
} as const;

const SCRIPT_GATE = {
  id: "script-delivery-check",
  kind: "gate",
  config: {
    name: "Script delivery check",
    scriptName: "check-delivery",
    toolMode: "readonly",
  },
} as const;

function workspaceTask(root: string, paths: Record<string, string | undefined>, overrides: Partial<TaskDetail> = {}): TaskDetail {
  const now = "2026-08-29T00:00:00.000Z";
  return {
    id: "FN-255",
    title: "Workspace gate context",
    description: "Use task-owned child worktrees for reporting gates.",
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
    prompt: "# Task\n",
    worktree: undefined,
    branch: undefined,
    workspaceRoot: root,
    repositoryScope: { state: "confirmed", revision: 1, repositories: ["repo1", "repo2"] },
    workspaceWorktrees: Object.fromEntries(Object.entries(paths).map(([repo, worktreePath]) => [
      repo,
      worktreePath ? { worktreePath, branch: `fusion/fn-255-${repo}`, baseCommitSha: "base" } : {},
    ])),
    ...overrides,
  } as TaskDetail;
}

function createHarness(root: string, row: TaskDetail) {
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
    workspaceConfig: { repos: ["repo1", "repo2"] },
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

async function createWorkspacePaths(root: string) {
  const taskDir = join(root, ".fusion", "worktrees", "fn-255");
  const paths = {
    repo1: join(taskDir, "repo1"),
    repo2: join(taskDir, "repo2"),
  };
  await Promise.all(Object.values(paths).map((path) => mkdir(path, { recursive: true })));
  return { taskDir, paths };
}

afterEach(async () => {
  reviewWorkspacePerRepoMock.mockReset();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("workspace gate repository context", () => {
  it("runs Documentation from the task directory whose boundary names both acquired repositories", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-fn255-workspace-gate-"));
    roots.push(root);
    const { taskDir, paths } = await createWorkspacePaths(root);
    const row = workspaceTask(root, paths);
    const harness = createHarness(root, row);

    const result = await runGraphCustomNode(harness as never, DOCUMENTATION_NODE as never, row, {} as Settings);

    expect(result.outcome).toBe("success");
    expect(harness.executeWorkflowStep).toHaveBeenCalledTimes(1);
    expect(harness.executeWorkflowStep.mock.calls[0]?.[2]).toBe(taskDir);
    expect(harness.executeWorkflowStep.mock.calls[0]?.[5]).toMatchObject({
      sessionBoundary: {
        kind: "workspace-task-dir",
        writableRoot: taskDir,
        projectRoot: root,
        repoRoots: [
          { repoRelPath: "repo1", repoRootDir: join(root, "repo1") },
          { repoRelPath: "repo2", repoRootDir: join(root, "repo2") },
        ],
      },
    });
  });

  it("keeps Code Review fan-out on the same acquired tree set", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-fn255-workspace-gate-"));
    roots.push(root);
    const { paths } = await createWorkspacePaths(root);
    const row = workspaceTask(root, paths);
    const harness = createHarness(root, row);
    reviewWorkspacePerRepoMock.mockImplementation(async (live: TaskDetail, review: (path: string) => Promise<unknown>) => {
      await Promise.all(live.repositoryScope!.repositories.map((repo) => review(live.workspaceWorktrees![repo]!.worktreePath!)));
      return {
        verdict: "APPROVE",
        review: "approved",
        summary: "approved",
        retryable: false,
        repositoryScopeRevision: 1,
        repositoryReviewOutcomes: [],
        repositoryDiffFingerprints: { repo1: "fp-1", repo2: "fp-2" },
        repositoryModifiedFiles: ["repo1/src/changed.ts", "repo2/src/changed.ts"],
      };
    });

    await runGraphCustomNode(harness as never, CODE_REVIEW_NODE as never, row, {} as Settings);

    expect(harness.executeWorkflowStep.mock.calls.map((call) => call[2])).toEqual([paths.repo1, paths.repo2]);
    expect(harness.executeWorkflowStep.mock.calls.map((call) => call[5]?.dispatchLabel)).toEqual(["repo1", "repo2"]);
  });

  it("fans out Code Review from the authoritative scope after the initial graph snapshot becomes stale", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-fn255-workspace-gate-"));
    roots.push(root);
    const { paths } = await createWorkspacePaths(root);
    const stale = workspaceTask(root, paths, {
      repositoryScope: { state: "confirmed", revision: 1, repositories: ["repo1"] },
    });
    const authoritative = workspaceTask(root, paths, {
      repositoryScope: { state: "confirmed", revision: 2, repositories: ["repo2"] },
    });
    const harness = createHarness(root, authoritative);
    harness.store.getTask
      .mockImplementationOnce(async () => stale)
      .mockImplementation(async () => authoritative);
    reviewWorkspacePerRepoMock.mockImplementation(async (task: TaskDetail, review: (path: string) => Promise<unknown>) => {
      await Promise.all(task.repositoryScope!.repositories.map((repo) => review(task.workspaceWorktrees![repo]!.worktreePath!)));
      return {
        verdict: "APPROVE",
        review: "approved",
        summary: "approved",
        retryable: false,
        repositoryScopeRevision: task.repositoryScope!.revision,
        repositoryReviewOutcomes: [],
        repositoryDiffFingerprints: Object.fromEntries(task.repositoryScope!.repositories.map((repository) => [repository, `fp-${repository}`])),
        repositoryModifiedFiles: task.repositoryScope!.repositories.map((repository) => `${repository}/src/changed.ts`),
      };
    });

    await runGraphCustomNode(harness as never, CODE_REVIEW_NODE as never, stale, {} as Settings);

    expect(reviewWorkspacePerRepoMock).toHaveBeenCalledWith(authoritative, expect.any(Function), expect.any(Object));
    expect(harness.executeWorkflowStep.mock.calls.map((call) => call[0])).toEqual([authoritative]);
    expect(harness.executeWorkflowStep.mock.calls.map((call) => call[2])).toEqual([paths.repo2]);
    expect(harness.executeWorkflowStep.mock.calls.map((call) => call[2])).not.toContain(paths.repo1);
    expect(harness.executeWorkflowStep.mock.calls[0]?.[5]).toMatchObject({
      sessionBoundary: { repoRoots: [{ repoRelPath: "repo2", repoRootDir: join(root, "repo2") }] },
    });
    expect(harness.executeWorkflowStep.mock.calls.map((call) => call[5]?.dispatchLabel)).toEqual(["repo2"]);
  });

  it("keeps Plan Review in the task directory and deterministic verification on its existing path", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-fn255-workspace-gate-"));
    roots.push(root);
    const { taskDir, paths } = await createWorkspacePaths(root);
    const row = workspaceTask(root, paths);
    const harness = createHarness(root, row);

    await runGraphCustomNode(harness as never, PLAN_REVIEW_NODE as never, row, {} as Settings);
    expect(harness.executeWorkflowStep.mock.calls[0]?.[2]).toBe(taskDir);
    expect(harness.executeWorkflowStep.mock.calls[0]?.[5]).toMatchObject({
      sessionBoundary: {
        kind: "workspace-task-dir",
        writableRoot: taskDir,
        projectRoot: root,
        repoRoots: [
          { repoRelPath: "repo1", repoRootDir: join(root, "repo1") },
          { repoRelPath: "repo2", repoRootDir: join(root, "repo2") },
        ],
      },
    });

    const verification = await runGraphCustomNode(harness as never, DETERMINISTIC_GATE as never, row, {} as Settings);
    expect(verification).toMatchObject({ outcome: "success", value: "not-configured" });
    expect(harness.executeWorkflowStep).toHaveBeenCalledTimes(1);
  });

  it("keeps a legacy-layout reporting gate on its recorded child worktree", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-fn255-workspace-gate-"));
    roots.push(root);
    const { taskDir } = await createWorkspacePaths(root);
    const legacyRepo = join(root, "legacy-repo1");
    await mkdir(legacyRepo, { recursive: true });
    const row = workspaceTask(root, { repo1: legacyRepo, repo2: join(root, "legacy-repo2") });
    await mkdir(row.workspaceWorktrees!.repo2!.worktreePath!, { recursive: true });
    const harness = createHarness(root, row);

    await runGraphCustomNode(harness as never, DOCUMENTATION_NODE as never, row, {} as Settings);

    expect(harness.executeWorkflowStep.mock.calls[0]?.[2]).toBe(legacyRepo);
    expect(harness.executeWorkflowStep.mock.calls[0]?.[5]).not.toHaveProperty("sessionBoundary");
    expect(taskDir).toContain("fn-255");
  });

  it("gives script-mode workspace gates the task-directory cwd", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-fn255-workspace-gate-"));
    roots.push(root);
    const { taskDir, paths } = await createWorkspacePaths(root);
    const row = workspaceTask(root, paths);
    const harness = createHarness(root, row);

    await runGraphCustomNode(harness as never, SCRIPT_GATE as never, row, {} as Settings);

    expect(harness.executeScriptWorkflowStep.mock.calls[0]?.[2]).toBe(taskDir);
  });

  it.each([
    ["unconfirmed scope", (root: string, paths: Record<string, string>) => workspaceTask(root, paths, { repositoryScope: { state: "proposed", revision: 1, repositories: ["repo1", "repo2"] } })],
    ["missing recorded checkout", (root: string, paths: Record<string, string>) => workspaceTask(root, { repo1: paths.repo1, repo2: join(root, ".fusion", "worktrees", "fn-255", "missing-repo2") })],
    ["missing worktree entry", (root: string, paths: Record<string, string>) => workspaceTask(root, { repo1: paths.repo1, repo2: undefined })],
    ["missing task directory", (root: string, paths: Record<string, string>) => workspaceTask(root, paths)],
  ] as const)("returns an explicit not-run result without constructing a session when context has %s", async (_name, makeTask) => {
    const root = await mkdtemp(join(tmpdir(), "fusion-fn255-workspace-gate-"));
    roots.push(root);
    const { taskDir, paths } = await createWorkspacePaths(root);
    const row = makeTask(root, paths);
    if (_name === "missing task directory") {
      await rm(taskDir, { recursive: true, force: true });
    }
    const harness = createHarness(root, row);

    const result = await runGraphCustomNode(harness as never, DOCUMENTATION_NODE as never, row, {} as Settings);

    expect(result).toMatchObject({
      outcome: "success",
      value: "repository-context-unresolved",
      contextPatch: { notRunReason: "repository-context-unresolved" },
    });
    expect(harness.executeWorkflowStep).not.toHaveBeenCalled();
    expect(harness.executeScriptWorkflowStep).not.toHaveBeenCalled();
    expect(harness.buildInjectedRuntimeEnv).not.toHaveBeenCalled();
  });
});
