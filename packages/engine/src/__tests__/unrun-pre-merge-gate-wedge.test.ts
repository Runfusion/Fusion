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
    updateTaskAtomic: vi.fn(async (_id: string, reduce: (t: Task) => Partial<Task> | null) => { const patch = reduce(task); if (patch) Object.assign(task, patch); return task; }),
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

  it.each([false, true])("recovers a failed unrun gate after engine stall pause=%s without merging", async (paused) => {
    const live = resultlessReviewTask({ status: "failed", paused, workflowIrPin: "old-ir", workflowIrPinNodeId: "merge",
      pausedReason: paused ? "in-review-stall-deadlock" : undefined,
      error: "AUTO_MERGE_RETRY_REJECTED: Cannot merge FN-9243-resultless: task has enabled pre-merge workflow steps that never ran" });
    const store = recoveryStore(live);
    const enqueueMerge = vi.fn();
    await new SelfHealingManager(store, { rootDir: "/tmp/fn-9243-resultless", enqueueMerge } as any).recoverMergeableReviewTasks();
    expect(store.seedWorkspaceCodeReviewContinuationIfIdle).toHaveBeenCalledWith(expect.objectContaining({ nodeId: "code-review" }));
    expect(live).toMatchObject({ status: null, error: null, paused: false, column: "in-review", workflowIrPin: null, workflowIrPinNodeId: null });
    expect(enqueueMerge).not.toHaveBeenCalled();
  });

  it("reclassifies against a workflow selected after the failed-park claim", async () => {
    const live = resultlessReviewTask({
      status: "failed",
      enabledWorkflowSteps: ["code-review", "security-review"],
      error: "task has enabled pre-merge workflow steps that never ran",
    });
    const store = recoveryStore(live);
    const replacementIr = {
      ...codingIr,
      name: "replacement-review-workflow",
      nodes: codingIr.nodes.map((node) => node.id === "code-review" ? { ...node, id: "security-review" } : node),
    };
    let selection = { workflowId: "old-review-workflow", stepIds: ["code-review"] };
    store.getTaskWorkflowSelection.mockImplementation(() => selection);
    store.getTaskWorkflowSelectionAsync.mockImplementation(async () => selection);
    store.getWorkflowDefinition.mockImplementation(async (workflowId: string) => ({
      id: workflowId,
      ir: workflowId === "replacement-review-workflow" ? replacementIr : codingIr,
    }));
    store.listWorkflowDefinitions.mockResolvedValue([
      { id: "old-review-workflow", ir: codingIr },
      { id: "replacement-review-workflow", ir: replacementIr },
    ]);
    store.updateTaskAtomic.mockImplementation(async (_id: string, reduce: (task: Task) => Partial<Task> | null) => {
      const patch = reduce(live);
      if (patch) Object.assign(live, patch);
      selection = { workflowId: "replacement-review-workflow", stepIds: ["security-review"] };
      return live;
    });

    await new SelfHealingManager(store, { rootDir: "/tmp/fn-9243-resultless" }).recoverMergeableReviewTasks();

    expect(live).toMatchObject({ status: null, error: null });
    expect(store.seedWorkspaceCodeReviewContinuationIfIdle).toHaveBeenCalledWith(expect.objectContaining({ nodeId: "security-review" }));
    expect(store.seedWorkspaceCodeReviewContinuationIfIdle).not.toHaveBeenCalledWith(expect.objectContaining({ nodeId: "code-review" }));
  });

  it("retains the failed park when selection changes before its continuation seed", async () => {
    const error = "task has enabled pre-merge workflow steps that never ran";
    const live = resultlessReviewTask({ status: "failed", error });
    const store = recoveryStore(live);
    let selection = { workflowId: "old-review-workflow", stepIds: ["code-review"] };
    store.getTaskWorkflowSelection.mockImplementation(() => selection);
    store.getTaskWorkflowSelectionAsync.mockImplementation(async () => selection);
    store.seedWorkspaceCodeReviewContinuationIfIdle.mockImplementation(async (input: { expectedWorkflowSelection?: typeof selection }) => {
      selection = { workflowId: "replacement-review-workflow", stepIds: ["security-review"] };
      return input.expectedWorkflowSelection?.workflowId === selection.workflowId
        ? { seeded: true }
        : { seeded: false, reason: "workflow-selection-changed" };
    });

    await new SelfHealingManager(store, { rootDir: "/tmp/fn-9243-resultless" }).recoverMergeableReviewTasks();

    expect(live).toMatchObject({ status: "failed", error });
    expect(store.seedWorkspaceCodeReviewContinuationIfIdle).toHaveBeenCalledWith(expect.objectContaining({
      nodeId: "code-review",
      expectedWorkflowSelection: { workflowId: "old-review-workflow", stepIds: ["code-review"] },
    }));
  });

  it.each([
    { userPaused: true }, { paused: true, pausedReason: "manual" },
    { deletedAt: "2026-09-01" }, { autoMerge: false }, { error: "unrelated failure" },
  ])("preserves operator holds and unrelated failures: %j", async (hold) => {
    const live = resultlessReviewTask({ status: "failed", error: "task has enabled pre-merge workflow steps that never ran", ...hold });
    const store = recoveryStore(live);
    await new SelfHealingManager(store, { rootDir: "/tmp/fn-9243-resultless" }).recoverMergeableReviewTasks();
    expect(store.updateTaskAtomic).not.toHaveBeenCalled();
    expect(store.seedWorkspaceCodeReviewContinuationIfIdle).not.toHaveBeenCalled();
  });

  it("does not release an unrun-gate park while a continuation owns it", async () => {
    const live = resultlessReviewTask({ status: "failed", error: "task has enabled pre-merge workflow steps that never ran" });
    const store = recoveryStore(live);
    store.listWorkflowWorkItemsForTask.mockResolvedValue([{ state: "running" }]);
    await new SelfHealingManager(store, { rootDir: "/tmp/fn-9243-resultless" }).recoverMergeableReviewTasks();
    expect(store.updateTaskAtomic).not.toHaveBeenCalled();
    expect(store.seedWorkspaceCodeReviewContinuationIfIdle).not.toHaveBeenCalled();
  });

  it("lets an operator pause win the recovery claim race", async () => {
    const live = resultlessReviewTask({ status: "failed", error: "task has enabled pre-merge workflow steps that never ran" });
    const store = recoveryStore(live);
    store.updateTaskAtomic.mockImplementation(async (_id: string, reduce: (t: Task) => unknown) => {
      live.userPaused = true;
      expect(reduce(live)).toBeNull();
      return live;
    });
    await new SelfHealingManager(store, { rootDir: "/tmp/fn-9243-resultless" }).recoverMergeableReviewTasks();
    expect(live.status).toBe("failed");
    expect(store.seedWorkspaceCodeReviewContinuationIfIdle).not.toHaveBeenCalled();
  });

  it("retains a failure when unfinished implementation still blocks the gate", async () => {
    const live = resultlessReviewTask({ status: "failed", error: "task has enabled pre-merge workflow steps that never ran", steps: [{ name: "Implement", status: "pending" }] });
    const store = recoveryStore(live);
    await new SelfHealingManager(store, { rootDir: "/tmp/fn-9243-resultless" }).recoverMergeableReviewTasks();
    expect(store.updateTaskAtomic).not.toHaveBeenCalled();
    expect(store.seedWorkspaceCodeReviewContinuationIfIdle).not.toHaveBeenCalled();
  });

  it("recovers the task in its renamed review lane", async () => {
    const live = resultlessReviewTask({ column: "checking", status: "failed", error: "task has enabled pre-merge workflow steps that never ran" });
    const store = recoveryStore(live);
    const ir = { ...codingIr, columns: codingIr.columns.map((column) => column.id === "in-review" ? { ...column, id: "checking" } : column),
      nodes: codingIr.nodes.map((node) => node.column === "in-review" ? { ...node, column: "checking" } : node) };
    store.getTaskWorkflowSelection.mockReturnValue({ workflowId: "custom-review", stepIds: ["code-review"] });
    store.getTaskWorkflowSelectionAsync.mockResolvedValue({ workflowId: "custom-review", stepIds: ["code-review"] });
    store.getWorkflowDefinition.mockResolvedValue({ id: "custom-review", ir });
    store.listWorkflowDefinitions.mockResolvedValue([{ id: "custom-review", ir }]);
    store.listTasks.mockImplementation(async (options: { column: string }) => options.column === "checking" ? [live] : []);
    await new SelfHealingManager(store, { rootDir: "/tmp/fn-9243-resultless" }).recoverMergeableReviewTasks();
    expect(store.seedWorkspaceCodeReviewContinuationIfIdle).toHaveBeenCalledWith(expect.objectContaining({ nodeId: "code-review", sourceColumn: "checking" }));
    expect(live.column).toBe("checking");
    expect(live.status).toBeNull();
  });

  it("leaves unsupported workspace parks visible", async () => {
    const live = resultlessReviewTask({ status: "failed", error: "task has enabled pre-merge workflow steps that never ran", workspaceWorktrees: {} });
    const store = recoveryStore(live);
    await new SelfHealingManager(store, { rootDir: "/tmp/fn-9243-resultless" }).recoverMergeableReviewTasks();
    expect(store.updateTaskAtomic).not.toHaveBeenCalled();
    expect(live.status).toBe("failed");
  });

  it("continues recovering other cards when one candidate cannot be inspected", async () => {
    const first = resultlessReviewTask({ id: "FN-broken", status: "failed", error: "task has enabled pre-merge workflow steps that never ran" });
    const live = resultlessReviewTask({ status: "failed", error: first.error });
    const store = recoveryStore(live);
    store.listTasks.mockImplementation(async (options: { column: string }) => options.column === "in-review" ? [first, live] : []);
    store.listWorkflowWorkItemsForTask.mockImplementation(async (id: string) => { if (id === first.id) throw new Error("temporary read failure"); return []; });
    await new SelfHealingManager(store, { rootDir: "/tmp/fn-9243-resultless" }).recoverMergeableReviewTasks();
    expect(first.status).toBe("failed");
    expect(live.status).toBeNull();
    expect(store.seedWorkspaceCodeReviewContinuationIfIdle).toHaveBeenCalledWith(expect.objectContaining({ taskId: live.id }));
  });

  it.each([undefined, "still-pinned"])("recovers drift only after the stale pin was cleared: %s", async (workflowIrPin) => {
    const live = resultlessReviewTask({ status: "failed", workflowIrPin,
      error: "Workflow drift park: the workflow definition changed under this run. Stale IR pin cleared — requeue the task." });
    const store = recoveryStore(live);
    await new SelfHealingManager(store, { rootDir: "/tmp/fn-9243-resultless" }).recoverMergeableReviewTasks();
    expect(store.seedWorkspaceCodeReviewContinuationIfIdle).toHaveBeenCalledTimes(workflowIrPin ? 0 : 1);
    expect(live.status).toBe(workflowIrPin ? "failed" : null);
  });

  it("uses merge admission to schedule the producer while retaining its blocker", async () => {
    const live = resultlessReviewTask();
    const store = recoveryStore(live);
    const engine = new ProjectEngine({ projectId: "fn-9243", workingDirectory: "/tmp/fn-9243-resultless", isolationMode: "in-process", maxConcurrent: 1, maxWorktrees: 1 } as any, { on: vi.fn(), off: vi.fn() } as any, { skipNotifier: true });
    /*
    FNXC:NoVerdictReviewRecovery 2026-09-24-04:54:
    Merge admission now probes no-verdict recovery before checking the pre-existing unrun-gate
    fixture. This isolated admission seam has no started runtime, so state the intended idle-queue
    condition explicitly instead of letting an uninitialized TaskStore hide the producer assertion.
    */
    vi.spyOn(engine, "isMergePending").mockResolvedValue(false);
    vi.spyOn(engine, "rerouteFailedNoVerdictPreMergeReview").mockResolvedValue("not-applicable");

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
