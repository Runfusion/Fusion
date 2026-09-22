import { describe, expect, it, vi } from "vitest";
import { routeGraphFailureToExecutionResume } from "../executor/route-graph-failure-to-execution-resume.js";
import { MERGE_BOUNDARY_RECOVERY_VALUE } from "../workflows/workflow-merge-nodes.js";

const absentResultEvidence = { code: "no-node-result", missingInstanceIds: [] } as const;

const task = {
  id: "FN-9341-shape",
  title: "incomplete implementation",
  description: "",
  prompt: "# task",
  column: "checking",
  steps: [{ id: "0", title: "Preflight", status: "done" }, { id: "1", title: "Implementation", status: "in-progress" }],
  dependencies: [],
  createdAt: "2026-09-20T00:00:00.000Z",
  updatedAt: "2026-09-20T00:00:00.000Z",
} as any;

describe("FN-9345 merge-boundary evidence recovery", () => {
  it("moves an FN-9341-shaped review card to its resolved implementation lane without requesting merge", async () => {
    let current = { ...task };
    const moveTask = vi.fn(async (_id: string, column: string) => (current = { ...current, column }));
    const updateTask = vi.fn().mockResolvedValue(undefined);
    const updateTaskAtomic = vi.fn(async (_id: string, reducer: (value: any) => any) => {
      const patch = reducer(current);
      if (patch) current = { ...current, ...patch };
      return current;
    });
    const logEntry = vi.fn().mockResolvedValue(undefined);
    const result = await routeGraphFailureToExecutionResume({
      store: {
        moveTask, updateTask, updateTaskAtomic, logEntry, getTaskWorkflowSelection: () => ({ workflowId: "custom:recovery", stepIds: [] }),
        replaceActiveTaskWorkflowContinuation: vi.fn().mockResolvedValue(undefined),
        getWorkflowDefinition: async () => ({ ir: { version: "v2", columns: [], nodes: [{ id: "execute", kind: "prompt", config: { seam: "execute" } }], edges: [] } }),
      } as any,
      getRunContextFor: () => undefined,
      resolveResumeLanes: vi.fn().mockResolvedValue({ hold: "todo", wip: "building", review: "checking", wipDeclared: true }),
      clearTerminalStepFailuresForRetry: vi.fn().mockResolvedValue(undefined),
      persistTokenUsage: vi.fn().mockResolvedValue(undefined),
      isRemediationGraphNode: vi.fn().mockResolvedValue(false),
    }, task, "merge", MERGE_BOUNDARY_RECOVERY_VALUE, undefined, absentResultEvidence);

    expect(result).toBe(true);
    expect(moveTask).toHaveBeenCalledWith(task.id, "building", expect.objectContaining({
      preserveProgress: true,
      preserveWorktree: true,
      workflowMoveMetadata: expect.objectContaining({ reason: "merge-boundary-evidence-recovery" }),
    }));
    expect(updateTaskAtomic).toHaveBeenCalledTimes(2);
    expect(logEntry).toHaveBeenCalledWith(task.id, expect.stringContaining("'execute' is being resumed"), undefined, undefined);
  });

  it("keeps a review card under an explicit auto-merge-off hold without claiming or moving it", async () => {
    const moveTask = vi.fn();
    const replaceActiveTaskWorkflowContinuation = vi.fn();
    const updateTaskAtomic = vi.fn();

    await expect(routeGraphFailureToExecutionResume({
      store: {
        moveTask, updateTaskAtomic, logEntry: vi.fn(), getSettings: vi.fn().mockResolvedValue({ autoMerge: false }),
        replaceActiveTaskWorkflowContinuation,
        getTaskWorkflowSelection: () => ({ workflowId: "custom:recovery", stepIds: [] }),
        getWorkflowDefinition: vi.fn(),
      } as any,
      getRunContextFor: () => undefined,
      resolveResumeLanes: vi.fn().mockResolvedValue({ hold: "todo", wip: "building", review: "checking", wipDeclared: true }),
      isLiveSharedBranchGroupMember: vi.fn().mockResolvedValue(false),
      clearTerminalStepFailuresForRetry: vi.fn(), persistTokenUsage: vi.fn(), isRemediationGraphNode: vi.fn(),
    }, { ...task, autoMerge: false }, "merge", MERGE_BOUNDARY_RECOVERY_VALUE, undefined, absentResultEvidence)).resolves.toBe(false);

    expect(updateTaskAtomic).not.toHaveBeenCalled();
    expect(replaceActiveTaskWorkflowContinuation).not.toHaveBeenCalled();
    expect(moveTask).not.toHaveBeenCalled();
  });

  it("abandons a claimed recovery when auto-merge is disabled before continuation seeding", async () => {
    let current = { ...task, autoMerge: true, status: "failed", error: "merge-boundary-unproven" };
    const replaceActiveTaskWorkflowContinuation = vi.fn();
    const moveTaskIf = vi.fn();
    const updateTaskAtomic = vi.fn(async (_id: string, reducer: (value: any) => any) => {
      const patch = reducer(current);
      if (patch) {
        current = { ...current, ...patch };
        if (patch.status === "merge-boundary-evidence-recovery") current = { ...current, autoMerge: false };
      }
      return current;
    });

    await expect(routeGraphFailureToExecutionResume({
      store: {
        updateTaskAtomic, moveTaskIf, logEntry: vi.fn(), getSettings: vi.fn().mockResolvedValue({ autoMerge: true }),
        getTask: vi.fn(async () => current), replaceActiveTaskWorkflowContinuation,
        getTaskWorkflowSelection: () => ({ workflowId: "custom:recovery", stepIds: [] }),
        getWorkflowDefinition: async () => ({ ir: { version: "v2", columns: [], nodes: [{ id: "implementation", kind: "prompt", config: { seam: "execute" } }], edges: [] } }),
      } as any,
      getRunContextFor: () => undefined,
      resolveResumeLanes: vi.fn().mockResolvedValue({ hold: "todo", wip: "building", review: "checking", wipDeclared: true }),
      isLiveSharedBranchGroupMember: vi.fn().mockResolvedValue(false),
      clearTerminalStepFailuresForRetry: vi.fn(), persistTokenUsage: vi.fn(), isRemediationGraphNode: vi.fn(),
    }, current, "merge", MERGE_BOUNDARY_RECOVERY_VALUE, undefined, absentResultEvidence)).resolves.toBe(false);

    expect(replaceActiveTaskWorkflowContinuation).not.toHaveBeenCalled();
    expect(moveTaskIf).not.toHaveBeenCalled();
    expect(current).toMatchObject({ column: "checking", status: "failed", error: "merge-boundary-unproven", autoMerge: false });
  });

  it("derives the unfinished direct execute owner from durable work-item history", async () => {
    let current = { ...task };
    const replaceActiveTaskWorkflowContinuation = vi.fn().mockResolvedValue(undefined);
    const updateTaskAtomic = vi.fn(async (_id: string, reducer: (value: any) => any) => {
      const patch = reducer(current);
      if (patch) current = { ...current, ...patch };
      return current;
    });
    await expect(routeGraphFailureToExecutionResume({
      store: {
        moveTask: vi.fn(async (_id: string, column: string) => (current = { ...current, column })), updateTask: vi.fn(), updateTaskAtomic, logEntry: vi.fn(),
        replaceActiveTaskWorkflowContinuation,
        listWorkflowWorkItemsForTask: vi.fn().mockResolvedValue([{ nodeId: "preflight", state: "succeeded", kind: "task" }]),
        getTaskWorkflowSelection: () => ({ workflowId: "custom:recovery", stepIds: [] }),
        getWorkflowDefinition: async () => ({ ir: { version: "v2", columns: [], nodes: [
          { id: "preflight", kind: "prompt", config: { seam: "execute" } },
          { id: "implementation", kind: "prompt", config: { seam: "execute" } },
        ], edges: [] } }),
      } as any,
      getRunContextFor: () => undefined,
      resolveResumeLanes: vi.fn().mockResolvedValue({ hold: "todo", wip: "building", review: "checking", wipDeclared: true }),
      clearTerminalStepFailuresForRetry: vi.fn(), persistTokenUsage: vi.fn(), isRemediationGraphNode: vi.fn(),
    }, task, "merge", MERGE_BOUNDARY_RECOVERY_VALUE, undefined, absentResultEvidence)).resolves.toBe(true);

    expect(replaceActiveTaskWorkflowContinuation).toHaveBeenCalledWith(expect.objectContaining({ nodeId: "implementation" }));
  });

  it("fails closed when durable history cannot distinguish multiple executable owners", async () => {
    const replaceActiveTaskWorkflowContinuation = vi.fn();
    await expect(routeGraphFailureToExecutionResume({
      store: {
        updateTask: vi.fn(), updateTaskAtomic: vi.fn(async (_id: string, reducer: (value: any) => any) => reducer(task)), logEntry: vi.fn(),
        replaceActiveTaskWorkflowContinuation,
        listWorkflowWorkItemsForTask: vi.fn().mockResolvedValue([]),
        getTaskWorkflowSelection: () => ({ workflowId: "custom:recovery", stepIds: [] }),
        getWorkflowDefinition: async () => ({ ir: { version: "v2", columns: [], nodes: [
          { id: "preflight", kind: "prompt", config: { seam: "execute" } },
          { id: "implementation", kind: "prompt", config: { seam: "execute" } },
        ], edges: [] } }),
      } as any,
      getRunContextFor: () => undefined,
      resolveResumeLanes: vi.fn().mockResolvedValue({ hold: "todo", wip: "building", review: "checking", wipDeclared: true }),
      clearTerminalStepFailuresForRetry: vi.fn(), persistTokenUsage: vi.fn(), isRemediationGraphNode: vi.fn(),
    }, task, "merge", MERGE_BOUNDARY_RECOVERY_VALUE, undefined, absentResultEvidence)).resolves.toBe(false);
    expect(replaceActiveTaskWorkflowContinuation).not.toHaveBeenCalled();
  });

  it("seeds the durable foreach owner even when a graph-native checklist is settled", async () => {
    const replaceActiveTaskWorkflowContinuation = vi.fn().mockResolvedValue(undefined);
    let current = { ...task, steps: [{ id: "0", title: "Preflight", status: "done" }] };
    const moveTask = vi.fn(async (_id: string, column: string) => (current = { ...current, column }));
    const updateTaskAtomic = vi.fn(async (_id: string, reducer: (value: any) => any) => {
      const patch = reducer(current);
      if (patch) current = { ...current, ...patch };
      return current;
    });
    await expect(routeGraphFailureToExecutionResume({
      store: {
        moveTask, updateTask: vi.fn(), updateTaskAtomic, logEntry: vi.fn(),
        replaceActiveTaskWorkflowContinuation,
        getTaskWorkflowSelection: () => ({ workflowId: "custom:recovery", stepIds: [] }),
        getWorkflowDefinition: async () => ({ ir: {
          version: "v2", columns: [], nodes: [{ id: "foreach-implementation", kind: "foreach", config: { source: "task-steps", template: { nodes: [], edges: [] } } }], edges: [],
        } }),
      } as any,
      getRunContextFor: () => undefined,
      resolveResumeLanes: vi.fn().mockResolvedValue({ hold: "todo", wip: "building", review: "checking", wipDeclared: true }),
      clearTerminalStepFailuresForRetry: vi.fn(), persistTokenUsage: vi.fn(), isRemediationGraphNode: vi.fn(),
    }, { ...task, steps: [{ id: "0", title: "Preflight", status: "done" }] }, "merge", MERGE_BOUNDARY_RECOVERY_VALUE, undefined, {
      code: "missing-foreach-instances", missingInstanceIds: ["foreach-implementation#0:step-execute"],
    })).resolves.toBe(true);
    expect(replaceActiveTaskWorkflowContinuation).toHaveBeenCalledOnce();
    expect(replaceActiveTaskWorkflowContinuation.mock.calls[0]?.[0]).toMatchObject({
      nodeId: "foreach-implementation", kind: "task", state: "runnable",
    });
    expect(moveTask).toHaveBeenCalled();
  });

  it("serializes two proven foreach owners through the canonical continuation slot", async () => {
    let current = { ...task, steps: [{ id: "0", title: "First", status: "in-progress" }] };
    const replaceActiveTaskWorkflowContinuation = vi.fn().mockResolvedValue(undefined);
    const updateTaskAtomic = vi.fn(async (_id: string, reducer: (value: any) => any) => {
      const patch = reducer(current);
      if (patch) current = { ...current, ...patch };
      return current;
    });
    await expect(routeGraphFailureToExecutionResume({
      store: {
        moveTask: vi.fn(async (_id: string, column: string) => (current = { ...current, column })), updateTask: vi.fn(), updateTaskAtomic, logEntry: vi.fn(),
        replaceActiveTaskWorkflowContinuation,
        getTaskWorkflowSelection: () => ({ workflowId: "custom:two-foreach-regions", stepIds: [] }),
        getWorkflowDefinition: async () => ({ ir: { version: "v2", columns: [], nodes: [
          { id: "foreach-first", kind: "foreach", config: {} },
          { id: "foreach-second", kind: "foreach", config: {} },
        ], edges: [] } }),
      } as any,
      getRunContextFor: () => undefined,
      resolveResumeLanes: vi.fn().mockResolvedValue({ hold: "todo", wip: "building", review: "checking", wipDeclared: true }),
      clearTerminalStepFailuresForRetry: vi.fn(), persistTokenUsage: vi.fn(), isRemediationGraphNode: vi.fn(),
    }, current, "merge", MERGE_BOUNDARY_RECOVERY_VALUE, undefined, {
      code: "missing-foreach-instances",
      missingInstanceIds: ["foreach-first#0:step-execute", "foreach-second#0:step-execute"],
    })).resolves.toBe(true);

    // Only one task continuation may be active; the graph rechecks and schedules the next proven owner.
    expect(replaceActiveTaskWorkflowContinuation).toHaveBeenCalledOnce();
    expect(replaceActiveTaskWorkflowContinuation).toHaveBeenCalledWith(expect.objectContaining({ nodeId: "foreach-first" }));
  });

  it.each([
    ["nonterminal result", { code: "non-terminal-node-result", nonTerminalNodeId: "execute-b", missingInstanceIds: [] }, [
      { id: "execute-a", kind: "prompt", config: { seam: "execute" } },
      { id: "execute-b", kind: "prompt", config: { seam: "execute" } },
    ], "execute-b"],
    ["sequential missing instance", { code: "missing-foreach-instances", missingInstanceIds: ["foreach-sequential#1:step-execute"] }, [
      { id: "foreach-sequential", kind: "foreach", config: {} },
      { id: "foreach-parallel", kind: "foreach", config: {} },
    ], "foreach-sequential"],
    ["parallel missing instances", { code: "missing-foreach-instances", missingInstanceIds: ["foreach-parallel#0:step-execute", "foreach-parallel#2:step-execute"] }, [
      { id: "foreach-sequential", kind: "foreach", config: {} },
      { id: "foreach-parallel", kind: "foreach", config: {} },
    ], "foreach-parallel"],
  ])("re-enters only the owning executable node for %s", async (_label, evidence, nodes, expectedOwner) => {
    let current = { ...task, workflowStepResults: evidence.code === "non-terminal-node-result"
      ? [{ workflowStepId: "execute-b", source: "node", status: "pending" }]
      : undefined };
    const replace = vi.fn();
    const updateTaskAtomic = vi.fn(async (_id: string, reducer: (value: any) => any) => {
      const patch = reducer(current);
      if (patch) current = { ...current, ...patch };
      return current;
    });
    await expect(routeGraphFailureToExecutionResume({
      store: {
        moveTask: vi.fn(async (_id: string, column: string) => (current = { ...current, column })), updateTask: vi.fn(), updateTaskAtomic, logEntry: vi.fn(),
        replaceActiveTaskWorkflowContinuation: replace,
        getTaskWorkflowSelection: () => ({ workflowId: "custom:recovery", stepIds: [] }),
        getWorkflowDefinition: async () => ({ ir: { version: "v2", columns: [], nodes, edges: [] } }),
      } as any,
      getRunContextFor: () => undefined,
      resolveResumeLanes: vi.fn().mockResolvedValue({ hold: "todo", wip: "building", review: "checking", wipDeclared: true }),
      clearTerminalStepFailuresForRetry: vi.fn(), persistTokenUsage: vi.fn(), isRemediationGraphNode: vi.fn(),
    }, current, "merge", MERGE_BOUNDARY_RECOVERY_VALUE, undefined, evidence as any)).resolves.toBe(true);
    expect(replace).toHaveBeenCalledWith(expect.objectContaining({ nodeId: expectedOwner }));
  });

  it("does not clear a competing pause after its recovery claim", async () => {
    let current = { ...task };
    const updateTaskAtomic = vi.fn(async (_id: string, reducer: (value: any) => any) => {
      const patch = reducer(current);
      if (patch) current = { ...current, ...patch };
      return current;
    });
    const moveTask = vi.fn();
    const moveTaskIf = vi.fn(async (_id: string, _column: string, predicate: (value: any) => boolean) => {
      current = { ...current, column: "building", paused: true, userPaused: true, status: "operator-owned" };
      return { moved: predicate(current) };
    });
    await expect(routeGraphFailureToExecutionResume({
      store: {
        moveTask, moveTaskIf, updateTask: vi.fn(), updateTaskAtomic, logEntry: vi.fn(),
        replaceActiveTaskWorkflowContinuation: vi.fn(),
        getTaskWorkflowSelection: () => ({ workflowId: "custom:recovery", stepIds: [] }),
        getWorkflowDefinition: async () => ({ ir: { version: "v2", columns: [], nodes: [{ id: "execute", kind: "prompt", config: { seam: "execute" } }], edges: [] } }),
      } as any,
      getRunContextFor: () => undefined,
      resolveResumeLanes: vi.fn().mockResolvedValue({ hold: "todo", wip: "building", review: "checking", wipDeclared: true }),
      clearTerminalStepFailuresForRetry: vi.fn(), persistTokenUsage: vi.fn(), isRemediationGraphNode: vi.fn(),
    }, task, "merge", MERGE_BOUNDARY_RECOVERY_VALUE, undefined, absentResultEvidence)).resolves.toBe(true);
    expect(current).toMatchObject({ paused: true, userPaused: true, status: "operator-owned" });
    expect(moveTask).not.toHaveBeenCalled();
  });

  it("hands off a rejected continuation seed without stranding the concurrent owner", async () => {
    let current = { ...task };
    const competingContinuation = { id: "winner", taskId: task.id, nodeId: "implementation", state: "running", kind: "task" };
    const replace = vi.fn().mockRejectedValue(Object.assign(new Error("active task continuation exists"), { name: "ActiveTaskContinuationError" }));
    const updateTaskAtomic = vi.fn(async (_id: string, reducer: (value: any) => any) => {
      const patch = reducer(current);
      if (patch) current = { ...current, ...patch };
      return current;
    });
    const listWorkflowWorkItemsForTask = vi.fn().mockResolvedValue([competingContinuation]);
    await expect(routeGraphFailureToExecutionResume({
      store: {
        moveTask: vi.fn(), updateTask: vi.fn(), updateTaskAtomic, logEntry: vi.fn(), listWorkflowWorkItemsForTask,
        replaceActiveTaskWorkflowContinuation: replace,
        getTaskWorkflowSelection: () => ({ workflowId: "custom:recovery", stepIds: [] }),
        getWorkflowDefinition: async () => ({ ir: { version: "v2", columns: [], nodes: [{ id: "execute", kind: "prompt", config: { seam: "execute" } }], edges: [] } }),
      } as any,
      getRunContextFor: () => undefined,
      resolveResumeLanes: vi.fn().mockResolvedValue({ hold: "todo", wip: "building", review: "checking", wipDeclared: true }),
      clearTerminalStepFailuresForRetry: vi.fn(), persistTokenUsage: vi.fn(), isRemediationGraphNode: vi.fn(),
    }, task, "merge", MERGE_BOUNDARY_RECOVERY_VALUE, undefined, absentResultEvidence)).resolves.toBe(true);
    expect(replace).toHaveBeenCalledOnce();
    expect(listWorkflowWorkItemsForTask).toHaveBeenCalledWith(task.id, { kinds: ["task"] });
    expect(competingContinuation).toMatchObject({ nodeId: "implementation", state: "running" });
    expect(current).toMatchObject({ column: "checking" });
    expect(current.status).toBeUndefined();
    expect(current.error).toBeUndefined();
  });

  it("defers an unchanged proof gap until its durable bounded recheck time", async () => {
    let current = { ...task, status: null as string | null };
    const replaceActiveTaskWorkflowContinuation = vi.fn().mockResolvedValue(undefined);
    const moveTask = vi.fn(async (_id: string, column: string) => (current = { ...current, column }));
    const updateTaskAtomic = vi.fn(async (_id: string, reducer: (value: any) => any) => {
      const patch = reducer(current);
      if (patch) current = { ...current, ...patch };
      return current;
    });
    const deps = {
      store: {
        moveTask, updateTask: vi.fn(), updateTaskAtomic, logEntry: vi.fn(),
        replaceActiveTaskWorkflowContinuation,
        getTaskWorkflowSelection: () => ({ workflowId: "custom:recovery", stepIds: [] }),
        getWorkflowDefinition: async () => ({ ir: { version: "v2", columns: [], nodes: [{ id: "execute", kind: "prompt", config: { seam: "execute" } }], edges: [] } }),
      } as any,
      getRunContextFor: () => undefined,
      resolveResumeLanes: vi.fn().mockResolvedValue({ hold: "todo", wip: "building", review: "checking", wipDeclared: true }),
      clearTerminalStepFailuresForRetry: vi.fn(), persistTokenUsage: vi.fn(), isRemediationGraphNode: vi.fn(),
    };

    await expect(routeGraphFailureToExecutionResume(deps, current, "merge", MERGE_BOUNDARY_RECOVERY_VALUE, undefined, absentResultEvidence)).resolves.toBe(true);
    const firstMarker = current.mergeDetails?.mergeBoundaryRecovery;
    expect(firstMarker).toMatchObject({ attempt: 1 });

    // Reproduces the failed proof at the review boundary without any implementation progress.
    current = { ...current, column: "checking", status: null };
    await expect(routeGraphFailureToExecutionResume(deps, current, "merge", MERGE_BOUNDARY_RECOVERY_VALUE, undefined, absentResultEvidence)).resolves.toBe(true);

    expect(replaceActiveTaskWorkflowContinuation).toHaveBeenCalledTimes(1);
    expect(moveTask).toHaveBeenCalledTimes(1);
    expect(current.mergeDetails?.mergeBoundaryRecovery).toEqual(firstMarker);
  });

  it("holds unchanged proof after the bounded recovery budget is exhausted", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-21T10:40:00.000Z"));
    try {
      let current = { ...task, status: null as string | null };
      const replaceActiveTaskWorkflowContinuation = vi.fn().mockResolvedValue(undefined);
      const updateTaskAtomic = vi.fn(async (_id: string, reducer: (value: any) => any) => {
        const patch = reducer(current);
        if (patch) current = { ...current, ...patch };
        return current;
      });
      const deps = {
        store: {
          moveTask: vi.fn(async (_id: string, column: string) => (current = { ...current, column })), updateTask: vi.fn(), updateTaskAtomic, logEntry: vi.fn(),
          replaceActiveTaskWorkflowContinuation,
          getTaskWorkflowSelection: () => ({ workflowId: "custom:recovery", stepIds: [] }),
          getWorkflowDefinition: async () => ({ ir: { version: "v2", columns: [], nodes: [{ id: "execute", kind: "prompt", config: { seam: "execute" } }], edges: [] } }),
        } as any,
        getRunContextFor: () => undefined,
        resolveResumeLanes: vi.fn().mockResolvedValue({ hold: "todo", wip: "building", review: "checking", wipDeclared: true }),
        clearTerminalStepFailuresForRetry: vi.fn(), persistTokenUsage: vi.fn(), isRemediationGraphNode: vi.fn(),
      };
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await expect(routeGraphFailureToExecutionResume(deps, current, "merge", MERGE_BOUNDARY_RECOVERY_VALUE, undefined, absentResultEvidence)).resolves.toBe(true);
        current = { ...current, column: "checking", status: null };
        vi.setSystemTime(new Date(Date.now() + 600_000));
      }
      await expect(routeGraphFailureToExecutionResume(deps, current, "merge", MERGE_BOUNDARY_RECOVERY_VALUE, undefined, absentResultEvidence)).resolves.toBe(true);

      expect(replaceActiveTaskWorkflowContinuation).toHaveBeenCalledTimes(4);
      expect(current).toMatchObject({ status: "merge-boundary-evidence-recovery-held" });
      expect(current.mergeDetails?.mergeBoundaryRecovery).toMatchObject({ attempt: 4, heldAt: expect.any(String), nextCheckAt: null });
    } finally {
      vi.useRealTimers();
    }
  });

  it("resets the recovery budget when durable node progress changes", async () => {
    let current = {
      ...task,
      status: null as string | null,
      workflowStepResults: [{ workflowStepId: "execute", source: "node", status: "pending" }],
    };
    const replaceActiveTaskWorkflowContinuation = vi.fn().mockResolvedValue(undefined);
    const updateTaskAtomic = vi.fn(async (_id: string, reducer: (value: any) => any) => {
      const patch = reducer(current);
      if (patch) current = { ...current, ...patch };
      return current;
    });
    const deps = {
      store: {
        moveTask: vi.fn(async (_id: string, column: string) => (current = { ...current, column })), updateTask: vi.fn(), updateTaskAtomic, logEntry: vi.fn(),
        replaceActiveTaskWorkflowContinuation,
        getTaskWorkflowSelection: () => ({ workflowId: "custom:recovery", stepIds: [] }),
        getWorkflowDefinition: async () => ({ ir: { version: "v2", columns: [], nodes: [{ id: "execute", kind: "prompt", config: { seam: "execute" } }], edges: [] } }),
      } as any,
      getRunContextFor: () => undefined,
      resolveResumeLanes: vi.fn().mockResolvedValue({ hold: "todo", wip: "building", review: "checking", wipDeclared: true }),
      clearTerminalStepFailuresForRetry: vi.fn(), persistTokenUsage: vi.fn(), isRemediationGraphNode: vi.fn(),
    };
    const evidence = { code: "non-terminal-node-result", nonTerminalNodeId: "execute", missingInstanceIds: [] } as const;

    await routeGraphFailureToExecutionResume(deps, current, "merge", MERGE_BOUNDARY_RECOVERY_VALUE, undefined, evidence);
    current = {
      ...current,
      column: "checking",
      status: null,
      workflowStepResults: [{ workflowStepId: "execute", source: "node", status: "running" }],
    };
    await routeGraphFailureToExecutionResume(deps, current, "merge", MERGE_BOUNDARY_RECOVERY_VALUE, undefined, evidence);

    expect(replaceActiveTaskWorkflowContinuation).toHaveBeenCalledTimes(2);
    expect(current.mergeDetails?.mergeBoundaryRecovery).toMatchObject({ attempt: 1 });
  });

  it("remains fail-closed when the card is paused", async () => {
    for (const live of [
      { ...task, paused: true },
    ]) {
      const moveTask = vi.fn();
      await expect(routeGraphFailureToExecutionResume({
        store: { moveTask, updateTask: vi.fn(), logEntry: vi.fn(), getTaskWorkflowSelection: () => undefined } as any,
        getRunContextFor: () => undefined,
        resolveResumeLanes: vi.fn().mockResolvedValue({ hold: "todo", wip: "building", review: "checking", wipDeclared: true }),
        clearTerminalStepFailuresForRetry: vi.fn(), persistTokenUsage: vi.fn(), isRemediationGraphNode: vi.fn(),
      }, live, "merge", MERGE_BOUNDARY_RECOVERY_VALUE, undefined, absentResultEvidence)).resolves.toBe(false);
      expect(moveTask).not.toHaveBeenCalled();
    }
  });
});
