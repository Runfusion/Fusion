import { describe, expect, it, vi } from "vitest";
import type { Task } from "@fusion/core";
import { OverseerAdvisorService, createParsingOverseerAgent } from "../overseer/overseer-advisor-service.js";
import { ProjectEngine } from "../project-engine.js";
import { RUN_AUDIT_EMIT_TIMEOUT_MS } from "../util/emit-bounded-run-audit.js";

const task = { id: "FN-1", title: "t", column: "in-progress", status: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" } as Task;

describe("overseer run-audit sink health", () => {
  it.each([
    ["absent", undefined], ["throws", () => { throw new Error("down"); }],
    ["rejects", () => Promise.reject(new Error("down"))], ["hangs", () => new Promise<void>(() => {})],
    ["late", () => new Promise<void>(() => {})],
  ])("delivers advice when the steering sink %s", async (_name, recordRunAuditEvent) => {
    const addSteeringComment = vi.fn(async () => ({}));
    const service = new OverseerAdvisorService({
      store: { addSteeringComment, recordRunAuditEvent, getRunAuditEvents: () => [], getTask: async () => task },
      resolveLevel: () => "autonomous",
      resolveModel: () => ({ provider: "mock", modelId: "scripted" }),
      agentFactory: async ({ systemPrompt, onAdvice }) => createParsingOverseerAgent({ systemPrompt, onAdvice, complete: async () => JSON.stringify({ note: "Check scope", severity: "concern" }) }),
    });
    expect(await service.ensureTask(task)).toBe(true);
    await service.onExecutorLogDelta(task.id, [{ type: "text", text: "editing source", agent: "executor" }]);
    await vi.waitFor(() => expect(addSteeringComment).toHaveBeenCalled());
  });

  it.each([
    ["absent", undefined], ["throws", () => { throw new Error("down"); }],
    ["rejects", () => Promise.reject(new Error("down"))], ["hangs", () => new Promise<void>(() => {})],
    ["late", () => new Promise<void>(() => {})],
  ])("completes the ProjectEngine escalation caller when the facade sink %s", async (name, recordRunAuditEvent) => {
    if (name === "hangs" || name === "late") vi.useFakeTimers();
    try {
      // This prototype entry is the exact private ProjectEngine poll helper without booting unrelated runtime subsystems.
      const engine = Object.create(ProjectEngine.prototype) as any;
      engine.plannerEscalationEmitDedup = new Set();
      const audit = recordRunAuditEvent ? vi.fn(recordRunAuditEvent) : undefined;
      const store = { recordRunAuditEvent: audit, getRunAuditEvents: () => [] } as any;
      const pending = engine.emitOverseerEscalationDeduped(store, "FN-1", {
        watchedStage: "executor", reason: "budget exhausted", attemptCount: 1, attemptLimit: 1, sourceLinks: [],
      });
      if (name === "hangs" || name === "late") await vi.advanceTimersByTimeAsync(RUN_AUDIT_EMIT_TIMEOUT_MS);
      await expect(pending).resolves.toBeUndefined();
      if (audit) expect(audit).toHaveBeenCalledWith(expect.objectContaining({
        mutationType: "overseer:intervention", taskId: "FN-1", metadata: expect.objectContaining({ action: "escalate", outcome: "failed" }),
      }));
    } finally { vi.useRealTimers(); }
  });

  it("pre-observes a late steering rejection after advice delivery", async () => {
    let reject!: (error: Error) => void;
    const late = new Promise<void>((_resolve, rejectPromise) => { reject = rejectPromise; });
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const addSteeringComment = vi.fn(async () => ({}));
      const service = new OverseerAdvisorService({
        store: { addSteeringComment, recordRunAuditEvent: () => late, getRunAuditEvents: () => [], getTask: async () => task },
        resolveLevel: () => "autonomous",
        resolveModel: () => ({ provider: "mock", modelId: "scripted" }),
        agentFactory: async ({ systemPrompt, onAdvice }) => createParsingOverseerAgent({ systemPrompt, onAdvice, complete: async () => JSON.stringify({ note: "Check scope", severity: "concern" }) }),
      });
      await service.ensureTask(task);
      await service.onExecutorLogDelta(task.id, [{ type: "text", text: "editing source", agent: "executor" }]);
      await vi.waitFor(() => expect(addSteeringComment).toHaveBeenCalled());
      reject(new Error("late"));
      await Promise.resolve();
      expect(unhandled).not.toHaveBeenCalled();
    } finally { process.off("unhandledRejection", unhandled); }
  });
});
