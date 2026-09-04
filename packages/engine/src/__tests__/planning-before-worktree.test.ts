import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { requiresContentReviewProof, type Settings, type TaskDetail, type WorkflowIrNode } from "@fusion/core";
import { prepareGraphNodeExecution } from "../executor/prepare-graph-node-execution.js";
import { runGraphCustomNode } from "../executor/run-graph-custom-node.js";

const ROOT = resolve(__dirname, "../../../..");

function productionEngineFiles(): string[] {
  return execFileSync("git", ["ls-files", "--", "packages/engine/src"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter((file) => file.endsWith(".ts") && !file.includes("/__tests__/"));
}

function task(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: "FN-282",
    title: "Plan before checkout",
    description: "fixture",
    column: "todo",
    priority: "normal",
    steps: [],
    currentStep: 0,
    enabledWorkflowSteps: ["plan-review"],
    workflowStepResults: [],
    ...overrides,
  } as TaskDetail;
}

function graphDeps(row: TaskDetail, workspaceConfig: { repos: string[] } | null = null) {
  return {
    store: {
      getTask: vi.fn(async () => row),
      logEntry: vi.fn(async () => undefined),
    },
    rootDir: ROOT,
    workspaceConfig,
    options: {},
    graphUnattendedRuns: new Set<string>(),
    getRunContextFor: () => undefined,
    adoptColumnAgentForNode: vi.fn(async () => undefined),
    buildInjectedRuntimeEnv: vi.fn(async () => ({ env: {}, pathEntryCount: 0, injectedKeyCount: 0 })),
    ensureGraphCustomNodeWorktree: vi.fn(async () => ({ ...row, worktree: `${ROOT}/.fusion/worktrees/FN-282` })),
    executeScriptWorkflowStep: vi.fn(async () => ({ success: true, output: "APPROVE", verdict: "APPROVE" })),
    executeWorkflowStep: vi.fn(async () => ({ success: true, output: "APPROVE", verdict: "APPROVE" })),
    pauseForCliApproval: vi.fn(),
    resolveWorkflowInputMarkerForGraphNode: vi.fn(async () => undefined),
    runAwaitInputNode: vi.fn(),
    runCliAgentNode: vi.fn(),
    runRawCliCommand: vi.fn(),
    runConfiguredCommand: vi.fn(),
  };
}

const PLAN_REVIEW_NODE = {
  id: "plan-review-step",
  kind: "prompt",
  config: { name: "Plan Review", prompt: "Review the plan", toolMode: "readonly" },
} as WorkflowIrNode;

describe("planning before execution worktree acquisition", () => {
  it("has no production planning-worktree acquisition surface", () => {
    const offenders = productionEngineFiles().flatMap((file) => {
      const source = readFileSync(resolve(ROOT, file), "utf8");
      return /ensureTaskWorktreeForPlanning|acquirePlanningWorktree/.test(source) ? [file] : [];
    });

    expect(offenders).toEqual([]);
  });

  it("declares project-root planning as read-only with only .fusion writable", () => {
    const source = readFileSync(resolve(ROOT, "packages/engine/src/triage.ts"), "utf8");

    expect(source).toContain("const planningCwd = this.rootDir;");
    expect(source).toContain('kind: "read-only-root" as const');
    expect(source).toContain('writableAllowlist: [join(this.rootDir, ".fusion")]');
    expect(source).not.toContain("Workspace planning requires a private task directory");
  });

  it("runs checkout-less single-repository Plan Review from main without acquisition", async () => {
    const row = task();
    const deps = graphDeps(row);

    await runGraphCustomNode(deps as never, PLAN_REVIEW_NODE, row, {} as Settings, "plan-review", { reviewKind: "plan" });

    expect(deps.ensureGraphCustomNodeWorktree).not.toHaveBeenCalled();
    expect(deps.executeWorkflowStep).toHaveBeenCalledWith(
      row,
      expect.any(Object),
      ROOT,
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({
        sessionBoundary: {
          kind: "read-only-root",
          writableRoot: null,
          projectRoot: ROOT,
          writableAllowlist: [`${ROOT}/.fusion`],
        },
      }),
    );
  });

  it("runs checkout-less workspace Plan Review from the workspace root without acquisition", async () => {
    const row = task({ workspaceWorktrees: {} });
    const deps = graphDeps(row, { repos: ["packages/core", "packages/engine"] });

    const result = await runGraphCustomNode(deps as never, PLAN_REVIEW_NODE, row, {} as Settings, "plan-review", { reviewKind: "plan" });

    expect(result.outcome).toBe("success");
    expect(deps.ensureGraphCustomNodeWorktree).not.toHaveBeenCalled();
    expect(deps.executeWorkflowStep).toHaveBeenCalledWith(
      row,
      expect.any(Object),
      ROOT,
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({ sessionBoundary: expect.objectContaining({ kind: "read-only-root", projectRoot: ROOT }) }),
    );
  });

  it.each([false, true])("honors a read-only preparation requirement before store access (workspace=%s)", async (workspace) => {
    const row = task({ workspaceWorktrees: workspace ? {} : undefined });
    const deps = {
      store: { getTask: vi.fn(async () => row), logEntry: vi.fn(async () => undefined) },
      rootDir: ROOT,
      workspaceConfigOwner: {},
      getWorkspaceConfig: () => workspace ? { repos: ["packages/core"] } : null,
      setWorkspaceConfig: vi.fn(),
      getRunContextFor: () => undefined,
      ensureGraphCustomNodeWorktree: vi.fn(),
    };

    await prepareGraphNodeExecution(deps as never, PLAN_REVIEW_NODE, row, {} as Settings, { requiresWorktree: false });

    expect(deps.store.getTask).not.toHaveBeenCalled();
    expect(deps.ensureGraphCustomNodeWorktree).not.toHaveBeenCalled();
  });

  it("acquires the first checkout only when a write-capable execution node begins", async () => {
    const row = task();
    const acquired = { ...row, worktree: `${ROOT}/.fusion/worktrees/FN-282` };
    const deps = {
      store: { getTask: vi.fn(async () => row), logEntry: vi.fn(async () => undefined) },
      rootDir: ROOT,
      workspaceConfigOwner: {},
      getWorkspaceConfig: () => null,
      setWorkspaceConfig: vi.fn(),
      getRunContextFor: () => undefined,
      ensureGraphCustomNodeWorktree: vi.fn(async () => acquired),
    };

    await prepareGraphNodeExecution(
      deps as never,
      { id: "implementation", kind: "code", config: { toolMode: "coding" } } as WorkflowIrNode,
      row,
      {} as Settings,
      { requiresWorktree: true },
    );

    expect(deps.ensureGraphCustomNodeWorktree).toHaveBeenCalledOnce();
    expect(deps.ensureGraphCustomNodeWorktree).toHaveBeenCalledWith(row, expect.any(Object), "implementation", true);
  });

  it("does not require content-review diff proof for Plan Review", () => {
    expect(requiresContentReviewProof("plan-review", { reviewKind: "plan" })).toBe(false);
    expect(requiresContentReviewProof("code-review", { reviewKind: "code" })).toBe(true);
  });
});
