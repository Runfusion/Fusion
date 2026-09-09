import { describe, expect, it } from "vitest";
import type { Task } from "../types/task/task-core.js";
import {
  BUDGET_WRITE_GUARD_MS,
  classifyTerminalFailureAutoRecovery,
  MAX_TERMINAL_FAILURE_AUTO_RETRIES,
  TERMINAL_FAILURE_BUDGET_MAX_AGE_MS,
} from "../tasks/terminal-failure-auto-recovery.js";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-8908", description: "test", column: "todo", status: "failed",
    updatedAt: new Date(10_000).toISOString(), ...overrides,
  } as Task;
}

const generic = {
  isGenericTerminalFailure: true, hasRecoveryOwner: false, isProgressing: false,
  inTerminalSuccessColumn: false, isDeletedOrHistorical: false, autoRecoveryEnabled: true,
  now: () => 20_000,
};

describe("classifyTerminalFailureAutoRecovery", () => {
  it("retries a generic failed task from its durable budget", () => {
    expect(classifyTerminalFailureAutoRecovery(task(), generic)).toEqual({ action: "retry", attempt: 1 });
    expect(classifyTerminalFailureAutoRecovery(task({ wedgeNotification: {
      reasonKey: "terminal-failed", episodeId: "e", status: "active", transitionedAt: "",
      autoRecovery: { attempts: 1, lastAttemptAt: new Date(1_000).toISOString() },
    } }), generic)).toEqual({ action: "retry", attempt: 2 });
  });

  it("escalates an exhausted budget before retry-path guards", () => {
    const exhausted = task({ paused: true, autoMerge: false, wedgeNotification: {
      reasonKey: "terminal-failed", episodeId: "e", status: "active", transitionedAt: "",
      autoRecovery: { attempts: MAX_TERMINAL_FAILURE_AUTO_RETRIES, lastAttemptAt: new Date(1_000).toISOString() },
    } });
    expect(classifyTerminalFailureAutoRecovery(exhausted, { ...generic, hasRecoveryOwner: true, isProgressing: true }))
      .toEqual({ action: "notify", reason: "budget-exhausted" });
  });

  it("clears a budget before generic classification and never treats merely non-failed as progress", () => {
    const budget = { attempts: 1, lastAttemptAt: new Date(1_000).toISOString() };
    expect(classifyTerminalFailureAutoRecovery(task({ status: null, wedgeNotification: { reasonKey: "x", episodeId: "e", status: "active", transitionedAt: "", autoRecovery: budget } }), {
      ...generic, isGenericTerminalFailure: false, inTerminalSuccessColumn: true,
    })).toEqual({ action: "reset-budget", reason: "terminal-success" });
    expect(classifyTerminalFailureAutoRecovery(task({ status: null, wedgeNotification: { reasonKey: "x", episodeId: "e", status: "active", transitionedAt: "", autoRecovery: budget } }), {
      ...generic, isGenericTerminalFailure: false,
    })).toEqual({ action: "skip", reason: "not-generic-terminal-failure" });
  });

  it("requires a foreign write after the budget watermark before stale cleanup", () => {
    const now = TERMINAL_FAILURE_BUDGET_MAX_AGE_MS + 10_000;
    const budget = { attempts: 3, lastAttemptAt: new Date(0).toISOString(), lastBudgetWriteAt: new Date(1_000).toISOString() };
    const base = { reasonKey: "terminal-failed", episodeId: "e", status: "active" as const, transitionedAt: "", autoRecovery: budget };
    expect(classifyTerminalFailureAutoRecovery(task({ updatedAt: new Date(1_000 + BUDGET_WRITE_GUARD_MS).toISOString(), wedgeNotification: base }), { ...generic, now: () => now }))
      .toEqual({ action: "notify", reason: "budget-exhausted" });
    expect(classifyTerminalFailureAutoRecovery(task({ updatedAt: new Date(1_001 + BUDGET_WRITE_GUARD_MS).toISOString(), wedgeNotification: base }), { ...generic, now: () => now }))
      .toEqual({ action: "reset-budget", reason: "budget-stale" });
  });
});
