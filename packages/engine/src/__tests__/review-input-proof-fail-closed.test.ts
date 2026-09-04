import { describe, expect, it, beforeEach, vi } from "vitest";
import type { Settings, TaskDetail, WorkflowIr, WorkflowStep, WorkflowStepResult } from "@fusion/core";
import { FAST_MODE_BYPASS_ACTOR, getTaskMergeBlocker } from "@fusion/core";

const mocks = vi.hoisted(() => {
  const resolveProof = vi.fn();
  const resolveDiffBaseRef = vi.fn(async () => "base");
  const exec = vi.fn((
    _command: string,
    _options: unknown,
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => callback(new Error("shortstat unavailable"), "", ""));
  (exec as unknown as Record<symbol, unknown>)[Symbol.for("nodejs.util.promisify.custom")] = (
    command: string,
    options: unknown,
  ) => new Promise((resolve, reject) => {
    exec(command, options, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve({ stdout, stderr });
    });
  });
  return { resolveProof, resolveDiffBaseRef, exec };
});

vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  exec: mocks.exec,
}));
vi.mock("../executor/worktree-git-refs.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../executor/worktree-git-refs.js")>(),
  resolveDiffBaseRef: mocks.resolveDiffBaseRef,
}));
vi.mock("../worktree/review-diff-fingerprint.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../worktree/review-diff-fingerprint.js")>(),
  resolveContentReviewInputProof: mocks.resolveProof,
}));

import { persistWorkflowStepResultWithOutcome } from "../executor/execute-workflow-graph.js";
import { executeWorkflowStep, type ExecuteWorkflowStepDeps } from "../executor/execute-workflow-step.js";
import { runGraphCustomNode } from "../executor/run-graph-custom-node.js";
import { EMPTY_REVIEW_DIFF_FINGERPRINT } from "../worktree/review-diff-fingerprint.js";
import { WorkflowGraphExecutor } from "../workflows/workflow-graph-executor.js";
import { WORKFLOW_OPTIONAL_GROUP_CONTEXT_KEY } from "../workflows/workflow-graph-executor.js";

const now = "2026-09-01T00:00:00.000Z";

function task(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: "FN-279",
    title: "Review input proof",
    description: "Bind approval to reviewed content.",
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
    worktree: process.cwd(),
    baseCommitSha: "base",
    ...overrides,
  } as TaskDetail;
}

function graphHarness(row: TaskDetail, options: { workspaceConfig?: unknown } = {}) {
  const store = {
    getTask: vi.fn(async () => row),
    logEntry: vi.fn(async () => undefined),
    updateTask: vi.fn(async (_id: string, patch: Partial<TaskDetail>) => Object.assign(row, patch)),
  };
  return {
    store,
    rootDir: process.cwd(),
    workspaceConfig: options.workspaceConfig ?? null,
    options: {},
    graphUnattendedRuns: new Set<string>(),
    getRunContextFor: () => undefined,
    adoptColumnAgentForNode: vi.fn(async () => undefined),
    buildInjectedRuntimeEnv: vi.fn(async () => ({ env: {}, pathEntryCount: 0, injectedKeyCount: 0 })),
    ensureGraphCustomNodeWorktree: vi.fn(async () => row),
    executeScriptWorkflowStep: vi.fn(async () => ({ success: true, output: "APPROVE" })),
    executeWorkflowStep: vi.fn(async () => ({ success: true, output: "APPROVE", verdict: "APPROVE" })),
    pauseForCliApproval: vi.fn(),
    resolveWorkflowInputMarkerForGraphNode: vi.fn(async () => undefined),
    runAwaitInputNode: vi.fn(),
    runCliAgentNode: vi.fn(),
    runRawCliCommand: vi.fn(),
    runConfiguredCommand: vi.fn(),
  };
}

function codeNode(kind: "prompt" | "script", overrides: Record<string, unknown> = {}) {
  return {
    id: "custom-review",
    kind,
    config: {
      name: "Code Review",
      reviewKind: "code",
      gateMode: "gate",
      ...(kind === "script" ? { scriptName: "review" } : { prompt: "Review" }),
      ...overrides,
    },
  } as const;
}

function executeDeps(row: TaskDetail): ExecuteWorkflowStepDeps {
  return {
    store: {
      getTask: vi.fn(async () => row),
      logEntry: vi.fn(async () => undefined),
    } as never,
    rootDir: process.cwd(),
    options: {},
    activePlanningWorkflowSessions: new Set(),
    activeWorkflowStepSessions: new Map(),
    getRunContextFor: () => undefined,
    captureModifiedFiles: vi.fn(async () => []),
    createSpawnAgentTool: vi.fn(),
    sharedWorkerTools: {} as never,
    deleteActiveWorkflowStepSession: vi.fn(),
    getAssignedAgentRuntimeConfig: vi.fn(),
    getAuthoritativeAssignedAgent: vi.fn(),
    readTaskArtifact: vi.fn(async () => "# Task\nReview the implementation."),
    resolveInstructionsForRole: vi.fn(),
    resolveMcpServers: vi.fn(),
    setActiveWorkflowStepSession: vi.fn(),
  };
}

function step(overrides: Partial<WorkflowStep> & { optionalGroupId?: string; reviewKind?: "plan" | "code" } = {}): WorkflowStep {
  return {
    id: "graph:custom-review",
    name: "Code Review",
    description: "Review",
    mode: "prompt",
    phase: "pre-merge",
    gateMode: "gate",
    prompt: "Review",
    toolMode: "readonly",
    enabled: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as WorkflowStep;
}

beforeEach(() => {
  mocks.resolveProof.mockReset();
  mocks.resolveProof.mockResolvedValue({ kind: "fingerprint", fingerprint: "proof-279" });
  mocks.resolveDiffBaseRef.mockClear();
  mocks.exec.mockClear();
});

describe("content-binding review dispatch proof", () => {
  it.each(["prompt", "script"] as const)("refuses an unprovable %s code review before either dispatcher runs", async (kind) => {
    mocks.resolveProof.mockResolvedValue({ kind: "unprovable", reason: "no-diff-base" });
    const row = task();
    const harness = graphHarness(row);

    const result = await runGraphCustomNode(harness as never, codeNode(kind) as never, row, {} as Settings);

    expect(result).toMatchObject({ outcome: "failure", value: "review-input-unprovable" });
    expect(harness.executeWorkflowStep).not.toHaveBeenCalled();
    expect(harness.executeScriptWorkflowStep).not.toHaveBeenCalled();
    expect(harness.store.logEntry).toHaveBeenCalledWith(
      row.id,
      expect.stringContaining("no-diff-base"),
      undefined,
      undefined,
    );
  });

  it("surfaces an oversized-diff refusal without dispatching", async () => {
    mocks.resolveProof.mockResolvedValue({ kind: "unprovable", reason: "git-diff-too-large" });
    const row = task();
    const harness = graphHarness(row);
    const result = await runGraphCustomNode(harness as never, codeNode("prompt") as never, row, {} as Settings);
    expect(result).toMatchObject({ outcome: "failure", value: "review-input-unprovable" });
    expect(harness.store.logEntry).toHaveBeenCalledWith(row.id, expect.stringContaining("git-diff-too-large"), undefined, undefined);
  });

  it("attaches node-captured proof to a script review outcome", async () => {
    const row = task();
    const harness = graphHarness(row);
    const result = await runGraphCustomNode(harness as never, codeNode("script") as never, row, {} as Settings);
    expect(harness.executeScriptWorkflowStep).toHaveBeenCalledTimes(1);
    expect(result.contextPatch).toMatchObject({ reviewInputFingerprint: "proof-279" });
  });

  it("recognizes the reserved optional-group identity without reviewKind", async () => {
    mocks.resolveProof.mockResolvedValue({ kind: "unprovable", reason: "no-diff-base" });
    const row = task();
    const harness = graphHarness(row);
    const result = await runGraphCustomNode(
      harness as never,
      codeNode("prompt", { reviewKind: undefined }) as never,
      row,
      {} as Settings,
      undefined,
      { [WORKFLOW_OPTIONAL_GROUP_CONTEXT_KEY]: "code-review" },
    );
    expect(result).toMatchObject({ outcome: "failure", value: "review-input-unprovable" });
    expect(harness.executeWorkflowStep).not.toHaveBeenCalled();
  });

  it("leaves plan and non-review nodes outside the source-proof contract", async () => {
    mocks.resolveProof.mockResolvedValue({ kind: "unprovable", reason: "no-diff-base" });
    const row = task();
    const harness = graphHarness(row);
    const plan = codeNode("prompt", { reviewKind: "plan", name: "Plan assessment" });
    const docs = { id: "documentation-delivery", kind: "prompt", config: { name: "Documentation", prompt: "Document" } };

    await expect(runGraphCustomNode(harness as never, plan as never, row, {} as Settings)).resolves.toMatchObject({ outcome: "success" });
    await expect(runGraphCustomNode(harness as never, docs as never, row, {} as Settings)).resolves.toMatchObject({ outcome: "success" });
    expect(harness.executeWorkflowStep).toHaveBeenCalledTimes(2);
    expect(mocks.resolveProof).not.toHaveBeenCalled();
  });

  it("keeps the direct producer fail-closed for an identity-only step", async () => {
    mocks.resolveProof.mockResolvedValue({ kind: "unprovable", reason: "no-diff-base" });
    const row = task();
    const result = await executeWorkflowStep(
      executeDeps(row),
      row,
      step({ id: "graph:code-review", reviewKind: undefined }),
      process.cwd(),
      {} as Settings,
    );
    expect(result).toMatchObject({ success: false, failureValue: "review-input-unprovable" });
    expect(result).not.toHaveProperty("verdict");
  });

  it("keeps a pre-resolved empty proof even when shortstat capture fails", async () => {
    const row = task({ noCommitsExpected: true });
    const result = await executeWorkflowStep(
      executeDeps(row),
      row,
      step({ reviewKind: "code" }),
      process.cwd(),
      {} as Settings,
      undefined,
      { reviewInputFingerprint: EMPTY_REVIEW_DIFF_FINGERPRINT },
    );
    expect(result).toMatchObject({
      success: true,
      verdict: "APPROVE",
      reviewInputFingerprint: EMPTY_REVIEW_DIFF_FINGERPRINT,
    });
    expect(mocks.resolveProof).not.toHaveBeenCalled();
  });
});

describe("identity-only graph result writers", () => {
  function recorder() {
    const results = new Map<string, WorkflowStepResult>();
    return {
      results,
      record: vi.fn(async (_taskId: string, result: WorkflowStepResult) => {
        results.set(result.workflowStepId, result);
      }),
    };
  }

  it("preserves proof through the optional-group writer without broadening review metadata", async () => {
    const group: WorkflowIr["nodes"][number] = {
      id: "code-review",
      kind: "optional-group",
      column: "review",
      config: {
        name: "Code Review",
        defaultOn: false,
        template: {
          nodes: [{ id: "code-review-step", kind: "prompt", config: { name: "Code Review", prompt: "Review", gateMode: "gate" } }],
          edges: [],
        },
      },
    };
    const ir: WorkflowIr = {
      version: "v2",
      name: "identity optional review",
      columns: [{ id: "review", name: "Review", traits: [] }],
      nodes: [
        { id: "start", kind: "start", column: "review" },
        group,
        { id: "end", kind: "end", column: "review" },
      ],
      edges: [
        { from: "start", to: "code-review" },
        { from: "code-review", to: "end", condition: "success" },
      ],
    };
    const sink = recorder();
    const executor = new WorkflowGraphExecutor({
      handlers: {
        prompt: async () => ({
          outcome: "success",
          value: "APPROVE",
          contextPatch: {
            reviewInputFingerprint: "proof-279",
            findings: [{ id: "not-lifted" }],
            reviewedCommitSha: "commit-not-lifted",
          },
        }),
      },
      recordWorkflowStepResult: sink.record,
    });

    await executor.run(task({ enabledWorkflowSteps: ["code-review"] }), {} as Settings, ir);
    expect(sink.results.get("code-review")).toMatchObject({
      workflowStepId: "code-review",
      status: "passed",
      reviewInputFingerprint: "proof-279",
    });
    expect(sink.results.get("code-review")).not.toHaveProperty("reviewKind");
    expect(sink.results.get("code-review")).not.toHaveProperty("findings");
    expect(sink.results.get("code-review")).not.toHaveProperty("reviewedCommitSha");
  });

  it("preserves proof through the top-level writer when progress is independently enabled", async () => {
    const ir: WorkflowIr = {
      version: "v2",
      name: "identity top-level review",
      columns: [{ id: "review", name: "Review", traits: [] }],
      nodes: [
        { id: "start", kind: "start", column: "review" },
        { id: "code-review", kind: "prompt", column: "review", config: { name: "Code Review", prompt: "Review", skillName: "review-skill" } },
        { id: "end", kind: "end", column: "review" },
      ],
      edges: [
        { from: "start", to: "code-review" },
        { from: "code-review", to: "end", condition: "success" },
      ],
    };
    const sink = recorder();
    const executor = new WorkflowGraphExecutor({
      handlers: {
        prompt: async () => ({
          outcome: "success",
          contextPatch: {
            reviewInputFingerprint: "proof-279",
            findings: [{ id: "not-lifted" }],
            reviewedCommitSha: "commit-not-lifted",
          },
        }),
      },
      recordWorkflowStepResult: sink.record,
    });

    await executor.run(task(), {} as Settings, ir);
    expect(sink.results.get("code-review")).toMatchObject({
      workflowStepId: "code-review",
      status: "passed",
      reviewInputFingerprint: "proof-279",
    });
    expect(sink.results.get("code-review")).not.toHaveProperty("reviewKind");
    expect(sink.results.get("code-review")).not.toHaveProperty("findings");
    expect(sink.results.get("code-review")).not.toHaveProperty("reviewedCommitSha");
  });

  it("connects the real identity-only graph node to a mergeable persisted proof", async () => {
    const row = task({ enabledWorkflowSteps: ["code-review"] });
    const harness = graphHarness(row);
    harness.executeWorkflowStep.mockImplementation(async (...args: unknown[]) => ({
      success: true,
      output: "APPROVE",
      verdict: "APPROVE",
      reviewInputFingerprint: (args[5] as { reviewInputFingerprint?: string } | undefined)?.reviewInputFingerprint,
    }));
    const group: WorkflowIr["nodes"][number] = {
      id: "code-review",
      kind: "optional-group",
      column: "review",
      config: {
        name: "Code Review",
        defaultOn: false,
        template: {
          nodes: [{ id: "code-review-step", kind: "prompt", config: { name: "Code Review", prompt: "Review", gateMode: "gate" } }],
          edges: [],
        },
      },
    };
    const ir: WorkflowIr = {
      version: "v2",
      name: "identity end-to-end review",
      columns: [{ id: "review", name: "Review", traits: [] }],
      nodes: [
        { id: "start", kind: "start", column: "review" },
        group,
        { id: "end", kind: "end", column: "review" },
      ],
      edges: [
        { from: "start", to: "code-review" },
        { from: "code-review", to: "end", condition: "success" },
      ],
    };
    const sink = recorder();
    const executor = new WorkflowGraphExecutor({
      runCustomNode: (node, nodeTask, context) => runGraphCustomNode(
        harness as never,
        node,
        nodeTask,
        {} as Settings,
        undefined,
        context,
      ),
      recordWorkflowStepResult: sink.record,
    });

    await executor.run(row, {} as Settings, ir);
    const persisted = sink.results.get("code-review")!;
    expect(harness.executeWorkflowStep).toHaveBeenCalledTimes(1);
    expect(persisted).toMatchObject({ status: "passed", reviewInputFingerprint: "proof-279", verdict: "APPROVE" });
    row.workflowStepResults = [persisted];
    for (const manual of [false, true]) {
      expect(getTaskMergeBlocker(row, {
        manual,
        requiredPreMergeStepIds: new Set(["code-review"]),
        mergeContent: { kind: "singular", diff: { state: "fingerprint", fingerprint: "proof-279" } },
      })).toBeUndefined();
    }
  });

  it("does not lift a fingerprint for an unrelated unmarked node", async () => {
    const ir: WorkflowIr = {
      version: "v2",
      name: "unmarked docs",
      columns: [{ id: "review", name: "Review", traits: [] }],
      nodes: [
        { id: "start", kind: "start", column: "review" },
        { id: "documentation-delivery", kind: "prompt", column: "review", config: { prompt: "Document", skillName: "docs-skill" } },
        { id: "end", kind: "end", column: "review" },
      ],
      edges: [
        { from: "start", to: "documentation-delivery" },
        { from: "documentation-delivery", to: "end", condition: "success" },
      ],
    };
    const sink = recorder();
    const executor = new WorkflowGraphExecutor({
      handlers: { prompt: async () => ({ outcome: "success", contextPatch: { reviewInputFingerprint: "must-drop" } }) },
      recordWorkflowStepResult: sink.record,
    });
    await executor.run(task(), {} as Settings, ir);
    expect(sink.results.get("documentation-delivery")).not.toHaveProperty("reviewInputFingerprint");
  });
});

describe("content-binding approval persistence backstop", () => {
  function sinkHarness(row: TaskDetail) {
    const store = {
      getTask: vi.fn(async () => row),
      updateTask: vi.fn(async (_id: string, patch: Partial<TaskDetail>) => Object.assign(row, patch)),
      updateTaskAtomic: vi.fn(async (_id: string, compute: (current: TaskDetail) => Partial<TaskDetail> | null) => {
        const patch = compute(row);
        if (patch) Object.assign(row, patch);
        return row;
      }),
      isBackendMode: vi.fn(() => false),
      recordAgentActivity: vi.fn(async () => undefined),
      logEntry: vi.fn(async () => undefined),
    };
    return {
      store,
      deps: { store, getRunContextFor: () => undefined, readTaskArtifact: vi.fn() },
    };
  }

  function approval(overrides: Partial<WorkflowStepResult> = {}): WorkflowStepResult {
    return {
      workflowStepId: "code-review",
      workflowStepName: "Code Review",
      phase: "pre-merge",
      status: "passed",
      verdict: "APPROVE",
      reviewKind: "code",
      startedAt: now,
      completedAt: now,
      ...overrides,
    };
  }

  it.each([
    ["declared kind", approval({ workflowStepId: "custom-code-review" })],
    ["reserved identity", approval({ reviewKind: undefined })],
  ])("downgrades a proofless approval recognized by %s", async (_name, incoming) => {
    const row = task({ workflowStepResults: [{
      workflowStepId: "documentation-delivery",
      workflowStepName: "Documentation",
      status: "passed",
    }] });
    const harness = sinkHarness(row);
    await expect(persistWorkflowStepResultWithOutcome(harness.deps as never, row.id, incoming)).resolves.toEqual({
      scopeCurrent: true,
      persisted: true,
    });
    const persisted = row.workflowStepResults?.find((entry) => entry.workflowStepId === incoming.workflowStepId);
    expect(persisted).toMatchObject({ status: "failed" });
    expect(persisted).not.toHaveProperty("verdict");
    expect(persisted?.notes).toContain("reviewInputFingerprint");
    expect(row.workflowStepResults?.find((entry) => entry.workflowStepId === "documentation-delivery")).toMatchObject({ status: "passed" });
    expect(harness.store.logEntry).toHaveBeenCalledTimes(1);
    expect(harness.store.recordAgentActivity).toHaveBeenCalledWith(expect.objectContaining({ type: "workflow:gate-failed" }));
  });

  it.each([
    ["workspace", task({ workspaceWorktrees: {} }), approval()],
    ["fingerprinted", task(), approval({ reviewInputFingerprint: "proof-279" })],
    ["fast bypass", task(), approval({
      status: "skipped",
      verdict: undefined,
      bypassedBy: FAST_MODE_BYPASS_ACTOR,
      bypassedAt: now,
      bypassReason: "Fast mode bypasses pre-merge workflow gates",
      bypassedFromStatus: "absent",
    })],
  ])("leaves %s result semantics untouched", async (_name, row, incoming) => {
    const harness = sinkHarness(row);
    await persistWorkflowStepResultWithOutcome(harness.deps as never, row.id, incoming);
    expect(row.workflowStepResults?.find((entry) => entry.workflowStepId === incoming.workflowStepId)).toMatchObject(incoming);
    expect(harness.store.logEntry).not.toHaveBeenCalled();
  });
});
