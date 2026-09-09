import { describe, expect, it, vi } from "vitest";
import type { TaskStore } from "@fusion/core";
import { Scheduler } from "../scheduler.js";
import { flushAsyncHandlers } from "./_flush-async-handlers.js";
import {
  createPlanReviewApprovedState,
  createPlanReviewRevisedState,
  createSupersededPlanReviewApproval,
} from "./_plan-review-outcome-states.js";

/*
FNXC:CodingIdeasWorkflow 2026-07-25-13:10:
Covers the dispatch half of the "started card does nothing" gap. Triage's finalize clears `status`
in place for plan-in-place workflows (it deliberately skips the triage->todo move), so a card that
just finished planning becomes dispatchable via a bare task:updated — no task:moved, no pause
transition — and none of the scheduler's pre-existing event wakes (task:created, globalPause
unpause, enginePaused unpause, per-task unpause) fire for it. The operator paid one poll interval
for planning to start and another for execution to start.

Surface enumeration (invariant: the planning -> dispatchable transition schedules exactly once, and
only when the card is genuinely dispatchable):
 - planning -> null in todo and in triage: schedules.
 - planning -> failed / awaiting-approval: does NOT schedule (a park is not a dispatch).
 - planning -> null but paused / userPaused: does NOT schedule.
 - planning -> null in a non-schedulable column: does NOT schedule.
 - A task never seen planning: does NOT schedule (no spurious wake on unrelated updates).
 - Fires once per transition, not on every subsequent update.
 - Deletion mid-planning clears the tracking so a reused id cannot fire a stale wake.
*/

function createStore() {
  const listeners = new Map<string, ((payload: unknown) => void)[]>();
  const store = {
    on: vi.fn((event: string, listener: (payload: unknown) => void) => {
      const existing = listeners.get(event) ?? [];
      existing.push(listener);
      listeners.set(event, existing);
    }),
    off: vi.fn(),
    getRootDir: vi.fn().mockReturnValue("/test/project"),
    getSettings: vi.fn().mockResolvedValue({ globalPause: false, enginePaused: false }),
    listTasks: vi.fn().mockResolvedValue([]),
    updateTask: vi.fn().mockResolvedValue(undefined),
  } as unknown as TaskStore;

  return {
    store,
    emit: (event: string, payload: unknown) => {
      for (const listener of listeners.get(event) ?? []) listener(payload);
    },
  };
}

function createTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "FN-1",
    column: "todo",
    status: null,
    paused: false,
    userPaused: false,
    assignedAgentId: null,
    checkedOutBy: null,
    deletedAt: null,
    dependencies: [],
    columnMovedAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** Build a running scheduler with schedule() stubbed, so we count wakes not real passes. */
function createScheduler() {
  const { store, emit } = createStore();
  const scheduler = new Scheduler(store, {});
  const schedule = vi.spyOn(scheduler, "schedule").mockResolvedValue(undefined);
  (scheduler as unknown as { running: boolean }).running = true;
  return { scheduler, emit, schedule };
}

describe("Scheduler wakes on the planning -> dispatchable transition", () => {
  it("schedules when planning clears in todo", async () => {
    const { emit, schedule } = createScheduler();

    emit("task:updated", createTask({ status: "planning" }));
    expect(schedule).not.toHaveBeenCalled(); // still planning — nothing to dispatch yet

    emit("task:updated", createTask({ status: null }));
    await flushAsyncHandlers();
    expect(schedule).toHaveBeenCalledTimes(1);
  });

  it("schedules when planning clears in triage", async () => {
    const { emit, schedule } = createScheduler();

    emit("task:updated", createTask({ column: "triage", status: "planning" }));
    emit("task:updated", createTask({ column: "triage", status: null }));

    await flushAsyncHandlers();

    expect(schedule).toHaveBeenCalledTimes(1);
  });

  it("fires once per transition, not on every later update", async () => {
    const { emit, schedule } = createScheduler();

    emit("task:updated", createTask({ status: "planning" }));
    emit("task:updated", createTask({ status: null }));
    emit("task:updated", createTask({ status: null }));
    emit("task:updated", createTask({ status: null }));

    await flushAsyncHandlers();

    expect(schedule).toHaveBeenCalledTimes(1);
  });

  it("does not schedule when planning ends in a park rather than a dispatchable state", () => {
    for (const status of ["failed", "awaiting-approval", "stuck-killed"]) {
      const { emit, schedule } = createScheduler();

      emit("task:updated", createTask({ status: "planning" }));
      emit("task:updated", createTask({ status }));

      expect(schedule, status).not.toHaveBeenCalled();
    }
  });

  it("does not schedule when the card is paused", () => {
    for (const pauseFlag of ["paused", "userPaused"]) {
      const { emit, schedule } = createScheduler();

      emit("task:updated", createTask({ status: "planning" }));
      emit("task:updated", createTask({ status: null, [pauseFlag]: true }));

      expect(schedule, pauseFlag).not.toHaveBeenCalled();
    }
  });

  it("does not schedule when the card lands in a non-schedulable column", () => {
    for (const column of ["in-progress", "in-review", "done", "archived"]) {
      const { emit, schedule } = createScheduler();

      emit("task:updated", createTask({ status: "planning" }));
      emit("task:updated", createTask({ column, status: null }));

      expect(schedule, column).not.toHaveBeenCalled();
    }
  });

  it("does not schedule for a task never seen planning", () => {
    const { emit, schedule } = createScheduler();

    emit("task:updated", createTask({ status: null }));
    emit("task:updated", createTask({ id: "FN-OTHER", status: null }));

    expect(schedule).not.toHaveBeenCalled();
  });

  it("clears planning tracking on delete so a reused id cannot fire a stale wake", () => {
    const { scheduler, emit, schedule } = createScheduler();

    emit("task:updated", createTask({ status: "planning" }));
    emit("task:deleted", { id: "FN-1" });
    expect(
      (scheduler as unknown as { planningTaskIds: Set<string> }).planningTaskIds.has("FN-1"),
    ).toBe(false);

    emit("task:updated", createTask({ status: null }));
    expect(schedule).not.toHaveBeenCalled();
  });

  it("does not schedule while the scheduler is stopped", () => {
    const { scheduler, emit, schedule } = createScheduler();
    (scheduler as unknown as { running: boolean }).running = false;

    emit("task:updated", createTask({ status: "planning" }));
    emit("task:updated", createTask({ status: null }));

    expect(schedule).not.toHaveBeenCalled();
  });
});

describe("Scheduler wakes on the approval-held -> dispatchable transition", () => {
  it("schedules immediately when plan approval clears in a hold column", async () => {
    const { emit, schedule } = createScheduler();

    emit("task:updated", createTask({ status: "awaiting-approval" }));
    expect(schedule).not.toHaveBeenCalled();

    emit("task:updated", createTask({ status: null }));
    await flushAsyncHandlers();

    expect(schedule).toHaveBeenCalledTimes(1);
  });

  it("uses the durable approval fingerprint when this process missed the hold event", async () => {
    const { emit, schedule } = createScheduler();

    emit("task:updated", createTask({
      status: null,
      approvedPlanFingerprint: "approved-plan",
    }));
    await flushAsyncHandlers();

    expect(schedule).toHaveBeenCalledTimes(1);
  });

  it("uses audited Plan Review evidence when approval could not fingerprint PROMPT.md", async () => {
    const { emit, schedule } = createScheduler();

    emit("task:updated", createTask({
      status: null,
      approvedPlanFingerprint: undefined,
      workflowStepResults: [{
        workflowStepId: "plan-review",
        workflowStepName: "Plan Review",
        status: "skipped",
        bypassedBy: "dashboard-operator",
        bypassedAt: "2026-08-04T00:26:00.000Z",
        bypassReason: "Approved after Plan Review did not converge",
        bypassedFromStatus: "failed",
        bypassedFromVerdict: "REVISE",
      }],
    }));
    await flushAsyncHandlers();

    expect(schedule).toHaveBeenCalledTimes(1);
  });

  it("queues an ordinary passed Plan Review without first arming the approval-held disjunct", async () => {
    const { emit, schedule } = createScheduler();
    const approved = createPlanReviewApprovedState({ id: "FN-1", approvedPlanFingerprint: undefined });

    emit("task:updated", createTask(approved as unknown as Record<string, unknown>));
    await flushAsyncHandlers();

    expect(schedule).toHaveBeenCalledTimes(1);
  });

  it("queues an ordinary passed Plan Review only once across identical updates", async () => {
    const { emit, schedule } = createScheduler();
    const approved = createPlanReviewApprovedState({ id: "FN-1", approvedPlanFingerprint: undefined });

    emit("task:updated", createTask(approved as unknown as Record<string, unknown>));
    emit("task:updated", createTask(approved as unknown as Record<string, unknown>));
    await flushAsyncHandlers();

    expect(schedule).toHaveBeenCalledTimes(1);
  });

  it("does not queue a non-satisfying, superseded, replanning, paused, or unproven Plan Review state", async () => {
    const cases = [
      createPlanReviewRevisedState({ id: "FN-REVISED", status: null }),
      createSupersededPlanReviewApproval({ id: "FN-SUPERSEDED" }),
      createPlanReviewApprovedState({ id: "FN-REPLANNING", status: "needs-replan" }),
      createPlanReviewApprovedState({ id: "FN-PAUSED", paused: true }),
      createPlanReviewApprovedState({ id: "FN-USER-PAUSED", userPaused: true }),
      createPlanReviewApprovedState({ id: "FN-NO-PROOF", workflowStepResults: [] }),
    ];

    for (const candidate of cases) {
      const { emit, schedule } = createScheduler();
      emit("task:updated", createTask(candidate as unknown as Record<string, unknown>));
      await flushAsyncHandlers();
      expect(schedule, candidate.id).not.toHaveBeenCalled();
    }
  });

  it("does not wake when approval remains held or clears into a pause/non-hold lane", async () => {
    for (const terminal of [
      { status: "awaiting-approval" },
      { status: null, paused: true },
      { status: null, userPaused: true },
      { status: null, column: "in-review" },
    ]) {
      const { emit, schedule } = createScheduler();
      emit("task:updated", createTask({ status: "awaiting-approval" }));
      emit("task:updated", createTask(terminal));
      await flushAsyncHandlers();
      expect(schedule, JSON.stringify(terminal)).not.toHaveBeenCalled();
    }
  });

});
