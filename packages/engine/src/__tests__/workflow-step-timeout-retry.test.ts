import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveWorkspaceTaskWorktreeDir,
  type Settings,
  type TaskDetail,
  type TaskStore,
  type WorkflowIr,
  type WorkflowStepResult,
} from "@fusion/core";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

vi.mock("../agents/agent-session-helpers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agents/agent-session-helpers.js")>();
  return { ...actual, createResolvedAgentSession: vi.fn() };
});

vi.mock("../executor/browser-probe.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../executor/browser-probe.js")>();
  return {
    ...actual,
    probeAgentBrowserAvailability: vi.fn(async () => ({
      available: true,
      version: "agent-browser test fixture",
    })),
  };
});

vi.mock("../environment/environment-capabilities.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../environment/environment-capabilities.js")>();
  return {
    ...actual,
    probeEnvironmentCapabilities: vi.fn(async () => ({ capabilities: [], degraded: false })),
  };
});

vi.mock("../executor/worktree-git-refs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../executor/worktree-git-refs.js")>();
  return { ...actual, resolveDiffBaseRef: vi.fn(async () => undefined) };
});

vi.mock("../worktree/review-diff-fingerprint.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../worktree/review-diff-fingerprint.js")>();
  return {
    ...actual,
    resolveContentReviewInputProof: vi.fn(async () => ({
      kind: "fingerprint" as const,
      fingerprint: "sha256:fn-380-reviewed-input",
    })),
  };
});

vi.mock("../worktree/review-inline-fix-recapture.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../worktree/review-inline-fix-recapture.js")>();
  return {
    ...actual,
    readHeadSha: vi.fn(async () => undefined),
    isFastForwardAdvance: vi.fn(async () => false),
  };
});

vi.mock("../worktree/workspace-review-evidence.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../worktree/workspace-review-evidence.js")>();
  return {
    ...actual,
    captureWorkspaceReviewEvidence: vi.fn(async ({ task }: { task: TaskDetail }) => ({
      repositories: Object.entries(task.workspaceWorktrees ?? {}).map(([repository, entry]) => ({
        repository,
        baseCommitSha: entry.baseCommitSha ?? "base-sha",
        branch: entry.branch ?? `fusion/${task.id.toLowerCase()}`,
        files: ["src/reviewed.ts"],
        qualifiedFiles: [`${repository}/src/reviewed.ts`],
        fingerprint: `sha256:${repository}-review-fingerprint`,
        ahead: true,
        netZero: false,
      })),
      modifiedFiles: Object.keys(task.workspaceWorktrees ?? {}).map((repository) => `${repository}/src/reviewed.ts`),
      modifiedRepositories: new Set(Object.keys(task.workspaceWorktrees ?? {})),
      outOfScopeRepositories: new Set<string>(),
    })),
  };
});

import { createResolvedAgentSession } from "../agents/agent-session-helpers.js";
import { probeAgentBrowserAvailability } from "../executor/browser-probe.js";
import { executeWorkflowStep } from "../executor/execute-workflow-step.js";
import { recoverFailedPreMergeWorkflowStepDetailed } from "../executor/recover-failed-pre-merge-step.js";
import { runGraphCustomNode } from "../executor/run-graph-custom-node.js";
import { WorkflowCustomNodeExecutionService } from "../workflows/workflow-custom-node-execution.js";
import { WorkflowGraphExecutor } from "../workflows/workflow-graph-executor.js";
import { WorkflowGraphTaskRunner } from "../workflows/workflow-graph-task-runner.js";

const mockedCreateResolvedAgentSession = vi.mocked(createResolvedAgentSession);
const mockedProbeAgentBrowserAvailability = vi.mocked(probeAgentBrowserAvailability);
const roots: string[] = [];

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  let reject!: Deferred<T>["reject"];
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

type SessionPlan =
  | { kind: "pending" }
  | { kind: "output"; output: string };

interface ControlledSession {
  session: AgentSession;
  emit: (text: string) => void;
  prompt: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
}

function installSessionPlans(plans: SessionPlan[], lifecycle: string[]) {
  const creations: Array<Record<string, any>> = [];
  const sessions: ControlledSession[] = [];
  const promptDeferreds = plans.map(() => deferred<void>());
  const promptStartedDeferreds = plans.map(() => deferred<void>());
  const sessionIndexes = new WeakMap<object, number>();

  mockedCreateResolvedAgentSession.mockImplementation(async (options: any) => {
    const index = creations.length;
    const plan = plans[index];
    if (!plan) throw new Error(`Unexpected workflow-step session ${index + 1}`);
    creations.push(options);
    lifecycle.push(`create:${index}`);

    const listeners: Array<(event: any) => void> = [];
    const emit = (text: string) => {
      for (const listener of listeners) {
        listener({
          type: "message_update",
          assistantMessageEvent: {
            type: "text_delta",
            contentIndex: 0,
            delta: text,
            partial: text,
          },
        });
      }
    };
    const prompt = vi.fn(async () => {
      lifecycle.push(`prompt:${index}`);
      promptStartedDeferreds[index]!.resolve();
      if (plan.kind === "pending") return promptDeferreds[index]!.promise;
      emit(plan.output);
    });
    const dispose = vi.fn(() => {
      lifecycle.push(`dispose:${index}`);
    });
    const session = {
      state: {},
      model: {
        provider: options.defaultProvider ?? "runtime-provider",
        id: options.defaultModelId ?? "runtime-model",
      },
      subscribe: vi.fn((listener: (event: any) => void) => {
        listeners.push(listener);
        return vi.fn();
      }),
      prompt,
      dispose,
    } as unknown as AgentSession;
    sessionIndexes.set(session as object, index);
    sessions.push({ session, emit, prompt, dispose });
    return {
      session,
      runtimeId: "pi",
      wasConfigured: true,
    } as Awaited<ReturnType<typeof createResolvedAgentSession>>;
  });

  return {
    creations,
    sessions,
    sessionIndexes,
    promptStarted: promptStartedDeferreds.map((entry) => entry.promise),
    resolvePrompt: (index: number) => promptDeferreds[index]!.resolve(),
    rejectPrompt: (index: number, error: unknown) => promptDeferreds[index]!.reject(error),
  };
}

function makeTask(id: string, worktree: string, groupId: string, overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id,
    title: "Workflow timeout retry fixture",
    description: "Verify one bounded review retry.",
    column: groupId === "plan-review" ? "todo" : "in-review",
    priority: "normal",
    worktree,
    branch: `fusion/${id.toLowerCase()}`,
    baseCommitSha: "base-sha",
    dependencies: [],
    steps: [{ name: "Implementation", status: "done" }],
    currentStep: 1,
    enabledWorkflowSteps: [groupId],
    workflowStepResults: [],
    createdAt: "2026-09-13T00:00:00.000Z",
    updatedAt: "2026-09-13T00:00:00.000Z",
    ...overrides,
  } as TaskDetail;
}

function optionalGroupGraph(input: {
  groupId: string;
  groupName: string;
  innerName: string;
  reviewKind?: "plan" | "code";
  requiresBrowser?: boolean;
}): WorkflowIr {
  return {
    version: "v2",
    name: `${input.groupId}-timeout-retry`,
    columns: [{ id: "in-review", name: "In Review", traits: [] }],
    nodes: [
      { id: "start", kind: "start" },
      {
        id: input.groupId,
        kind: "optional-group",
        config: {
          name: input.groupName,
          defaultOn: true,
          phase: "pre-merge",
          ...(input.reviewKind ? { reviewKind: input.reviewKind } : {}),
          template: {
            nodes: [{
              id: `${input.groupId}-step`,
              kind: "prompt",
              config: {
                name: input.innerName,
                prompt: `Run ${input.innerName}.`,
                gateMode: "gate",
                toolMode: "readonly",
                ...(input.requiresBrowser ? { requiresBrowser: true } : {}),
              },
            }],
            edges: [],
          },
        },
      },
      { id: "success-sentinel", kind: "script", config: { scriptName: "success-sentinel" } },
      { id: "success-end", kind: "end" },
    ],
    edges: [
      { from: "start", to: input.groupId },
      { from: input.groupId, to: "success-sentinel", condition: "success" },
      { from: "success-sentinel", to: "success-end", condition: "success" },
    ],
  } as WorkflowIr;
}

function splitCodeReviewGraph(): WorkflowIr {
  return {
    version: "v2",
    name: "split-code-review-timeout-cancellation",
    columns: [{ id: "in-review", name: "In Review", traits: [] }],
    nodes: [
      { id: "start", kind: "start" },
      { id: "split", kind: "split", column: "in-review" },
      {
        id: "split-code-review",
        kind: "prompt",
        column: "in-review",
        config: {
          name: "Code Review",
          prompt: "Review the delivered implementation.",
          gateMode: "gate",
          toolMode: "readonly",
          reviewKind: "code",
        },
      },
      { id: "sibling", kind: "gate", column: "in-review", config: {} },
      { id: "join", kind: "join", column: "in-review", config: { mode: "all", onBranchFailure: "fail-fast" } },
      { id: "end", kind: "end" },
    ],
    edges: [
      { from: "start", to: "split" },
      { from: "split", to: "split-code-review" },
      { from: "split", to: "sibling" },
      { from: "split-code-review", to: "join", condition: "success" },
      { from: "sibling", to: "join", condition: "success" },
      { from: "join", to: "end", condition: "success" },
      { from: "join", to: "end", condition: "failure" },
    ],
  } as WorkflowIr;
}

function makeStore(
  task: TaskDetail,
  settings: Settings,
  hooks: { onLogEntry?: (action: string, detail?: string) => void | Promise<void> } = {},
) {
  const recordHistory: WorkflowStepResult[] = [];
  const logRows: Array<{ action: string; detail?: string }> = [];
  const store = {
    getTask: vi.fn(async () => task),
    getSettings: vi.fn(async () => settings),
    updateTask: vi.fn(async (_taskId: string, patch: Partial<TaskDetail>) => {
      Object.assign(task, patch);
      return task;
    }),
    logEntry: vi.fn(async (_taskId: string, action: string, detail?: string) => {
      logRows.push({ action, detail });
      await hooks.onLogEntry?.(action, detail);
    }),
    appendAgentLog: vi.fn(async () => undefined),
    appendAgentLogBatch: vi.fn(async () => undefined),
    publishWorkspaceCodeReviewEvidence: vi.fn(async (_taskId: string, input: any) => {
      if (task.repositoryScope?.state === "confirmed") {
        task.repositoryScope = {
          ...task.repositoryScope,
          reviewEvidence: input.reviewEvidence,
        };
      }
      if (input.modifiedFiles) task.modifiedFiles = input.modifiedFiles;
      return { published: true };
    }),
    getTaskWorkflowSelection: vi.fn(() => ({ taskId: task.id, workflowId: "WF-FN380" })),
    getTaskWorkflowSelectionAsync: vi.fn(async () => ({ taskId: task.id, workflowId: "WF-FN380" })),
    getWorkflowDefinition: vi.fn(async () => ({
      id: "WF-FN380",
      name: "FN-380 recovery fixture",
      ir: {
        version: "v2",
        name: "FN-380 recovery fixture",
        columns: [{ id: "in-review", name: "In Review", traits: [] }],
        nodes: [
          { id: "start", kind: "start" },
          {
            id: "parse",
            kind: "parse-steps",
            config: {
              artifact: "PROMPT.md",
              parser: "step-headings",
              implementationOnlySteps: true,
              preserveRemediationSteps: true,
            },
          },
          { id: "end", kind: "end" },
        ],
        edges: [{ from: "start", to: "parse" }, { from: "parse", to: "end" }],
      },
    })),
  } as unknown as TaskStore;

  const recordWorkflowStepResult = vi.fn(async (_taskId: string, result: WorkflowStepResult) => {
    const snapshot = { ...result } as WorkflowStepResult;
    recordHistory.push(snapshot);
    const current = task.workflowStepResults ?? [];
    task.workflowStepResults = [
      ...current.filter((entry) => entry.workflowStepId !== result.workflowStepId),
      snapshot,
    ];
    return {
      scopeCurrent: true,
      persisted: true,
      disposition: "applied" as const,
      persistedResult: snapshot,
    };
  });

  return { store, recordHistory, recordWorkflowStepResult, logRows };
}

interface GraphScenario {
  groupId: string;
  groupName: string;
  innerName: string;
  reviewKind?: "plan" | "code";
  requiresBrowser?: boolean;
  workspace?: boolean;
}

interface GraphScenarioOptions {
  graphAbortController?: AbortController;
  holdSecondaryAttemptLog?: boolean;
  graphIr?: WorkflowIr;
  runThroughTaskRunner?: boolean;
}

async function startGraphScenario(
  scenario: GraphScenario,
  plans: SessionPlan[],
  settingsOverrides: Partial<Settings> = {},
  options: GraphScenarioOptions = {},
) {
  const root = mkdtempSync(join(tmpdir(), "fn-380-timeout-retry-"));
  roots.push(root);
  const taskId = `FN-380-${scenario.groupId.toUpperCase().replace(/[^A-Z0-9]/g, "-")}`;
  const singularWorktree = join(root, "singular-worktree");
  mkdirSync(singularWorktree, { recursive: true });

  const settings = {
    experimentalFeatures: { workflowGraphExecutor: true },
    workflowStepTimeoutMs: 60_000,
    validatorProvider: "validator-provider",
    validatorModelId: "validator-model",
    executionProvider: "executor-provider",
    executionModelId: "executor-model",
    ...settingsOverrides,
  } as Settings;

  let task: TaskDetail;
  let workspaceConfig: { repos: string[] } | null = null;
  let expectedCwd = singularWorktree;
  if (scenario.workspace) {
    const workspaceTaskDir = resolveWorkspaceTaskWorktreeDir(root, settings, taskId);
    const repositoryWorktree = join(workspaceTaskDir, "repo-a");
    mkdirSync(repositoryWorktree, { recursive: true });
    workspaceConfig = { repos: ["repo-a"] };
    task = makeTask(taskId, workspaceTaskDir, scenario.groupId, {
      workspaceWorktrees: {
        "repo-a": {
          worktreePath: repositoryWorktree,
          branch: `fusion/${taskId.toLowerCase()}`,
          baseCommitSha: "base-sha",
        },
      },
      repositoryScope: {
        state: "confirmed",
        revision: 1,
        repositories: ["repo-a"],
      },
      modifiedFiles: ["repo-a/src/reviewed.ts"],
    });
    expectedCwd = scenario.reviewKind === "code" ? repositoryWorktree : workspaceTaskDir;
  } else {
    task = makeTask(taskId, singularWorktree, scenario.groupId);
  }

  const lifecycle: string[] = [];
  const control = installSessionPlans(plans, lifecycle);
  const activeWorkflowStepSessions = new Map<string, AgentSession>();
  const agentText: string[] = [];
  const graphAbortController = options.graphAbortController ?? new AbortController();
  const secondaryAttemptLogStarted = deferred<void>();
  const secondaryAttemptLogRelease = deferred<void>();
  const storeHarness = makeStore(task, settings, {
    onLogEntry: options.holdSecondaryAttemptLog
      ? async (action) => {
          if (
            action.includes("starting one fresh same-model retry")
            || (action.includes("starting one configured ") && action.includes(" fallback attempt"))
          ) {
            secondaryAttemptLogStarted.resolve();
            await secondaryAttemptLogRelease.promise;
          }
        }
      : undefined,
  });
  const agentStore = { getAgent: vi.fn(async () => null) };
  const executeDeps = {
    store: storeHarness.store,
    rootDir: root,
    options: {
      agentStore,
      onAgentText: (_taskId: string, delta: string) => agentText.push(delta),
    },
    activePlanningWorkflowSessions: new Set<string>(),
    activeWorkflowStepSessions,
    getRunContextFor: () => undefined,
    captureModifiedFiles: vi.fn(async () => ["src/reviewed.ts"]),
    createSpawnAgentTool: vi.fn(),
    sharedWorkerTools: {} as never,
    deleteActiveWorkflowStepSession: vi.fn((id: string) => {
      const active = activeWorkflowStepSessions.get(id);
      const index = active ? control.sessionIndexes.get(active as object) : undefined;
      lifecycle.push(`unregister:${index ?? "missing"}`);
      activeWorkflowStepSessions.delete(id);
    }),
    getAssignedAgentRuntimeConfig: vi.fn(async () => undefined),
    getAuthoritativeAssignedAgent: vi.fn(async () => undefined),
    readTaskArtifact: vi.fn(async () => "# Approved Task\n\nReview the delivered implementation."),
    resolveInstructionsForRole: vi.fn(async () => ""),
    resolveMcpServers: vi.fn(async () => []),
    setActiveWorkflowStepSession: vi.fn((id: string, session: AgentSession) => {
      const index = control.sessionIndexes.get(session as object);
      lifecycle.push(`register:${index ?? "missing"}`);
      activeWorkflowStepSessions.set(id, session);
    }),
  };
  const graphNodeDeps = {
    store: storeHarness.store,
    rootDir: root,
    workspaceConfig,
    options: { agentStore },
    graphUnattendedRuns: new Set<string>(),
    getRunContextFor: () => undefined,
    adoptColumnAgentForNode: vi.fn(async () => undefined),
    buildInjectedRuntimeEnv: vi.fn(async () => ({ env: {}, pathEntryCount: 0, injectedKeyCount: 0 })),
    ensureGraphCustomNodeWorktree: vi.fn(async () => task),
    executeScriptWorkflowStep: vi.fn(async () => ({ success: true, output: "script passed" })),
    executeWorkflowStep: (
      target: TaskDetail,
      step: Parameters<typeof executeWorkflowStep>[2],
      cwd: string,
      effectiveSettings: Settings,
      taskEnv?: NodeJS.ProcessEnv,
      stepOptions?: Parameters<typeof executeWorkflowStep>[6],
    ) => executeWorkflowStep(executeDeps as never, target, step, cwd, effectiveSettings, taskEnv, stepOptions),
    pauseForCliApproval: vi.fn(),
    resolveWorkflowInputMarkerForGraphNode: vi.fn(async () => undefined),
    runAwaitInputNode: vi.fn(),
    runCliAgentNode: vi.fn(),
    runRawCliCommand: vi.fn(),
    runConfiguredCommand: vi.fn(async () => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
      signal: null,
      timedOut: false,
      bufferExceeded: false,
    })),
  };
  const requestPreMergeOptionalStepFix = vi.fn(async () => false);
  const customNodeExecution = new WorkflowCustomNodeExecutionService({
    execute: (node, target, effectiveSettings, columnBinding, context, signal) => runGraphCustomNode(
      graphNodeDeps as never,
      node,
      target,
      effectiveSettings,
      columnBinding,
      context,
      undefined,
      signal,
    ),
  });
  const graphIr = options.graphIr ?? optionalGroupGraph(scenario);
  const runCustomNode = customNodeExecution.runner(settings);
  const graphPromise = options.runThroughTaskRunner
    ? new WorkflowGraphTaskRunner({
        store: {
          getTaskWorkflowSelection: () => ({ workflowId: "WF-FN380", stepIds: [] }),
          getTaskWorkflowSelectionAsync: async () => ({ workflowId: "WF-FN380", stepIds: [] }),
          getWorkflowDefinition: async () => ({
            id: "WF-FN380",
            name: "FN-380 graph fixture",
            description: "",
            kind: "workflow",
            ir: graphIr,
            layout: {},
            createdAt: "2026-09-13T00:00:00.000Z",
            updatedAt: "2026-09-13T00:00:00.000Z",
          }),
          getTask: async () => task,
        },
        seams: {
          planning: async () => ({ outcome: "success" }),
          execute: async () => ({ outcome: "success" }),
          review: async () => ({ outcome: "success" }),
          merge: async () => ({ outcome: "success" }),
          schedule: async () => ({ outcome: "success" }),
        },
        runCustomNode,
        signal: graphAbortController.signal,
        recordWorkflowStepResult: storeHarness.recordWorkflowStepResult,
        requestPreMergeOptionalStepFix,
      }).run(task, settings)
    : new WorkflowGraphExecutor({
        runCustomNode,
        handlers: {
          script: async (node) => node.id === "success-sentinel"
            ? { outcome: "success", value: "success-sentinel-reached" }
            : { outcome: "failure", value: "unexpected-script" },
        },
        signal: graphAbortController.signal,
        recordWorkflowStepResult: storeHarness.recordWorkflowStepResult,
        requestPreMergeOptionalStepFix,
      }).run(task, settings, graphIr);
  await control.promptStarted[0];

  return {
    root,
    task,
    settings,
    expectedCwd,
    workspaceConfig,
    lifecycle,
    control,
    activeWorkflowStepSessions,
    agentText,
    storeHarness,
    requestPreMergeOptionalStepFix,
    graphAbortController,
    secondaryAttemptLogStarted: secondaryAttemptLogStarted.promise,
    releaseSecondaryAttemptLog: () => secondaryAttemptLogRelease.resolve(),
    graphPromise,
  };
}

async function elapsePrimaryTimeout(run: Awaited<ReturnType<typeof startGraphScenario>>) {
  await vi.advanceTimersByTimeAsync(60_000);
  await Promise.race([
    run.control.promptStarted[1],
    run.graphPromise.then(() => {
      throw new Error("The workflow graph terminated before creating the required timeout retry session.");
    }),
  ]);
}

function assertRetiredBeforeSecondary(run: Awaited<ReturnType<typeof startGraphScenario>>) {
  expect(run.lifecycle.indexOf("dispose:0")).toBeLessThan(run.lifecycle.indexOf("unregister:0"));
  expect(run.lifecycle.indexOf("unregister:0")).toBeLessThan(run.lifecycle.indexOf("create:1"));
}

beforeEach(() => {
  vi.useFakeTimers();
  mockedCreateResolvedAgentSession.mockReset();
  mockedProbeAgentBrowserAvailability.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("workflow-step timeout retry production graph", () => {
  it("retries the reported Code Review timeout before persisting one approved aggregate result", async () => {
    const run = await startGraphScenario(
      {
        groupId: "code-review",
        groupName: "Code Review",
        innerName: "Code Review",
        reviewKind: "code",
      },
      [
        { kind: "pending" },
        { kind: "output", output: '{"verdict":"APPROVE","notes":"The retry reviewed and approved the delivered diff."}' },
      ],
    );

    await elapsePrimaryTimeout(run);
    const result = await run.graphPromise;

    expect(result.outcome).toBe("success");
    expect(result.visitedNodeIds).toContain("success-sentinel");
    expect(run.storeHarness.recordHistory.map((entry) => entry.status)).toEqual(["pending", "passed"]);
    expect(run.storeHarness.recordHistory.at(-1)).toMatchObject({
      workflowStepId: "code-review",
      workflowStepName: "Code Review",
      phase: "pre-merge",
      status: "passed",
      verdict: "APPROVE",
      verdictRequired: true,
    });
    expect(run.storeHarness.recordHistory).not.toContainEqual(expect.objectContaining({ status: "failed" }));
    expect(run.control.creations).toHaveLength(2);
    assertRetiredBeforeSecondary(run);
    expect(run.activeWorkflowStepSessions.size).toBe(0);
    expect(run.requestPreMergeOptionalStepFix).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each<GraphScenario>([
    { groupId: "plan-review", groupName: "Plan Review", innerName: "Plan Review", reviewKind: "plan" },
    { groupId: "code-review", groupName: "Code Review", innerName: "Code Review", reviewKind: "code" },
    { groupId: "browser-verification", groupName: "Browser Verification", innerName: "Browser Verification", requiresBrowser: true },
    { groupId: "custom-verdict", groupName: "Custom Verdict", innerName: "Required Decision" },
    { groupId: "plan-review", groupName: "Plan Review", innerName: "Plan Review", reviewKind: "plan", workspace: true },
    { groupId: "code-review", groupName: "Code Review", innerName: "Code Review", reviewKind: "code", workspace: true },
  ])("applies the same bounded retry to $groupName (workspace=$workspace)", async (scenario) => {
    const run = await startGraphScenario(
      scenario,
      [
        { kind: "pending" },
        { kind: "output", output: '{"verdict":"APPROVE","notes":"The fresh retry approved this surface."}' },
      ],
    );

    await elapsePrimaryTimeout(run);
    const result = await run.graphPromise;

    expect(result.outcome).toBe("success");
    expect(result.visitedNodeIds).toContain("success-sentinel");
    expect(run.control.creations).toHaveLength(2);
    expect(run.control.creations.map((options) => options.cwd)).toEqual([run.expectedCwd, run.expectedCwd]);
    expect(run.control.creations.map((options) => [options.defaultProvider, options.defaultModelId])).toEqual([
      scenario.groupId === "custom-verdict"
        ? ["executor-provider", "executor-model"]
        : ["validator-provider", "validator-model"],
      scenario.groupId === "custom-verdict"
        ? ["executor-provider", "executor-model"]
        : ["validator-provider", "validator-model"],
    ]);
    expect(run.storeHarness.recordHistory.at(-1)).toMatchObject({
      workflowStepId: scenario.groupId,
      status: "passed",
      verdict: "APPROVE",
    });
    assertRetiredBeforeSecondary(run);
    expect(run.control.sessions.every(({ dispose }) => dispose.mock.calls.length === 1)).toBe(true);
    expect(run.activeWorkflowStepSessions.size).toBe(0);
    if (scenario.requiresBrowser) {
      expect(mockedProbeAgentBrowserAvailability).toHaveBeenCalledTimes(2);
    }
    if (scenario.workspace && scenario.reviewKind === "code") {
      expect(run.storeHarness.logRows.some(({ action }) => action.includes("[repo-a] using model:"))).toBe(true);
      expect(run.control.creations.every((options) => options.sessionBoundary?.kind === "workspace-task-dir")).toBe(true);
    }
    if (scenario.workspace && scenario.reviewKind === "plan") {
      expect(run.control.creations.every((options) => options.sessionBoundary?.kind === "workspace-task-dir")).toBe(true);
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    {
      label: "same-model retry",
      workspace: false,
      settings: {} as Partial<Settings>,
    },
    {
      label: "configured fallback",
      workspace: true,
      settings: {
        validatorFallbackProvider: "fallback-provider",
        validatorFallbackModelId: "fallback-model",
      } as Partial<Settings>,
    },
  ])("fences the $label when graph cancellation lands between attempts", async ({ workspace, settings }) => {
    const graphAbortController = new AbortController();
    const run = await startGraphScenario(
      {
        groupId: "code-review",
        groupName: "Code Review",
        innerName: "Code Review",
        reviewKind: "code",
        workspace,
      },
      [
        { kind: "pending" },
        { kind: "output", output: '{"verdict":"APPROVE","notes":"This session must never be created."}' },
      ],
      settings,
      { graphAbortController, holdSecondaryAttemptLog: true },
    );

    const timerAdvance = vi.advanceTimersByTimeAsync(60_000);
    await run.secondaryAttemptLogStarted;
    expect(run.control.creations).toHaveLength(1);
    expect(run.lifecycle).toEqual(expect.arrayContaining(["dispose:0", "unregister:0"]));
    expect(run.lifecycle.indexOf("dispose:0")).toBeLessThan(run.lifecycle.indexOf("unregister:0"));

    graphAbortController.abort();
    run.releaseSecondaryAttemptLog();
    await timerAdvance;
    const result = await run.graphPromise;

    expect(result.outcome).toBe("failure");
    expect(result.visitedNodeIds).not.toContain("success-sentinel");
    expect(run.control.creations).toHaveLength(1);
    expect(run.control.sessions[0]?.dispose).toHaveBeenCalledTimes(1);
    expect(run.lifecycle).not.toContain("register:1");
    expect(run.activeWorkflowStepSessions.size).toBe(0);
    expect(run.storeHarness.recordHistory.map((entry) => entry.status)).toEqual(["pending"]);
    expect(run.storeHarness.recordHistory).not.toContainEqual(
      expect.objectContaining({ status: expect.stringMatching(/^(passed|failed)$/) }),
    );
    expect(run.requestPreMergeOptionalStepFix).not.toHaveBeenCalled();
    expect(run.storeHarness.store.publishWorkspaceCodeReviewEvidence).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a split-branch Code Review between attempts without creating a secondary session", async () => {
    const graphAbortController = new AbortController();
    const run = await startGraphScenario(
      {
        groupId: "split-code-review",
        groupName: "Code Review",
        innerName: "Code Review",
        reviewKind: "code",
      },
      [
        { kind: "pending" },
        { kind: "output", output: '{"verdict":"APPROVE","notes":"This split retry must never start."}' },
      ],
      {},
      {
        graphAbortController,
        holdSecondaryAttemptLog: true,
        graphIr: splitCodeReviewGraph(),
        runThroughTaskRunner: true,
      },
    );

    const timerAdvance = vi.advanceTimersByTimeAsync(60_000);
    await run.secondaryAttemptLogStarted;
    expect(run.control.creations).toHaveLength(1);
    expect(run.lifecycle).toEqual(expect.arrayContaining(["dispose:0", "unregister:0"]));

    graphAbortController.abort();
    run.releaseSecondaryAttemptLog();
    await timerAdvance;
    const result = await run.graphPromise;

    expect(result).toMatchObject({ disposition: "failed", outcome: "failure" });
    expect(run.control.creations).toHaveLength(1);
    expect(run.control.sessions[0]?.dispose).toHaveBeenCalledTimes(1);
    expect(run.lifecycle).not.toContain("create:1");
    expect(run.lifecycle).not.toContain("register:1");
    expect(run.activeWorkflowStepSessions.size).toBe(0);
    expect(run.storeHarness.recordHistory).toEqual([
      expect.objectContaining({ workflowStepId: "split-code-review", status: "pending" }),
    ]);
    expect(run.storeHarness.recordHistory).not.toContainEqual(
      expect.objectContaining({ status: expect.stringMatching(/^(passed|failed)$/) }),
    );
    expect(run.requestPreMergeOptionalStepFix).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps a second same-model timeout failed, recoverable, and bounded to two sessions", async () => {
    const run = await startGraphScenario(
      {
        groupId: "code-review",
        groupName: "Code Review",
        innerName: "Code Review",
        reviewKind: "code",
      },
      [{ kind: "pending" }, { kind: "pending" }],
    );

    await elapsePrimaryTimeout(run);
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await run.graphPromise;

    expect(result.outcome).toBe("failure");
    expect(result.visitedNodeIds).not.toContain("success-sentinel");
    expect(run.control.creations).toHaveLength(2);
    expect(run.control.sessions.every(({ dispose }) => dispose.mock.calls.length === 1)).toBe(true);
    expect(run.lifecycle).toEqual(expect.arrayContaining(["unregister:0", "unregister:1"]));
    expect(run.storeHarness.recordHistory.map((entry) => entry.status)).toEqual(["pending", "failed"]);
    expect(run.storeHarness.recordHistory.at(-1)).toMatchObject({
      workflowStepId: "code-review",
      status: "failed",
      verdictRequired: true,
    });
    expect(run.storeHarness.recordHistory.at(-1)?.verdict).toBeUndefined();
    expect(run.storeHarness.logRows.map(({ action }) => action).filter((action) => action.includes("model timed out after 60s"))).toEqual([
      "Workflow step 'Code Review' primary model timed out after 60s — aborting session",
      "Workflow step 'Code Review' same-model retry model timed out after 60s — aborting session",
    ]);
    expect(run.requestPreMergeOptionalStepFix).not.toHaveBeenCalled();
    expect(run.activeWorkflowStepSessions.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);

    const sendTaskBackForFix = vi.fn(async () => undefined);
    const recovery = await recoverFailedPreMergeWorkflowStepDetailed({
      store: run.storeHarness.store,
      resolveFailedPreMergeWorkflowStepBudget: vi.fn(async () => ({
        unbounded: false,
        max: 3,
        label: "3",
        key: "code-review",
        stepName: "Code Review",
        attempts: 0,
      })),
      sendTaskBackForFix,
    }, run.task);
    expect(recovery).toEqual({
      kind: "refused",
      reason: "unclassified-gate-no-reopen",
      gate: "Code Review",
    });
    expect(sendTaskBackForFix).not.toHaveBeenCalled();
  });

  it("keeps malformed output from the distinct fallback failed without a third session", async () => {
    const run = await startGraphScenario(
      {
        groupId: "code-review",
        groupName: "Code Review",
        innerName: "Code Review",
        reviewKind: "code",
      },
      [
        { kind: "pending" },
        { kind: "output", output: "The fallback returned prose without a structured verdict." },
      ],
      {
        validatorFallbackProvider: "fallback-provider",
        validatorFallbackModelId: "fallback-model",
      },
    );

    await elapsePrimaryTimeout(run);
    const result = await run.graphPromise;

    expect(result.outcome).toBe("failure");
    expect(run.control.creations.map((options) => [options.defaultProvider, options.defaultModelId])).toEqual([
      ["validator-provider", "validator-model"],
      ["fallback-provider", "fallback-model"],
    ]);
    expect(run.control.creations).toHaveLength(2);
    expect(run.control.sessions[1]?.prompt).toHaveBeenCalledTimes(2);
    expect(run.control.sessions.every(({ dispose }) => dispose.mock.calls.length === 1)).toBe(true);
    expect(run.storeHarness.recordHistory.map((entry) => entry.status)).toEqual(["pending", "failed"]);
    expect(run.storeHarness.recordHistory.at(-1)).toMatchObject({
      workflowStepId: "code-review",
      status: "failed",
      verdictRequired: true,
    });
    expect(run.storeHarness.recordHistory.at(-1)?.verdict).toBeUndefined();
    expect(run.storeHarness.recordHistory).not.toContainEqual(expect.objectContaining({ verdict: "APPROVE" }));
    expect(run.activeWorkflowStepSessions.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores late stream output and rejection from the expired primary attempt", async () => {
    const unhandledRejection = vi.fn();
    process.on("unhandledRejection", unhandledRejection);
    try {
      const run = await startGraphScenario(
        {
          groupId: "code-review",
          groupName: "Code Review",
          innerName: "Code Review",
          reviewKind: "code",
        },
        [
          { kind: "pending" },
          { kind: "output", output: '{"verdict":"APPROVE","notes":"The secondary attempt is authoritative."}' },
        ],
      );

      await elapsePrimaryTimeout(run);
      const result = await run.graphPromise;
      const persistedBeforeLateSettlement = JSON.stringify(run.storeHarness.recordHistory);

      run.control.sessions[0]!.emit('{"verdict":"REVISE","notes":"LATE PRIMARY OUTPUT"}');
      run.control.rejectPrompt(0, new Error("late primary rejection"));
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();

      expect(result.outcome).toBe("success");
      expect(run.control.creations).toHaveLength(2);
      expect(JSON.stringify(run.storeHarness.recordHistory)).toBe(persistedBeforeLateSettlement);
      expect(run.storeHarness.recordHistory.at(-1)).toMatchObject({ status: "passed", verdict: "APPROVE" });
      expect(run.agentText.join("\n")).toContain("The secondary attempt is authoritative.");
      expect(run.agentText.join("\n")).not.toContain("LATE PRIMARY OUTPUT");
      expect(unhandledRejection).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      process.off("unhandledRejection", unhandledRejection);
    }
  });
});
