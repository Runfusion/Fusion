import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../execution/reviewer.js", () => ({ reviewStep: vi.fn() }));

import { routeReviewConvergenceLadder } from "../executor/review-convergence-ladder.js";
import { applyReviewArbitrationRelease, runReviewArbitration } from "../executor/review-arbitration.js";
import { reviewStep } from "../execution/reviewer.js";
import { createReviewDisputeTool } from "../executor/create-review-dispute-tool.js";
import { getTaskMergeBlocker } from "@fusion/core";
import { RUN_AUDIT_EMIT_TIMEOUT_MS } from "../util/emit-bounded-run-audit.js";

/*
FNXC:ReviewConvergence 2026-08-22-16:17:
FN-149 and FN-9175 require review-convergence telemetry to stay best effort. A hostile audit sink
must never alter the ladder, arbitration release or fenced-stale decline, dispute result, or the
operator-authored Plan Review cap; late rejection must remain observed rather than become an unhandled rejection.
*/
function failedTask() {
  return {
    id: "FN-149-audit", column: "in-review", dependencies: [], worktree: "/tmp/review-convergence-audit", steps: [{ name: "Fix review finding", status: "pending", remediation: { wave: 1, gate: "Code Review", gateStepId: "code-review", detail: "Fix review finding" } }], currentStep: 0, log: [],
    createdAt: "2026-08-22T00:00:00.000Z", updatedAt: "2026-08-22T00:00:00.000Z",
    reviewConvergenceStage: 2, reviewConvergenceEscalationCount: 2,
    workflowStepResults: [{
      workflowStepId: "code-review", workflowStepName: "Code Review", phase: "pre-merge",
      status: "failed", verdict: "REVISE", startedAt: "2026-08-22T01:00:00.000Z",
      findings: [{ id: "f-1", title: "Must fix", body: "A blocking finding." }],
    }],
  };
}

afterEach(() => vi.useRealTimers());

type SinkMode = "absent" | "throws" | "rejects" | "pending" | "late-resolve" | "late-reject";

function hostileSink(mode: SinkMode) {
  let resolve: (() => void) | undefined;
  let reject: ((error: Error) => void) | undefined;
  const recordRunAuditEvent = mode === "absent" ? undefined : vi.fn(() => {
    if (mode === "throws") throw new Error("audit unavailable");
    if (mode === "rejects") return Promise.reject(new Error("audit unavailable"));
    if (mode === "pending") return new Promise<void>(() => undefined);
    return new Promise<void>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  });
  return { recordRunAuditEvent, settle: () => resolve?.(), reject: () => reject?.(new Error("late audit failure")) };
}

/** Run the lifecycle owner past the bounded audit wait and prove late rejections stay observed. */
async function runWithHostileSink<T>(sink: ReturnType<typeof hostileSink>, mode: SinkMode, run: () => Promise<T>) {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  vi.useFakeTimers();
  try {
    const pending = run();
    for (let turn = 0; turn < 4; turn += 1) await vi.advanceTimersByTimeAsync(RUN_AUDIT_EMIT_TIMEOUT_MS + 1);
    const result = await pending;
    if (mode === "late-resolve") sink.settle();
    if (mode === "late-reject") sink.reject();
    await Promise.resolve();
    await Promise.resolve();
    expect(unhandled).toEqual([]);
    return result;
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
}

describe("FN-149 review convergence audit sink health", () => {
  it.each([
    ["absent", undefined],
    ["throws", () => { throw new Error("audit unavailable"); }],
    ["rejects", async () => Promise.reject(new Error("audit unavailable"))],
  ])("keeps the stage-three lifecycle outcome under a %s audit sink", async (_mode, recordRunAuditEvent) => {
    const row = failedTask();
    const logEntry = vi.fn(async () => {});
    const store = {
      getTask: vi.fn(async () => row), getSettings: vi.fn(async () => ({})), logEntry,
      updateTask: vi.fn(async (_id, patch) => Object.assign(row, patch)),
      updateTaskAtomic: vi.fn(async (_id, callback) => {
        const patch = await callback(row);
        if (patch) Object.assign(row, patch);
        return row;
      }),
      ...(recordRunAuditEvent ? { recordRunAuditEvent: vi.fn(recordRunAuditEvent) } : {}),
    };
    await expect(routeReviewConvergenceLadder({
      store, sendTaskBackForFix: vi.fn(async () => {}),
      getRunContextFor: () => ({ agentId: "reviewer", runId: "run-149" }),
    } as any, row.id, {
      kind: "repeat-unchanged", workflowStepId: "code-review", stepName: "Code Review", feedback: "same", attempt: 3,
    })).resolves.toBe("released");
    expect(row).not.toHaveProperty("awaitingApprovalReason");
    expect(row).not.toHaveProperty("status");
    expect(logEntry).toHaveBeenCalledOnce();
  });

  it.each(["late-resolve", "late-reject"] as const)("absorbs a %s audit sink after the lifecycle branch returns", async (mode) => {
    vi.useFakeTimers();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    let resolveSink: (() => void) | undefined;
    let rejectSink: ((reason: Error) => void) | undefined;
    try {
      const row = failedTask();
      const logEntry = vi.fn(async () => {});
      const store = {
        getTask: vi.fn(async () => row), getSettings: vi.fn(async () => ({})), logEntry,
        updateTask: vi.fn(async (_id, patch) => Object.assign(row, patch)),
        updateTaskAtomic: vi.fn(async (_id, callback) => {
          const patch = await callback(row);
          if (patch) Object.assign(row, patch);
          return row;
        }),
        recordRunAuditEvent: vi.fn(() => new Promise<void>((resolve, reject) => {
          resolveSink = resolve;
          rejectSink = reject;
        })),
      };
      const outcome = routeReviewConvergenceLadder({
        store, sendTaskBackForFix: vi.fn(async () => {}),
        getRunContextFor: () => ({ agentId: "reviewer", runId: "run-149" }),
      } as any, row.id, {
        kind: "repeat-unchanged", workflowStepId: "code-review", stepName: "Code Review", feedback: "same", attempt: 3,
      });
      await vi.advanceTimersByTimeAsync(2_001);
      await expect(outcome).resolves.toBe("released");
      expect(logEntry).toHaveBeenCalledOnce();
      if (mode === "late-resolve") resolveSink?.();
      else rejectSink?.(new Error("late audit failure"));
      await Promise.resolve();
      await Promise.resolve();
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it.each(["absent", "throws", "rejects", "pending", "late-resolve", "late-reject"] as const)("keeps stage-one escalation lifecycle-effective with a %s sink", async (mode) => {
    const row = { ...failedTask(), reviewConvergenceStage: 0, reviewConvergenceEscalationCount: 0 };
    const sink = hostileSink(mode);
    const sendTaskBackForFix = vi.fn(async () => {});
    const store = {
      getTask: vi.fn(async () => row), logEntry: vi.fn(async () => {}),
      getSettings: vi.fn(async () => ({ reviewConvergenceEscalationEnabled: true, reviewConvergenceEscalationProvider: "mock", reviewConvergenceEscalationModelId: "strong" })),
      updateTask: vi.fn(async (_id, patch) => Object.assign(row, patch)),
      updateTaskAtomic: vi.fn(async (_id, callback) => { const patch = await callback(row); if (patch) Object.assign(row, patch); return row; }),
      ...(sink.recordRunAuditEvent ? { recordRunAuditEvent: sink.recordRunAuditEvent } : {}),
    };
    await expect(runWithHostileSink(sink, mode, () => routeReviewConvergenceLadder({ store, sendTaskBackForFix, getRunContextFor: () => ({ agentId: "reviewer", runId: "run-149" }) } as any, row.id, {
      kind: "repeat-unchanged", workflowStepId: "code-review", stepName: "Code Review", feedback: "same", attempt: 2,
    }))).resolves.toBe("escalated");
    expect(sendTaskBackForFix).toHaveBeenCalledOnce();
    expect(row).toMatchObject({ reviewConvergenceStage: 1, modelProvider: "mock", modelId: "strong" });
    if (sink.recordRunAuditEvent) {
      const event = sink.recordRunAuditEvent.mock.calls.map((call) => call[0])
        .find((candidate) => candidate.mutationType === "task:review-convergence-escalation");
      expect(event?.metadata).toMatchObject({
        stage: 1,
        mode: "alternate-model",
        hasModelTarget: true,
        escalationSource: "dedicated",
      });
    }
  });

  it.each(["absent", "throws", "rejects", "pending", "late-resolve", "late-reject"] as const)("keeps a fenced arbitration release observable with a %s sink", async (mode) => {
    const sink = hostileSink(mode);
    const row = failedTask();
    const logEntry = vi.fn(async () => {});
    const store = {
      getTask: vi.fn(async () => row), logEntry,
      updateTaskAtomic: vi.fn(async (_id, callback) => { const patch = await callback(row); if (patch) Object.assign(row, patch); return row; }),
      ...(sink.recordRunAuditEvent ? { recordRunAuditEvent: sink.recordRunAuditEvent } : {}),
    };
    await expect(runWithHostileSink(sink, mode, () => applyReviewArbitrationRelease({ store, getRunContextFor: () => ({ agentId: "reviewer", runId: "run-149" }) } as any, row.id, {
      workflowStepId: "code-review", expectedStartedAt: row.workflowStepResults[0].startedAt, expectedVerdict: "REVISE", decision: "UPHOLD_IMPLEMENTER", bindingFindingCount: 0, arbitratedAt: "2026-08-22T17:20:00.000Z", arbitrationNotes: "upheld",
    }))).resolves.toEqual({ applied: true });
    expect(logEntry).toHaveBeenCalledWith(row.id, "Review arbitration released adjudicated gate", expect.any(String), expect.anything());
    expect(getTaskMergeBlocker({ ...row, steps: [] } as any, { skipColumnIdentityCheck: true })).toBeUndefined();
  });

  it.each(["absent", "throws", "rejects", "pending", "late-resolve", "late-reject"] as const)("keeps a fenced-stale UPHOLD_REVIEW decline inert with a %s sink", async (mode) => {
    const sink = hostileSink(mode);
    const row = failedTask();
    row.worktree = "/tmp/review";
    row.prompt = "# Task";
    row.workflowStepResults[0] = {
      ...row.workflowStepResults[0],
      completedAt: "2026-08-22T01:01:00.000Z",
      reviewInputFingerprint: "reviewed-fingerprint",
      findings: [{ id: "f-1", title: "Must fix", body: "A blocking finding.", disputedAt: "2026-08-22T01:01:00.000Z" }],
    };
    vi.mocked(reviewStep).mockResolvedValue({
      review: '{"decision":"UPHOLD_REVIEW","notes":"maintain","bindingFindingIds":["f-1"]}',
    } as never);
    const sendTaskBackForFix = vi.fn(async () => {});
    const store = {
      getSettings: vi.fn(async () => ({ reviewArbitrationEnabled: true })),
      getTaskWorkflowSelection: vi.fn(async () => undefined),
      getWorkflowDefinition: vi.fn(async () => undefined),
      getWorkflowSettingValues: vi.fn(async () => ({})),
      getWorkflowSettingsProjectId: vi.fn(() => undefined),
      updateTaskAtomic: vi.fn(async (_id, callback) => {
        // Simulate a same-gate review retry winning while the arbiter session was running.
        row.workflowStepResults[0] = {
          ...row.workflowStepResults[0],
          completedAt: "2026-08-22T01:02:00.000Z",
          reviewInputFingerprint: "replacement-fingerprint",
        };
        const patch = await callback(row);
        if (patch) Object.assign(row, patch);
        return row;
      }),
      ...(sink.recordRunAuditEvent ? { recordRunAuditEvent: sink.recordRunAuditEvent } : {}),
    };
    await expect(runWithHostileSink(sink, mode, () => runReviewArbitration({
      store, sendTaskBackForFix, getRunContextFor: () => ({ agentId: "reviewer", runId: "run-149" }),
    } as any, row as any, "code-review", "Code Review", "same", 2, 3))).resolves.toBe("declined");
    expect(sendTaskBackForFix).not.toHaveBeenCalled();
    expect(row.workflowStepResults[0]).toMatchObject({
      completedAt: "2026-08-22T01:02:00.000Z", reviewInputFingerprint: "replacement-fingerprint",
    });
  });

  it.each(["absent", "throws", "rejects", "pending", "late-resolve", "late-reject"] as const)("persists the dispute before a %s audit sink", async (mode) => {
    const sink = hostileSink(mode);
    const row = failedTask();
    const store = {
      logEntry: vi.fn(async () => {}),
      updateTaskAtomic: vi.fn(async (_id, callback) => { const patch = await callback(row); if (patch) Object.assign(row, patch); return row; }),
      ...(sink.recordRunAuditEvent ? { recordRunAuditEvent: sink.recordRunAuditEvent } : {}),
    };
    const tool = createReviewDisputeTool({ store, getRunContextFor: () => undefined } as any, row.id);
    await expect(runWithHostileSink(sink, mode, () => tool.execute("call", { findingId: "f-1", rationale: "The transaction already protects this." } as never) as any)).resolves.toMatchObject({ details: { outcome: "disputed", workflowStepId: "code-review" } });
    expect(row.workflowStepResults[0].findings?.[0]).toMatchObject({ disputeRationale: "The transaction already protects this.", disputedAt: expect.any(String) });
  });

  it("releases Code Review at stage three without consulting a never-settling sink", async () => {
    vi.useFakeTimers();
    const row = failedTask();
    const logEntry = vi.fn(async () => {});
    const store = {
      getTask: vi.fn(async () => row), getSettings: vi.fn(async () => ({})), logEntry,
      updateTask: vi.fn(async (_id, patch) => Object.assign(row, patch)),
      updateTaskAtomic: vi.fn(async (_id, callback) => {
        const patch = await callback(row);
        if (patch) Object.assign(row, patch);
        return row;
      }),
      recordRunAuditEvent: vi.fn(() => new Promise(() => {})),
    };
    const outcome = routeReviewConvergenceLadder({
      store, sendTaskBackForFix: vi.fn(async () => {}),
      getRunContextFor: () => ({ agentId: "reviewer", runId: "run-149" }),
    } as any, row.id, {
      kind: "repeat-unchanged", workflowStepId: "code-review", stepName: "Code Review", feedback: "same", attempt: 3,
    });
    await vi.advanceTimersByTimeAsync(2_001);
    await expect(outcome).resolves.toBe("released");
    expect(logEntry).toHaveBeenCalledOnce();
    expect(store.recordRunAuditEvent).not.toHaveBeenCalled();
  });
});
