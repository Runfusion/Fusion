import { describe, expect, it } from "vitest";
import type { ExecutorOverseerSignalMemory, PlannerInterventionEntry } from "@fusion/core";
import { EXECUTOR_FAILED_INCOMPLETE_REASON } from "../planner-overseer.js";
import {
  deriveExecutorSignalMemory,
  evaluateNoOpFinalizeExecutorVeto,
  NO_OP_FINALIZE_EXECUTOR_VETO_REASON,
  type NoOpFinalizeExecutorVetoTask,
} from "../overseer-noop-finalize-veto.js";

/**
 * FNXC:Lifecycle 2026-07-16-09:40:
 * FN-8141 invariant coverage for the overseer-layer no-op-finalize veto. Tests
 * assert the GENERAL invariant across all enumerated surfaces (not only the
 * exact FN-8141 shape): failed-incomplete→no-green ⇒ veto; failed-then-green ⇒
 * no veto; non-empty merge ⇒ never vetoed; user-paused / autoMerge:false ⇒
 * defer to the FN-7514 human-control contract.
 */

function entry(overrides: Partial<PlannerInterventionEntry>): PlannerInterventionEntry {
  return {
    id: overrides.id ?? "ev-1",
    taskId: overrides.taskId ?? "FN-1",
    timestamp: overrides.timestamp ?? "2026-07-16T22:00:00.000Z",
    stage: overrides.stage ?? "executor",
    reason: overrides.reason ?? "Task is actively executing in-progress work",
    action: overrides.action ?? "observe",
    outcome: overrides.outcome ?? "succeeded",
    ...overrides,
  };
}

const failedEntry = (overrides: Partial<PlannerInterventionEntry> = {}) =>
  entry({ reason: EXECUTOR_FAILED_INCOMPLETE_REASON, ...overrides });

const okTask: NoOpFinalizeExecutorVetoTask = {
  userPaused: false,
  paused: false,
  pausedReason: undefined,
  status: undefined,
  autoMerge: true,
  prInfo: undefined,
  prInfos: undefined,
};

const incompleteMemory: ExecutorOverseerSignalMemory = { signal: "failed", incompleteWork: true, observedAt: 1 };

describe("deriveExecutorSignalMemory", () => {
  it("returns null when there are no intervention entries", () => {
    expect(deriveExecutorSignalMemory(null)).toBeNull();
    expect(deriveExecutorSignalMemory([])).toBeNull();
  });

  it("derives incompleteWork from the newest executor failed-incomplete observation", () => {
    const memory = deriveExecutorSignalMemory([failedEntry({ timestamp: "2026-07-16T22:40:00.000Z" })]);
    expect(memory).toEqual({ signal: "failed", incompleteWork: true, observedAt: Date.parse("2026-07-16T22:40:00.000Z") });
  });

  it("a later green executor observation supersedes an earlier failed one (no subsequent-green derivation)", () => {
    // Timeline is newest-first, as getPlannerInterventionTimeline returns it.
    const memory = deriveExecutorSignalMemory([
      entry({ id: "green", timestamp: "2026-07-16T23:10:00.000Z", reason: "Task is actively executing in-progress work" }),
      failedEntry({ id: "fail", timestamp: "2026-07-16T22:40:00.000Z" }),
    ]);
    expect(memory?.incompleteWork).toBe(false);
    expect(memory?.signal).toBe("progressing");
  });

  it("ignores non-executor stages and non-observe actions when picking the newest signal", () => {
    const memory = deriveExecutorSignalMemory([
      // Newest overall, but a merger observation — must be ignored.
      entry({ id: "merger", stage: "merger", timestamp: "2026-07-16T23:40:00.000Z", reason: "Task is in the merge/integration phase" }),
      // Newer than the failed one, but a retry action (recovery message, not a signal) — ignored.
      entry({ id: "retry", stage: "executor", action: "retry", timestamp: "2026-07-16T23:00:00.000Z", reason: "retrying step" }),
      failedEntry({ id: "fail", timestamp: "2026-07-16T22:40:00.000Z" }),
    ]);
    expect(memory?.incompleteWork).toBe(true);
  });
});

describe("evaluateNoOpFinalizeExecutorVeto", () => {
  it("vetoes an empty merge when the most-recent executor signal is failed-with-incomplete-work", () => {
    const decision = evaluateNoOpFinalizeExecutorVeto({ mergeIsEmpty: true, task: okTask, memory: incompleteMemory });
    expect(decision.veto).toBe(true);
    expect(decision.reason).toBe(NO_OP_FINALIZE_EXECUTOR_VETO_REASON);
  });

  it("does NOT veto when a later execution completed green (memory not incompleteWork)", () => {
    const greenMemory: ExecutorOverseerSignalMemory = { signal: "progressing", incompleteWork: false, observedAt: 2 };
    expect(evaluateNoOpFinalizeExecutorVeto({ mergeIsEmpty: true, task: okTask, memory: greenMemory }).veto).toBe(false);
  });

  it("does NOT veto when there is no executor memory at all", () => {
    expect(evaluateNoOpFinalizeExecutorVeto({ mergeIsEmpty: true, task: okTask, memory: null }).veto).toBe(false);
  });

  it("NEVER vetoes a non-empty (real squash landed) merge, even with failed-incomplete memory", () => {
    const decision = evaluateNoOpFinalizeExecutorVeto({ mergeIsEmpty: false, task: okTask, memory: incompleteMemory });
    expect(decision.veto).toBe(false);
  });

  it("defers (no veto) for a user-paused task per the FN-7514 human-control contract", () => {
    const paused: NoOpFinalizeExecutorVetoTask = { ...okTask, userPaused: true };
    const decision = evaluateNoOpFinalizeExecutorVeto({ mergeIsEmpty: true, task: paused, memory: incompleteMemory });
    expect(decision.veto).toBe(false);
    expect(decision.deferredForHumanControl).toBe(true);
    expect(decision.humanControlReason).toBe("user-paused");
  });

  it("defers (no veto) for an autoMerge:false / human-review task", () => {
    const humanReview: NoOpFinalizeExecutorVetoTask = { ...okTask, autoMerge: false };
    const decision = evaluateNoOpFinalizeExecutorVeto({
      mergeIsEmpty: true,
      task: humanReview,
      memory: incompleteMemory,
      settings: { autoMerge: false },
    });
    expect(decision.veto).toBe(false);
    expect(decision.deferredForHumanControl).toBe(true);
    expect(decision.humanControlReason).toBe("auto-merge-off-human-review");
  });

  it("does not veto a missing task (fails open — other guards remain)", () => {
    expect(evaluateNoOpFinalizeExecutorVeto({ mergeIsEmpty: true, task: null, memory: incompleteMemory }).veto).toBe(false);
  });
});
