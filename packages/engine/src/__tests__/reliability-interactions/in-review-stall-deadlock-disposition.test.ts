import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskStore } from "@fusion/core";
import { SelfHealingManager } from "../../self-healing.js";

function createStore(task: Task, settings: Record<string, unknown> = {}): TaskStore & EventEmitter {
  const emitter = new EventEmitter() as TaskStore & EventEmitter;
  const auditEvents: any[] = [];

  (emitter as any).__auditEvents = auditEvents;
  (emitter as any).getSettings = vi.fn().mockResolvedValue({
    autoMerge: true,
    globalPause: false,
    enginePaused: false,
    taskStuckTimeoutMs: 60_000,
    inReviewStallDeadlockThreshold: 3,
    ...settings,
  });
  (emitter as any).listTasks = vi.fn().mockImplementation(async () => [task]);
  (emitter as any).logEntry = vi.fn().mockImplementation(async (_taskId: string, action: string) => {
    task.log = task.log ?? [];
    task.log.push({ timestamp: new Date(Date.now()).toISOString(), action });
  });
  (emitter as any).updateTask = vi.fn().mockImplementation(async (_taskId: string, updates: Partial<Task>) => {
    Object.assign(task, updates);
  });
  (emitter as any).applyInReviewStallObservationFenced = vi.fn().mockImplementation(async (_taskId: string, compute: (current: Task) => any) => {
    const patch = compute(task);
    if (!patch) return { applied: false, reason: "refused" };
    await (emitter as any).logEntry(task.id, patch.logEntry.action);
    const { logEntry: _logEntry, ...fields } = patch;
    Object.assign(task, fields);
    return { applied: true, task };
  });
  (emitter as any).recordRunAuditEvent = vi.fn().mockImplementation(async (event: any) => {
    auditEvents.push(event);
  });
  (emitter as any).moveTask = vi.fn().mockResolvedValue(undefined);
  (emitter as any).enqueueMergeQueue = vi.fn().mockResolvedValue(undefined);
  /*
  FNXC:ReviewStallDisposition 2026-11-04-05:30 (RUFU-398):
  `SelfHealingManager.batchWorkflowIrCache()` builds `new EpochedWorkflowIrCache(() => store
  .workflowDefinitionEpoch())` unconditionally, so a hand-rolled fake that omits it throws the moment a
  case reaches any sweep that resolves workflow IR — which is how the limbo-requeue case below died with
  `workflowDefinitionEpoch is not a function` instead of asserting its own claim. Same one-line stub the
  other reduced self-healing fakes carry (`merge-not-run-gate-wedge.test.ts`,
  `self-healing-076-pause-storm.test.ts`); a constant epoch just means the IR cache never invalidates.
  */
  (emitter as any).workflowDefinitionEpoch = vi.fn(() => 0);

  return emitter;
}

describe("reliability interactions: in-review stall deadlock disposition", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("FN-4885: auto-disposes repeated merge-blocker stalls once, then no-ops", async () => {
    const task = {
      id: "FN-4860",
      column: "in-review",
      paused: false,
      userPaused: false,
      status: "failed",
      error: "Failed to create worktree after 3 attempts: Branch fusion/fn-4860 conflict could not be auto-resolved",
      branch: "fusion/fn-4860",
      worktree: "/tmp/missing-fn-4860",
      mergeDetails: {},
      mergeRetries: 0,
      steps: [{ name: "merge", status: "done" }],
      workflowStepResults: [],
      updatedAt: "2026-01-01T00:00:00.000Z",
      log: [],
    } as any satisfies Task;

    const store = createStore(task);
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/repo" });

    vi.setSystemTime(new Date("2026-01-01T00:10:00.000Z"));
    expect(await manager.surfaceInReviewStalls()).toBe(1);

    vi.setSystemTime(new Date("2026-01-01T00:12:00.000Z"));
    expect(await manager.surfaceInReviewStalls()).toBe(1);

    vi.setSystemTime(new Date("2026-01-01T00:14:00.000Z"));
    expect(await manager.surfaceInReviewStalls()).toBe(1);

    expect(task.paused).toBe(true);
    expect(task.pausedReason).toBe("in-review-stall-deadlock");
    expect(task.status).toBe("failed");

    const disposedEntries = task.log.filter((entry: { action: string }) =>
      entry.action.startsWith("In-review stall auto-disposed [merge-blocker]:"),
    );
    expect(disposedEntries).toHaveLength(1);

    const auditEvents = (store as any).__auditEvents as any[];
    const disposeAuditEvents = auditEvents.filter((event) => event.mutationType === "task:in-review-stall-deadlock-disposed");
    expect(disposeAuditEvents).toHaveLength(1);

    expect(disposeAuditEvents[0]).toMatchObject({
      domain: "database",
      taskId: "FN-4860",
      target: "FN-4860",
      metadata: expect.objectContaining({
        code: "merge-blocker",
        repetitionCount: 3,
        threshold: 3,
        branch: "fusion/fn-4860",
        worktree: "/tmp/missing-fn-4860",
      }),
    });

    const logCountBeforeFourth = task.log.length;
    const auditCountBeforeFourth = disposeAuditEvents.length;
    const updateCallsBeforeFourth = (store.updateTask as any).mock.calls.length;

    vi.setSystemTime(new Date("2026-01-01T00:16:00.000Z"));
    expect(await manager.surfaceInReviewStalls()).toBe(0);

    expect(task.log).toHaveLength(logCountBeforeFourth);
    expect((store.updateTask as any).mock.calls.length).toBe(updateCallsBeforeFourth);
    const disposeAuditsAfterFourth = ((store as any).__auditEvents as any[]).filter(
      (event) => event.mutationType === "task:in-review-stall-deadlock-disposed",
    );
    expect(disposeAuditsAfterFourth).toHaveLength(auditCountBeforeFourth);

    manager.stop();
  });

  it("uses the default ten-observation threshold when no override is configured", async () => {
    const reason = "task is marked 'failed': unchanged merge failure";
    const task = {
      id: "FN-336-DEFAULT",
      column: "in-review",
      paused: false,
      userPaused: false,
      status: "failed",
      error: "unchanged merge failure",
      steps: [{ name: "implementation", status: "done" }],
      workflowStepResults: [],
      worktree: "/tmp/fn-336-default",
      mergeDetails: {},
      mergeRetries: 0,
      updatedAt: "2026-01-01T00:00:00.000Z",
      log: Array.from({ length: 9 }, (_, index) => ({
        timestamp: `2026-01-01T00:0${index}:00.000Z`,
        action: `In-review stall surfaced [merge-blocker]: ${reason}`,
      })),
    } as any satisfies Task;
    const store = createStore(task, { inReviewStallDeadlockThreshold: undefined });
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/repo" });

    vi.setSystemTime(new Date("2026-01-01T00:20:00.000Z"));
    expect(await manager.surfaceInReviewStalls()).toBe(1);
    expect(task.pausedReason).toBe("in-review-stall-deadlock");
    expect(task.error).toContain("repeated 10× without progress");
  });

  it("starts a new episode when a failed pre-merge gate progressed after identical stalls", async () => {
    const reason = "task has failed pre-merge workflow steps";
    const task = {
      id: "FN-336-PROGRESS",
      column: "in-review",
      paused: false,
      userPaused: false,
      steps: [{ name: "implementation", status: "done" }],
      workflowStepResults: [{
        workflowStepId: "code-review",
        workflowStepName: "Code Review",
        phase: "pre-merge",
        status: "failed",
        startedAt: "2026-01-01T00:04:00.000Z",
        completedAt: "2026-01-01T00:05:00.000Z",
        priorAttempts: [{ status: "failed", startedAt: "2026-01-01T00:00:00.000Z" }],
      }],
      worktree: "/tmp/fn-336-progress",
      mergeDetails: {},
      mergeRetries: 0,
      updatedAt: "2026-01-01T00:05:00.000Z",
      log: [
        { timestamp: "2026-01-01T00:01:00.000Z", action: `In-review stall surfaced [merge-blocker]: ${reason}` },
        { timestamp: "2026-01-01T00:03:00.000Z", action: `In-review stall surfaced [merge-blocker]: ${reason}` },
      ],
    } as any satisfies Task;
    const store = createStore(task, { inReviewStallDeadlockThreshold: 3 });
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/repo" });

    vi.setSystemTime(new Date("2026-01-01T00:10:00.000Z"));
    expect(await manager.surfaceInReviewStalls()).toBe(1);
    expect(task.paused).toBe(false);
    expect(task.log.filter((entry: { action: string }) => entry.action.startsWith("In-review stall surfaced"))).toHaveLength(3);
    expect(task.log.some((entry: { action: string }) => entry.action.startsWith("In-review stall auto-disposed"))).toBe(false);
    expect((store as any).__auditEvents).toEqual([]);
  });

  it("FN-6113: terminal provider errors dispose in a single stall cycle", async () => {
    const task = {
      id: "FN-6113-TERMINAL",
      column: "in-review",
      paused: false,
      userPaused: false,
      status: "failed",
      error: "HTTP 400 invalid_request_error: model gpt-5.3-codex is not supported",
      branch: "fusion/fn-6113-terminal",
      worktree: "/tmp/fn-6113-terminal",
      mergeDetails: {},
      mergeRetries: 0,
      steps: [{ name: "merge", status: "done" }],
      workflowStepResults: [],
      updatedAt: "2026-01-01T00:00:00.000Z",
      log: [],
    } as any satisfies Task;

    const store = createStore(task);
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/repo" });

    vi.setSystemTime(new Date("2026-01-01T00:10:00.000Z"));
    expect(await manager.surfaceInReviewStalls()).toBe(1);

    expect(task.paused).toBe(true);
    expect(task.pausedReason).toBe("non-retryable-provider-error");
    expect(task.status).toBe("failed");
    expect(task.error).toBe(
      "Terminal provider error (non-retryable): Terminal provider error: HTTP 400 invalid_request_error: model gpt-5.3-codex is not supported",
    );
    expect(task.log.filter((entry: { action: string }) => entry.action.startsWith("In-review stall terminal disposed [non-retryable-provider-error]:"))).toHaveLength(1);
    expect(task.log.some((entry: { action: string }) => entry.action.startsWith("In-review stall auto-disposed ["))).toBe(false);
    expect(task.log.some((entry: { action: string }) => entry.action.startsWith("In-review stall surfaced ["))).toBe(false);

    const auditEvents = (store as any).__auditEvents as any[];
    const terminalAuditEvents = auditEvents.filter((event) => event.mutationType === "task:in-review-stall-terminal-provider-error");
    expect(terminalAuditEvents).toHaveLength(1);
    expect(terminalAuditEvents[0]).toMatchObject({
      domain: "database",
      taskId: "FN-6113-TERMINAL",
      target: "FN-6113-TERMINAL",
      metadata: expect.objectContaining({
        code: "non-retryable-provider-error",
        reason: "Terminal provider error: HTTP 400 invalid_request_error: model gpt-5.3-codex is not supported",
        branch: "fusion/fn-6113-terminal",
        worktree: "/tmp/fn-6113-terminal",
      }),
    });

    manager.stop();
  });

  it("FN-9400: explicit user auto-merge hold remains untouched across repeated stall scans", async () => {
    const task = {
      id: "FN-9400-MANUAL-HOLD",
      column: "in-review",
      paused: false,
      userPaused: false,
      autoMerge: false,
      autoMergeProvenance: "user",
      status: "failed",
      error: "Workflow graph merge blocked at node 'merge': implementation incomplete with no executable proof to resume — failing instead of retrying merge",
      branch: "fusion/fn-9400-manual-hold",
      worktree: "/tmp/fn-9400-manual-hold",
      mergeDetails: {},
      mergeRetries: 0,
      steps: [],
      workflowStepResults: [{ workflowStepId: "code-review", status: "passed", verdict: "APPROVE" }],
      updatedAt: "2026-01-01T00:00:00.000Z",
      log: [],
    } as any satisfies Task;

    const store = createStore(task, { autoMerge: true });
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/repo" });

    for (const timestamp of ["2026-01-01T00:10:00.000Z", "2026-01-01T00:12:00.000Z", "2026-01-01T00:14:00.000Z"]) {
      vi.setSystemTime(new Date(timestamp));
      expect(await manager.surfaceInReviewStalls()).toBe(0);
    }

    expect(task).toMatchObject({ paused: false, status: "failed" });
    expect((store.updateTask as any).mock.calls).toHaveLength(0);
    expect(task.log).toHaveLength(0);
    expect(((store as any).__auditEvents as any[])).toHaveLength(0);

    manager.stop();
  });

  it("FN-6113: terminal provider errors are ignored when autoMerge is disabled", async () => {
    const task = {
      id: "FN-6113-AUTOMERGE-OFF",
      column: "in-review",
      paused: false,
      userPaused: false,
      status: "failed",
      error: "HTTP 400 invalid_request_error: model gpt-5.3-codex is not supported",
      branch: "fusion/fn-6113-automerge-off",
      worktree: "/tmp/fn-6113-automerge-off",
      mergeDetails: {},
      mergeRetries: 0,
      steps: [{ name: "merge", status: "done" }],
      workflowStepResults: [],
      updatedAt: "2026-01-01T00:00:00.000Z",
      log: [],
    } as any satisfies Task;

    const store = createStore(task, { autoMerge: false });
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/repo" });

    vi.setSystemTime(new Date("2026-01-01T00:10:00.000Z"));
    expect(await manager.surfaceInReviewStalls()).toBe(0);
    expect(task.paused).toBe(false);
    expect((store.updateTask as any).mock.calls.length).toBe(0);
    expect(task.log).toHaveLength(0);

    manager.stop();
  });

  it("FN-6113: terminal provider errors do not auto-dispose userPaused tasks", async () => {
    const task = {
      id: "FN-6113-USER-PAUSED",
      column: "in-review",
      paused: false,
      userPaused: true,
      status: "failed",
      error: "HTTP 403 forbidden for model access",
      branch: "fusion/fn-6113-user-paused",
      worktree: "/tmp/fn-6113-user-paused",
      mergeDetails: {},
      mergeRetries: 0,
      steps: [{ name: "merge", status: "done" }],
      workflowStepResults: [],
      updatedAt: "2026-01-01T00:00:00.000Z",
      log: [],
    } as any satisfies Task;

    const store = createStore(task);
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/repo" });

    vi.setSystemTime(new Date("2026-01-01T00:10:00.000Z"));
    expect(await manager.surfaceInReviewStalls()).toBe(1);
    expect(task.paused).toBe(false);
    expect(task.pausedReason).toBeUndefined();
    expect((store.updateTask as any).mock.calls.length).toBe(0);
    expect(task.log.some((entry: { action: string }) => entry.action.startsWith("In-review stall terminal disposed ["))).toBe(false);
    expect(((store as any).__auditEvents as any[]).some((event) => event.mutationType === "task:in-review-stall-terminal-provider-error")).toBe(false);

    manager.stop();
  });

  it("FN-6113: retryable provider errors still use repeated-stall deadlock disposition", async () => {
    const task = {
      id: "FN-6113-RETRYABLE",
      column: "in-review",
      paused: false,
      userPaused: false,
      status: "failed",
      error: "HTTP 503 service unavailable",
      branch: "fusion/fn-6113-retryable",
      worktree: "/tmp/fn-6113-retryable",
      mergeDetails: {},
      mergeRetries: 0,
      steps: [{ name: "merge", status: "done" }],
      workflowStepResults: [],
      updatedAt: "2026-01-01T00:00:00.000Z",
      log: [],
    } as any satisfies Task;

    const store = createStore(task);
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/repo" });

    vi.setSystemTime(new Date("2026-01-01T00:10:00.000Z"));
    expect(await manager.surfaceInReviewStalls()).toBe(1);
    expect(task.paused).toBe(false);
    vi.setSystemTime(new Date("2026-01-01T00:12:00.000Z"));
    expect(await manager.surfaceInReviewStalls()).toBe(1);
    expect(task.paused).toBe(false);
    vi.setSystemTime(new Date("2026-01-01T00:14:00.000Z"));
    expect(await manager.surfaceInReviewStalls()).toBe(1);

    expect(task.paused).toBe(true);
    expect(task.pausedReason).toBe("in-review-stall-deadlock");
    expect(task.log.filter((entry: { action: string }) => entry.action.startsWith("In-review stall surfaced [merge-blocker]:"))).toHaveLength(2);
    expect(task.log.filter((entry: { action: string }) => entry.action.startsWith("In-review stall auto-disposed [merge-blocker]:"))).toHaveLength(1);
    expect(task.log.some((entry: { action: string }) => entry.action.startsWith("In-review stall terminal disposed ["))).toBe(false);

    manager.stop();
  });

  it("FN-6070: rejected limbo requeues do not increment into deadlock disposition", async () => {
    const task = {
      id: "FN-6070-REJECTED",
      column: "in-review",
      paused: false,
      userPaused: false,
      status: undefined,
      error: undefined,
      branch: "fusion/fn-6070-rejected",
      worktree: "/tmp/fn-6070-rejected",
      mergeDetails: undefined,
      mergeRetries: 0,
      completionHandoffLimboRecoveryCount: 2,
      steps: [{ name: "merge", status: "done" }],
      workflowStepResults: [],
      updatedAt: "2026-01-01T00:00:00.000Z",
      log: [{ action: "Task marked done by agent", timestamp: "2026-01-01T00:00:00.000Z" }],
    } as any satisfies Task;

    const store = createStore(task);
    const manager = new SelfHealingManager(store, {
      rootDir: "/tmp/repo",
      requeueForAutoMerge: vi.fn(() => false),
    });

    vi.setSystemTime(new Date("2026-01-01T00:10:00.000Z"));
    await manager.recoverCompletionHandoffLimbo();
    vi.setSystemTime(new Date("2026-01-01T00:25:00.000Z"));
    await manager.recoverCompletionHandoffLimbo();
    vi.setSystemTime(new Date("2026-01-01T00:40:00.000Z"));
    await manager.recoverCompletionHandoffLimbo();

    expect(task.completionHandoffLimboRecoveryCount).toBe(2);
    expect(task.status).toBeUndefined();
    expect(task.error).toBeUndefined();
    expect(await manager.surfaceInReviewStalls()).toBe(1);
    expect(task.pausedReason).not.toBe("in-review-stall-deadlock");
    expect(task.log.some((entry: { action: string }) => entry.action.startsWith("In-review stall auto-disposed"))).toBe(false);
    expect(task.log.some((entry: { action: string }) => entry.action.includes("Completion handoff limbo recovery exhausted"))).toBe(false);

    manager.stop();
  });

  it("does not auto-dispose userPaused tasks with repeated identical stalls", async () => {
    const task = {
      id: "FN-4860-PAUSED",
      column: "in-review",
      paused: false,
      userPaused: true,
      status: "failed",
      error: "Failed to create worktree after 3 attempts: Branch fusion/fn-4860 conflict could not be auto-resolved",
      branch: "fusion/fn-4860-paused",
      worktree: "/tmp/missing-fn-4860-paused",
      mergeDetails: {},
      mergeRetries: 0,
      steps: [{ name: "merge", status: "done" }],
      workflowStepResults: [],
      updatedAt: "2026-01-01T00:00:00.000Z",
      log: [],
    } as any satisfies Task;

    const store = createStore(task);
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/repo" });

    vi.setSystemTime(new Date("2026-01-01T00:10:00.000Z"));
    await manager.surfaceInReviewStalls();
    vi.setSystemTime(new Date("2026-01-01T00:12:00.000Z"));
    await manager.surfaceInReviewStalls();
    vi.setSystemTime(new Date("2026-01-01T00:14:00.000Z"));
    await manager.surfaceInReviewStalls();

    expect(task.pausedReason).not.toBe("in-review-stall-deadlock");
    expect((store.updateTask as any).mock.calls.length).toBe(0);
    expect(task.log.some((entry: { action: string }) => entry.action.startsWith("In-review stall auto-disposed ["))).toBe(false);
    expect(((store as any).__auditEvents as any[]).some((event) => event.mutationType === "task:in-review-stall-deadlock-disposed")).toBe(false);

    manager.stop();
  });

  /*
  FNXC:ReviewStallDisposition 2026-11-04-05:30 (RUFU-398) — Symptom Verification.
  The reported failure was an operator told a stall release had held, who then found the same card in the
  same engine park ~11 h later with `mergeRetries` still 0: "the release survived 0 cycles" was arguable
  because the disposition row recorded nothing about the episode. These cases replay the measured row
  shape through the real sweep seam — park, release exactly as the release arms do, park again — and pin
  the three new metadata keys on the SECOND row. The control case is what an honest release looks like.
  */
  describe("release-durability evidence on the disposition row", () => {
    const BLOCKER = "unchanged merge failure";
    const BLOCKER_REASON = `task is marked 'failed': ${BLOCKER}`;

    const blockedCard = (id: string) => ({
      id,
      column: "in-review",
      paused: false,
      userPaused: false,
      status: "failed",
      error: BLOCKER,
      branch: `fusion/${id.toLowerCase()}`,
      worktree: `/tmp/${id.toLowerCase()}`,
      mergeDetails: {},
      mergeRetries: 0,
      steps: [{ name: "implementation", status: "done" }],
      workflowStepResults: [],
      updatedAt: "2026-01-01T00:00:00.000Z",
      log: [],
    } as any satisfies Task);

    const disposedRows = (store: any) => ((store).__auditEvents as any[])
      .filter((event) => event.mutationType === "task:in-review-stall-deadlock-disposed");

    /** Three cycles at the configured threshold of 3: two surfaced observations, then the park. */
    async function driveToPark(manager: SelfHealingManager, atMinutes: [number, number, number]) {
      for (const minutes of atMinutes) {
        vi.setSystemTime(new Date(`2026-01-01T00:${String(minutes).padStart(2, "0")}:00.000Z`));
        await manager.surfaceInReviewStalls();
      }
    }

    /**
     * The release, in the shape the release arms write it: the four park fields are the exact inverse of
     * the disposition's write, and the underlying merge blocker is what remains on the row once the merge
     * fails again. `mergeRetries` is left to the caller because whether it advanced IS the question.
     */
    function releasePark(task: any, errorAfterRelease = BLOCKER) {
      task.paused = false;
      task.pausedReason = null;
      task.status = "failed";
      task.error = errorAfterRelease;
    }

    it("labels a re-park that survived zero merge cycles, and counts the first park as zero", async () => {
      const task = blockedCard("RUFU-398-EPISODE");
      const store = createStore(task, { inReviewStallDeadlockThreshold: 3 });
      const manager = new SelfHealingManager(store, { rootDir: "/tmp/repo" });

      await driveToPark(manager, [10, 12, 14]);
      expect(task.paused).toBe(true);
      expect(task.pausedReason).toBe("in-review-stall-deadlock");
      expect(disposedRows(store)).toHaveLength(1);

      // The observation arm writes no audit row at all: two surfaced cycles, zero disposition rows.
      expect(task.log.filter((entry: { action: string }) => entry.action.startsWith("In-review stall surfaced ["))).toHaveLength(2);

      // First park of the episode: the park line being written must NOT count itself.
      expect(disposedRows(store)[0].metadata).toMatchObject({
        code: "merge-blocker",
        repetitionCount: 3,
        threshold: 3,
        priorParkCount: 0,
        mergeRetriesAtPark: 0,
        episodeHasMergeAttempt: false,
      });

      // Byte-identical History sentence, exactly as authored before RUFU-398 — the new keys are audit-only.
      expect(task.log.filter((entry: { action: string }) => entry.action.startsWith("In-review stall auto-disposed ["))[0].action)
        .toBe(`In-review stall auto-disposed [merge-blocker]: deadlock-prevention threshold reached after 3 identical stalls — pausing task. last reason: ${BLOCKER_REASON}`);
      // Unchanged pause payload.
      expect(task.status).toBe("failed");
      expect(task.error).toBe(`In-review stall deadlock: merge-blocker repeated 3× without progress. ${BLOCKER_REASON}`);

      releasePark(task);
      await driveToPark(manager, [20, 22, 24]);

      const rows = disposedRows(store);
      expect(rows).toHaveLength(2);
      expect(task.pausedReason).toBe("in-review-stall-deadlock");
      // The reported symptom, now answerable by query: released, never attempted, parked again.
      expect(rows[1].metadata).toMatchObject({
        code: "merge-blocker",
        repetitionCount: 3,
        threshold: 3,
        priorParkCount: 1,
        mergeRetriesAtPark: 0,
        episodeHasMergeAttempt: false,
      });

      manager.stop();
    });

    it("reports an honest release: a merge attempt that ran between the parks is recorded", async () => {
      const task = blockedCard("RUFU-398-MERGE-ATTEMPT");
      const store = createStore(task, { inReviewStallDeadlockThreshold: 3 });
      const manager = new SelfHealingManager(store, { rootDir: "/tmp/repo" });

      await driveToPark(manager, [10, 12, 14]);
      expect(disposedRows(store)).toHaveLength(1);

      releasePark(task);
      // The merge lane really ran and failed: that increment is what the release arms do NOT reset.
      task.mergeRetries = 2;
      await driveToPark(manager, [20, 22, 24]);

      const rows = disposedRows(store);
      expect(rows).toHaveLength(2);
      expect(rows[1].metadata).toMatchObject({
        priorParkCount: 1,
        mergeRetriesAtPark: 2,
        episodeHasMergeAttempt: true,
      });

      manager.stop();
    });

    it("starts a fresh episode when the reason changed, so a re-park under a new reason counts zero", async () => {
      const task = blockedCard("RUFU-398-NEW-REASON");
      const store = createStore(task, { inReviewStallDeadlockThreshold: 3 });
      const manager = new SelfHealingManager(store, { rootDir: "/tmp/repo" });

      await driveToPark(manager, [10, 12, 14]);
      expect(disposedRows(store)).toHaveLength(1);

      // Same code, different blocker sentence: a different episode signature, so no prior park of THIS one.
      releasePark(task, "a genuinely different merge blocker appeared");
      await driveToPark(manager, [20, 22, 24]);

      const rows = disposedRows(store);
      expect(rows).toHaveLength(2);
      expect(rows[1].metadata).toMatchObject({
        reason: "task is marked 'failed': a genuinely different merge blocker appeared",
        priorParkCount: 0,
        mergeRetriesAtPark: 0,
        episodeHasMergeAttempt: false,
      });

      manager.stop();
    });

    it("keeps the terminal provider-error arm free of the episode keys", async () => {
      const task = {
        id: "RUFU-398-TERMINAL",
        column: "in-review",
        paused: false,
        userPaused: false,
        status: "failed",
        error: "HTTP 400 invalid_request_error: model gpt-5.3-codex is not supported by this provider",
        steps: [{ name: "implementation", status: "done" }],
        workflowStepResults: [],
        worktree: "/tmp/rufu-398-terminal",
        mergeDetails: {},
        mergeRetries: 0,
        updatedAt: "2026-01-01T00:00:00.000Z",
        log: [],
      } as any satisfies Task;
      const store = createStore(task, { inReviewStallDeadlockThreshold: 3 });
      const manager = new SelfHealingManager(store, { rootDir: "/tmp/repo" });

      vi.setSystemTime(new Date("2026-01-01T00:10:00.000Z"));
      await manager.surfaceInReviewStalls();

      expect(disposedRows(store)).toHaveLength(0);
      const terminal = ((store as any).__auditEvents as any[])
        .filter((event) => event.mutationType === "task:in-review-stall-terminal-provider-error");
      expect(terminal).toHaveLength(1);
      for (const key of ["priorParkCount", "mergeRetriesAtPark", "episodeHasMergeAttempt", "repetitionCount", "threshold"]) {
        expect(terminal[0].metadata).not.toHaveProperty(key);
      }

      manager.stop();
    });
  });
});
