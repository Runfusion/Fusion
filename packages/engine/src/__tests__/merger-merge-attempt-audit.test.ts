import { describe, expect, it, vi } from "vitest";
import type { RunAuditEventInput, TaskStore } from "@fusion/core";
import { createRunAuditor } from "../util/run-audit.js";
import { emitMergeAttemptAuditEvent } from "../merger.js";

function createStore(recordImpl?: (input: RunAuditEventInput) => Promise<void>) {
  const recordRunAuditEvent = vi.fn(recordImpl ?? (async () => {}));
  const store = { recordRunAuditEvent } as unknown as TaskStore;
  return { store, recordRunAuditEvent };
}

describe("FN-4809 merge-attempt run_audit emission", () => {
  it.each([1, 2, 3] as const)("emits git merge:start with merge-attempt-%d phase (FN-4809)", async (attemptNum) => {
    const { store, recordRunAuditEvent } = createStore();
    const audit = createRunAuditor(store, {
      runId: "run-1",
      agentId: "agent-1",
      taskId: "FN-4809",
      phase: "merge",
    });

    await emitMergeAttemptAuditEvent({
      audit,
      branch: "fusion/FN-4809",
      attemptNum,
      mergeConflictStrategy: "smart-prefer-main",
      attemptLabel: `Attempt ${attemptNum}: test`,
      taskId: "FN-4809",
    });

    expect(recordRunAuditEvent).toHaveBeenCalledTimes(1);
    const event = recordRunAuditEvent.mock.calls[0][0] as RunAuditEventInput;
    expect(event.domain).toBe("git");
    expect(event.mutationType).toBe("merge:start");
    expect(event.taskId).toBe("FN-4809");
    expect(event.metadata).toMatchObject({
      phase: `merge-attempt-${attemptNum}`,
      attemptNum,
      mergeConflictStrategy: "smart-prefer-main",
      attemptLabel: `Attempt ${attemptNum}: test`,
    });
    expect(/^merge-attempt-/.test(String(event.metadata?.phase))).toBe(true);
  });

  it("swallows run-audit record failures (FN-4809)", async () => {
    const { store } = createStore(async () => {
      throw new Error("db unavailable");
    });
    const audit = createRunAuditor(store, {
      runId: "run-1",
      agentId: "agent-1",
      taskId: "FN-4809",
      phase: "merge",
    });

    await expect(
      emitMergeAttemptAuditEvent({
        audit,
        branch: "fusion/FN-4809",
        attemptNum: 1,
        mergeConflictStrategy: "smart-prefer-main",
        attemptLabel: "Attempt 1: test",
        taskId: "FN-4809",
      }),
    ).resolves.toBeUndefined();
  });
});
