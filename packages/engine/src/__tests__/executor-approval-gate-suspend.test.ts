import "./executor-test-helpers.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TaskExecutor } from "../executor.js";
import { resetExecutorMocks } from "./executor-test-helpers.js";

/*
FNXC:AgentGating 2026-07-05-00:30:
FN-7608 regression coverage: TaskExecutor.buildActionGateContext's
`pauseForApproval` closure must both pause the task in the store AND
synchronously trigger a session-suspending abort of the in-flight session for
that task (via the existing awaitAbortInFlightTaskWork hard-cancel surface).
Before this fix, pauseTask() marked the row paused but the running LLM turn
kept going -- the executor prompt forbade ending a turn without a tool call,
so the agent hunted for ungated workarounds while the task only *looked*
paused in the store. Assert both effects fire, and that a rejected/failed
abort call is swallowed (never breaks pauseForApproval's own control flow).
*/
function createEventedStore() {
  const listeners = new Map<string, Set<(...args: any[]) => void>>();
  return {
    on: vi.fn((event: string, listener: (...args: any[]) => void) => {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
    }),
    off: vi.fn((event: string, listener: (...args: any[]) => void) => {
      listeners.get(event)?.delete(listener);
    }),
    getSettings: vi.fn().mockResolvedValue({ globalPause: false, enginePaused: false }),
    listTasks: vi.fn().mockResolvedValue([]),
    pauseTask: vi.fn().mockResolvedValue(undefined),
    logEntry: vi.fn().mockResolvedValue(undefined),
  } as any;
}

describe("TaskExecutor.buildActionGateContext pauseForApproval", () => {
  beforeEach(() => {
    resetExecutorMocks();
    vi.clearAllMocks();
  });

  it("pauses the task and synchronously kicks off an in-flight session abort", async () => {
    const store = createEventedStore();
    const executor = new TaskExecutor(store, "/tmp/test");

    const abortSpy = vi.spyOn(executor, "awaitAbortInFlightTaskWork").mockResolvedValue(undefined);

    const gateContext = (executor as any).buildActionGateContext("FN-1", null, undefined);
    expect(gateContext).toBeTruthy();

    const decision = {
      disposition: "require-approval",
      category: "command_execution",
      toolName: "bash",
      operation: "shell command",
      summary: "bash: shell command",
      resourceType: "command",
      approvalDedupeKey: "executor-FN-1|FN-1|bash|command_execution|command||shell command",
      metadata: {},
    };

    await gateContext.pauseForApproval({ approvalRequestId: "apr-1", decision });

    // FN-7736: pauseForApproval must durably stamp the canonical
    // AWAITING_APPROVAL_PAUSE_REASON so recovery/oversight code can recognize
    // this hold via isTaskBlockedOnApproval (not just paused:true).
    expect(store.pauseTask).toHaveBeenCalledWith("FN-1", true, undefined, expect.objectContaining({ pausedByAgentId: expect.any(String), pausedReason: "awaiting-approval" }));
    expect(store.logEntry).toHaveBeenCalled();
    // Session suspension must be triggered synchronously (called, not merely
    // scheduled for some later tick) as part of this same pauseForApproval
    // invocation.
    expect(abortSpy).toHaveBeenCalledTimes(1);
    expect(abortSpy).toHaveBeenCalledWith("FN-1", expect.stringContaining("awaiting-approval"));
  });

  it("does not let a rejected session-abort break pauseForApproval's control flow", async () => {
    const store = createEventedStore();
    const executor = new TaskExecutor(store, "/tmp/test");

    vi.spyOn(executor, "awaitAbortInFlightTaskWork").mockRejectedValue(new Error("boom"));

    const gateContext = (executor as any).buildActionGateContext("FN-2", null, undefined);
    const decision = {
      disposition: "require-approval",
      category: "command_execution",
      toolName: "bash",
      operation: "shell command",
      summary: "bash: shell command",
      resourceType: "command",
      approvalDedupeKey: "k",
      metadata: {},
    };

    await expect(gateContext.pauseForApproval({ approvalRequestId: "apr-2", decision })).resolves.toBeUndefined();
    expect(store.pauseTask).toHaveBeenCalledTimes(1);

    // Let the fire-and-forget rejected promise's .catch() handler settle
    // before the test ends, so no unhandled rejection leaks.
    await new Promise((resolve) => setImmediate(resolve));
  });

  it("fires the abort call without blocking on it (fire-and-forget, not awaited inline)", async () => {
    const store = createEventedStore();
    const executor = new TaskExecutor(store, "/tmp/test");

    let resolveAbort: () => void = () => {};
    const abortPromise = new Promise<void>((resolve) => {
      resolveAbort = resolve;
    });
    vi.spyOn(executor, "awaitAbortInFlightTaskWork").mockReturnValue(abortPromise);

    const gateContext = (executor as any).buildActionGateContext("FN-3", null, undefined);
    const decision = {
      disposition: "require-approval",
      category: "command_execution",
      toolName: "bash",
      operation: "shell command",
      summary: "bash: shell command",
      resourceType: "command",
      approvalDedupeKey: "k3",
      metadata: {},
    };

    // If pauseForApproval awaited the abort call inline, this would hang
    // forever since abortPromise never resolves during the test body.
    await expect(gateContext.pauseForApproval({ approvalRequestId: "apr-3", decision })).resolves.toBeUndefined();

    resolveAbort();
    await abortPromise;
  });
});
