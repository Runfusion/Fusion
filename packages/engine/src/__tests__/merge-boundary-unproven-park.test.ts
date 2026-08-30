import { describe, expect, it, vi } from "vitest";
import { MERGE_BOUNDARY_UNPROVEN_VALUE, classifyMergePrimitiveResult, runWorkflowMergeAttemptNode } from "../workflows/workflow-merge-nodes.js";
import { graphFailureValue, isMergeGraphFailure } from "../executor/graph-failure-pure.js";
import { isTerminalMergeGraphFailureValue } from "../executor/task-predicates.js";
import { routeGraphMergeFailureToRetry } from "../executor/route-graph-merge-failure-to-retry.js";
import { MERGE_BOUNDARY_UNPROVEN_AUDIT_EMIT_TIMEOUT_MS } from "../executor/emit-merge-boundary-unproven-audit.js";
import { shouldHoldActiveFileScopeLease } from "../scheduler.js";

const task = { id: "FN-9157", column: "in-review", steps: [], dependencies: [], log: [], createdAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-08-20T00:00:00.000Z", title: "t", description: "", prompt: "# t" } as any;
const graphResult = (nodeId = "merge") => ({ visitedNodeIds: [nodeId], context: { [`node:${nodeId}:value`]: MERGE_BOUNDARY_UNPROVEN_VALUE } }) as any;

describe("FN-9157 merge-boundary-unproven terminal routing", () => {
  it("preserves the explicit terminal value before failed-data classification", () => {
    expect(classifyMergePrimitiveResult(undefined, MERGE_BOUNDARY_UNPROVEN_VALUE, "failure")).toEqual({ outcome: "failure", value: MERGE_BOUNDARY_UNPROVEN_VALUE });
    expect(classifyMergePrimitiveResult({ status: "failed", reason: MERGE_BOUNDARY_UNPROVEN_VALUE } as any, MERGE_BOUNDARY_UNPROVEN_VALUE, "failure")).toEqual({ outcome: "failure", value: MERGE_BOUNDARY_UNPROVEN_VALUE });
  });

  it("keeps the value on direct merge-attempt dispatch and both graph context ids", async () => {
    const output = await runWorkflowMergeAttemptNode({ primitives: {
      requestMerge: vi.fn().mockResolvedValue({ outcome: "failure", value: MERGE_BOUNDARY_UNPROVEN_VALUE }),
      audit: vi.fn(),
    } }, {} as any, task);
    expect(output).toMatchObject({ outcome: "failure", value: MERGE_BOUNDARY_UNPROVEN_VALUE });
    expect(graphFailureValue(graphResult("merge"))).toBe(MERGE_BOUNDARY_UNPROVEN_VALUE);
    expect(graphFailureValue(graphResult("merge-attempt"))).toBe(MERGE_BOUNDARY_UNPROVEN_VALUE);
    expect(isMergeGraphFailure("merge")).toBe(true);
    expect(isMergeGraphFailure("merge-attempt")).toBe(true);
    expect(isTerminalMergeGraphFailureValue(MERGE_BOUNDARY_UNPROVEN_VALUE)).toBe(true);
  });

  it("parks an unprovable retry once without requesting merge and keeps its worktree-backed lease", async () => {
    const live = { ...task, worktree: "/worktree", status: undefined };
    const updateTask = vi.fn(async (_id, patch) => ({ ...live, ...patch }));
    const logEntry = vi.fn();
    const mergeRequester = vi.fn();
    const handled = await routeGraphMergeFailureToRetry({
      store: { updateTask, logEntry } as any,
      getRunContextFor: () => undefined,
      mergeRequester,
      ensureWorkflowMergeBoundaryTask: vi.fn().mockResolvedValue({ task: live, blocked: { reason: "no pre-merge node result recorded", code: "no-node-result", missingInstanceCount: 0 } }),
      persistTokenUsage: vi.fn(),
    }, live, graphResult(), undefined);
    expect(handled).toBe(true);
    expect(mergeRequester).not.toHaveBeenCalled();
    expect(updateTask).toHaveBeenCalledWith("FN-9157", expect.objectContaining({ status: "failed", error: expect.stringContaining("MERGE_BOUNDARY_UNPROVEN:") }), undefined);
    expect(logEntry).toHaveBeenCalledWith("FN-9157", expect.stringContaining("retry parked task"), undefined, undefined);
    expect(shouldHoldActiveFileScopeLease({ ...live, status: "failed" }, [])).toBe(true);
    expect(shouldHoldActiveFileScopeLease({ ...live, status: "failed", worktree: undefined }, [])).toBe(false);
  });

  it("emits redacted audit metadata for parked and already-terminal retry boundaries", async () => {
    const live = { ...task, status: undefined };
    const updateTask = vi.fn(async (_id, patch) => ({ ...live, ...patch }));
    const recordRunAuditEvent = vi.fn().mockResolvedValue(undefined);
    const base = {
      store: { updateTask, logEntry: vi.fn(), recordRunAuditEvent } as any,
      getRunContextFor: () => undefined,
      mergeRequester: vi.fn(),
      persistTokenUsage: vi.fn(),
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
    await expect(routeGraphMergeFailureToRetry({
      ...base,
      ensureWorkflowMergeBoundaryTask: vi.fn().mockResolvedValue({ task: terminal, blocked: { reason: "no pre-merge node result recorded", code: "no-node-result", missingInstanceCount: 0 } }),
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
    const persistTokenUsage = vi.fn();
    await expect(routeGraphMergeFailureToRetry({
      store: { updateTask, logEntry: vi.fn(), recordRunAuditEvent } as any,
      getRunContextFor: () => undefined,
      mergeRequester: vi.fn(),
      ensureWorkflowMergeBoundaryTask: vi.fn().mockResolvedValue({ task: live, blocked: { reason: "no pre-merge node result recorded", code: "no-node-result", missingInstanceCount: 0 } }),
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
      const persistTokenUsage = vi.fn();
      const handled = routeGraphMergeFailureToRetry({
        store: { updateTask, logEntry: vi.fn(), recordRunAuditEvent: vi.fn(() => new Promise<void>(() => {})) } as any,
        getRunContextFor: () => undefined,
        mergeRequester: vi.fn(),
        ensureWorkflowMergeBoundaryTask: vi.fn().mockResolvedValue({ task: live, blocked: { reason: "no pre-merge node result recorded", code: "no-node-result", missingInstanceCount: 0 } }),
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
