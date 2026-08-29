import { beforeEach, describe, expect, it, vi } from "vitest";
import "./executor-test-helpers.js";
import { TaskExecutor, evaluateTaskDoneRefusal } from "../executor.js";
import { executorLog } from "../logger.js";
import { createMockStore, mockedExecSync, resetExecutorMocks } from "./executor-test-helpers.js";

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "FN-4946-R",
    title: "Implicit revise guard",
    description: "",
    column: "in-progress",
    worktree: "/repo/.worktrees/swift-falcon",
    branch: "fusion/fn-4946-r",
    baseCommitSha: "abc123",
    taskDoneRetryCount: 0,
    dependencies: [],
    steps: [{ name: "Step 1", status: "in-progress" as const }],
    currentStep: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function refusal() {
  return {
    ok: false as const,
    refusalClass: "pending-code-review-revise" as const,
    reason: "Step 1 has pending REVISE",
    message: "fn_task_done refused (pending-code-review-revise): Step 1 has pending REVISE",
  };
}

describe("FN-4946 implicit completion + REVISE verdict interaction", () => {
  beforeEach(() => {
    resetExecutorMocks();
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-parse --show-toplevel")) return Buffer.from("/repo/.worktrees/swift-falcon\n");
      if (cmd.includes("rev-parse --abbrev-ref HEAD")) return Buffer.from("fusion/fn-4946-r\n");
      if (cmd.includes("rev-list --count")) return Buffer.from("1\n");
      if (cmd.includes("rev-parse HEAD")) return Buffer.from("def456\n");
      return Buffer.from("");
    });
  });

  it("requeues with implicit-completion refusal shape and retry count", async () => {
    const store = createMockStore();
    const executor = new TaskExecutor(store as any, "/repo");

    await (executor as any).handleImplicitTaskDoneRefusal(makeTask({ id: "FN-4946-R1" }), refusal());

    expect(store.updateTask).toHaveBeenCalledWith("FN-4946-R1", expect.objectContaining({
      status: "queued",
      error: null,
      taskDoneRetryCount: 1,
      worktree: null,
      branch: null,
      paused: false,
      pausedByAgentId: null,
      sessionFile: null,
    }));
    expect(store.moveTask).toHaveBeenCalledWith("FN-4946-R1", "todo", { preserveProgress: true });
    const refusalLogCall = store.logEntry.mock.calls.find(
      ([id, message]: [string, string]) => id === "FN-4946-R1" && message.includes("pending-code-review-revise"),
    );
    expect(refusalLogCall).toBeTruthy();
    expect(executorLog.error).toHaveBeenCalledWith(expect.stringContaining("(implicit completion)"));
  });

  it("evaluateTaskDoneRefusal returns ok when REVISE exists only on already-done steps", () => {
    const result = evaluateTaskDoneRefusal(
      makeTask({ steps: [{ name: "Step 1", status: "done" }] }) as any,
      {},
      new Map([[0, "REVISE"]]),
    );

    expect(result.ok).toBe(true);
  });

  it("handles implicit refusal once without falling into no-fn_task_done exhaustion handling", async () => {
    const store = createMockStore();
    const executor = new TaskExecutor(store as any, "/repo");

    await (executor as any).handleImplicitTaskDoneRefusal(makeTask({ id: "FN-4946-R2" }), refusal());

    const retryCountUpdates = store.updateTask.mock.calls.filter(
      ([id, patch]: [string, Record<string, unknown>]) => id === "FN-4946-R2" && "taskDoneRetryCount" in patch,
    );
    expect(retryCountUpdates).toHaveLength(1);
    expect(retryCountUpdates[0]?.[1]).toEqual(expect.objectContaining({ taskDoneRetryCount: 1 }));

    const noFnTaskDoneEscalations = store.updateTask.mock.calls.filter(
      ([id, patch]: [string, Record<string, unknown>]) =>
        id === "FN-4946-R2"
        && typeof patch.error === "string"
        && patch.error.includes("Agent finished without calling fn_task_done"),
    );
    expect(noFnTaskDoneEscalations).toHaveLength(0);
  });
});
