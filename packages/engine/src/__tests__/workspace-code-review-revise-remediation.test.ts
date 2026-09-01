import "./executor-test-helpers.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskStep, WorkflowReviewFinding } from "@fusion/core";
import { getBuiltinWorkflow, planRemediationPlacement } from "@fusion/core";

import { appendReviewRemediationSteps } from "../executor/append-review-remediation-steps.js";
import { deriveRemediationSteps } from "../executor/derive-remediation-steps.js";
import { requestPreMergeOptionalStepFix } from "../executor/request-pre-merge-optional-step-fix.js";
import { resolveReviewRemediationGate } from "../executor/review-remediation-gate.js";
import { deriveWorkspaceReviewRemediation } from "../executor/workspace-review-remediation.js";
import { TaskExecutor } from "../executor.js";
import { createMockStore, resetExecutorMocks } from "./executor-test-helpers.js";

beforeEach(() => {
  resetExecutorMocks();
});

function routingHarness() {
  const task = {
    id: "MULT-029",
    column: "in-review",
    worktree: "/tmp/singular",
    steps: [{ name: "Implement", status: "done" }],
  } as Task;
  const appendReviewRemediationSteps = vi.fn(async () => "appended" as const);
  const store = {
    getTask: vi.fn(async () => task),
    getSettings: vi.fn(async () => ({ autoMerge: true })),
    getTaskWorkflowSelectionAsync: vi.fn(async () => undefined),
    logEntry: vi.fn(async () => undefined),
  };
  const deps = {
    store: store as never,
    getRunContextFor: () => undefined,
    recoverMissingRequiredArtifacts: vi.fn(async () => undefined),
    parkPlanReviewReplanCapExhausted: vi.fn(async () => undefined),
    clearPausedAborted: vi.fn(),
    readTaskArtifact: vi.fn(async () => undefined),
    appendReviewRemediationSteps,
    workflowLifecycleMovesInFlight: new Set<string>(),
    sendTaskBackForFix: vi.fn(async () => undefined),
  };
  return { task, store, deps, appendReviewRemediationSteps };
}

const baseInfo = {
  stepName: "Code Review",
  feedback: "Review requested changes.",
  phase: "pre-merge" as const,
  status: "failed" as const,
  verdict: "REVISE",
};

describe("review remediation gate identity", () => {
  it("resolves built-in and structural Code Review signals", () => {
    expect(resolveReviewRemediationGate({ nodeId: "code-review" })).toBe("Code Review");
    expect(resolveReviewRemediationGate({ nodeId: "code-review-step", reviewKind: "code" })).toBe("Code Review");
  });

  it("resolves deterministic verification by workflow action", () => {
    expect(resolveReviewRemediationGate({ nodeId: "custom-check", workflowAction: "deterministic-verification" })).toBe("Verification");
    expect(resolveReviewRemediationGate({ nodeId: "verification" })).toBe("Verification");
  });

  it("does not classify a reporting-only optional group", () => {
    expect(resolveReviewRemediationGate({ nodeId: "documentation", workflowAction: "documentation-delivery" })).toBeUndefined();
  });

  it("refuses a reporting-only optional group through the requester and records the refusal", async () => {
    const { task, store, deps, appendReviewRemediationSteps } = routingHarness();
    store.getTaskWorkflowSelectionAsync.mockResolvedValue({ workflowId: "builtin:coding-ideas-v2" });
    Object.assign(store, {
      getWorkflowDefinition: vi.fn(async (id: string) => {
        const workflow = getBuiltinWorkflow(id);
        return workflow ? { ir: workflow.ir } : undefined;
      }),
    });

    await expect(requestPreMergeOptionalStepFix(deps as never, task.id, task, {
      ...baseInfo,
      nodeId: "documentation-delivery",
      stepName: "Documentation & Delivery",
      workflowAction: "documentation-delivery",
    })).resolves.toBe(false);

    expect(appendReviewRemediationSteps).not.toHaveBeenCalled();
    expect(deps.sendTaskBackForFix).not.toHaveBeenCalled();
    expect(store.logEntry).toHaveBeenCalledWith(
      task.id,
      "Documentation & Delivery recorded feedback but cannot reopen implementation",
      expect.stringMatching(/reports on accepted work.*no executor remediation was scheduled/s),
      undefined,
    );
  });

  it.each([
    ["the built-in Code Review node", { nodeId: "code-review" }],
    ["a custom Code Review node", { nodeId: "code-review-step", reviewKind: "code" as const }],
  ])("routes %s into named remediation", async (_label, identity) => {
    const { task, deps, appendReviewRemediationSteps } = routingHarness();

    await expect(requestPreMergeOptionalStepFix(deps as never, task.id, task, { ...baseInfo, ...identity })).resolves.toBe(true);

    expect(appendReviewRemediationSteps).toHaveBeenCalledWith(
      task,
      expect.objectContaining(identity),
      expect.objectContaining({ attemptClaim: expect.objectContaining({ revisionKey: identity.nodeId }) }),
    );
  });

  it("routes a custom deterministic verification node into named remediation", async () => {
    const { task, deps, appendReviewRemediationSteps } = routingHarness();
    const info = {
      ...baseInfo,
      stepName: "Custom verification",
      verdict: undefined,
      nodeId: "custom-check",
      workflowAction: "deterministic-verification",
    };

    await expect(requestPreMergeOptionalStepFix(deps as never, task.id, task, info)).resolves.toBe(true);

    expect(appendReviewRemediationSteps).toHaveBeenCalledWith(task, expect.objectContaining({ nodeId: "custom-check" }));
  });
});

const reportedFinding: WorkflowReviewFinding = {
  id: "repo2:MULT-029-source-location-unchecked",
  title: "Repo2 does not reject a recreated bonjour.txt",
  body: "Replace or add the source-location check while preserving the unrelated test.txt date contract.",
  filePath: "repo2/tests/test_txt_absence.sh",
  line: 31,
  severity: "critical",
  resolution: "open",
};

function reportedSymptomHarness(options: { findings?: WorkflowReviewFinding[]; remediationWaves?: number } = {}) {
  const findings = options.findings ?? [reportedFinding];
  const prompt = [
    "# Task: MULT-029",
    "",
    "## File Scope",
    "",
    "- `repo1/bonjour.txt`",
    "- `repo2/bonjour.txt`",
    "- `repo2/tests/test_bonjour.sh`",
    "",
    "## Steps",
  ].join("\n");
  const task = {
    id: "MULT-029",
    column: "in-review",
    prompt,
    modifiedFiles: ["repo1/bonjour.txt", "repo1/tests/test_bonjour.sh", "repo2/bonjour.txt", "repo2/tests/test_bonjour.sh"],
    log: [],
    steps: [
      { name: "Preflight", status: "done" },
      { name: "Establish destination ownership", status: "done" },
      { name: "Remove stale source ownership", status: "done" },
      { name: "Testing & Verification", status: "done" },
    ] as TaskStep[],
    repositoryScope: { state: "confirmed", revision: 1, repositories: ["repo1", "repo2"] },
    workspaceWorktrees: {
      repo1: { worktreePath: "/tmp/mult-029/repo1", baseCommitSha: "r1" },
      repo2: { worktreePath: "/tmp/mult-029/repo2", baseCommitSha: "r2" },
    },
    workflowStepResults: [{
      workflowStepId: "code-review-step",
      workflowStepName: "Code Review",
      reviewKind: "code",
      phase: "pre-merge",
      status: "failed",
      verdict: "REVISE",
      repositoryScopeRevision: 1,
      repositoryReviewOutcomes: [
        { repository: "repo1", status: "REVIEWED", verdict: "APPROVE", findings: [] },
        { repository: "repo2", status: "REVIEWED", verdict: "REVISE", findings },
      ],
    }],
  } as Task;
  for (let wave = 1; wave <= (options.remediationWaves ?? 0); wave += 1) {
    task.steps.push(
      {
        name: `Fix: prior wave ${wave}`,
        status: "done",
        remediation: { wave, gate: "Code Review", gateStepId: "code-review-step", detail: `Prior wave ${wave}` },
      },
      { name: "Testing & Verification", status: "done" },
    );
  }
  const sendTaskBackForFix = vi.fn(async () => undefined);
  const store = {
    getTask: vi.fn(async () => task),
    getSettings: vi.fn(async () => ({ autoMerge: true })),
    getTaskWorkflowSelectionAsync: vi.fn(async () => undefined),
    logEntry: vi.fn(async (_id: string, action: string, outcome?: string, runContext?: never) => {
      task.log = [...(task.log ?? []), { timestamp: new Date().toISOString(), action, outcome, runContext }];
    }),
    updateTask: vi.fn(async (_id: string, patch: Partial<Task>) => {
      Object.assign(task, patch);
      return task;
    }),
    appendRemediationSteps: vi.fn(async (_id: string, steps: readonly TaskStep[], options: { wave?: number }) => {
      const appended = steps.map((step) => ({ ...step, status: "pending" as const }));
      const placement = planRemediationPlacement(task.steps ?? [], appended);
      task.steps = placement.steps;
      return { task, appended, appendedCount: appended.length, wave: options.wave ?? 1, ...placement };
    }),
    updateTaskAtomic: vi.fn(async (_id: string, mutate: (current: Task) => Partial<Task> | null | undefined | Promise<Partial<Task> | null | undefined>) => {
      const patch = await mutate(task);
      if (patch) Object.assign(task, patch);
      return task;
    }),
    updateWorkspaceReviewState: vi.fn(async (_id: string, revision: number, remediation: NonNullable<NonNullable<Task["repositoryScope"]>["reviewRemediation"]>) => {
      if (task.repositoryScope?.revision !== revision) return { task, updated: false };
      task.repositoryScope = { ...task.repositoryScope, reviewRemediation: remediation };
      return { task, updated: true };
    }),
  };
  const deps = {
    store: store as never,
    getRunContextFor: () => undefined,
    recoverMissingRequiredArtifacts: vi.fn(async () => undefined),
    parkPlanReviewReplanCapExhausted: vi.fn(async () => undefined),
    clearPausedAborted: vi.fn(),
    readTaskArtifact: vi.fn(async () => task.prompt),
    appendReviewRemediationSteps: (
      live: Task,
      info: never,
      options?: Parameters<typeof appendReviewRemediationSteps>[3],
    ) => appendReviewRemediationSteps(
      { store: store as never, readTaskArtifact: async () => task.prompt, sendTaskBackForFix },
      live,
      info,
      options,
    ),
    workflowLifecycleMovesInFlight: new Set<string>(),
    sendTaskBackForFix,
  };
  return { task, store, deps, sendTaskBackForFix };
}

describe("workspace Code Review REVISE symptom", () => {
  it("appends the reported source-location fix and reopens the failing repository", async () => {
    const { task, store, deps, sendTaskBackForFix } = reportedSymptomHarness();
    const info = {
      ...baseInfo,
      nodeId: "code-review-step",
      reviewKind: "code" as const,
      feedback: "The source repository no longer rejects a recreated bonjour.txt.",
      findings: [reportedFinding],
    };

    await expect(requestPreMergeOptionalStepFix(deps as never, task.id, task, info)).resolves.toBe(true);

    const remediation = task.steps?.find((step) => step.remediation?.findingId === reportedFinding.id);
    expect(remediation).toMatchObject({
      name: `Fix: ${reportedFinding.title}`,
      status: "pending",
      remediation: {
        gate: "Code Review",
        gateStepId: "code-review-step",
        wave: 1,
        filePath: "repo2/tests/test_txt_absence.sh",
        findingId: "repo2:MULT-029-source-location-unchecked",
        detail: reportedFinding.body,
      },
    });
    expect(remediation?.name).not.toContain(reportedFinding.body);
    expect(task.steps?.map((step) => [step.name, step.status])).toEqual([
      ["Preflight", "done"],
      ["Establish destination ownership", "done"],
      ["Remove stale source ownership", "done"],
      ["Testing & Verification", "done"],
      [expect.stringContaining(reportedFinding.title), "pending"],
      ["Testing & Verification", "pending"],
    ]);
    expect(task.prompt).toContain("- `repo2/tests/test_txt_absence.sh`");
    expect(sendTaskBackForFix).toHaveBeenCalledWith(
      expect.anything(),
      "/tmp/mult-029/repo2",
      expect.anything(),
      "Code Review",
      expect.anything(),
      true,
      false,
      undefined,
      [reportedFinding],
      false,
      "none",
    );
    expect(store.logEntry.mock.calls.some((call) => /released as non-blocking/i.test(String(call[1])))).toBe(false);
  });

  it("turns a finding-less Code Review REVISE into a workspace repair step", async () => {
    const { task, store, deps, sendTaskBackForFix } = reportedSymptomHarness({ findings: [] });

    await expect(requestPreMergeOptionalStepFix(deps as never, task.id, task, {
      ...baseInfo, nodeId: "code-review-step", reviewKind: "code", findings: [],
    })).resolves.toBe(true);

    expect(sendTaskBackForFix).toHaveBeenCalledOnce();
    expect(task.steps).toContainEqual(expect.objectContaining({
      remediation: expect.objectContaining({ findingId: "missing-code-review-fix-steps" }),
    }));
    expect(store.logEntry.mock.calls.some((call) => /released as non-blocking/i.test(String(call[1])))).toBe(false);
  });

  it("turns below-threshold Code Review feedback into a workspace repair step", async () => {
    const advisoryFinding = { ...reportedFinding, severity: "minor" as const };
    const { task, deps, sendTaskBackForFix } = reportedSymptomHarness({ findings: [advisoryFinding] });

    await expect(requestPreMergeOptionalStepFix(deps as never, task.id, task, {
      ...baseInfo, nodeId: "code-review-step", reviewKind: "code", findings: [advisoryFinding],
    })).resolves.toBe(true);

    expect(sendTaskBackForFix).toHaveBeenCalledOnce();
    expect(task.steps).toContainEqual(expect.objectContaining({
      remediation: expect.objectContaining({ findingId: "missing-code-review-fix-steps" }),
    }));
  });

  it("keeps the first verification pass done when a second remediation wave is appended", async () => {
    const { task, deps } = reportedSymptomHarness({ remediationWaves: 1 });

    await expect(requestPreMergeOptionalStepFix(deps as never, task.id, task, {
      ...baseInfo, nodeId: "code-review-step", reviewKind: "code", findings: [reportedFinding],
    })).resolves.toBe(true);

    expect(task.steps?.filter((step) => step.name === "Testing & Verification").map((step) => step.status))
      .toEqual(["done", "done", "pending"]);
    expect(task.steps?.at(-2)?.remediation).toMatchObject({ wave: 2, gate: "Code Review" });
    expect(task.steps?.at(-1)).toEqual({ name: "Testing & Verification", status: "pending" });
  });

  it("appends a fourth workspace wave when its durable review input changed", async () => {
    const { task, store, deps, sendTaskBackForFix } = reportedSymptomHarness({ remediationWaves: 3 });
    task.repositoryScope = {
      ...task.repositoryScope!,
      reviewRemediation: { scopeRevision: 1, repository: "repo2", inputSignature: "older-input" },
    };

    await expect(requestPreMergeOptionalStepFix(deps as never, task.id, task, {
      ...baseInfo, nodeId: "code-review-step", reviewKind: "code", findings: [reportedFinding],
    })).resolves.toBe(true);

    expect(task.steps).toContainEqual(expect.objectContaining({
      status: "pending",
      remediation: expect.objectContaining({ wave: 4 }),
    }));
    expect(sendTaskBackForFix).toHaveBeenCalledTimes(1);
    expect(sendTaskBackForFix.mock.calls[0]?.[1]).toBe("/tmp/mult-029/repo2");
    expect(store.logEntry.mock.calls.some((call) => String(call[0]).includes("attempt 1/"))).toBe(false);
    expect(task.log?.some((entry) => entry.action.includes("attempt 1/"))).toBe(true);
  });

  it("routes unchanged durable workspace input to convergence without appending", async () => {
    const { task, store, deps, sendTaskBackForFix } = reportedSymptomHarness();
    const current = deriveWorkspaceReviewRemediation(task.workflowStepResults![0]!);
    expect(current).toBeDefined();
    task.repositoryScope = { ...task.repositoryScope!, reviewRemediation: current };

    await expect(requestPreMergeOptionalStepFix(deps as never, task.id, task, {
      ...baseInfo, nodeId: "code-review-step", reviewKind: "code", findings: [reportedFinding],
    })).resolves.toBe(false);

    expect(store.appendRemediationSteps).not.toHaveBeenCalled();
    expect(sendTaskBackForFix).not.toHaveBeenCalled();
    expect(task.reviewConvergenceEscalationCount).toBeGreaterThanOrEqual(1);
  });

  it("preserves superseded-scope behavior when the workspace revision changed", async () => {
    const { task, store, deps, sendTaskBackForFix } = reportedSymptomHarness();
    task.repositoryScope = { ...task.repositoryScope!, revision: 2 };

    await expect(requestPreMergeOptionalStepFix(deps as never, task.id, task, {
      ...baseInfo, nodeId: "code-review-step", reviewKind: "code", findings: [reportedFinding],
    })).resolves.toBe(false);

    expect(sendTaskBackForFix).not.toHaveBeenCalled();
    expect(store.logEntry).toHaveBeenCalledWith(
      task.id,
      "Workspace review remediation superseded by repository scope change",
    );
  });

  it("enforces an authored workspace maxRevisions budget from production-written attempts", async () => {
    const { task, store, deps, sendTaskBackForFix } = reportedSymptomHarness();
    task.workflowStepResults![0]!.workflowStepId = "code-review";
    const info = {
      ...baseInfo,
      nodeId: "code-review",
      reviewKind: "code" as const,
      maxRevisions: 2,
      findings: [reportedFinding],
    };
    const blockingOutcome = task.workflowStepResults![0]!.repositoryReviewOutcomes![1]!;

    blockingOutcome.fingerprint = "workspace-fingerprint-1";
    await expect(requestPreMergeOptionalStepFix(deps as never, task.id, task, info)).resolves.toBe(true);
    for (const step of task.steps ?? []) if (step.status === "pending") step.status = "done";

    blockingOutcome.fingerprint = "workspace-fingerprint-2";
    await expect(requestPreMergeOptionalStepFix(deps as never, task.id, task, info)).resolves.toBe(true);
    for (const step of task.steps ?? []) if (step.status === "pending") step.status = "done";

    task.reviewConvergenceStage = 2;
    blockingOutcome.fingerprint = "workspace-fingerprint-3";
    await expect(requestPreMergeOptionalStepFix(deps as never, task.id, task, info)).resolves.toBe(false);

    expect(store.appendRemediationSteps).toHaveBeenCalledTimes(0);
    expect(sendTaskBackForFix).toHaveBeenCalledTimes(2);
    expect(task.log?.filter((entry) => entry.action.includes("requested named remediation"))).toHaveLength(2);
    expect(task.reviewConvergenceEscalationCount).toBeGreaterThanOrEqual(1);
    expect(store.logEntry).toHaveBeenCalledWith(
      task.id,
      "Pre-merge remediation not scheduled — revision budget exhausted",
      expect.stringContaining("Maximum revisions: 2"),
      undefined,
    );
  });

  it("keeps a finding in an unconfirmed repository out of scope", () => {
    const result = deriveRemediationSteps({
      gate: "Code Review",
      gateStepId: "code-review-step",
      wave: 1,
      findings: [{ ...reportedFinding, filePath: "repo3/tests/source.test.ts" }],
      prompt: "## File Scope\n\n- `repo1/**`",
      confirmedRepositories: ["repo1", "repo2"],
    });

    expect(result).toMatchObject({ steps: [], reason: "upstream-out-of-scope" });
  });

  it("does not extend the confirmed-repository allowance to a singular task", () => {
    const result = deriveRemediationSteps({
      gate: "Code Review",
      gateStepId: "code-review",
      wave: 1,
      findings: [{ ...reportedFinding, filePath: "outside/new-file.ts" }],
      prompt: "## File Scope\n\n- `src/**`",
    });

    expect(result).toMatchObject({ steps: [], reason: "upstream-out-of-scope" });
  });
});

describe("graph failure visibility after review advancement", () => {
  function advancedTask(withFailedReview: boolean): Task {
    return {
      id: "FN-231-graph",
      title: "Graph failure visibility",
      description: "Keep rejected review visible",
      column: "in-review",
      status: null,
      dependencies: [],
      steps: [{ name: "Implement", status: "done" }],
      currentStep: 0,
      log: [],
      worktree: "/tmp/fn-231-graph",
      createdAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:00:00.000Z",
      workflowStepResults: withFailedReview
        ? [{
          workflowStepId: "code-review-step",
          workflowStepName: "Code Review",
          phase: "pre-merge",
          status: "failed",
          verdict: "REVISE",
          reviewKind: "code",
        }]
        : [],
    } as Task;
  }

  const graphFailure = {
    disposition: "failed" as const,
    outcome: "failure" as const,
    reason: "remediation-not-scheduled",
    visitedNodeIds: ["code-review-step"],
    context: {
      "node:code-review-step:outcome": "failure",
      "node:code-review-step:value": "remediation-not-scheduled",
    },
  };

  it("names the failed pre-merge step instead of calling the advanced card benign", async () => {
    const store = createMockStore();
    const live = advancedTask(true);
    store.getTask.mockResolvedValue(live);
    const executor = new TaskExecutor(store, "/tmp/fn-231");
    vi.spyOn(executor as any, "routeRetryableRemediationGraphFailureToPreMergeFix").mockResolvedValue(false);
    vi.spyOn(executor as any, "routeGraphFailureToExecutionResume").mockResolvedValue(false);
    const request = vi.spyOn(executor as any, "requestPreMergeOptionalStepFix").mockResolvedValue(true);

    await (executor as any).handleGraphFailure(live, graphFailure);

    /* FN-267 added a fourth argument: the admission claim this backstop now holds while it hands off. */
    expect(request).toHaveBeenCalledWith(live.id, expect.objectContaining({ id: live.id }), expect.objectContaining({
      nodeId: "code-review-step", reviewKind: "code", verdict: "REVISE",
    }), expect.anything());
    expect(store.logEntry.mock.calls.some((call) => String(call[1]).includes("no further action needed"))).toBe(false);
  });

  it("keeps the existing benign message when no failed pre-merge step remains", async () => {
    const store = createMockStore();
    const live = advancedTask(false);
    store.getTask.mockResolvedValue(live);
    const executor = new TaskExecutor(store, "/tmp/fn-231");
    vi.spyOn(executor as any, "routeRetryableRemediationGraphFailureToPreMergeFix").mockResolvedValue(false);
    vi.spyOn(executor as any, "routeGraphFailureToExecutionResume").mockResolvedValue(false);

    await (executor as any).handleGraphFailure(live, graphFailure);

    expect(store.logEntry).toHaveBeenCalledWith(
      live.id,
      "Workflow graph run ended after task already advanced to 'in-review' — no further action needed",
      undefined,
      undefined,
    );
  });
});
