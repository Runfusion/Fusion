import { describe, expect, it, vi } from "vitest";
import type { TaskStore } from "@fusion/core";
import { RUN_AUDIT_EMIT_TIMEOUT_MS } from "../util/emit-bounded-run-audit.js";
import { emitGoalInjectionDiagnostic, resolveAndEmitGoalContext } from "../goals/goal-injection-diagnostics.js";
import { emitGoalRetrievalAudit } from "../goals/goal-anchoring-audit.js";

type Sink = undefined | (() => unknown);
const sinks: [string, Sink][] = [
  ["absent", undefined],
  ["throws", () => { throw new Error("sink down"); }],
  ["rejects", () => Promise.reject(new Error("sink down"))],
  ["hangs", () => new Promise<void>(() => {})],
  ["late", () => new Promise<void>(() => {})],
];

async function diagnostic(sink: Sink) {
  const store = { recordRunAuditEvent: sink } as unknown as TaskStore;
  return emitGoalInjectionDiagnostic({
    lane: "heartbeat", outcome: "applied", goalCount: 1, goalIds: ["G-1"], truncated: false,
    store, runContext: { runId: "run", agentId: "agent", taskId: "FN-1", phase: "heartbeat" },
  });
}

describe("goal run-audit sink health", () => {
  it.each(sinks)("preserves the diagnostic through an %s audit sink", async (name, sink) => {
    if (name === "hangs") vi.useFakeTimers();
    try {
      const pending = diagnostic(sink);
      if (name === "hangs") await vi.advanceTimersByTimeAsync(RUN_AUDIT_EMIT_TIMEOUT_MS);
      await expect(pending).resolves.toMatchObject({ lane: "heartbeat", goalIds: ["G-1"] });
    } finally { vi.useRealTimers(); }
  });

  it.each(sinks)("keeps retrieval synchronous when sink %s", async (_name, sink) => {
    const store = { recordRunAuditEvent: sink } as unknown as TaskStore;
    expect(() => emitGoalRetrievalAudit(store, { runId: "run", agentId: "agent", taskId: "FN-1" }, { toolName: "fn_goal_list", resultCount: 1, goalIds: ["G-1"] })).not.toThrow();
  });

  it.each(sinks)("preserves resolveAndEmitGoalContext results when diagnostic sink %s", async (name, sink) => {
    if (name === "hangs" || name === "late") vi.useFakeTimers();
    try {
      const store = {
        recordRunAuditEvent: sink,
        getGoalStore: () => ({ listGoals: async () => [] }),
      } as unknown as TaskStore;
      const pending = resolveAndEmitGoalContext({
        lane: "heartbeat", store, audit: { database: vi.fn(async () => undefined) } as any,
        runContext: { runId: "run", agentId: "agent", phase: "heartbeat" },
      });
      if (name === "hangs" || name === "late") await vi.advanceTimersByTimeAsync(RUN_AUDIT_EMIT_TIMEOUT_MS);
      await expect(pending).resolves.toMatchObject({ goalContext: "", classification: { outcome: "no-goals" } });
    } finally { vi.useRealTimers(); }
  });

  it("keeps retrieval synchronous and observes a late rejection", async () => {
    vi.useFakeTimers();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    let reject!: (error: Error) => void;
    const late = new Promise<void>((_resolve, rejectPromise) => { reject = rejectPromise; });
    const sink = vi.fn(() => late);
    try {
      expect(() => emitGoalRetrievalAudit({ recordRunAuditEvent: sink } as unknown as TaskStore, { runId: "run", agentId: "agent", taskId: "FN-1" }, { toolName: "fn_goal_list", resultCount: 1, goalIds: ["G-1"] })).not.toThrow();
      expect(sink).toHaveBeenCalledWith(expect.objectContaining({ mutationType: "goal:retrieval-invoked", metadata: expect.objectContaining({ goalIds: ["G-1"] }) }));
      await vi.advanceTimersByTimeAsync(RUN_AUDIT_EMIT_TIMEOUT_MS);
      reject(new Error("late"));
      await Promise.resolve();
      expect(unhandled).not.toHaveBeenCalled();
    } finally { process.off("unhandledRejection", unhandled); vi.useRealTimers(); }
  });
});
