import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CORE_RUN_AUDIT_EMIT_TIMEOUT_MS,
  emitBoundedRunAudit,
  emitBoundedRunAuditWithOutcome,
} from "../run-audit/emit-bounded-run-audit.js";

const event = { taskId: "FN-1", agentId: "system", runId: "run", domain: "database" as const, mutationType: "test:audit", target: "FN-1", metadata: {} };

afterEach(() => vi.useRealTimers());

describe("emitBoundedRunAudit", () => {
  it("calls sinks synchronously and resolves healthy, absent, throwing, and rejecting sinks", async () => {
    const log = { warn: vi.fn() };
    const sink = vi.fn(() => undefined);
    const promise = emitBoundedRunAudit({ recordRunAuditEvent: sink }, event, { log });
    expect(sink).toHaveBeenCalledWith(event);
    await expect(promise).resolves.toBeUndefined();
    await expect(emitBoundedRunAudit(undefined, event, { log })).resolves.toBeUndefined();
    await expect(emitBoundedRunAudit({ recordRunAuditEvent: () => { throw new Error("no"); } }, event, { log })).resolves.toBeUndefined();
    await expect(emitBoundedRunAudit({ recordRunAuditEvent: () => Promise.reject(new Error("no")) }, event, { log })).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith("[run-audit] failed to record test:audit");
  });

  it("bounds never-settling and late-settling sinks without unhandled rejections", async () => {
    vi.useFakeTimers();
    const log = { warn: vi.fn() };
    const never = emitBoundedRunAudit({ recordRunAuditEvent: () => new Promise(() => undefined) }, event, { log });
    await vi.advanceTimersByTimeAsync(CORE_RUN_AUDIT_EMIT_TIMEOUT_MS);
    await expect(never).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith("[run-audit] timed out recording test:audit");

    let reject!: (error: Error) => void;
    const late = emitBoundedRunAudit({ recordRunAuditEvent: () => new Promise<unknown>((_, fail) => { reject = fail; }) }, event, { timeoutMs: 1, log });
    await vi.advanceTimersByTimeAsync(1);
    reject(new Error("late"));
    await expect(late).resolves.toBeUndefined();
  });
});

describe("emitBoundedRunAuditWithOutcome", () => {
  it("classifies absent, successful, and failed sinks with original errors", async () => {
    const log = { warn: vi.fn() };
    const thrown = new Error("thrown");
    const rejected = new Error("rejected");

    await expect(emitBoundedRunAuditWithOutcome(undefined, event, { log })).resolves.toEqual({ outcome: "absent" });
    await expect(emitBoundedRunAuditWithOutcome({ recordRunAuditEvent: 1 as never }, event, { log })).resolves.toEqual({ outcome: "absent" });
    await expect(emitBoundedRunAuditWithOutcome({ recordRunAuditEvent: () => undefined }, event, { log })).resolves.toEqual({ outcome: "recorded" });
    await expect(emitBoundedRunAuditWithOutcome({ recordRunAuditEvent: () => { throw thrown; } }, event, { log })).resolves.toEqual({ outcome: "failed", error: thrown });
    await expect(emitBoundedRunAuditWithOutcome({ recordRunAuditEvent: () => Promise.reject(rejected) }, event, { log })).resolves.toEqual({ outcome: "failed", error: rejected });
  });

  it("bounds never and late-settling sinks with explicit outcomes", async () => {
    vi.useFakeTimers();
    const log = { warn: vi.fn() };
    const never = emitBoundedRunAuditWithOutcome({ recordRunAuditEvent: () => new Promise(() => undefined) }, event, { log });
    await vi.advanceTimersByTimeAsync(CORE_RUN_AUDIT_EMIT_TIMEOUT_MS);
    await expect(never).resolves.toEqual({ outcome: "timed-out" });

    let resolveLate!: () => void;
    const lateResolve = emitBoundedRunAuditWithOutcome({ recordRunAuditEvent: () => new Promise<void>((resolve) => { resolveLate = resolve; }) }, event, { timeoutMs: 1, log });
    await vi.advanceTimersByTimeAsync(1);
    resolveLate();
    await expect(lateResolve).resolves.toEqual({ outcome: "timed-out" });

    let rejectLate!: (error: Error) => void;
    const lateReject = emitBoundedRunAuditWithOutcome({ recordRunAuditEvent: () => new Promise<void>((_resolve, reject) => { rejectLate = reject; }) }, event, { timeoutMs: 1, log });
    await vi.advanceTimersByTimeAsync(1);
    rejectLate(new Error("late rejection"));
    await expect(lateReject).resolves.toEqual({ outcome: "timed-out" });
  });

  it("still invokes the void seam synchronously and resolves undefined for every sink state", async () => {
    vi.useFakeTimers();
    const modes = [
      undefined,
      () => undefined,
      () => { throw new Error("throw"); },
      () => Promise.reject(new Error("reject")),
      () => new Promise(() => undefined),
    ];
    for (const recordRunAuditEvent of modes) {
      const sink = vi.fn(recordRunAuditEvent);
      const promise = emitBoundedRunAudit(recordRunAuditEvent === undefined ? undefined : { recordRunAuditEvent: sink }, event, { log: { warn: vi.fn() } });
      if (recordRunAuditEvent !== undefined) expect(sink).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(CORE_RUN_AUDIT_EMIT_TIMEOUT_MS);
      await expect(promise).resolves.toBeUndefined();
    }
  });
});
