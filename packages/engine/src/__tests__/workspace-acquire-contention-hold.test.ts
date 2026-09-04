import { afterEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskDetail, TaskStore } from "@fusion/core";
import { holdForSessionContention } from "../executor/session-contention-hold.js";
import { createAuthoritativeWorkflowSeams } from "../executor/create-authoritative-workflow-seams.js";
import { FOREACH_ACTIVE_CONTEXT_KEY } from "../workflows/workflow-node-handlers.js";
import { SESSION_CONTENTION_HOLD_VALUE } from "../workflows/workflow-graph-executor.js";

describe("workspace acquisition contention hold", () => {
  afterEach(() => vi.useRealTimers());

  it("maps a foreach step-session acquisition refusal to the scheduling-hold graph value", async () => {
    const live = { id: "FN-179-foreach", worktree: "/tmp/fn-179", steps: [] } as unknown as TaskDetail;
    const seams = createAuthoritativeWorkflowSeams({
      store: { getTask: vi.fn(async () => live) },
      graphStepActiveContext: new Map(),
      runProjectedGraphTaskStep: vi.fn(async () => ({
        outcome: "failure",
        error: "workspace sub-repo Merge acquisition is in progress for task MRG-050",
      })),
    } as never, {} as never);

    const result = await seams.stepExecute?.(live, {
      [FOREACH_ACTIVE_CONTEXT_KEY]: { foreachNodeId: "steps", stepIndex: 0, instanceId: "steps#0:step-execute" },
    });

    expect(result).toMatchObject({ outcome: "failure", value: SESSION_CONTENTION_HOLD_VALUE });
  });

  it("retains the durable attempt count across scheduled re-execution", async () => {
    vi.useFakeTimers();
    let task = {
      id: "FN-179-wait",
      status: "in-progress",
      sessionContentionHoldCount: 0,
    } as unknown as TaskDetail;
    const reexecute = vi.fn(async () => undefined);
    const store = {
      getTask: async () => task,
      updateTask: async (_id: string, patch: Partial<Task>) => {
        task = { ...task, ...patch };
      },
      logEntry: async () => undefined,
    } as unknown as TaskStore;
    const result = { context: { "node:execute:error": "workspace sub-repo Merge acquisition is in progress for task MRG-050" } } as never;

    await holdForSessionContention({ store, getRunContextFor: () => undefined, reexecute }, task, task, result);
    expect(task).toMatchObject({ status: "contention-hold", sessionContentionHoldCount: 1 });

    await vi.runAllTimersAsync();
    expect(task).toMatchObject({ status: null, sessionContentionHoldCount: 1, sessionContentionWaitReason: null });
    expect(reexecute).toHaveBeenCalledOnce();

    await holdForSessionContention({ store, getRunContextFor: () => undefined, reexecute }, task, task, result);
    expect(task).toMatchObject({ status: "contention-hold", sessionContentionHoldCount: 2 });
  });

  it("keeps an exhausted durable budget so scheduler rediscovery cannot restart contention at one", async () => {
    let task = {
      id: "FN-179-exhausted",
      status: "contention-hold",
      sessionContentionHoldCount: 10,
      sessionContentionWaitReason: "workspace sub-repo Merge acquisition is in progress for task MRG-050",
    } as unknown as TaskDetail;
    const store = {
      getTask: async () => task,
      updateTask: async (_id: string, patch: Partial<Task>) => { task = { ...task, ...patch }; },
      logEntry: async () => undefined,
    } as unknown as TaskStore;
    const result = { context: { "node:execute:error": "workspace sub-repo Merge acquisition is in progress for task MRG-050" } } as never;

    await holdForSessionContention({ store, getRunContextFor: () => undefined, reexecute: vi.fn(async () => undefined) }, task, task, result);

    expect(task).toMatchObject({ status: null, sessionContentionHoldCount: 10, sessionContentionWaitReason: null });
  });
});
