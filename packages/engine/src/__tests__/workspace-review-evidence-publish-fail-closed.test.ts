import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import ts from "typescript";
import type { Task, TaskStore } from "@fusion/core";

const reviewWorkspacePerRepoMock = vi.hoisted(() => vi.fn());
vi.mock("../executor/workspace-review-per-repo.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../executor/workspace-review-per-repo.js")>(),
  reviewWorkspacePerRepo: reviewWorkspacePerRepoMock,
}));

import { TaskExecutor } from "../executor.js";
import { runGraphCustomNode } from "../executor/run-graph-custom-node.js";
import { FOREACH_ACTIVE_CONTEXT_KEY } from "../workflows/workflow-node-handlers.js";

const ROOT = "/workspace";
const roots: string[] = [];
const reviewAggregate = {
  verdict: "APPROVE" as const,
  review: "approved both repositories",
  summary: "approved both repositories",
  retryable: false,
  repositoryScopeRevision: 1,
  repositoryDiffFingerprints: { "repo-a": "fingerprint-a", "repo-b": "fingerprint-b" },
  repositoryModifiedFiles: ["repo-a/src/a.ts", "repo-b/src/b.ts"],
  repositoryReviewOutcomes: [],
};

function workspaceTask(root = ROOT): Task {
  return {
    id: "FN-259",
    title: "Workspace review evidence",
    description: "Persist workspace review evidence.",
    column: "in-review",
    dependencies: [],
    steps: [{ name: "Implement", status: "done" }],
    currentStep: 0,
    log: [],
    repositoryScope: { state: "confirmed", revision: 1, repositories: ["repo-a", "repo-b"] },
    workspaceWorktrees: {
      "repo-a": { worktreePath: `${root}/.fusion/worktrees/fn-259/repo-a`, branch: "fusion/fn-259", baseCommitSha: "base-a" },
      "repo-b": { worktreePath: `${root}/.fusion/worktrees/fn-259/repo-b`, branch: "fusion/fn-259", baseCommitSha: "base-b" },
    },
    modifiedFiles: ["repo-a/src/a.ts", "repo-b/src/b.ts"],
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T00:00:00.000Z",
  } as Task;
}

type WriterMode = "missing" | "refused" | "throws";

function makeStore(task: Task, mode: WriterMode) {
  const store = Object.assign(new EventEmitter(), {
    getTask: vi.fn(async () => task),
    getSettings: vi.fn(async () => ({ autoMerge: false })),
    updateStep: vi.fn(async () => undefined),
    updateTaskAtomic: vi.fn(async () => task),
    logEntry: vi.fn(async () => undefined),
    getTaskWorkflowSelection: vi.fn(async () => undefined),
    getWorkflowDefinition: vi.fn(async () => undefined),
    getWorkflowSettingValues: vi.fn(async () => ({})),
  }) as Record<string, unknown>;
  if (mode === "refused") {
    store.publishWorkspaceCodeReviewEvidence = vi.fn(async () => ({ task, published: false as const }));
  }
  if (mode === "throws") {
    store.publishWorkspaceCodeReviewEvidence = vi.fn(async () => {
      throw new Error("durable writer unavailable");
    });
  }
  return store as unknown as TaskStore & { logEntry: ReturnType<typeof vi.fn> };
}

function makeExecutor(store: TaskStore, root = ROOT): TaskExecutor {
  const executor = new TaskExecutor(store, root);
  (executor as unknown as { workspaceConfig: { repos: string[] } }).workspaceConfig = { repos: ["repo-a", "repo-b"] };
  vi.spyOn(executor as never, "reviewWorkspacePerRepo").mockResolvedValue(reviewAggregate);
  return executor;
}

async function runStepProducer(store: TaskStore, task: Task) {
  const seams = makeExecutor(store).createAuthoritativeWorkflowSeams({ autoMerge: false } as never);
  return await seams.stepReview!(task as never, {
    [FOREACH_ACTIVE_CONTEXT_KEY]: { stepIndex: 0, worktreePath: ROOT, baselineSha: "base" },
  } as never, { type: "code", advisory: false } as never);
}

async function runGraphProducer(store: TaskStore, task: Task, root: string) {
  reviewWorkspacePerRepoMock.mockResolvedValue(reviewAggregate);
  return await runGraphCustomNode({
    store,
    rootDir: root,
    workspaceConfig: { repos: ["repo-a", "repo-b"] },
    options: {},
    graphUnattendedRuns: new Set<string>(),
    getRunContextFor: () => undefined,
    adoptColumnAgentForNode: vi.fn(async () => undefined),
    buildInjectedRuntimeEnv: vi.fn(async () => ({ env: {}, pathEntryCount: 0, injectedKeyCount: 0 })),
    ensureGraphCustomNodeWorktree: vi.fn(async () => task),
    executeScriptWorkflowStep: vi.fn(),
    executeWorkflowStep: vi.fn(),
    pauseForCliApproval: vi.fn(),
    resolveWorkflowInputMarkerForGraphNode: vi.fn(async () => undefined),
    runAwaitInputNode: vi.fn(),
    runCliAgentNode: vi.fn(),
    runRawCliCommand: vi.fn(),
    runConfiguredCommand: vi.fn(),
  }, { id: "code-review", kind: "prompt", config: { name: "Code Review", reviewKind: "code", prompt: "Review.", toolMode: "readonly" } }, task as never, {} as never);
}

function repositoryQualifiedFailureLogs(store: { logEntry: ReturnType<typeof vi.fn> }): unknown[][] {
  return store.logEntry.mock.calls.filter((call) => String(call[1]).startsWith("Workspace Code Review approval unavailable for FN-259:"));
}

afterEach(() => {
  reviewWorkspacePerRepoMock.mockReset();
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

function workspaceRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "fusion-fn259-evidence-"));
  roots.push(root);
  mkdirSync(join(root, ".fusion", "worktrees", "fn-259", "repo-a"), { recursive: true });
  mkdirSync(join(root, ".fusion", "worktrees", "fn-259", "repo-b"), { recursive: true });
  return root;
}

describe("workspace Code Review evidence publication", () => {
  it.each(["missing", "refused", "throws"] as const)("fails closed in the step-review producer when the writer is %s", async (mode) => {
    const task = workspaceTask();
    const store = makeStore(task, mode);

    const result = await runStepProducer(store, task);

    expect(result).toMatchObject({ verdict: "UNAVAILABLE", retryable: true });
    expect(result).not.toMatchObject({ verdict: "APPROVE" });
    expect(repositoryQualifiedFailureLogs(store)).toHaveLength(1);
    expect(repositoryQualifiedFailureLogs(store)[0]).toEqual(expect.arrayContaining([
      "FN-259",
      expect.stringContaining("repo-a, repo-b"),
    ]));
  });

  it.each(["missing", "refused", "throws"] as const)("fails closed in the graph producer when the writer is %s", async (mode) => {
    const root = workspaceRoot();
    const task = workspaceTask(root);
    const store = makeStore(task, mode);

    const result = await runGraphProducer(store, task, root);

    expect(result).toMatchObject({ outcome: "failure", value: "workspace-review-unavailable" });
    expect(result).not.toMatchObject({ outcome: "success" });
    expect(repositoryQualifiedFailureLogs(store)).toHaveLength(1);
    expect(repositoryQualifiedFailureLogs(store)[0]).toEqual(expect.arrayContaining([
      "FN-259",
      expect.stringContaining("repo-a, repo-b"),
    ]));
  });
});

function productionTypescriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : productionTypescriptFiles(path);
    return entry.isFile() && path.endsWith(".ts") ? [path] : [];
  });
}

function objectContainsRepositoryScope(node: ts.Node): boolean {
  if (!ts.isObjectLiteralExpression(node)) return false;
  return node.properties.some((property) => ts.isPropertyAssignment(property)
    && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
    && property.name.text === "repositoryScope");
}

function updateCallCarriesRepositoryScope(call: ts.CallExpression): boolean {
  const expression = call.expression;
  if (!ts.isPropertyAccessExpression(expression) || !["updateTask", "updateTaskAtomic"].includes(expression.name.text)) return false;
  const argument = call.arguments[1];
  if (!argument) return false;
  if (objectContainsRepositoryScope(argument)) return true;
  if (!ts.isArrowFunction(argument) && !ts.isFunctionExpression(argument)) return false;
  if (objectContainsRepositoryScope(argument.body)) return true;
  let found = false;
  const inspect = (node: ts.Node) => {
    if (ts.isReturnStatement(node) && node.expression && objectContainsRepositoryScope(node.expression)) found = true;
    ts.forEachChild(node, inspect);
  };
  inspect(argument.body);
  return found;
}

describe("workspace review evidence writer structure", () => {
  it("keeps repository scope out of generic update patches and exposes one shared workspace approval writer", () => {
    const root = resolve(__dirname, "../../../..");
    const productionFiles = [
      ...productionTypescriptFiles(join(root, "packages/core/src")),
      ...productionTypescriptFiles(join(root, "packages/engine/src")),
    ];
    const offendingCalls: string[] = [];
    let writerDefinitions = 0;
    for (const path of productionFiles) {
      const source = readFileSync(path, "utf8");
      writerDefinitions += source.match(/export\s+async\s+function\s+persistWorkspaceCodeReviewApproval\s*\(/g)?.length ?? 0;
      const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const inspect = (node: ts.Node) => {
        if (ts.isCallExpression(node) && updateCallCarriesRepositoryScope(node)) offendingCalls.push(path);
        ts.forEachChild(node, inspect);
      };
      inspect(file);
    }

    expect(offendingCalls).toEqual([]);
    expect(writerDefinitions).toBe(1);
  });
});
