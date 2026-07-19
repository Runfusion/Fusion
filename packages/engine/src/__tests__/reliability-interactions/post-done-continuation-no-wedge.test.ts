import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskStore } from "@fusion/core";
import "../executor-test-helpers.js";
import { TaskExecutor } from "../../executor.js";
import { MAX_POST_DONE_NONCONTINUABLE_WEDGE_RECOVERIES, SelfHealingManager } from "../../self-healing.js";
import { MAX_RECOVERY_RETRIES } from "../../recovery-policy.js";
import { mockExecuteAll, mockedCreateFnAgent, resetExecutorMocks } from "../executor-test-helpers.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-5866",
    title: "Prevent executor from continuing post-done sessions",
    description: "regression fixture",
    column: "in-progress",
    status: undefined,
    error: undefined,
    paused: false,
    userPaused: false,
    dependencies: [],
    steps: [{ name: "Implement", status: "pending" as const }],
    currentStep: 0,
    workflowStepResults: [],
    log: [],
    prompt: "# Task\n\n## Steps\n\n### Step 0: Implement\n- [ ] do the work\n",
    branch: "fusion/fn-5866",
    worktree: "/tmp/test/.worktrees/swift-falcon",
    createdAt: "2026-06-02T00:00:00.000Z",
    updatedAt: "2026-06-02T00:00:00.000Z",
    ...overrides,
  } as Task;
}

function createStore(task: Task, settingsOverrides: Record<string, unknown> = {}): TaskStore & EventEmitter {
  const emitter = new EventEmitter() as TaskStore & EventEmitter;
  const audits: any[] = [];

  (emitter as any).__audits = audits;
  (emitter as any).getTask = vi.fn().mockImplementation(async () => task);
  (emitter as any).listTasks = vi.fn().mockImplementation(async ({ column }: { column?: string } = {}) => {
    if (!column) return [task];
    return task.column === column ? [task] : [];
  });
  (emitter as any).getSettings = vi.fn().mockResolvedValue({
    autoMerge: true,
    globalPause: false,
    enginePaused: false,
    maxConcurrent: 2,
    maxWorktrees: 4,
    pollIntervalMs: 15_000,
    groupOverlappingFiles: false,
    inReviewStallDeadlockThreshold: 3,
    taskStuckTimeoutMs: 60_000,
    ...settingsOverrides,
  });
  (emitter as any).updateTask = vi.fn().mockImplementation(async (_taskId: string, updates: Partial<Task>) => {
    const normalized = { ...updates } as Record<string, unknown>;
    if (normalized.status === null) normalized.status = undefined;
    if (normalized.error === null) normalized.error = undefined;
    Object.assign(task, normalized, { updatedAt: new Date(Date.now()).toISOString() });
    return task;
  });
  (emitter as any).moveTask = vi.fn().mockImplementation(async (_taskId: string, column: Task["column"]) => {
    task.column = column;
    task.updatedAt = new Date(Date.now()).toISOString();
    return task;
  });
  (emitter as any).handoffToReview = vi.fn().mockImplementation(async () => {
    task.column = "in-review";
    task.updatedAt = new Date(Date.now()).toISOString();
    return { ...task, autoMerge: task.autoMerge ?? true };
  });
  (emitter as any).mergeTask = vi.fn().mockResolvedValue(task);
  (emitter as any).logEntry = vi.fn().mockImplementation(async (_taskId: string, action: string, detail?: string) => {
    task.log = task.log ?? [];
    task.log.push({ timestamp: new Date(Date.now()).toISOString(), action, detail } as any);
  });
  (emitter as any).recordRunAuditEvent = vi.fn().mockImplementation(async (event: any) => {
    audits.push(event);
  });
  (emitter as any).appendAgentLog = vi.fn().mockResolvedValue(undefined);
  (emitter as any).getGoalStore = vi.fn().mockReturnValue({ listGoals: vi.fn().mockReturnValue([]) });
  (emitter as any).getFusionDir = vi.fn().mockReturnValue("/tmp/test/.fusion");
  (emitter as any).clearStaleExecutionStartBranchReferences = vi.fn().mockReturnValue([]);
  (emitter as any).listWorkflowSteps = vi.fn().mockResolvedValue([]);
  (emitter as any).getWorkflowStep = vi.fn().mockResolvedValue(undefined);
  (emitter as any).setPluginWorkflowStepTemplates = vi.fn().mockResolvedValue(undefined);
  (emitter as any).updateStep = vi.fn().mockResolvedValue(undefined);
  (emitter as any).parseStepsFromPrompt = vi.fn().mockResolvedValue([]);
  (emitter as any).parseFileScopeFromPrompt = vi.fn().mockResolvedValue([]);
  (emitter as any).getAgentLogs = vi.fn().mockResolvedValue([]);
  // FNXC:EngineTests 2026-07-17-06:30: graph tool-failure cursor reads getAgentLogCount at execute entry.
  (emitter as any).getAgentLogCount = vi.fn().mockResolvedValue(0);
  // FNXC:EngineTests 2026-07-19-01:20: FN-8296 pending verification before createFnAgent.
  (emitter as any).getTaskVerificationRequestAsync = vi.fn().mockResolvedValue(null);
  (emitter as any).claimTaskVerificationRequest = vi.fn().mockResolvedValue(null);
  (emitter as any).finishTaskVerificationRequest = vi.fn().mockResolvedValue(undefined);
  (emitter as any).updateSettings = vi.fn().mockResolvedValue(undefined);
  (emitter as any).emit = emitter.emit.bind(emitter);

  return emitter;
}

function createSelfHealingStore(tasks: Task[], settingsOverrides: Record<string, unknown> = {}): TaskStore & EventEmitter {
  const emitter = new EventEmitter() as TaskStore & EventEmitter;
  const audits: any[] = [];
  const taskMap = new Map(tasks.map((task) => [task.id, task]));

  (emitter as any).__audits = audits;
  (emitter as any).getTask = vi.fn().mockImplementation(async (taskId: string) => taskMap.get(taskId));
  (emitter as any).listTasks = vi.fn().mockImplementation(async ({ column }: { column?: string } = {}) => {
    const values = [...taskMap.values()];
    return column ? values.filter((task) => task.column === column) : values;
  });
  (emitter as any).getSettings = vi.fn().mockResolvedValue({
    autoMerge: true,
    globalPause: false,
    enginePaused: false,
    maxConcurrent: 2,
    maxWorktrees: 4,
    pollIntervalMs: 15_000,
    inReviewStallDeadlockThreshold: 3,
    taskStuckTimeoutMs: 60_000,
    ...settingsOverrides,
  });
  (emitter as any).updateTask = vi.fn().mockImplementation(async (taskId: string, updates: Partial<Task>) => {
    const task = taskMap.get(taskId)!;
    const normalized = { ...updates } as Record<string, unknown>;
    if (normalized.status === null) normalized.status = undefined;
    if (normalized.error === null) normalized.error = undefined;
    Object.assign(task, normalized, { updatedAt: new Date(Date.now()).toISOString() });
    return task;
  });
  (emitter as any).logEntry = vi.fn().mockImplementation(async (taskId: string, action: string, detail?: string) => {
    const task = taskMap.get(taskId)!;
    task.log = task.log ?? [];
    task.log.push({ timestamp: new Date(Date.now()).toISOString(), action, detail } as any);
  });
  (emitter as any).recordRunAuditEvent = vi.fn().mockImplementation(async (event: any) => {
    audits.push(event);
  });
  // FNXC:EngineTests 2026-07-17-06:30: graph tool-failure cursor reads getAgentLogCount at execute entry.
  (emitter as any).getAgentLogCount = vi.fn().mockResolvedValue(0);
  (emitter as any).getAgentLogs = vi.fn().mockResolvedValue([]);
  // FNXC:EngineTests 2026-07-19-01:20: FN-8296 pending verification before createFnAgent.
  (emitter as any).getTaskVerificationRequestAsync = vi.fn().mockResolvedValue(null);
  (emitter as any).claimTaskVerificationRequest = vi.fn().mockResolvedValue(null);
  (emitter as any).finishTaskVerificationRequest = vi.fn().mockResolvedValue(undefined);
  (emitter as any).emit = emitter.emit.bind(emitter);
  return emitter;
}

describe("FN-5866 reliability interactions: post-done continuation no wedge", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetExecutorMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps completed work cleanly in-review and avoids stall deadlock after a post-done continuation error", async () => {
    const task = makeTask();
    const store = createStore(task);
    const onComplete = vi.fn();
    const onError = vi.fn();

    mockedCreateFnAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockImplementation(async () => {
          task.steps = [{ name: "Implement", status: "done" as const }];
          task.currentStep = 1;
          task.column = "in-review";
          task.status = undefined;
          task.error = undefined;
          throw new Error("Cannot continue from message role: assistant");
        }),
        dispose: vi.fn(),
        getSessionStats: vi.fn().mockResolvedValue({
          tokens: { input: 11, output: 7, cacheRead: 0, cacheWrite: 0, total: 18 },
        }),
      },
    } as any);

    const executor = new TaskExecutor(store, "/tmp/test", { onComplete, onError });
    await executor.execute(task);

    expect(task.column).toBe("in-review");
    expect(task.status).toBeUndefined();
    expect(task.error).toBeUndefined();
    expect(onError).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalled();
    expect((store.handoffToReview as any).mock.calls.length).toBe(0);
    expect((task.log ?? []).some((entry: any) => entry.action.includes("Post-done session continuation suppressed"))).toBe(true);

    const manager = new SelfHealingManager(store, { rootDir: "/tmp/repo" });
    expect(await manager.surfaceInReviewStalls()).toBe(0);
    expect(task.paused).toBe(false);
    expect(((store as any).__audits as any[]).some((event) => event.mutationType === "task:in-review-stall-deadlock-disposed")).toBe(false);
    manager.stop();
  });

  it("keeps completed work cleanly in-review when a post-done step-session continuation is not continuable", async () => {
    const task = makeTask({
      id: "FN-5889-STEP-SESSION-WEDGE",
      steps: [{ name: "Implement", status: "in-progress" as const }],
    });
    const store = createStore(task, { runStepsInNewSessions: true });
    const onComplete = vi.fn();
    const onError = vi.fn();

    mockExecuteAll.mockImplementation(async () => {
      task.steps = [{ name: "Implement", status: "done" as const }];
      task.currentStep = 1;
      task.log = [
        ...task.log,
        { timestamp: new Date(Date.now()).toISOString(), action: "Task marked done by agent" } as any,
      ];
      throw new Error("Cannot continue from message role: assistant");
    });

    const executor = new TaskExecutor(store, "/tmp/test", { onComplete, onError, agentStore: { getAgent: vi.fn().mockResolvedValue(null) } as any });
    await executor.execute(task);

    // Pre-fix root cause: the post-done step-session catch in executor.ts marked
    // status=failed + handoff directly instead of consulting handleNonContinuableSessionError().
    expect(task.column).toBe("in-review");
    expect(task.status).toBeUndefined();
    expect(task.error).toBeUndefined();
    expect(onError).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalled();
    expect(store.handoffToReview).toHaveBeenCalledTimes(1);
    expect((task.log ?? []).some((entry: any) => entry.action.includes("Post-done session continuation suppressed"))).toBe(true);
  });

  it("requeues incomplete work with a fresh session when the session is not continuable", async () => {
    const task = makeTask({
      id: "FN-5866-INCOMPLETE",
      sessionFile: "/tmp/test/.fusion/sessions/FN-5866-INCOMPLETE.json",
    });
    const store = createStore(task);
    const onError = vi.fn();

    mockedCreateFnAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockRejectedValue(new Error("Cannot continue from message role: assistant")),
        dispose: vi.fn(),
        getSessionStats: vi.fn().mockResolvedValue({
          tokens: { input: 5, output: 0, cacheRead: 0, cacheWrite: 0, total: 5 },
        }),
      },
    } as any);

    const executor = new TaskExecutor(store, "/tmp/test", { onError });
    await executor.execute(task);

    expect(task.column).toBe("todo");
    expect(task.status).toBeUndefined();
    expect(task.error).toBeUndefined();
    expect(task.sessionFile).toBeNull();
    expect(task.recoveryRetryCount).toBe(1);
    expect(task.nextRecoveryAt).toEqual(expect.any(String));
    expect(store.moveTask).toHaveBeenCalledWith(task.id, "todo", { preserveResumeState: true });
    expect(store.handoffToReview).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    // FNXC:PostDoneContinuation 2026-07-16-11:57: Incomplete assistant-last transcripts use the dedicated stale-continuation recovery lane. Assert its fresh-session retry action rather than conflating it with the completed-work suppression path.
    expect((task.log ?? []).some((entry: any) => entry.action.includes("Detected stale assistant-continuation session — fresh-session retry"))).toBe(true);
  });

  it("self-heals already wedged post-done non-continuable failures back to clean in-review", async () => {
    const wedged = makeTask({
      id: "FN-5889-WEDGED",
      column: "in-review",
      status: "failed",
      error: "Cannot continue from message role: assistant",
      steps: [{ name: "Implement", status: "done" as const }],
      log: [{ timestamp: new Date(Date.now() - 60_000).toISOString(), action: "Task marked done by agent" } as any],
    });
    const exhausted = makeTask({
      id: "FN-5889-EXHAUSTED",
      column: "in-review",
      status: "failed",
      error: "Cannot continue from message role: assistant",
      completionHandoffLimboRecoveryCount: MAX_POST_DONE_NONCONTINUABLE_WEDGE_RECOVERIES,
      steps: [{ name: "Implement", status: "done" as const }],
      log: [{ timestamp: new Date(Date.now() - 60_000).toISOString(), action: "Task marked done by agent" } as any],
    });
    const nonMatching = makeTask({
      id: "FN-5889-NON-MATCH",
      column: "in-review",
      status: "failed",
      error: "Different failure",
      steps: [{ name: "Implement", status: "in-progress" as const }],
      log: [{ timestamp: new Date(Date.now() - 60_000).toISOString(), action: "Task marked done by agent" } as any],
    });
    const store = createSelfHealingStore([wedged, exhausted, nonMatching]);
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/repo" });

    expect(await manager.recoverPostDoneNonContinuableWedge()).toBe(1);

    expect(wedged.column).toBe("in-review");
    expect(wedged.status).toBeUndefined();
    expect(wedged.error).toBeUndefined();
    expect(wedged.completionHandoffLimboRecoveryCount).toBe(1);
    expect((wedged.log ?? []).some((entry: any) => entry.action.includes("Auto-recovered completed-task non-continuable wedge"))).toBe(true);
    expect(((store as any).__audits as any[]).some((event: any) => event.mutationType === "task:auto-recover-post-done-noncontinuable-wedge" && event.target === wedged.id)).toBe(true);

    expect(exhausted.status).toBe("failed");
    expect(exhausted.error).toBe("Cannot continue from message role: assistant");
    expect(((store as any).__audits as any[]).some((event: any) => event.mutationType === "task:auto-recover-post-done-noncontinuable-wedge-exhausted" && event.target === exhausted.id)).toBe(true);

    expect(nonMatching.status).toBe("failed");
    expect(nonMatching.error).toBe("Different failure");
    manager.stop();
  });

  it("self-heals Codex transcript-desync post-done wedges without swallowing generic 400s", async () => {
    const codexEnvelope = "Codex error: " + JSON.stringify({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "No tool call found for function call output with call_id call_2KewW55MyBgwZoNtMubFNpUb.",
        param: "input",
      },
      status: 400,
    });
    const symmetricLogEvidence = "No function call found for function call output with call_id call_2KewW55MyBgwZoNtMubFNpUb.";
    const envelopeWedged = makeTask({
      id: "FN-6594-CODEX-ENVELOPE-WEDGED",
      column: "in-review",
      status: "failed",
      error: codexEnvelope,
      steps: [{ name: "Implement", status: "done" as const }],
      log: [{ timestamp: new Date(Date.now() - 60_000).toISOString(), action: "Task marked done by agent" } as any],
    });
    const logEvidenceWedged = makeTask({
      id: "FN-6594-CODEX-LOG-WEDGED",
      column: "in-review",
      status: "failed",
      error: "Session failed while replaying transcript",
      steps: [{ name: "Implement", status: "done" as const }],
      log: [
        { timestamp: new Date(Date.now() - 60_000).toISOString(), action: "Task marked done by agent" } as any,
        {
          timestamp: new Date(Date.now() - 30_000).toISOString(),
          action: "executor post-done continuation failed",
          outcome: symmetricLogEvidence,
        } as any,
      ],
    });
    const badInputWedged = makeTask({
      id: "FN-6594-BAD-INPUT-WEDGED",
      column: "in-review",
      status: "failed",
      error: "400 invalid_request_error: invalid temperature",
      steps: [{ name: "Implement", status: "done" as const }],
      log: [
        { timestamp: new Date(Date.now() - 60_000).toISOString(), action: "Task marked done by agent" } as any,
        { timestamp: new Date(Date.now() - 30_000).toISOString(), action: "quota exceeded" } as any,
      ],
    });
    const store = createSelfHealingStore([envelopeWedged, logEvidenceWedged, badInputWedged]);
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/repo" });

    expect(await manager.recoverPostDoneNonContinuableWedge()).toBe(2);

    for (const recovered of [envelopeWedged, logEvidenceWedged]) {
      expect(recovered.column).toBe("in-review");
      expect(recovered.status).toBeUndefined();
      expect(recovered.error).toBeUndefined();
      expect(recovered.completionHandoffLimboRecoveryCount).toBe(1);
      expect(
        (recovered.log ?? []).some((entry: any) => entry.action.includes("Auto-recovered completed-task non-continuable wedge")),
      ).toBe(true);
      expect(
        ((store as any).__audits as any[]).some(
          (event: any) => event.mutationType === "task:auto-recover-post-done-noncontinuable-wedge" && event.target === recovered.id,
        ),
      ).toBe(true);
    }

    expect(badInputWedged.status).toBe("failed");
    expect(badInputWedged.error).toBe("400 invalid_request_error: invalid temperature");
    expect(badInputWedged.completionHandoffLimboRecoveryCount).toBeUndefined();
    expect(((store as any).__audits as any[]).some((event: any) => event.target === badInputWedged.id)).toBe(false);
    manager.stop();
  });

  it("falls through to terminal failure after the non-continuable fresh-session retry budget is exhausted", async () => {
    const task = makeTask({
      id: "FN-5866-INCOMPLETE-EXHAUSTED",
      recoveryRetryCount: MAX_RECOVERY_RETRIES,
      nextRecoveryAt: "2026-06-02T00:05:00.000Z",
      sessionFile: "/tmp/test/.fusion/sessions/FN-5866-INCOMPLETE-EXHAUSTED.json",
    });
    const store = createStore(task);
    const onError = vi.fn();

    mockedCreateFnAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockRejectedValue(new Error("Cannot continue from message role: assistant")),
        dispose: vi.fn(),
        getSessionStats: vi.fn().mockResolvedValue({
          tokens: { input: 5, output: 0, cacheRead: 0, cacheWrite: 0, total: 5 },
        }),
      },
    } as any);

    const executor = new TaskExecutor(store, "/tmp/test", { onError });
    await executor.execute(task);

    // FNXC:WorkflowLifecycle 2026-07-01-21:15: When the non-continuable fresh-session retry budget is
    // exhausted, the run falls through to the TERMINAL failure path, which under the workflow-graph model
    // parks the task `status: "failed"` IN PLACE (column preserved, worktree/session state cleared, onError
    // surfaced) — the failure-in-place model that superseded the legacy FN-1284 move-to-in-review
    // escalation. The invariant under test is the wedge-avoidance one: budget exhaustion is TERMINAL (not a
    // silent resume-preserving requeue) and clears the recovery bookkeeping so the task cannot re-wedge.
    expect(task.column).toBe("in-progress");
    expect(task.status).toBe("failed");
    expect(task.error).toContain("Cannot continue from message role: assistant");
    expect(task.recoveryRetryCount).toBeNull();
    expect(task.nextRecoveryAt).toBeNull();
    expect(task.sessionFile).toBeNull();
    expect(store.moveTask).not.toHaveBeenCalledWith(task.id, "todo", { preserveResumeState: true });
    expect(store.handoffToReview).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect((task.log ?? []).some((entry: any) => entry.action.includes("fresh-session retries exhausted"))).toBe(true);
  });
});
