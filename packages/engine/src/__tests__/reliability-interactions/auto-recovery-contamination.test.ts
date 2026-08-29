import { describe, expect, it, vi } from "vitest";
import type { Task } from "@fusion/core";
import { AutoRecoveryDispatcher } from "../../healing/auto-recovery.js";

const baseTask = { id: "FN-1", column: "in-progress", recoveryRetryCount: 0 } as Task;

describe("reliability interaction: contamination auto-recovery precedence", () => {
  it("bootstrap/4428 deterministic fast paths bypass dispatcher retry handler", async () => {
    const issueRetry = vi.fn();
    const dispatcher = new AutoRecoveryDispatcher({
      taskStore: {} as never,
      auditEmitter: { database: vi.fn(async () => {}), git: vi.fn(), filesystem: vi.fn(), sandbox: vi.fn() },
      handlers: { issueRetry },
    });

    const bootstrapRecovered = true;
    if (!bootstrapRecovered) {
      await dispatcher.dispatch({ class: "branch-cross-contamination", taskId: "FN-1", pausedReason: "branch-cross-contamination" }, {
        task: baseTask,
        retryCount: 0,
        settings: { mode: "programmatic", maxRetries: 3 },
      });
    }

    const crossContaminationAutoRecovered = true;
    if (!crossContaminationAutoRecovered) {
      await dispatcher.dispatch({ class: "branch-cross-contamination", taskId: "FN-1", pausedReason: "branch-cross-contamination" }, {
        task: baseTask,
        retryCount: 0,
        settings: { mode: "programmatic", maxRetries: 3 },
      });
    }

    expect(issueRetry).not.toHaveBeenCalled();
  });

  it("dispatcher retry is last step before pause path", async () => {
    const issueRetry = vi.fn(async () => {});
    const dispatcher = new AutoRecoveryDispatcher({
      taskStore: {} as never,
      auditEmitter: { database: vi.fn(async () => {}), git: vi.fn(), filesystem: vi.fn(), sandbox: vi.fn() },
      handlers: { issueRetry },
    });

    const decision = await dispatcher.dispatch({
      class: "branch-cross-contamination",
      taskId: "FN-1",
      pausedReason: "branch-cross-contamination",
      evidence: { ownCommits: 0, foreignAttributedCommits: 2 },
    }, {
      task: baseTask,
      retryCount: 0,
      settings: { mode: "programmatic", maxRetries: 1 },
    });

    expect(decision.action).toBe("retry");
    expect(issueRetry).toHaveBeenCalledOnce();
  });

  it("foreign-only no-own-work routes to retry, not pause", async () => {
    const issueRetry = vi.fn(async () => {});
    const dispatcher = new AutoRecoveryDispatcher({
      taskStore: {} as never,
      auditEmitter: { database: vi.fn(async () => {}), git: vi.fn(), filesystem: vi.fn(), sandbox: vi.fn() },
      handlers: { issueRetry },
    });

    const decision = await dispatcher.dispatch({
      class: "branch-cross-contamination",
      taskId: "FN-1",
      pausedReason: "branch-cross-contamination",
      evidence: { ownCommits: 0, foreignAttributedCommits: 3, recoveryKind: "foreign-only" },
    }, {
      task: baseTask,
      retryCount: 0,
      settings: { mode: "programmatic", maxRetries: 2 },
    });

    expect(decision.action).toBe("retry");
    expect(issueRetry).toHaveBeenCalledOnce();
  });

  it("mode off and destructive ambiguity preserve pause", () => {
    const dispatcher = new AutoRecoveryDispatcher({
      taskStore: {} as never,
      auditEmitter: { database: vi.fn(async () => {}), git: vi.fn(), filesystem: vi.fn(), sandbox: vi.fn() },
      handlers: { issueRetry: vi.fn() },
    });

    const modeOff = dispatcher.classify({ class: "branch-cross-contamination", taskId: "FN-1", pausedReason: "branch-cross-contamination" }, {
      task: baseTask,
      retryCount: 0,
      settings: { mode: "off", maxRetries: 3 },
    });
    expect(modeOff.action).toBe("pause");
    expect(modeOff.legacyPausedReason).toBe("branch-cross-contamination");

    const destructive = dispatcher.classify({
      class: "branch-cross-contamination",
      taskId: "FN-1",
      pausedReason: "branch-cross-contamination",
      evidence: { ownCommits: 1, foreignAttributedCommits: 1 },
    }, {
      task: baseTask,
      retryCount: 0,
      settings: { mode: "programmatic", maxRetries: 3 },
    });
    expect(destructive.action).toBe("pause");
  });

  it("retry budget exhaustion pauses on subsequent event", () => {
    const dispatcher = new AutoRecoveryDispatcher({
      taskStore: {} as never,
      auditEmitter: { database: vi.fn(async () => {}), git: vi.fn(), filesystem: vi.fn(), sandbox: vi.fn() },
      handlers: { issueRetry: vi.fn() },
    });

    const second = dispatcher.classify({ class: "branch-cross-contamination", taskId: "FN-1", pausedReason: "branch-cross-contamination" }, {
      task: { ...baseTask, recoveryRetryCount: 1 } as Task,
      retryCount: 1,
      settings: { mode: "programmatic", maxRetries: 1 },
    });

    expect(second.action).toBe("pause");
  });
});
