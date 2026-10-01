import { describe, expect, it, vi } from "vitest";
import { MERGE_BOUNDARY_RECOVERY_VALUE, MERGE_BOUNDARY_UNPROVEN_VALUE, classifyMergePrimitiveResult, runWorkflowMergeAttemptNode } from "../workflows/workflow-merge-nodes.js";
import { graphFailureValue, isMergeGraphFailure } from "../executor/graph-failure-pure.js";
import { isTerminalMergeGraphFailureValue } from "../executor/task-predicates.js";
import { routeGraphMergeFailureToRetry } from "../executor/route-graph-merge-failure-to-retry.js";
import { routeGraphFailureToExecutionResume } from "../executor/route-graph-failure-to-execution-resume.js";
import { MERGE_BOUNDARY_UNPROVEN_AUDIT_EMIT_TIMEOUT_MS } from "../executor/emit-merge-boundary-unproven-audit.js";
import { shouldHoldActiveFileScopeLease } from "../scheduler.js";

const task = { id: "FN-9157", column: "in-review", steps: [], dependencies: [], log: [], createdAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-08-20T00:00:00.000Z", title: "t", description: "", prompt: "# t" } as any;
const graphResult = (nodeId = "merge") => ({ visitedNodeIds: [nodeId], context: { [`node:${nodeId}:value`]: MERGE_BOUNDARY_UNPROVEN_VALUE } }) as any;

describe("merge-boundary proof routing", () => {
  it("preserves the typed recovery value before failed-data classification", () => {
    expect(classifyMergePrimitiveResult(undefined, MERGE_BOUNDARY_RECOVERY_VALUE, "failure")).toEqual({ outcome: "failure", value: MERGE_BOUNDARY_RECOVERY_VALUE });
    expect(classifyMergePrimitiveResult({ status: "failed", reason: MERGE_BOUNDARY_RECOVERY_VALUE } as any, MERGE_BOUNDARY_RECOVERY_VALUE, "failure")).toEqual({ outcome: "failure", value: MERGE_BOUNDARY_RECOVERY_VALUE });
    // Legacy terminal rows remain fail-closed until self-healing can prove an owner.
    expect(classifyMergePrimitiveResult(undefined, MERGE_BOUNDARY_UNPROVEN_VALUE, "failure")).toEqual({ outcome: "failure", value: MERGE_BOUNDARY_UNPROVEN_VALUE });
  });

  it("keeps recovery typed on direct merge-attempt dispatch while legacy stranded values stay terminal", async () => {
    const output = await runWorkflowMergeAttemptNode({ primitives: {
      requestMerge: vi.fn().mockResolvedValue({ outcome: "failure", value: MERGE_BOUNDARY_RECOVERY_VALUE }),
      audit: vi.fn(),
    } }, {} as any, task);
    expect(output).toMatchObject({ outcome: "failure", value: MERGE_BOUNDARY_RECOVERY_VALUE });
    expect(graphFailureValue({ visitedNodeIds: ["merge"], context: { "node:merge:value": MERGE_BOUNDARY_RECOVERY_VALUE } } as any)).toBe(MERGE_BOUNDARY_RECOVERY_VALUE);
    expect(graphFailureValue(graphResult("merge-attempt"))).toBe(MERGE_BOUNDARY_UNPROVEN_VALUE);
    expect(isMergeGraphFailure("merge")).toBe(true);
    expect(isMergeGraphFailure("merge-attempt")).toBe(true);
    expect(isTerminalMergeGraphFailureValue(MERGE_BOUNDARY_UNPROVEN_VALUE)).toBe(true);
  });

  it("parks an unprovable retry once without requesting merge and keeps its worktree-backed lease", async () => {
    const live = { ...task, worktree: "/worktree", status: undefined };
    const updateTask = vi.fn(async (_id, patch) => ({ ...live, ...patch }));
    const updateTaskAtomic = vi.fn(async (id, reducer, context) => {
      const patch = reducer(live);
      return patch ? updateTask(id, patch, context) : live;
    });
    const logEntry = vi.fn();
    const mergeRequester = vi.fn();
    const handled = await routeGraphMergeFailureToRetry({
      store: { updateTask, updateTaskAtomic, logEntry } as any,
      getRunContextFor: () => undefined,
      mergeRequester,
      ensureWorkflowMergeBoundaryTask: vi.fn().mockResolvedValue({ task: live, blocked: { reason: "no pre-merge node result recorded", code: "no-node-result", missingInstanceCount: 0, evidence: { code: "no-node-result", missingInstanceIds: [] } } }),
      persistTokenUsage: vi.fn(),
    }, live, graphResult(), undefined);
    expect(handled).toBe(true);
    expect(mergeRequester).not.toHaveBeenCalled();
    expect(updateTask).toHaveBeenCalledWith("FN-9157", expect.objectContaining({ status: "failed", error: expect.stringContaining("MERGE_BOUNDARY_UNPROVEN:") }), undefined);
    expect(logEntry).toHaveBeenCalledWith("FN-9157", expect.stringContaining("retry parked task"), undefined, undefined);
    expect(shouldHoldActiveFileScopeLease({ ...live, status: "failed" }, [])).toBe(true);
    expect(shouldHoldActiveFileScopeLease({ ...live, status: "failed", worktree: undefined }, [])).toBe(false);
  });

  it("routes a retry boundary evidence gap through the shared implementation recovery before terminal parking", async () => {
    const live = { ...task, status: undefined, steps: [{ status: "pending" }] };
    const routeGraphFailureToExecutionResume = vi.fn().mockResolvedValue(true);
    const updateTask = vi.fn();
    await expect(routeGraphMergeFailureToRetry({
      store: { updateTask, updateTaskAtomic: vi.fn(), logEntry: vi.fn() } as any,
      getRunContextFor: () => undefined,
      mergeRequester: vi.fn(),
      routeGraphFailureToExecutionResume,
      ensureWorkflowMergeBoundaryTask: vi.fn().mockResolvedValue({ task: live, blocked: { reason: "no pre-merge node result recorded", code: "no-node-result", missingInstanceCount: 0, evidence: { code: "no-node-result", missingInstanceIds: [] } } }),
      persistTokenUsage: vi.fn(),
    }, live, graphResult(), undefined)).resolves.toBe(true);
    expect(routeGraphFailureToExecutionResume).toHaveBeenCalledWith(
      live,
      "merge",
      MERGE_BOUNDARY_RECOVERY_VALUE,
      undefined,
      { code: "no-node-result", missingInstanceIds: [] },
    );
    expect(updateTask).not.toHaveBeenCalled();
  });

  it("keeps an auto-merge-off retry boundary under human control without seeding or moving recovery", async () => {
    let current = { ...task, status: undefined, autoMerge: false, steps: [{ status: "pending" }] };
    const moveTask = vi.fn();
    const replaceActiveTaskWorkflowContinuation = vi.fn();
    const updateTaskAtomic = vi.fn(async (_id, reducer) => {
      const patch = reducer(current);
      if (patch) current = { ...current, ...patch };
      return current;
    });
    const store = {
      moveTask, updateTaskAtomic, logEntry: vi.fn(), getSettings: vi.fn().mockResolvedValue({ autoMerge: false }),
      replaceActiveTaskWorkflowContinuation, getTaskWorkflowSelection: () => ({ workflowId: "custom:recovery", stepIds: [] }),
    } as any;
    const recoveryDeps = {
      store, getRunContextFor: () => undefined,
      resolveResumeLanes: vi.fn().mockResolvedValue({ hold: "todo", wip: "building", review: "in-review", wipDeclared: true }),
      isLiveSharedBranchGroupMember: vi.fn().mockResolvedValue(false),
      clearTerminalStepFailuresForRetry: vi.fn(), persistTokenUsage: vi.fn(), isRemediationGraphNode: vi.fn(),
    };

    await expect(routeGraphMergeFailureToRetry({
      store, getRunContextFor: () => undefined, mergeRequester: vi.fn(), persistTokenUsage: vi.fn(),
      routeGraphFailureToExecutionResume: (live, node, value, memo, evidence) => routeGraphFailureToExecutionResume(recoveryDeps, live, node, value, memo, evidence),
      ensureWorkflowMergeBoundaryTask: vi.fn().mockResolvedValue({ task: current, blocked: { reason: "no pre-merge node result recorded", code: "no-node-result", missingInstanceCount: 0, evidence: { code: "no-node-result", missingInstanceIds: [] } } }),
    }, current, graphResult(), undefined)).resolves.toBe(true);

    expect(replaceActiveTaskWorkflowContinuation).not.toHaveBeenCalled();
    expect(moveTask).not.toHaveBeenCalled();
    expect(updateTaskAtomic).not.toHaveBeenCalled();
    expect(current.status).toBeUndefined();
    expect(current.error).toBeUndefined();
  });

  it("leaves a newly enabled auto-merge human-control hold unchanged after recovery declines", async () => {
    let current = {
      ...task,
      status: undefined,
      error: undefined,
      autoMerge: true,
      column: "in-review",
      columnMovedAt: "2026-09-21T11:22:00.000Z",
    };
    const continuation = { taskId: current.id, nodeId: "implement", state: "active" };
    const updateTaskAtomic = vi.fn(async (_id, reducer) => {
      const patch = reducer(current);
      if (patch) current = { ...current, ...patch };
      return current;
    });
    const replaceActiveTaskWorkflowContinuation = vi.fn();
    const routeGraphFailureToExecutionResume = vi.fn(async () => {
      // The recovery claim began while auto-merge was enabled; the operator wins before its refusal returns.
      current = { ...current, autoMerge: false };
      return false;
    });
    const store = {
      getTask: vi.fn(async () => current),
      getSettings: vi.fn(async () => ({ autoMerge: true })),
      updateTaskAtomic,
      replaceActiveTaskWorkflowContinuation,
      logEntry: vi.fn(),
    } as any;

    await expect(routeGraphMergeFailureToRetry({
      store,
      getRunContextFor: () => undefined,
      mergeRequester: vi.fn(),
      persistTokenUsage: vi.fn(),
      routeGraphFailureToExecutionResume,
      ensureWorkflowMergeBoundaryTask: vi.fn().mockResolvedValue({
        task: current,
        blocked: {
          reason: "no pre-merge node result recorded",
          code: "no-node-result",
          missingInstanceCount: 0,
          evidence: { code: "no-node-result", missingInstanceIds: [] },
        },
      }),
    }, current, graphResult(), undefined)).resolves.toBe(true);

    expect(routeGraphFailureToExecutionResume).toHaveBeenCalledOnce();
    expect(current).toMatchObject({ column: "in-review", status: undefined, error: undefined, autoMerge: false });
    expect(continuation).toEqual({ taskId: "FN-9157", nodeId: "implement", state: "active" });
    expect(replaceActiveTaskWorkflowContinuation).not.toHaveBeenCalled();
    expect(updateTaskAtomic).not.toHaveBeenCalled();
  });

  it("emits redacted audit metadata for parked and already-terminal retry boundaries", async () => {
    const live = { ...task, status: undefined };
    const updateTask = vi.fn(async (_id, patch) => ({ ...live, ...patch }));
    const updateTaskAtomic = vi.fn(async (id, reducer, context) => {
      const patch = reducer(live);
      return patch ? updateTask(id, patch, context) : live;
    });
    const recordRunAuditEvent = vi.fn().mockResolvedValue(undefined);
    const base = {
      store: { updateTask, updateTaskAtomic, logEntry: vi.fn(), recordRunAuditEvent } as any,
      getRunContextFor: () => undefined,
      mergeRequester: vi.fn(),
      persistTokenUsage: vi.fn(),
      routeGraphFailureToExecutionResume: vi.fn().mockResolvedValue(false),
    };
    await expect(routeGraphMergeFailureToRetry({
      ...base,
      ensureWorkflowMergeBoundaryTask: vi.fn().mockResolvedValue({ task: live, blocked: { reason: "foreach step instances incomplete at merge boundary: missing secret-a, secret-b", code: "missing-foreach-instances", missingInstanceCount: 2 } }),
    }, live, graphResult(), undefined)).resolves.toBe(true);
    expect(recordRunAuditEvent).toHaveBeenCalledTimes(1);
    expect(recordRunAuditEvent).toHaveBeenLastCalledWith(expect.objectContaining({
      mutationType: "task:merge-boundary-unproven-parked", target: "FN-9157",
      metadata: expect.objectContaining({ taskId: "FN-9157", source: "retry-boundary", reasonCode: "missing-foreach-instances", missingInstanceCount: 2, outcome: "parked" }),
    }));
    expect(JSON.stringify(recordRunAuditEvent.mock.calls[0][0].metadata)).not.toContain("secret-a");

    const terminal = { ...live, status: "failed", error: "existing" };
    updateTaskAtomic.mockImplementation(async (id, reducer, context) => {
      const patch = reducer(terminal);
      return patch ? updateTask(id, patch, context) : terminal;
    });
    await expect(routeGraphMergeFailureToRetry({
      ...base,
      ensureWorkflowMergeBoundaryTask: vi.fn().mockResolvedValue({ task: terminal, blocked: { reason: "no pre-merge node result recorded", code: "no-node-result", missingInstanceCount: 0, evidence: { code: "no-node-result", missingInstanceIds: [] } } }),
    }, terminal, graphResult(), undefined)).resolves.toBe(true);
    expect(recordRunAuditEvent.mock.calls[1][0].metadata.outcome).toBe("already-terminal");
    expect(updateTask).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["absent", undefined],
    ["rejects", vi.fn().mockRejectedValue(new Error("audit sink down"))],
    ["throws", vi.fn(() => { throw new Error("audit sink boom"); })],
  ])("keeps the terminal park intact when the audit sink %s", async (_name, recordRunAuditEvent) => {
    const live = { ...task, status: undefined };
    const updateTask = vi.fn(async (_id, patch) => ({ ...live, ...patch }));
    const updateTaskAtomic = vi.fn(async (id, reducer, context) => {
      const patch = reducer(live);
      return patch ? updateTask(id, patch, context) : live;
    });
    const persistTokenUsage = vi.fn();
    await expect(routeGraphMergeFailureToRetry({
      store: { updateTask, updateTaskAtomic, logEntry: vi.fn(), recordRunAuditEvent } as any,
      getRunContextFor: () => undefined,
      mergeRequester: vi.fn(),
      ensureWorkflowMergeBoundaryTask: vi.fn().mockResolvedValue({ task: live, blocked: { reason: "no pre-merge node result recorded", code: "no-node-result", missingInstanceCount: 0, evidence: { code: "no-node-result", missingInstanceIds: [] } } }),
      persistTokenUsage,
    }, live, graphResult(), undefined)).resolves.toBe(true);
    expect(updateTask).toHaveBeenCalledWith("FN-9157", expect.objectContaining({ status: "failed", error: expect.stringContaining("MERGE_BOUNDARY_UNPROVEN:") }), undefined);
    expect(persistTokenUsage).toHaveBeenCalledWith("FN-9157");
  });

  it("bounds a hung audit sink without skipping token usage", async () => {
    vi.useFakeTimers();
    try {
      const live = { ...task, status: undefined };
      const updateTask = vi.fn(async (_id, patch) => ({ ...live, ...patch }));
      const updateTaskAtomic = vi.fn(async (id, reducer, context) => {
        const patch = reducer(live);
        return patch ? updateTask(id, patch, context) : live;
      });
      const persistTokenUsage = vi.fn();
      const handled = routeGraphMergeFailureToRetry({
        store: { updateTask, updateTaskAtomic, logEntry: vi.fn(), recordRunAuditEvent: vi.fn(() => new Promise<void>(() => {})) } as any,
        getRunContextFor: () => undefined,
        mergeRequester: vi.fn(),
        ensureWorkflowMergeBoundaryTask: vi.fn().mockResolvedValue({ task: live, blocked: { reason: "no pre-merge node result recorded", code: "no-node-result", missingInstanceCount: 0, evidence: { code: "no-node-result", missingInstanceIds: [] } } }),
        persistTokenUsage,
      }, live, graphResult(), undefined);
      let settled = false;
      void handled.then(() => { settled = true; });
      await Promise.resolve();
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(MERGE_BOUNDARY_UNPROVEN_AUDIT_EMIT_TIMEOUT_MS);
      await expect(handled).resolves.toBe(true);
      expect(persistTokenUsage).toHaveBeenCalledWith("FN-9157");
      expect(updateTask).toHaveBeenCalledWith("FN-9157", expect.objectContaining({ error: expect.stringContaining("MERGE_BOUNDARY_UNPROVEN:") }), undefined);
    } finally {
      vi.useRealTimers();
    }
  });
});
