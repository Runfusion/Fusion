import { describe, expect, it, vi } from "vitest";
import { resolveWipTargetForTask, type Task, type WorkflowReviewFinding } from "@fusion/core";

const { routeReviewConvergenceLadderMock } = vi.hoisted(() => ({
  routeReviewConvergenceLadderMock: vi.fn(async () => "declined" as const),
}));

vi.mock("../executor/review-convergence-ladder.js", () => ({
  routeReviewConvergenceLadder: routeReviewConvergenceLadderMock,
}));

import { appendReviewRemediationSteps } from "../executor/append-review-remediation-steps.js";
import { requestPreMergeOptionalStepFix } from "../executor/request-pre-merge-optional-step-fix.js";

function exhaustedCodeReviewTask() {
  const now = "2026-09-03T05:40:00.000Z";
  return {
    id: "FN-288-BOUNDED",
    title: "Bound Code Review",
    description: "Stop automatic Code Review remediation after the default cap.",
    column: "in-review" as const,
    worktree: "/tmp/fn-288-bounded",
    branch: "fusion/fn-288-bounded",
    dependencies: [],
    steps: [{ name: "Implement", status: "done" as const }],
    currentStep: 0,
    createdAt: now,
    updatedAt: now,
    log: [1, 2, 3].map((attempt) => ({
      action: `Pre-merge optional workflow step requested executor fixes (attempt ${attempt}/3)`,
      outcome: "Workflow revision key: code-review",
      timestamp: now,
    })),
    workflowStepResults: [{
      workflowStepId: "code-review",
      workflowStepName: "Code Review",
      phase: "pre-merge" as const,
      status: "failed" as const,
      verdict: "REVISE" as const,
      output: "A correctness defect remains.",
      findings: [{
        id: "remaining-defect",
        title: "Preserve the guard",
        body: "The required guard is still absent.",
        severity: "critical" as const,
        resolution: "open" as const,
        filePath: "packages/engine/src/guard.ts",
      }],
      startedAt: now,
      completedAt: now,
    }],
  };
}

function remediationDeps(task: Task) {
  const appendReviewRemediationSteps = vi.fn(async () => "appended" as const);
  const sendTaskBackForFix = vi.fn(async () => {});
  const store = {
    getTask: vi.fn(async () => task),
    getSettings: vi.fn(async () => ({ maxPostReviewFixes: 10 })),
    getTaskWorkflowSelection: vi.fn(() => ({ workflowId: "builtin:coding", stepIds: ["code-review"] })),
    getWorkflowDefinition: vi.fn(async () => undefined),
    getWorkflowSettingValues: vi.fn(() => ({})),
    getWorkflowSettingsProjectId: vi.fn(() => "project-fn-288"),
    logEntry: vi.fn(async () => undefined),
  };
  return {
    store,
    appendReviewRemediationSteps,
    sendTaskBackForFix,
    deps: {
      store,
      getRunContextFor: () => undefined,
      recoverMissingRequiredArtifacts: vi.fn(async () => {}),
      parkPlanReviewReplanCapExhausted: vi.fn(async () => {}),
      clearPausedAborted: vi.fn(),
      readTaskArtifact: vi.fn(async () => undefined),
      appendReviewRemediationSteps,
      workflowLifecycleMovesInFlight: new Set<string>(),
      sendTaskBackForFix,
    },
  };
}

const REVIEW_FILES = [
  "packages/engine/src/review-a.ts",
  "packages/core/src/review-b.ts",
] as const;

function namedFindings(): WorkflowReviewFinding[] {
  return [
    {
      id: "guard-a",
      title: "Restore the execution guard",
      body: "Add the missing state guard before dispatch.",
      severity: "critical",
      resolution: "open",
      filePath: REVIEW_FILES[0],
      line: 12,
    },
    {
      id: "guard-b",
      title: "Preserve the persisted verdict",
      body: "Keep the failed verdict record until re-review.",
      severity: "critical",
      resolution: "open",
      filePath: REVIEW_FILES[1],
      line: 34,
    },
  ];
}

function namedRemediationTask(overrides: Partial<Task> = {}): Task {
  const now = "2026-09-03T05:40:00.000Z";
  return {
    id: "FN-288-NAMED",
    title: "Named review remediation",
    description: "Return review fixes to the executor.",
    column: "in-review",
    worktree: "/tmp/fn-288-named",
    branch: "fusion/fn-288-named",
    modifiedFiles: [...REVIEW_FILES],
    dependencies: [],
    steps: [
      { name: "Implement", status: "done" },
      {
        name: "Fix: Earlier review item",
        status: "done",
        remediation: {
          wave: 1,
          gate: "Code Review",
          gateStepId: "code-review",
          findingId: "earlier",
          detail: "Earlier review item",
        },
      },
      { name: "Testing & Verification", status: "done" },
    ],
    currentStep: 2,
    prompt: "# Task\n\n## File Scope\n- `packages/existing.ts`\n\n## Steps\n",
    log: [],
    workflowStepResults: [{
      workflowStepId: "code-review",
      workflowStepName: "Code Review",
      phase: "pre-merge",
      status: "failed",
      verdict: "REVISE",
      reviewKind: "code",
      reviewInputFingerprint: "review-input-2",
      findings: namedFindings(),
      startedAt: now,
      completedAt: now,
    }],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as Task;
}

function namedRemediationHarness(initial = namedRemediationTask()) {
  let live = initial;
  const sendTaskBackForFix = vi.fn(async () => undefined);
  const store = {
    getTask: vi.fn(async () => live),
    getSettings: vi.fn(async () => ({ maxPostReviewFixes: 10 })),
    getTaskWorkflowSelection: vi.fn(() => ({ workflowId: "builtin:coding", stepIds: ["code-review"] })),
    getWorkflowDefinition: vi.fn(async () => undefined),
    getWorkflowSettingValues: vi.fn(() => ({})),
    getWorkflowSettingsProjectId: vi.fn(() => "project-fn-288"),
    updateTask: vi.fn(async (_id: string, patch: Partial<Task>) => {
      live = { ...live, ...patch } as Task;
      return live;
    }),
    updateTaskAtomic: vi.fn(async (_id: string, compute: (current: Task) => Partial<Task> | null) => {
      const patch = compute(live);
      if (patch) live = { ...live, ...patch } as Task;
      return live;
    }),
    logEntry: vi.fn(async () => undefined),
    addTaskComment: vi.fn(async () => undefined),
  };
  const append = (task: Task, info: Parameters<typeof appendReviewRemediationSteps>[2], maxRevisions: number | "unbounded" = 3) =>
    appendReviewRemediationSteps({
      store: store as any,
      readTaskArtifact: vi.fn(async () => live.prompt),
      sendTaskBackForFix,
    }, task, info, {
      attemptClaim: {
        revisionKey: "code-review",
        stepName: "Code Review",
        status: "failed",
        maxRevisions,
      },
    });
  return { store, append, sendTaskBackForFix, current: () => live };
}

function reviseInfo(findings: WorkflowReviewFinding[] = namedFindings()) {
  return {
    phase: "pre-merge" as const,
    status: "failed" as const,
    verdict: "REVISE",
    reviewKind: "code" as const,
    nodeId: "code-review",
    stepName: "Code Review",
    feedback: "Correct the two blocking review findings.",
    findings,
  };
}

describe("bounded Code Review named remediation", () => {
  it("routes an exhausted default budget to convergence without appending another wave", async () => {
    routeReviewConvergenceLadderMock.mockClear();
    const task = exhaustedCodeReviewTask();
    const { deps, store, appendReviewRemediationSteps, sendTaskBackForFix } = remediationDeps(task);

    await expect(requestPreMergeOptionalStepFix(deps as any, task.id, task as any, {
      phase: "pre-merge",
      status: "failed",
      verdict: "REVISE",
      nodeId: "code-review",
      stepName: "Code Review",
      feedback: "A correctness defect remains.",
      findings: task.workflowStepResults[0].findings,
    })).resolves.toBe(false);

    expect(routeReviewConvergenceLadderMock).toHaveBeenCalledWith(
      expect.anything(),
      task.id,
      expect.objectContaining({
        kind: "budget-exhausted",
        workflowStepId: "code-review",
        attempt: 3,
        max: 3,
      }),
    );
    expect(appendReviewRemediationSteps).not.toHaveBeenCalled();
    expect(sendTaskBackForFix).not.toHaveBeenCalled();
    expect(task.workflowStepResults[0].status).toBe("failed");
    expect(store.logEntry).toHaveBeenCalledWith(
      task.id,
      "Pre-merge remediation not scheduled — revision budget exhausted",
      expect.stringContaining("Maximum revisions: 3"),
      undefined,
    );
  });

  it("appends one named Fix step per finding, widens scope, and bounces with no trailing reopen", async () => {
    const harness = namedRemediationHarness();

    await expect(harness.append(harness.current(), reviseInfo())).resolves.toBe("appended");

    const pendingRemediation = harness.current().steps.filter((step) => step.status === "pending" && step.remediation);
    expect(pendingRemediation).toHaveLength(2);
    expect(pendingRemediation.map((step) => step.remediation?.findingId)).toEqual(["guard-a", "guard-b"]);
    expect(pendingRemediation.every((step) => step.remediation?.wave === 2)).toBe(true);
    expect(harness.current().steps.at(-1)).toMatchObject({ name: "Testing & Verification", status: "pending" });
    expect(harness.current().prompt).toContain(`\`packages/engine/src/review-a.ts\``);
    expect(harness.current().prompt).toContain(`\`packages/core/src/review-b.ts\``);
    expect(harness.sendTaskBackForFix).toHaveBeenCalledOnce();
    expect(harness.sendTaskBackForFix.mock.calls[0].at(-1)).toBe("none");
    expect(harness.current().log).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "Review gate Code Review requested named remediation (attempt 1/3)",
        outcome: expect.stringContaining("Workflow revision key: code-review"),
      }),
    ]));
  });

  it("creates the deterministic fallback Fix step when the reviewer supplies no usable finding", async () => {
    const harness = namedRemediationHarness();

    await expect(harness.append(harness.current(), reviseInfo([]))).resolves.toBe("appended");

    const pendingRemediation = harness.current().steps.filter((step) => step.status === "pending" && step.remediation);
    expect(pendingRemediation).toHaveLength(1);
    expect(pendingRemediation[0]).toMatchObject({
      name: "Fix: Turn Code Review feedback into actionable fixes",
      remediation: {
        gate: "Code Review",
        gateStepId: "code-review",
        findingId: "missing-code-review-fix-steps",
        wave: 2,
      },
    });
    expect(harness.sendTaskBackForFix.mock.calls[0].at(-1)).toBe("none");
  });

  it("consumes the next attempt for changed review input and routes unchanged input to convergence", async () => {
    routeReviewConvergenceLadderMock.mockClear();
    const prior = {
      ...namedRemediationTask().workflowStepResults![0]!,
      reviewInputFingerprint: "review-input-1",
      completedAt: "2026-09-03T05:39:00.000Z",
    };
    const currentResult = {
      ...namedRemediationTask().workflowStepResults![0]!,
      priorAttempts: [prior],
    };
    const task = namedRemediationTask({
      log: [{
        action: "Review gate Code Review requested named remediation (attempt 1/3)",
        outcome: "Workflow revision key: code-review",
        timestamp: "2026-09-03T05:39:00.000Z",
      }],
      workflowStepResults: [currentResult],
    });
    const harness = namedRemediationHarness(task);
    const requestDeps = {
      store: harness.store,
      getRunContextFor: () => undefined,
      recoverMissingRequiredArtifacts: vi.fn(async () => {}),
      parkPlanReviewReplanCapExhausted: vi.fn(async () => {}),
      clearPausedAborted: vi.fn(),
      readTaskArtifact: vi.fn(async () => harness.current().prompt),
      appendReviewRemediationSteps: (live: Task, info: ReturnType<typeof reviseInfo>, options: any) =>
        appendReviewRemediationSteps({
          store: harness.store as any,
          readTaskArtifact: vi.fn(async () => harness.current().prompt),
          sendTaskBackForFix: harness.sendTaskBackForFix,
        }, live, info, options),
      workflowLifecycleMovesInFlight: new Set<string>(),
      sendTaskBackForFix: harness.sendTaskBackForFix,
    };

    await expect(requestPreMergeOptionalStepFix(
      requestDeps as any,
      task.id,
      task,
      reviseInfo(),
    )).resolves.toBe(true);
    expect(harness.current().log.filter((entry) => entry.action.includes("named remediation"))).toHaveLength(2);
    expect(routeReviewConvergenceLadderMock).not.toHaveBeenCalled();

    const unchanged = namedRemediationTask({
      log: harness.current().log,
      workflowStepResults: [{ ...currentResult, priorAttempts: [{ ...prior, reviewInputFingerprint: "review-input-2" }] }],
    });
    const unchangedDeps = remediationDeps(unchanged);
    routeReviewConvergenceLadderMock.mockClear();
    await expect(requestPreMergeOptionalStepFix(
      unchangedDeps.deps as any,
      unchanged.id,
      unchanged as any,
      reviseInfo(),
    )).resolves.toBe(false);
    expect(routeReviewConvergenceLadderMock).toHaveBeenCalledWith(
      expect.anything(),
      unchanged.id,
      expect.objectContaining({ kind: "repeat-unchanged" }),
    );
    expect(unchangedDeps.appendReviewRemediationSteps).not.toHaveBeenCalled();
  });

  it("resolves the workflow WIP lane instead of assuming the legacy column id", async () => {
    const ir = {
      version: "v2" as const,
      name: "renamed-wip",
      columns: [
        { id: "repair-lane", name: "Repair", traits: [{ trait: "wip" }] },
        { id: "review-lane", name: "Review", traits: [{ trait: "review" }] },
      ],
      nodes: [{ id: "start", kind: "start" as const }, { id: "end", kind: "end" as const }],
      edges: [{ from: "start", to: "end" }],
    };
    const store = {
      getTaskWorkflowSelection: vi.fn(() => ({ workflowId: "wf-renamed", stepIds: [] })),
      getTaskWorkflowSelectionAsync: vi.fn(async () => ({ workflowId: "wf-renamed", stepIds: [] })),
      getWorkflowDefinition: vi.fn(async () => ({ ir })),
    };

    await expect(resolveWipTargetForTask(store as any, "FN-288-NAMED")).resolves.toBe("repair-lane");
  });
});
