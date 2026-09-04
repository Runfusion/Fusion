import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunCommandResult, Settings, Task, TaskDetail, TaskStore, WorkflowIr, WorkflowStepResult } from "@fusion/core";
import { runPlanReviewDependencyGate, runGraphCustomNode } from "../executor/run-graph-custom-node.js";
import { requestPreMergeOptionalStepFix } from "../executor/request-pre-merge-optional-step-fix.js";
import { WorkflowGraphExecutor } from "../workflows/workflow-graph-executor.js";

const roots: string[] = [];

function worktree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "fn-258-plan-review-"));
  roots.push(root);
  mkdirSync(join(root, ".git"));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(root, name), content);
  return root;
}

function runner(result: RunCommandResult = { stdout: "", stderr: "", exitCode: 0, signal: null, timedOut: false, bufferExceeded: false }) {
  return vi.fn().mockResolvedValue(result);
}

function task(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: "FN-258",
    title: "Dependency gate fixture",
    description: "fixture",
    column: "todo",
    priority: "normal",
    steps: [],
    currentStep: 0,
    ...overrides,
  } as TaskDetail;
}

function input(overrides: Parameters<typeof runPlanReviewDependencyGate>[0] extends infer T ? Partial<T> : never = {}) {
  const store = { logEntry: vi.fn().mockResolvedValue(undefined) } as unknown as TaskStore;
  const worktreePath = overrides.worktreePath ?? worktree({ "index.html": "ok" });
  return {
    settings: {} as Settings,
    workspaceConfig: null,
    worktreePath,
    store,
    getRunContextFor: () => undefined,
    runConfiguredCommand: runner(),
    ...overrides,
    task: overrides.task ?? task({ worktree: worktreePath }),
  };
}

function graphNodeDeps(row: TaskDetail, worktreePath: string, runConfiguredCommand = runner()) {
  const store = {
    getTask: vi.fn(async () => row),
    logEntry: vi.fn(async () => undefined),
  };
  return {
    store,
    rootDir: tmpdir(),
    workspaceConfig: null,
    options: {},
    graphUnattendedRuns: new Set<string>(),
    getRunContextFor: () => undefined,
    adoptColumnAgentForNode: vi.fn(async () => undefined),
    buildInjectedRuntimeEnv: vi.fn(async () => ({ env: {}, pathEntryCount: 0, injectedKeyCount: 0 })),
    ensureGraphCustomNodeWorktree: vi.fn(async () => row),
    executeScriptWorkflowStep: vi.fn(async () => ({ success: true, output: "APPROVE", verdict: "APPROVE" })),
    executeWorkflowStep: vi.fn(async () => ({ success: true, output: "APPROVE", verdict: "APPROVE" })),
    pauseForCliApproval: vi.fn(),
    resolveWorkflowInputMarkerForGraphNode: vi.fn(async () => undefined),
    runAwaitInputNode: vi.fn(),
    runCliAgentNode: vi.fn(),
    runRawCliCommand: vi.fn(),
    runConfiguredCommand,
    worktreePath,
  };
}

function planReviewGraph(): WorkflowIr {
  return {
    version: "v2",
    name: "dependency-gate-production-path",
    columns: [{ id: "todo", name: "Todo", traits: [] }],
    nodes: [
      { id: "start", kind: "start" },
      {
        id: "plan-review",
        kind: "optional-group",
        config: {
          name: "Plan Review",
          reviewKind: "plan",
          defaultOn: true,
          maxRevisions: "unbounded",
          template: {
            nodes: [{ id: "plan-review-step", kind: "prompt", config: { name: "Plan Review", prompt: "Review the plan.", toolMode: "readonly" } }],
            edges: [],
          },
        },
      },
      { id: "plan-replan", kind: "gate", config: { workflowAction: "plan-replan", forWorkflowStepId: "plan-review" } },
      { id: "end", kind: "end" },
    ],
    edges: [
      { from: "start", to: "plan-review" },
      { from: "plan-review", to: "end", condition: "success" },
      { from: "plan-review", to: "plan-replan", condition: "failure" },
      { from: "plan-replan", to: "end", condition: "success" },
    ],
  };
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("Plan Review dependency gate", () => {
  it("does not delay a dependency-free worktree", async () => {
    const gate = input();
    const result = await runPlanReviewDependencyGate(gate);

    expect(result).toBeNull();
    expect(gate.runConfiguredCommand).not.toHaveBeenCalled();
  });

  it("returns a genuine REVISE for unrecognized dependency evidence", async () => {
    const root = worktree({ "flake.nix": "{}" });
    const gate = input({ worktreePath: root });
    const result = await runPlanReviewDependencyGate(gate);

    expect(result).toMatchObject({ outcome: "failure", value: "REVISE" });
    expect(result?.contextPatch?.output).toMatch(/^Dependencies are not installed\./);
    expect(result?.contextPatch?.output).toContain("flake.nix");
    expect(result?.contextPatch?.output).toContain("fn_install_worktree_dependencies");
    expect(result?.contextPatch?.findings).toEqual([
      expect.objectContaining({ severity: "high", body: expect.stringContaining("flake.nix") }),
    ]);
    expect(gate.runConfiguredCommand).not.toHaveBeenCalled();
  });

  it("retries a known matrix row and dispatches when catch-up succeeds", async () => {
    const root = worktree({ "package.json": "{}" });
    const command = runner();
    const gate = input({ worktreePath: root, runConfiguredCommand: command });
    const result = await runPlanReviewDependencyGate(gate);

    expect(result).toBeNull();
    expect(command).toHaveBeenCalledTimes(1);
  });

  it("returns REVISE when a matrix command remains unresolved", async () => {
    const root = worktree({ "package.json": "{}" });
    const command = runner({ stdout: "", stderr: "unavailable", exitCode: 1, signal: null, timedOut: false, bufferExceeded: false });
    const gate = input({ worktreePath: root, runConfiguredCommand: command });
    const result = await runPlanReviewDependencyGate(gate);

    expect(result).toMatchObject({ outcome: "failure", value: "REVISE" });
    expect(result?.contextPatch?.output).toContain("npm install");
    expect(result?.contextPatch?.findings).toHaveLength(1);
  });

  it("reports only the blocking repository in a multi-repository workspace", async () => {
    const clean = worktree({ "index.html": "ok" });
    const blocked = worktree({ "something.lock": "opaque" });
    const gate = input({
      workspaceConfig: { repos: ["clean", "blocked"] },
      task: task({ workspaceWorktrees: { clean: { worktreePath: clean }, blocked: { worktreePath: blocked } } }),
      worktreePath: clean,
    });
    const result = await runPlanReviewDependencyGate(gate);

    expect(result?.contextPatch?.output).toContain("blocked");
    expect(result?.contextPatch?.output).not.toContain("clean:");
    expect(result?.contextPatch?.findings).toHaveLength(1);
  });

  it("logs not-determined and falls through when no worktree can be probed", async () => {
    const gate = input({ worktreePath: join(tmpdir(), "missing-fn-258-worktree") });
    const result = await runPlanReviewDependencyGate(gate);

    expect(result).toBeNull();
    expect(gate.store.logEntry).toHaveBeenCalledWith(
      "FN-258",
      expect.stringContaining("not determined"),
      expect.any(String),
      undefined,
    );
  });

  it("blocks the production Plan Review node, persists REVISE, and enters the replan route", async () => {
    const root = worktree({ "flake.nix": "{}" });
    const row = task({
      worktree: root,
      enabledWorkflowSteps: ["plan-review"],
      workflowStepResults: [],
    });
    const harness = graphNodeDeps(row, root);
    const persisted: WorkflowStepResult[] = [];
    const requestPreMergeOptionalStepFix = vi.fn(async () => true);
    const graph = new WorkflowGraphExecutor({
      handlers: {
        prompt: (node, context) => runGraphCustomNode(
          harness as never,
          node,
          context.task,
          context.settings as Settings,
          undefined,
          context.context,
        ),
      },
      recordWorkflowStepResult: async (_taskId, result) => {
        persisted.push(result);
      },
      requestPreMergeOptionalStepFix,
    });

    const result = await graph.run(row, { experimentalFeatures: { workflowGraphExecutor: true } }, planReviewGraph());

    expect(harness.executeWorkflowStep).not.toHaveBeenCalled();
    const terminal = persisted.at(-1);
    expect(terminal).toMatchObject({
      workflowStepId: "plan-review",
      status: "failed",
      verdict: "REVISE",
      output: expect.stringMatching(/^Dependencies are not installed\./),
      findings: [expect.objectContaining({ severity: "high", body: expect.stringContaining("flake.nix") })],
    });
    expect(requestPreMergeOptionalStepFix).toHaveBeenCalledWith("FN-258", expect.objectContaining({
      stepName: "Plan Review",
      phase: "pre-merge",
      status: "failed",
      verdict: "REVISE",
      nodeId: "plan-review",
      feedback: expect.stringMatching(/^Dependencies are not installed\./),
    }));
    expect(result.visitedNodeIds).toContain("plan-replan");
  });

  it("routes a graph-produced dependency REVISE through cap exhaustion to awaiting approval", async () => {
    const root = worktree({ "flake.nix": "{}" });
    const row = task({
      worktree: root,
      enabledWorkflowSteps: ["plan-review"],
      workflowStepResults: [],
      /*
      FNXC:WorktreeDependencies 2026-08-29-11:18:
      The graph-persisted dependency REVISE must reach the real Plan Review cap terminal rung.
      Two prior bounded cap encounters make this the third and final human-escalation encounter.
      */
      reviewConvergenceStage: 2,
      reviewConvergenceEscalationCount: 2,
    });
    const harness = graphNodeDeps(row, root);
    const store = harness.store as unknown as {
      getTask: ReturnType<typeof vi.fn>;
      getSettings?: ReturnType<typeof vi.fn>;
      updateTask?: ReturnType<typeof vi.fn>;
      updateTaskAtomic?: ReturnType<typeof vi.fn>;
      logEntry: ReturnType<typeof vi.fn>;
    };
    store.getSettings = vi.fn(async () => ({ autoMerge: true, planReviewReplanCap: 0 }));
    store.updateTask = vi.fn(async (_taskId: string, patch: Partial<Task>) => {
      Object.assign(row, patch);
      return row;
    });
    store.updateTaskAtomic = vi.fn(async (
      _taskId: string,
      mutate: (current: TaskDetail) => Partial<Task> | null | undefined | Promise<Partial<Task> | null | undefined>,
    ) => {
      const patch = await mutate(row);
      if (patch) Object.assign(row, patch);
      return row;
    });
    const remediationDeps = {
      store: store as unknown as TaskStore,
      getRunContextFor: () => undefined,
      recoverMissingRequiredArtifacts: vi.fn(async () => undefined),
      parkPlanReviewReplanCapExhausted: vi.fn(async () => undefined),
      clearPausedAborted: vi.fn(),
      readTaskArtifact: vi.fn(async () => undefined),
      appendReviewRemediationSteps: vi.fn(async () => "not-applicable"),
      workflowLifecycleMovesInFlight: new Set<string>(),
      sendTaskBackForFix: vi.fn(async () => undefined),
    };
    const persisted: WorkflowStepResult[] = [];
    const graph = new WorkflowGraphExecutor({
      handlers: {
        prompt: (node, context) => runGraphCustomNode(
          harness as never,
          node,
          context.task,
          context.settings as Settings,
          undefined,
          context.context,
        ),
      },
      recordWorkflowStepResult: async (_taskId, result) => {
        persisted.push(result);
        row.workflowStepResults = [result];
      },
      requestPreMergeOptionalStepFix: (taskId, info) => requestPreMergeOptionalStepFix(
        remediationDeps as never,
        taskId,
        row,
        info,
      ),
    });

    const result = await graph.run(row, { experimentalFeatures: { workflowGraphExecutor: true } }, planReviewGraph());

    expect(harness.executeWorkflowStep).not.toHaveBeenCalled();
    expect(persisted.at(-1)).toMatchObject({
      workflowStepId: "plan-review",
      status: "failed",
      verdict: "REVISE",
      output: expect.stringMatching(/^Dependencies are not installed\./),
    });
    expect(row).toMatchObject({
      status: "awaiting-approval",
      awaitingApprovalReason: "plan-review-replan-cap",
    });
    expect(store.updateTask).toHaveBeenCalledWith(
      "FN-258",
      expect.objectContaining({
        status: "awaiting-approval",
        awaitingApprovalReason: "plan-review-replan-cap",
      }),
      undefined,
    );
    expect(result.visitedNodeIds).toContain("plan-replan");
  });
});
