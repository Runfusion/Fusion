import { beforeEach, describe, expect, it, vi } from "vitest";
import { getBuiltinWorkflow, type Task, type TaskDetail } from "@fusion/core";

import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import { ProjectEngine } from "../project-engine.js";
import { SelfHealingManager } from "../self-healing.js";
import { createWorkflowColumnBoundary } from "../workflows/workflow-column-boundary.js";
import { rerouteSingularStaleContentToReview } from "../merge/stale-content-review-reroute.js";
import { createMockStore, resetExecutorMocks } from "./executor-test-helpers.js";

const run = vi.hoisted(() => vi.fn());
vi.mock("../workflows/workflow-graph-task-runner.js", () => ({
  WorkflowGraphTaskRunner: class {
    run = run;
  },
}));

import { executeWorkflowGraph } from "../executor/execute-workflow-graph.js";

const task = {
  id: "FN-9243",
  column: "in-review",
  autoMerge: true,
  steps: [],
  workflowStepResults: [{ workflowStepId: "plan-review", status: "passed", reviewKind: "plan" }],
  enabledWorkflowSteps: ["security-review", "code-review"],
} as TaskDetail;

function deps(transitions: ReturnType<typeof vi.fn>, handleGraphFailure: ReturnType<typeof vi.fn>) {
  const noop = vi.fn();
  const store = {
    getSettings: vi.fn(async () => ({})),
    getTaskWorkflowSelection: vi.fn(() => ({ workflowId: "builtin:coding", stepIds: [] })),
    getTask: vi.fn(async () => task),
    listWorkflowWorkItemsForTask: vi.fn(async () => [{ id: "continuation-1", taskId: task.id, nodeId: "security-review", kind: "task", state: "running", leaseOwner: "executor:FN-9243" }]),
    transitionWorkflowWorkItem: transitions,
  };
  return {
    store,
    options: {},
    activeWorkflowGraphAbortControllers: new Map(), userCanceledTaskIds: new Set(), clearPausedAborted: noop,
    workflowAgentCapacity: {} as any, activeWorkflowAuthorities: new Map(), activeWorkflowPrincipals: new Map(), graphColumnAgentResolver: new Map(),
    graphExecuteSelfRequeued: new Set(), graphRethinkNarrations: new Map(), graphRouting: new Set(), graphSeamGoverningNodeId: new Map(), graphSeamSkillName: new Map(), graphSeamThinkingLevel: new Map(), graphStepActiveContext: new Map(), graphStepRunOnce: new Map(), graphStepSessionPinned: new Set(), graphToolFailureRunCursors: new Map(), graphUnattendedRuns: new Set(), workflowGateActivityPrincipals: new Map(), outerConcurrencyClaims: new Set(), processWideGraphRouting: new Set(),
    getRunContextFor: () => undefined, advanceNoMergeWorkflowToCompleteColumn: noop, applyGraphRethinkReset: noop, buildBranchPersistence: noop, buildCodeNodeRunner: noop, buildColumnBoundaryHooks: noop, buildForeachWorktreeDeps: noop, buildParseStepsDeps: noop, buildStepInstancePersistence: noop, createAuthoritativeWorkflowPrimitives: noop, createAuthoritativeWorkflowSeams: noop, finalizeMergeConfirmedWorkflowGraphTask: noop, handleGraphFailure,
    isLiveSharedBranchGroupMember: async () => false, prepareGraphNodeExecution: noop, readTaskArtifact: async () => "artifact", recoverMissingRequiredArtifacts: noop, requestPreMergeOptionalStepFix: noop, completePlanReviewNoOp: noop, holdPlanReviewNoOpContinuation: noop, runGraphCustomNode: noop, terminateAllChildren: noop,
  } as any;
}

/*
FNXC:PreMergeApproval 2026-09-02-11:05:
FN-9243 requires production owners—not helper-only seams—to re-seed an enabled review gate with no
result row while preserving the merge refusal until that real gate returns a verdict. The same wedge
must prove self-healing suppresses its doomed merge enqueue, merge admission schedules the producer,
and stale-content re-entry stays in review when its authored gate is in WIP.
*/
const codingIr = getBuiltinWorkflow("builtin:coding")!.ir;

function resultlessReviewTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-9243-resultless",
    title: "Resultless review gate",
    description: "",
    column: "in-review",
    status: null,
    autoMerge: true,
    worktree: "/tmp/fn-9243-resultless",
    dependencies: [],
    steps: [{ name: "Implement", status: "done" }],
    currentStep: 0,
    log: [],
    enabledWorkflowSteps: ["code-review"],
    workflowStepResults: [{ workflowStepId: "plan-review", status: "passed", reviewKind: "plan" }],
    createdAt: "2026-09-03T00:00:00.000Z",
    updatedAt: "2026-09-03T00:00:00.000Z",
    ...overrides,
  } as Task;
}

function recoveryStore(task: Task) {
  const seedWorkspaceCodeReviewContinuationIfIdle = vi.fn(async () => ({ seeded: true }));
  return {
    getTask: vi.fn(async () => task),
    getSettings: vi.fn(async () => ({ autoMerge: true })),
    getTaskWorkflowSelection: vi.fn(() => ({ workflowId: "builtin:coding", stepIds: ["code-review"] })),
    getTaskWorkflowSelectionAsync: vi.fn(async () => ({ workflowId: "builtin:coding", stepIds: ["code-review"] })),
    getWorkflowDefinition: vi.fn(async () => ({ ir: codingIr })),
    listWorkflowDefinitions: vi.fn(async () => [{ ir: codingIr }]),
    listWorkflowWorkItemsForTask: vi.fn(async () => []),
    seedWorkspaceCodeReviewContinuationIfIdle,
    listTasks: vi.fn(async (options?: { column?: string }) => options?.column === "in-review" ? [task] : []),
    logEntry: vi.fn(async () => undefined),
    recordRunAuditEvent: vi.fn(async () => undefined),
    getCompletionHandoffAcceptedMarker: vi.fn(async () => null),
    getAgentLogs: vi.fn(async () => []),
  } as any;
}

describe("unrun pre-merge gate wedge regression", () => {
  beforeEach(() => resetExecutorMocks());

  it("re-seeds the resultless review-lane fixture through the graph-failure production sink", async () => {
    const live = resultlessReviewTask();
    const store = Object.assign(createMockStore(), recoveryStore(live));
    store.getTask.mockResolvedValue(live);
    const executor = new TaskExecutor(store, "/tmp/fn-9243-resultless");
    vi.spyOn(executor as any, "routeRetryableRemediationGraphFailureToPreMergeFix").mockResolvedValue(false);
    vi.spyOn(executor as any, "routeGraphFailureToExecutionResume").mockResolvedValue(false);

    await (executor as any).handleGraphFailure(live, {
      disposition: "failed", outcome: "failure", reason: "remediation-not-scheduled", visitedNodeIds: ["code-review"], context: { "node:code-review:outcome": "failure", "node:code-review:value": "remediation-not-scheduled" },
    });

    expect(store.seedWorkspaceCodeReviewContinuationIfIdle).toHaveBeenCalledWith(expect.objectContaining({
      taskId: live.id, nodeId: "code-review", state: "runnable", sourceColumn: "in-review",
    }));
    expect(store.logEntry).toHaveBeenCalledWith(live.id, expect.stringContaining("re-seeded at unrun pre-merge gate"), undefined, undefined);
  });

  it("uses the self-healing production sweep to seed an unrun gate and suppress merge enqueue", async () => {
    const live = resultlessReviewTask();
    const store = recoveryStore(live);
    const enqueueMerge = vi.fn(async () => undefined);

    await new SelfHealingManager(store, { rootDir: "/tmp/fn-9243-resultless", enqueueMerge } as any)
      .recoverMergeableReviewTasks();

    expect(store.seedWorkspaceCodeReviewContinuationIfIdle).toHaveBeenCalledWith(expect.objectContaining({ taskId: live.id, nodeId: "code-review" }));
    expect(enqueueMerge).not.toHaveBeenCalled();
  });

  it("uses merge admission to schedule the producer while retaining its blocker", async () => {
    const live = resultlessReviewTask();
    const store = recoveryStore(live);
    const engine = new ProjectEngine({ projectId: "fn-9243", workingDirectory: "/tmp/fn-9243-resultless", isolationMode: "in-process", maxConcurrent: 1, maxWorktrees: 1 } as any, { on: vi.fn(), off: vi.fn() } as any, { skipNotifier: true });

    const blocker = await (engine as any).resolveMergeGateBlocker(store, live, { autoMerge: true });

    expect(blocker).toBe("task has enabled pre-merge workflow steps that never ran");
    expect(store.seedWorkspaceCodeReviewContinuationIfIdle).toHaveBeenCalledWith(expect.objectContaining({ taskId: live.id, nodeId: "code-review" }));
  });

  it("lets the shipped stale-content reroute enter its WIP review gate in place", async () => {
    const live = resultlessReviewTask({ workflowStepResults: [{ workflowStepId: "code-review", status: "passed", reviewInputFingerprint: "stale" }] });
    const store = recoveryStore(live);
    const securityGate = { id: "security-review", kind: "optional-group", column: "in-progress", config: { name: "Security Review" } } as any;
    store.getTaskWorkflowSelection.mockReturnValue({ workflowId: "custom", stepIds: ["security-review"] });
    store.getWorkflowDefinition.mockResolvedValue({ ir: { ...codingIr, name: "custom", nodes: [securityGate] } });
    await rerouteSingularStaleContentToReview(store, live, {
      requiredPreMergeStepIds: new Set(["security-review"]), mergeContent: { kind: "singular", diff: { state: "fingerprint", fingerprint: "current" } } as any,
    });
    const moveTask = vi.fn(async () => undefined);
    const boundary = createWorkflowColumnBoundary({ taskId: live.id, workflowId: "custom", ir: { ...codingIr, name: "custom", nodes: [securityGate], columns: [{ id: "in-progress", name: "WIP", traits: [{ trait: "wip" }] }, { id: "in-review", name: "Review", traits: [{ trait: "human-review" }, { trait: "merge-blocker" }] }] }, initialColumn: "in-review", moveTask });

    await expect(boundary.onNodeEntry(securityGate)).resolves.toEqual({ kind: "entered" });
    expect(moveTask).not.toHaveBeenCalled();
    expect(boundary.currentColumn()).toBe("in-review");
  });

  it("closes a fell-back dispatched continuation before handing the failure to recovery", async () => {
    run.mockResolvedValueOnce({ disposition: "fell-back", outcome: "failure", reason: "interpreter-error: Cannot move", visitedNodeIds: [] });
    const transitions = vi.fn(async (id: string, state: string, patch: object) => ({ id, state, ...patch }));
    const handleGraphFailure = vi.fn(async () => undefined);

    await executeWorkflowGraph(deps(transitions, handleGraphFailure), task, { alreadyClaimed: true });

    expect(run).toHaveBeenCalledTimes(1);
    expect(transitions).toHaveBeenCalledWith("continuation-1", "failed", {
      leaseOwner: null, leaseExpiresAt: null, lastError: "workflow-continuation-failed",
    });
    expect(handleGraphFailure).toHaveBeenCalledWith(task, expect.objectContaining({ disposition: "failed", reason: "interpreter-error: Cannot move" }));
  });
});
