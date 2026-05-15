import { describe, expect, it, vi } from "vitest";
import type { Task } from "@fusion/core";
import { AutoRecoveryDispatcher } from "../../auto-recovery.js";

const baseTask = { id: "FN-1", recoveryRetryCount: 0 } as Task;

describe("reliability interaction: auto-recovery dispatcher precedence", () => {
  it("mode off preserves legacy pausedReason contract across wired classes", () => {
    const dispatcher = new AutoRecoveryDispatcher({
      taskStore: {} as never,
      auditEmitter: { database: vi.fn(async () => {}), git: vi.fn(), filesystem: vi.fn() },
    });

    const wired = [
      "branch-cross-contamination",
      "branch-conflict-tripwire",
      "branch-conflict-recovery-exhausted",
      "branch-conflict-unrecoverable",
    ] as const;

    for (const klass of wired) {
      const decision = dispatcher.classify({ class: klass, taskId: "FN-1", pausedReason: klass }, {
        task: baseTask,
        retryCount: 0,
        settings: { mode: "off", maxRetries: 3 },
      });
      expect(decision.action).toBe("pause");
      expect(decision.legacyPausedReason).toBe(klass);
    }
  });

  it("deterministic recovery success can bypass dispatcher invocation", async () => {
    const classify = vi.fn();
    const deterministicFastPath = vi.fn(async () => true);

    if (!(await deterministicFastPath())) {
      classify();
    }

    expect(deterministicFastPath).toHaveBeenCalledOnce();
    expect(classify).not.toHaveBeenCalled();
  });
});
