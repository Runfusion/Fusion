import { describe, expect, it, vi } from "vitest";
import type { AutoRecoverySettings, Task } from "@fusion/core";
import { AutoRecoveryDispatcher, type AutoRecoveryFailure } from "../healing/auto-recovery.js";

const task = { id: "FN-1", recoveryRetryCount: 0 } as Task;

function createDispatcher() {
  const database = vi.fn(async () => {});
  const dispatcher = new AutoRecoveryDispatcher({
    taskStore: {} as never,
    auditEmitter: { database, git: vi.fn(), filesystem: vi.fn(), sandbox: vi.fn() },
  });
  return { dispatcher, database };
}

const classes: AutoRecoveryFailure["class"][] = [
  "file-scope-invariant",
  "post-squash-audit-blocker",
  "branch-cross-contamination",
  "branch-conflict-tripwire",
  "branch-conflict-recovery-exhausted",
  "branch-conflict-unrecoverable",
  "message-delivery-failure",
];

describe("auto-recovery dispatcher", () => {
  it.each(classes)("mode off preserves pause contract for %s", (klass) => {
    const { dispatcher } = createDispatcher();
    const decision = dispatcher.classify({ class: klass, taskId: "FN-1", pausedReason: "legacy-reason" }, {
      task,
      retryCount: 0,
      settings: { mode: "off", maxRetries: 3 },
    });
    expect(decision.action).toBe("pause");
    expect(decision.legacyPausedReason).toBe("legacy-reason");
    expect(decision.rationale).toBe("auto-recovery-disabled");
  });

  it("per-class override beats global mode", () => {
    const { dispatcher } = createDispatcher();
    const settings: AutoRecoverySettings = {
      mode: "deterministic-only",
      perClass: { "branch-conflict-unrecoverable": "programmatic" },
      maxRetries: 3,
    };
    const decision = dispatcher.classify({ class: "branch-conflict-unrecoverable", taskId: "FN-1", pausedReason: "branch-conflict-unrecoverable" }, { task, retryCount: 0, settings });
    expect(decision.action).toBe("retry");
  });

  it("forces pause on retry budget exhausted", () => {
    const { dispatcher } = createDispatcher();
    const decision = dispatcher.classify({ class: "branch-conflict-tripwire", taskId: "FN-1", pausedReason: "branch-conflict-tripwire" }, {
      task,
      retryCount: 3,
      settings: { mode: "programmatic", maxRetries: 3 },
    });
    expect(decision.action).toBe("pause");
    expect(decision.rationale).toBe("retry-budget-exhausted");
  });

  it("forces pause on destructive ambiguity", () => {
    const { dispatcher } = createDispatcher();
    const decision = dispatcher.classify({ class: "branch-cross-contamination", taskId: "FN-1", pausedReason: "branch-cross-contamination", evidence: { ownCommits: 1, foreignAttributedCommits: 1 } }, {
      task,
      retryCount: 0,
      settings: { mode: "ai-assisted", maxRetries: 3 },
    });
    expect(decision.action).toBe("pause");
    expect(decision.rationale).toBe("destructive-ambiguity");
  });

  it.each([
    ["off", "pause"],
    ["deterministic-only", "pause"],
    ["programmatic", "retry"],
    ["ai-assisted", "retry"],
  ] as const)("message-delivery-failure routes %s to %s", (mode, expectedAction) => {
    const { dispatcher } = createDispatcher();
    const decision = dispatcher.classify({ class: "message-delivery-failure", taskId: "FN-1", pausedReason: "message-delivery-failure" }, {
      task,
      retryCount: 0,
      settings: { mode, maxRetries: 3 },
    });
    expect(decision.action).toBe(expectedAction);
  });

  it("dispatch falls back to pause when handler missing", async () => {
    const { dispatcher, database } = createDispatcher();
    const decision = await dispatcher.dispatch({ class: "branch-conflict-unrecoverable", taskId: "FN-1", pausedReason: "branch-conflict-unrecoverable" }, {
      task,
      retryCount: 0,
      settings: { mode: "programmatic", maxRetries: 3 },
    });
    expect(decision.action).toBe("pause");
    expect(decision.rationale).toBe("handler-not-registered");
    expect(database).toHaveBeenCalledTimes(1);
    expect(database).toHaveBeenCalledWith(expect.objectContaining({
      type: "auto-recovery:classify-decision",
      metadata: expect.objectContaining({ class: "branch-conflict-unrecoverable", mode: "programmatic", retryCount: 0 }),
    }));
  });
});
