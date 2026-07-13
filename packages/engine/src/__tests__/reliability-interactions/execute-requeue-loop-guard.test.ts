import { describe, expect, it, vi } from "vitest";
import type { TaskDetail } from "@fusion/core";
import "../executor-test-helpers.js";
import {
  EXECUTE_REQUEUE_LOOP_VISIBLE_THRESHOLD,
  MAX_EXECUTE_REQUEUE_LOOP_CYCLES,
  TaskExecutor,
} from "../../executor.js";
import { SelfHealingManager } from "../../self-healing.js";
import { createMockStore, resetExecutorMocks } from "../executor-test-helpers.js";

const COMPLETED_BLOCKED_PAUSE_REASON = "completed-work-blocked";

const now = "2026-07-12T00:00:00.000Z";

function task(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: "FN-7863-T",
    title: "Execute requeue loop",
    description: "Bound execute self-requeue loops",
    column: "todo",
    dependencies: [],
    steps: [{ name: "Implement", status: "pending" }],
    currentStep: 0,
    log: [],
    branch: "fusion/fn-7863",
    baseBranch: "main",
    worktree: "/tmp/fusion-fn-7863",
    status: null,
    error: null,
    paused: false,
    userPaused: false,
    autoMerge: true,
    mergeRetries: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as TaskDetail;
}

function harness(initial: TaskDetail, relatedTasks: TaskDetail[] = []) {
  resetExecutorMocks();
  const store = createMockStore();
  let live = { ...initial } as TaskDetail;
  const related = new Map(relatedTasks.map((candidate) => [candidate.id, candidate]));
  store.getTask.mockImplementation(async (id: string) => {
    if (id === live.id) return live;
    const found = related.get(id);
    if (!found) throw new Error(`missing task ${id}`);
    return found;
  });
  store.updateTask.mockImplementation(async (id: string, updates: Partial<TaskDetail>) => {
    if (id === live.id) {
      live = { ...live, ...updates } as TaskDetail;
      return live;
    }
    const found = related.get(id);
    if (!found) throw new Error(`missing task ${id}`);
    const updated = { ...found, ...updates } as TaskDetail;
    related.set(id, updated);
    return updated;
  });
  store.moveTask.mockImplementation(async (id: string, column: TaskDetail["column"], options?: { preservePause?: boolean }) => {
    if (id !== live.id) throw new Error(`unexpected move ${id}`);
    live = {
      ...live,
      column,
      ...(options?.preservePause ? {} : { paused: false, pausedReason: undefined }),
    } as TaskDetail;
    return live;
  });
  store.listTasks.mockImplementation(async () => [live, ...Array.from(related.values())]);
  store.getSettings.mockResolvedValue({ autoMerge: true, globalPause: false, enginePaused: false });
  store.recordRunAuditEvent = vi.fn().mockResolvedValue(undefined);
  const executor = new TaskExecutor(store, "/tmp/test");
  return {
    store,
    executor,
    get live() {
      return live;
    },
    setLive(patch: Partial<TaskDetail>) {
      live = { ...live, ...patch } as TaskDetail;
    },
    setRelated(id: string, patch: Partial<TaskDetail>) {
      const found = related.get(id);
      if (!found) throw new Error(`missing related task ${id}`);
      related.set(id, { ...found, ...patch } as TaskDetail);
    },
  };
}

async function failAtExecute(executor: TaskExecutor, taskSnapshot: TaskDetail) {
  await (executor as any).handleGraphFailure(taskSnapshot, {
    disposition: "failed",
    outcome: "failure",
    visitedNodeIds: ["execute"],
    context: { "node:execute:value": "implementation-incomplete" },
  });
}

describe("execute requeue loop guard", () => {
  it("terminalizes unchanged todo execute self-requeues and preserves progress", async () => {
    const h = harness(task({
      id: "FN-7863-TODO",
      column: "todo",
      steps: [
        { name: "Preflight", status: "done" },
        { name: "Implement", status: "in-progress" },
      ],
      currentStep: 1,
    }));

    for (let i = 0; i < MAX_EXECUTE_REQUEUE_LOOP_CYCLES; i += 1) {
      await failAtExecute(h.executor, h.live);
    }

    expect(h.store.updateTask).toHaveBeenCalledWith(
      "FN-7863-TODO",
      expect.objectContaining({
        status: "failed",
        error: expect.stringMatching(/^EXECUTION_DISPATCH_LOOP_EXHAUSTED:/),
        executeRequeueLoopCount: MAX_EXECUTE_REQUEUE_LOOP_CYCLES,
      }),
      undefined,
    );
    expect(h.store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "task:execution-dispatch-loop-terminalized",
      metadata: expect.objectContaining({
        taskId: "FN-7863-TODO",
        cycleCount: MAX_EXECUTE_REQUEUE_LOOP_CYCLES,
        maxCycles: MAX_EXECUTE_REQUEUE_LOOP_CYCLES,
        failureValue: "implementation-incomplete",
      }),
    }));
    expect(h.store.moveTask).not.toHaveBeenCalled();
    const terminalUpdate = h.store.updateTask.mock.calls.find((call: any[]) => call[1]?.status === "failed")?.[1];
    expect(terminalUpdate).not.toHaveProperty("worktree");
    expect(terminalUpdate).not.toHaveProperty("branch");
    expect(terminalUpdate).not.toHaveProperty("steps");
    const lastLog = h.store.logEntry.mock.calls.at(-1)?.[1] as string;
    expect(lastLog).toMatch(/^EXECUTION_DISPATCH_LOOP_EXHAUSTED:/);
    expect(lastLog).not.toContain("executor recovery preserved");
  });

  it("terminalizes the stale in-progress self-requeue marker path", async () => {
    const h = harness(task({ id: "FN-7863-STALE", column: "in-progress" }));
    (h.executor as any).graphRouting.add("FN-7863-STALE");
    (h.executor as any).markGraphExecuteSelfRequeued("FN-7863-STALE");

    for (let i = 0; i < MAX_EXECUTE_REQUEUE_LOOP_CYCLES; i += 1) {
      await failAtExecute(h.executor, h.live);
    }

    expect(h.store.updateTask).toHaveBeenCalledWith(
      "FN-7863-STALE",
      expect.objectContaining({ status: "failed", error: expect.stringMatching(/^EXECUTION_DISPATCH_LOOP_EXHAUSTED:/) }),
      undefined,
    );
  });

  it("terminalizes drifting-signature execute self-requeues with no monotonic step progress", async () => {
    const h = harness(task({
      id: "FN-7941-DRIFT",
      column: "todo",
      steps: [
        { name: "Preflight", status: "pending" },
        { name: "Implement", status: "pending" },
      ],
      currentStep: 0,
    }));

    for (let i = 0; i < MAX_EXECUTE_REQUEUE_LOOP_CYCLES; i += 1) {
      h.setLive({
        currentStep: i % 2,
        steps: [
          { name: "Preflight", status: i % 2 === 0 ? "pending" : "in-progress" },
          { name: "Implement", status: i % 2 === 0 ? "in-progress" : "pending" },
        ],
      });
      await failAtExecute(h.executor, h.live);
    }

    expect(h.store.updateTask).toHaveBeenCalledWith(
      "FN-7941-DRIFT",
      expect.objectContaining({
        status: "failed",
        error: expect.stringMatching(/^EXECUTION_DISPATCH_LOOP_EXHAUSTED:/),
        executeRequeueLoopCount: MAX_EXECUTE_REQUEUE_LOOP_CYCLES,
      }),
      undefined,
    );
    expect(h.store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "task:execution-dispatch-loop-terminalized",
      metadata: expect.objectContaining({
        taskId: "FN-7941-DRIFT",
        cycleCount: MAX_EXECUTE_REQUEUE_LOOP_CYCLES,
      }),
    }));
  });

  it("bounds done-to-in-progress signature oscillation after the terminal-step high-water stops increasing", async () => {
    const h = harness(task({
      id: "FN-7941-DONE-OSCILLATION",
      column: "todo",
      steps: [{ name: "Implement", status: "in-progress" }],
      currentStep: 0,
    }));

    for (let i = 0; i < MAX_EXECUTE_REQUEUE_LOOP_CYCLES + 1; i += 1) {
      h.setLive({
        steps: [{ name: "Implement", status: i % 2 === 0 ? "in-progress" : "done" }],
      });
      await failAtExecute(h.executor, h.live);
    }

    expect(h.store.updateTask).toHaveBeenCalledWith(
      "FN-7941-DONE-OSCILLATION",
      expect.objectContaining({
        status: "failed",
        error: expect.stringMatching(/^EXECUTION_DISPATCH_LOOP_EXHAUSTED:/),
        executeRequeueLoopCount: MAX_EXECUTE_REQUEUE_LOOP_CYCLES,
      }),
      undefined,
    );
  });

  it("resets the streak on real step progress and never terminalizes", async () => {
    const stepCount = MAX_EXECUTE_REQUEUE_LOOP_CYCLES + 3;
    const h = harness(task({
      id: "FN-7863-PROGRESS",
      column: "todo",
      steps: Array.from({ length: stepCount }, (_, index) => ({ name: `Step ${index}`, status: "pending" })),
    }));

    for (let i = 0; i < stepCount; i += 1) {
      h.setLive({
        currentStep: i,
        steps: Array.from({ length: stepCount }, (_, index) => ({
          name: `Step ${index}`,
          status: index <= i ? "done" : index === i + 1 ? "in-progress" : "pending",
        })) as any,
      });
      await failAtExecute(h.executor, h.live);
    }

    expect(h.store.updateTask).not.toHaveBeenCalledWith(
      "FN-7863-PROGRESS",
      expect.objectContaining({ status: "failed" }),
      expect.anything(),
    );
    expect(h.live.executeRequeueLoopCount).toBe(1);
  });

  it("emits a visible warning at the threshold without terminalizing", async () => {
    const h = harness(task({ id: "FN-7863-WARN", column: "todo" }));

    for (let i = 0; i < EXECUTE_REQUEUE_LOOP_VISIBLE_THRESHOLD; i += 1) {
      await failAtExecute(h.executor, h.live);
    }

    expect(h.store.logEntry).toHaveBeenCalledWith(
      "FN-7863-WARN",
      expect.stringContaining(`Execution dispatch loop building: ${EXECUTE_REQUEUE_LOOP_VISIBLE_THRESHOLD}/${MAX_EXECUTE_REQUEUE_LOOP_CYCLES}`),
      undefined,
      undefined,
    );
    expect(h.store.updateTask).not.toHaveBeenCalledWith(
      "FN-7863-WARN",
      expect.objectContaining({ status: "failed" }),
      expect.anything(),
    );
  });

  it.each([
    ["userPaused", { userPaused: true }],
    ["paused", { paused: true }],
  ])("does not terminalize %s tasks from the benign branch", async (_label, patch) => {
    const h = harness(task({ id: `FN-7863-${_label}`, column: "todo", ...patch }));

    for (let i = 0; i < MAX_EXECUTE_REQUEUE_LOOP_CYCLES; i += 1) {
      await failAtExecute(h.executor, h.live);
    }

    expect(h.store.updateTask).not.toHaveBeenCalledWith(
      h.live.id,
      expect.objectContaining({ status: "failed" }),
      expect.anything(),
    );
    expect(h.store.logEntry).toHaveBeenCalledWith(
      h.live.id,
      expect.stringContaining("paused awaiting explicit unpause"),
      undefined,
      undefined,
    );
  });

  it.each([
    ["blockedBy", { blockedBy: "FN-BLOCKER", dependencies: [] }, "task is blocked by FN-BLOCKER"],
    ["dependencies", { blockedBy: null, dependencies: ["FN-BLOCKER"] }, "task has unresolved dependencies: FN-BLOCKER"],
  ])("parks completed-but-blocked tasks before the %s execute requeue loop can terminalize", async (_label, patch, blockerReason) => {
    const h = harness(
      task({
        id: "FN-7926-PARK",
        column: "todo",
        steps: [
          { name: "Preflight", status: "done" },
          { name: "Implement", status: "skipped" },
        ],
        ...patch,
      }),
      [task({ id: "FN-BLOCKER", column: "todo" })],
    );

    await failAtExecute(h.executor, h.live);

    expect(h.live).toMatchObject({
      column: "todo",
      paused: true,
      pausedReason: COMPLETED_BLOCKED_PAUSE_REASON,
      status: "queued",
      error: null,
      executeRequeueLoopCount: null,
      executeRequeueLoopSignature: null,
    });

    for (let i = 0; i < MAX_EXECUTE_REQUEUE_LOOP_CYCLES + 1; i += 1) {
      await failAtExecute(h.executor, h.live);
    }
    expect(h.store.logEntry).toHaveBeenCalledWith(
      "FN-7926-PARK",
      expect.stringContaining(`Completed work held — ${blockerReason}; will advance to review when blocker clears`),
      undefined,
      undefined,
    );
    expect(h.store.updateTask).not.toHaveBeenCalledWith(
      "FN-7926-PARK",
      expect.objectContaining({ status: "failed", error: expect.stringMatching(/^EXECUTION_DISPATCH_LOOP_EXHAUSTED:/) }),
      expect.anything(),
    );
    expect(h.store.recordRunAuditEvent).not.toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "task:execution-dispatch-loop-terminalized",
    }));
  });

  it("parks explicit taskDone completion even when the task has zero planned steps", async () => {
    const h = harness(
      task({
        id: "FN-7926-TASKDONE",
        column: "in-progress",
        blockedBy: "FN-BLOCKER",
        steps: [],
      }),
      [task({ id: "FN-BLOCKER", column: "todo" })],
    );

    const shouldFinalize = await (h.executor as any).shouldFinalizeCompletedTask("FN-7926-TASKDONE", true);

    expect(shouldFinalize).toBe(false);
    expect(h.live).toMatchObject({
      column: "todo",
      paused: true,
      pausedReason: COMPLETED_BLOCKED_PAUSE_REASON,
      status: "queued",
    });
  });

  it("parks the stale in-progress self-requeue marker path when completed work is blocked", async () => {
    const h = harness(
      task({
        id: "FN-7926-STALE",
        column: "in-progress",
        blockedBy: "FN-BLOCKER",
        steps: [{ name: "Implement", status: "done" }],
      }),
      [task({ id: "FN-BLOCKER", column: "todo" })],
    );
    (h.executor as any).graphRouting.add("FN-7926-STALE");
    (h.executor as any).markGraphExecuteSelfRequeued("FN-7926-STALE");

    await failAtExecute(h.executor, h.live);

    expect(h.live).toMatchObject({
      column: "todo",
      paused: true,
      pausedReason: COMPLETED_BLOCKED_PAUSE_REASON,
      status: "queued",
    });
    expect(h.store.moveTask).toHaveBeenCalledWith("FN-7926-STALE", "todo", expect.objectContaining({
      preserveProgress: true,
      preserveResumeState: true,
      preserveWorktree: true,
    }));
  });

  it.each([
    ["paused", { paused: true }],
    ["userPaused", { userPaused: true }],
    ["zero-step", { steps: [] }],
  ])("does not completed-block park %s tasks", async (_label, patch) => {
    const h = harness(
      task({
        id: "FN-7926-GUARD",
        column: "todo",
        blockedBy: "FN-BLOCKER",
        steps: [{ name: "Implement", status: "done" }],
        ...patch,
      }),
      [task({ id: "FN-BLOCKER", column: "todo" })],
    );

    await failAtExecute(h.executor, h.live);

    expect(h.live.pausedReason).not.toBe(COMPLETED_BLOCKED_PAUSE_REASON);
    expect(h.store.logEntry).not.toHaveBeenCalledWith(
      "FN-7926-GUARD",
      expect.stringContaining("Completed work held"),
      expect.anything(),
      expect.anything(),
    );
  });

  it("auto-advances a completed-blocked park to review when the blocker clears", async () => {
    const h = harness(
      task({
        id: "FN-7926-ADVANCE",
        column: "todo",
        blockedBy: "FN-BLOCKER",
        paused: true,
        pausedReason: COMPLETED_BLOCKED_PAUSE_REASON,
        status: "queued",
        steps: [{ name: "Implement", status: "done" }],
      }),
      [task({ id: "FN-BLOCKER", column: "todo" })],
    );
    const recoverCompletedTask = vi.fn(async (completed: TaskDetail) => {
      h.setLive({
        column: "in-review",
        paused: false,
        pausedReason: undefined,
        status: null,
        error: null,
        blockedBy: null,
      });
      return completed.id === "FN-7926-ADVANCE";
    });
    const healer = new SelfHealingManager(h.store, {
      rootDir: "/tmp/test",
      recoverCompletedTask: recoverCompletedTask as any,
      getExecutingTaskIds: () => new Set(),
      isTaskActive: () => false,
    });

    await (healer as any).reconcileCompletedBlockedTasks();
    expect(recoverCompletedTask).not.toHaveBeenCalled();

    h.setRelated("FN-BLOCKER", { column: "done" });
    await (healer as any).reconcileCompletedBlockedTasks();

    expect(recoverCompletedTask).toHaveBeenCalledWith(expect.objectContaining({ id: "FN-7926-ADVANCE" }));
    expect(h.live).toMatchObject({ column: "in-review", paused: false, status: null, blockedBy: null });
    expect(h.store.logEntry).toHaveBeenCalledWith(
      "FN-7926-ADVANCE",
      expect.stringContaining("Auto-advanced completed blocked work to review after blocker cleared"),
    );
  });

  it("auto-advances a zero-step taskDone completed-blocked park once the blocker clears (invariant: park and advance must agree on workComplete)", async () => {
    // Regression for the FN-7926 park/advance asymmetry: parkCompletedBlockedTask()
    // accepts workComplete=taskDone for a task with zero planned steps (see the
    // "parks explicit taskDone completion even when the task has zero planned steps"
    // test above), so reconcileCompletedBlockedTasks() must be able to un-park that
    // exact shape too, or the row is stranded forever behind the pause.
    const h = harness(
      task({
        id: "FN-7926-ADVANCE-ZEROSTEP",
        column: "todo",
        blockedBy: "FN-BLOCKER",
        paused: true,
        pausedReason: COMPLETED_BLOCKED_PAUSE_REASON,
        status: "queued",
        steps: [],
      }),
      [task({ id: "FN-BLOCKER", column: "todo" })],
    );
    const recoverCompletedTask = vi.fn(async (completed: TaskDetail) => {
      h.setLive({
        column: "in-review",
        paused: false,
        pausedReason: undefined,
        status: null,
        error: null,
        blockedBy: null,
      });
      return completed.id === "FN-7926-ADVANCE-ZEROSTEP";
    });
    const healer = new SelfHealingManager(h.store, {
      rootDir: "/tmp/test",
      recoverCompletedTask: recoverCompletedTask as any,
      getExecutingTaskIds: () => new Set(),
      isTaskActive: () => false,
    });

    await (healer as any).reconcileCompletedBlockedTasks();
    expect(recoverCompletedTask).not.toHaveBeenCalled();

    h.setRelated("FN-BLOCKER", { column: "done" });
    await (healer as any).reconcileCompletedBlockedTasks();

    expect(recoverCompletedTask).toHaveBeenCalledWith(expect.objectContaining({ id: "FN-7926-ADVANCE-ZEROSTEP" }));
    expect(h.live).toMatchObject({ column: "in-review", paused: false, status: null, blockedBy: null });
  });
});
