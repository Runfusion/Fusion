import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import * as worktreePool from "../worktree-pool.js";
import { SelfHealingManager } from "../self-healing.js";
import { evaluateNoCommitsNoOpFinalize } from "@fusion/core";
import {
  createMockStore,
  mockedCreateFnAgent,
  mockedExecSync,
  resetExecutorMocks,
} from "./executor-test-helpers.js";

/*
FNXC:Lifecycle 2026-07-16-10:20:
FN-8141 — regression coverage for the honest blocked exit. Asserts the INVARIANT across surfaces:
(1) fn_task_done(outcome="blocked") parks failed with a BLOCKED: error + audit event and NEVER trips the
    completion/bulk-completion gates or auto-completes/auto-skips steps;
(2) blockedBy becomes real task.dependencies so the task requeues behind the blocker;
(3) the completed-work recovery sweep never promotes a blocked-parked row to in-review;
(4) the ordinary completed outcome is unchanged.
*/

function baseTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "FN-8141",
    title: "Blocked exit test",
    description: "",
    column: "in-progress",
    worktree: "/repo/.worktrees/swift-falcon",
    branch: "fusion/fn-8141",
    baseCommitSha: "abc123",
    taskDoneRetryCount: 0,
    // Two unreviewed pending steps: the exact shape that trips bulk-step-completion-without-review.
    steps: [
      { name: "Implement", status: "in-progress" as const },
      { name: "Testing & Verification", status: "pending" as const },
    ],
    currentStep: 0,
    dependencies: [],
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

async function setup(overrides: Record<string, unknown> = {}) {
  const store = createMockStore();
  store.recordRunAuditEvent = vi.fn().mockResolvedValue(undefined);
  store.getAgentLogCount = vi.fn().mockResolvedValue(0);
  let task: any = baseTask(overrides);
  let tool: any;

  store.getTask.mockImplementation(async () => ({ ...task, steps: task.steps.map((s: any) => ({ ...s })) }));
  store.updateTask.mockImplementation(async (_id: string, updates: any) => {
    task = { ...task, ...updates };
    return task;
  });
  store.moveTask.mockImplementation(async (id: string, column: string) => {
    task = { ...task, id, column };
  });

  mockedCreateFnAgent.mockImplementation(async ({ customTools }: any) => {
    tool = customTools.find((t: any) => t.name === "fn_task_done");
    return { session: { prompt: vi.fn().mockResolvedValue(undefined), dispose: vi.fn() } } as any;
  });

  const executor = new TaskExecutor(store as any, "/repo");
  await executor.execute(task as any);

  // execute() runs a mock session that never calls fn_task_done, so its own
  // "finished without fn_task_done" recovery touches these mocks. Clear that
  // history so assertions capture ONLY the direct tool.execute() call below.
  store.updateTask.mockClear();
  store.moveTask.mockClear();
  store.updateStep.mockClear();
  store.logEntry.mockClear();
  store.recordRunAuditEvent.mockClear();

  return { store, tool, getTask: () => task };
}

describe("FN-8141 fn_task_done honest blocked exit", () => {
  beforeEach(() => {
    resetExecutorMocks();
    vi.spyOn(worktreePool, "isUsableTaskWorktree").mockResolvedValue(true);
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-parse --show-toplevel")) return Buffer.from("/repo/.worktrees/swift-falcon\n");
      if (cmd.includes("rev-parse --abbrev-ref HEAD")) return Buffer.from("fusion/fn-8141\n");
      if (cmd.includes("rev-list --count")) return Buffer.from("0\n");
      if (cmd.includes("rev-parse HEAD")) return Buffer.from("def456\n");
      return Buffer.from("");
    });
  });

  it("parks failed with a BLOCKED: error and does NOT trip the bulk-completion refusal", async () => {
    const { store, tool } = await setup();

    const result = await tool.execute("id", {
      outcome: "blocked",
      reason: "pi 0.80.10 removed AuthStorage; SDK bump cannot pass verify:fast",
      blockedBy: ["FN-8145"],
    });

    // Not a refusal — the blocked exit bypasses the completion gates.
    expect(result.content[0].text).not.toContain("fn_task_done refused");
    expect(result.content[0].text).toContain("parked as blocked");

    // Parked failed with the BLOCKED: convention; requeue budget untouched.
    const parkCall = store.updateTask.mock.calls.find(
      (c: any[]) => c[1]?.status === "failed" && typeof c[1]?.error === "string" && c[1].error.startsWith("BLOCKED:"),
    );
    expect(parkCall).toBeTruthy();
    expect(parkCall![1].error).toBe("BLOCKED: pi 0.80.10 removed AuthStorage; SDK bump cannot pass verify:fast");
    // The bulk-completion refusal path requeues to todo — blocked must not.
    expect(store.moveTask).not.toHaveBeenCalled();
  });

  it("records blockedBy as real dependency edges, unioned with existing, so the task requeues behind the blocker", async () => {
    const { store, tool } = await setup({ dependencies: ["FN-0001"] });

    await tool.execute("id", {
      outcome: "blocked",
      reason: "upstream break",
      blockedBy: ["FN-8145", "FN-8145", " FN-8146 "],
    });

    const depCall = store.updateTask.mock.calls.find((c: any[]) => Array.isArray(c[1]?.dependencies));
    expect(depCall).toBeTruthy();
    expect(depCall![1].dependencies).toEqual(["FN-0001", "FN-8145", "FN-8146"]);
  });

  it("emits task:execution-blocked-parked with ids/outcomes-only metadata (no reason prose)", async () => {
    const { store, tool } = await setup();

    await tool.execute("id", {
      outcome: "blocked",
      reason: "secret blocker prose that must never land in run-audit metadata",
      blockedBy: ["FN-8145"],
    });

    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        mutationType: "task:execution-blocked-parked",
        target: "FN-8141",
        metadata: { taskId: "FN-8141", blockedBy: ["FN-8145"], hasReason: true },
      }),
    );
    const auditCall = store.recordRunAuditEvent.mock.calls[0][0];
    expect(JSON.stringify(auditCall.metadata)).not.toContain("secret blocker prose");
  });

  it("leaves steps in their true statuses (no auto-done, no auto-skip)", async () => {
    const { store, tool } = await setup();

    await tool.execute("id", { outcome: "blocked", reason: "cannot proceed" });

    expect(store.updateStep).not.toHaveBeenCalled();
  });

  it("requires a non-empty reason before parking", async () => {
    const { store, tool } = await setup();

    const result = await tool.execute("id", { outcome: "blocked", reason: "   " });

    expect(result.content[0].text).toContain("requires a non-empty `reason`");
    // No park write, and no blocked audit event (execute() emits unrelated audit events, so scope the check).
    const parkCall = store.updateTask.mock.calls.find(
      (c: any[]) => typeof c[1]?.error === "string" && c[1].error.startsWith("BLOCKED:"),
    );
    expect(parkCall).toBeUndefined();
    const blockedAudit = store.recordRunAuditEvent.mock.calls.find(
      (c: any[]) => c[0]?.mutationType === "task:execution-blocked-parked",
    );
    expect(blockedAudit).toBeUndefined();
  });

  it("completed outcome (default) is unchanged — still marks steps done and hands off", async () => {
    const { store, tool } = await setup({
      steps: [{ name: "Implement", status: "in-progress" as const }],
    });
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-parse --show-toplevel")) return Buffer.from("/repo/.worktrees/swift-falcon\n");
      if (cmd.includes("rev-parse --abbrev-ref HEAD")) return Buffer.from("fusion/fn-8141\n");
      if (cmd.includes("rev-list --count")) return Buffer.from("1\n");
      if (cmd.includes("rev-parse HEAD")) return Buffer.from("def456\n");
      return Buffer.from("");
    });

    const result = await tool.execute("id", { summary: "Implemented the fix and verified." });

    expect(result.content[0].text).toContain("Task marked complete");
    expect(store.updateStep).toHaveBeenCalledWith("FN-8141", 0, "done");
    expect(store.recordRunAuditEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ mutationType: "task:execution-blocked-parked" }),
    );
  });
});

describe("FN-8141 blocked-parked task is not auto-recovered by the completed-todo sweep", () => {
  function blockedParkedTask(overrides: Record<string, unknown> = {}) {
    return {
      id: "FN-8141",
      title: "Blocked exit test",
      column: "in-progress",
      status: "failed",
      error: "BLOCKED: upstream pi SDK break",
      dependencies: ["FN-8145"],
      paused: false,
      // Steps stay in their true statuses — NOT all done/skipped.
      steps: [
        { name: "Implement", status: "in-progress" as const },
        { name: "Testing & Verification", status: "pending" as const },
      ],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...overrides,
    };
  }

  it("recoverStrandedCompletedTodoTasks never promotes a blocked-parked row", async () => {
    const store = createMockStore();
    const recoverCompletedTask = vi.fn().mockResolvedValue(true);

    // A blocked-parked task, even if it somehow surfaces in a todo listing, is filtered out
    // because task.error is set AND its steps are not all done/skipped.
    store.listTasks = vi.fn().mockResolvedValue([blockedParkedTask({ column: "todo" })]);

    const manager = new SelfHealingManager(store as any, {
      rootDir: "/tmp/test",
      recoverCompletedTask: recoverCompletedTask as any,
      getExecutingTaskIds: () => new Set<string>(),
    });

    const recovered = await manager.recoverStrandedCompletedTodoTasks();

    expect(recovered).toBe(0);
    expect(recoverCompletedTask).not.toHaveBeenCalled();
  });

  it("guard sanity: the blocked-parked shape has non-complete steps so the sweep's completion predicate is false", () => {
    const t = blockedParkedTask({ column: "todo" });
    const allDoneOrSkipped = t.steps.every((s) => {
      const status = s.status as string;
      return status === "done" || status === "skipped";
    });
    expect(allDoneOrSkipped).toBe(false);
    // And the FN-6461 no-op finalize guard is not what stops it — task.error is the primary gate.
    expect(Boolean((t as any).error)).toBe(true);
    // evaluateNoCommitsNoOpFinalize is import-checked to keep the guard reference honest.
    expect(typeof evaluateNoCommitsNoOpFinalize).toBe("function");
  });
});

/*
FNXC:Lifecycle 2026-07-16-21:22:
FN-8141 follow-up 1 — the honest blocked park must SURVIVE the graph-teardown machinery that undid the
original incident's failed park. In FN-8141 the pause-abort classifier and the workflow-graph failure
handler bounced the parked-failed task back to `todo` (clearing status/error) or overwrote the distinctive
`BLOCKED:` error with a generic graph-failure string — either of which re-opens the laundering hole because
self-healing (#2257/#2260) and dependency-gated scheduling key off exactly that error + the recorded
blockedBy dependencies. These tests drive handleGraphFailure (the graph-teardown sink) against a live
blocked park across the enumerated surfaces: pause-abort (hard-cancel), engine-internal auto-continue, and
the plain terminal graph-failure sink. Invariant asserted on every surface: the row stays parked
(status:"failed", error starts with "BLOCKED:", dependencies intact), is NOT moved to todo, is NOT
auto-continued into a new agent session, keeps its steps, and releases its worktree/concurrency slot.
*/
describe("FN-8141 follow-up 1 — blocked park survives graph teardown", () => {
  const now = "2026-07-16T00:00:00.000Z";

  function blockedParkedDetail(overrides: Record<string, unknown> = {}) {
    return {
      id: "FN-8141",
      title: "Blocked exit test",
      description: "",
      column: "in-progress",
      status: "failed",
      error: "BLOCKED: pi 0.80.10 removed AuthStorage; SDK bump cannot pass verify:fast",
      dependencies: ["FN-8145"],
      worktree: "/repo/.worktrees/swift-falcon",
      branch: "fusion/fn-8141",
      baseBranch: "main",
      paused: false,
      userPaused: false,
      autoMerge: true,
      mergeRetries: 0,
      // True statuses — NOT all done/skipped — so a laundered "complete" state can never form.
      steps: [
        { name: "Implement", status: "in-progress" as const },
        { name: "Testing & Verification", status: "pending" as const },
      ],
      currentStep: 0,
      log: [],
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };
  }

  function makeHarness(overrides: Record<string, unknown> = {}) {
    const store = createMockStore();
    const task = blockedParkedDetail(overrides);
    store.getTask.mockResolvedValue(task as any);
    store.getSettings.mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
      autoMerge: true,
      maxAutoMergeRetries: 3,
    } as any);
    store.recordRunAuditEvent = vi.fn().mockResolvedValue(undefined);
    const executor = new TaskExecutor(store as any, "/repo", {} as any);
    return { store, task, executor };
  }

  async function invokeGraphFailure(
    executor: TaskExecutor,
    task: any,
    resultOverrides: Record<string, unknown> = {},
  ) {
    await (executor as any).handleGraphFailure(task, {
      disposition: "failed",
      outcome: "failure",
      visitedNodeIds: ["plan", "execute"],
      context: {},
      ...resultOverrides,
    });
  }

  function logText(store: ReturnType<typeof createMockStore>): string {
    return store.logEntry.mock.calls.map((call: unknown[]) => call[1]).join("\n");
  }

  function assertParkPreserved(store: ReturnType<typeof createMockStore>, executor: TaskExecutor) {
    // Never moved to todo (the FN-8141 bounce).
    expect(store.moveTask).not.toHaveBeenCalled();
    // status/error never cleared to null...
    const clearedStatusOrError = store.updateTask.mock.calls.some((call: unknown[]) => {
      const patch = call[1] as { status?: unknown; error?: unknown } | undefined;
      return patch?.status === null || patch?.error === null;
    });
    expect(clearedStatusOrError).toBe(false);
    // ...and the distinctive BLOCKED: error is never overwritten by a generic graph-failure string.
    const overwroteBlockedError = store.updateTask.mock.calls.some((call: unknown[]) => {
      const patch = call[1] as { error?: unknown } | undefined;
      return typeof patch?.error === "string" && !patch.error.startsWith("BLOCKED:");
    });
    expect(overwroteBlockedError).toBe(false);
    // Dependencies never mutated.
    const mutatedDeps = store.updateTask.mock.calls.some(
      (call: unknown[]) => (call[1] as { dependencies?: unknown } | undefined)?.dependencies !== undefined,
    );
    expect(mutatedDeps).toBe(false);
    // Steps left untouched.
    expect(store.updateStep).not.toHaveBeenCalled();
    // Worktree/concurrency slot released; no leaked maxWorktrees holder (FN-6782).
    expect((executor as any).activeWorktrees.has("FN-8141")).toBe(false);
    expect((executor as any).pausedAborted.has("FN-8141")).toBe(false);
    // Honor-park breadcrumb logged.
    expect(logText(store)).toContain("honoring park, not requeueing, retrying, or clearing state");
  }

  beforeEach(() => {
    resetExecutorMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("honors the park under a hard-cancel pause-abort bounce (no requeue, no clear, no auto-continue)", async () => {
    const { store, task, executor } = makeHarness();
    (executor as any).addActiveWorktree(task.id, task.worktree);
    // The exact FN-8141 teardown: pause-abort mark/classify/cleanup fired hard-cancel.
    (executor as any).markPausedAborted(task.id, "hard-cancel");
    const executeSpy = vi.spyOn(executor as any, "execute").mockResolvedValue(undefined);

    await invokeGraphFailure(executor, task, {
      interruptedNodeId: "execute",
      interruptedAbortKind: "engine-pause",
      context: { "node:execute:value": "aborted", "node:execute:abortKind": "engine-pause" },
    });

    assertParkPreserved(store, executor);
    // NOT auto-continued into a fresh agent session (the engine-internal auto-continue path).
    await vi.advanceTimersByTimeAsync(10);
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("honors the park under a plain terminal graph failure (no pause-abort marker) — the sink never overwrites BLOCKED:", async () => {
    // Without the guard, the terminal graph-failure sink overwrites error with
    // "Workflow graph terminated with failure at node 'execute'", erasing the BLOCKED: marker.
    const { store, task, executor } = makeHarness();
    (executor as any).addActiveWorktree(task.id, task.worktree);
    const executeSpy = vi.spyOn(executor as any, "execute").mockResolvedValue(undefined);

    await invokeGraphFailure(executor, task, {
      visitedNodeIds: ["plan", "execute"],
      context: { "node:execute:value": "aborted" },
    });

    assertParkPreserved(store, executor);
    await vi.advanceTimersByTimeAsync(10);
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("does NOT emit a redundant blocked-parked run-audit event on the honor-park (the exit already emitted it)", async () => {
    const { store, task, executor } = makeHarness();
    (executor as any).addActiveWorktree(task.id, task.worktree);
    (executor as any).markPausedAborted(task.id, "hard-cancel");

    await invokeGraphFailure(executor, task);

    expect(store.recordRunAuditEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ mutationType: "task:execution-blocked-parked" }),
    );
  });

  it("NON-blocked failed park keeps existing behavior — the honor-park guard does not fire", async () => {
    // A generic terminal graph failure (error does NOT start with BLOCKED:) must fall through to
    // the normal terminal sink and park failed with the generic message — the guard is scoped to BLOCKED:.
    const { store, task, executor } = makeHarness({
      status: null,
      error: null,
    });

    await invokeGraphFailure(executor, task, {
      visitedNodeIds: ["plan", "execute"],
      context: { "node:execute:value": "some-non-blocked-failure" },
    });

    // Generic terminal park still happens.
    const parkedFailed = store.updateTask.mock.calls.some(
      (call: unknown[]) => (call[1] as { status?: string } | undefined)?.status === "failed",
    );
    expect(parkedFailed).toBe(true);
    // The blocked honor-park breadcrumb is absent.
    expect(logText(store)).not.toContain("honoring park, not requeueing, retrying, or clearing state");
  });

  it("a cleared (unblocked) row is NOT re-honor-parked — the stale BLOCKED: error must not wedge a requeue", async () => {
    // Operator requeue via moveTask(in-progress→todo) clears status/error (moves.ts reopen); a
    // re-dispatched row therefore carries no BLOCKED: error. The guard keys off the LIVE error, so
    // once cleared it must not fire and re-wedge the row — normal graph-failure handling resumes.
    const { store, task, executor } = makeHarness({
      status: null,
      error: null,
    });

    await invokeGraphFailure(executor, task, {
      visitedNodeIds: ["plan", "execute"],
      context: { "node:execute:value": "some-non-blocked-failure" },
    });

    // Guard did not intercept — the normal terminal sink parked failed instead.
    expect(logText(store)).not.toContain("honoring park, not requeueing, retrying, or clearing state");
    const parkedFailed = store.updateTask.mock.calls.some(
      (call: unknown[]) => (call[1] as { status?: string } | undefined)?.status === "failed",
    );
    expect(parkedFailed).toBe(true);
  });
});
