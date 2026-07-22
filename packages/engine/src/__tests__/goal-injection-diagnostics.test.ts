import { beforeEach, describe, expect, it, vi } from "vitest";

const { warnSpy } = vi.hoisted(() => ({
  warnSpy: vi.fn(),
}));

vi.mock("../logger.js", () => ({
  createLogger: () => ({ warn: warnSpy, log: vi.fn(), error: vi.fn() }),
}));

import {
  emitGoalInjectionDiagnostic,
  type GoalInjectionDiagnosticInput,
} from "../goals/goal-injection-diagnostics.js";

function buildInput(overrides: Partial<GoalInjectionDiagnosticInput> = {}): GoalInjectionDiagnosticInput {
  return {
    lane: "executor",
    outcome: "applied",
    goalCount: 2,
    goalIds: ["G-1", "G-2"],
    truncated: false,
    runId: "run-1",
    agentId: "agent-1",
    taskId: "FN-1",
    ...overrides,
  };
}

describe("emitGoalInjectionDiagnostic", () => {
  beforeEach(() => {
    warnSpy.mockReset();
  });

  it("emits applied outcome to task log and run audit", async () => {
    const logEntry = vi.fn().mockResolvedValue(undefined);
    const recordRunAuditEvent = vi.fn().mockResolvedValue(undefined);
    const store = { logEntry, recordRunAuditEvent } as any;

    const result = await emitGoalInjectionDiagnostic(buildInput({ store, runContext: { runId: "run-1", agentId: "agent-1", taskId: "FN-1" } }));

    expect(result.outcome).toBe("applied");
    expect(result.goalCount).toBe(2);
    expect(result.goalIds).toEqual(["G-1", "G-2"]);
    expect(result.truncated).toBe(false);
    expect(result.reason).toBeUndefined();
    expect(logEntry).toHaveBeenCalledTimes(1);
    expect(logEntry.mock.calls[0][1]).toContain("[goal-injection] applied");
    expect(logEntry.mock.calls[0][1]).toContain('ids=["G-1","G-2"]');
    expect(recordRunAuditEvent).toHaveBeenCalledTimes(1);
    const auditInput = recordRunAuditEvent.mock.calls[0][0];
    expect(auditInput.mutationType).toBe("prompt:goal-injection");
    expect(auditInput.metadata).toMatchObject({ outcome: "applied", goalCount: 2, goalIds: ["G-1", "G-2"], truncated: false });
  });

  it("reflects truncated applied outcome", async () => {
    const recordRunAuditEvent = vi.fn().mockResolvedValue(undefined);
    const store = { logEntry: vi.fn().mockResolvedValue(undefined), recordRunAuditEvent } as any;

    const result = await emitGoalInjectionDiagnostic(buildInput({ store, runContext: { runId: "run-1", agentId: "agent-1" }, truncated: true }));

    expect(result.truncated).toBe(true);
    expect(recordRunAuditEvent.mock.calls[0][0].metadata.truncated).toBe(true);
  });

  it("emits no-goals outcome", async () => {
    const logEntry = vi.fn().mockResolvedValue(undefined);
    const recordRunAuditEvent = vi.fn().mockResolvedValue(undefined);
    const store = { logEntry, recordRunAuditEvent } as any;

    const result = await emitGoalInjectionDiagnostic(
      buildInput({
        store,
        runContext: { runId: "run-1", agentId: "agent-1", taskId: "FN-1" },
        outcome: "no-goals",
        goalCount: 0,
        goalIds: [],
      }),
    );

    expect(result.goalCount).toBe(0);
    expect(result.goalIds).toEqual([]);
    expect(result.truncated).toBe(false);
    expect(logEntry.mock.calls[0][1]).toContain("no-goals count=0 ids=[]");
    expect(recordRunAuditEvent).toHaveBeenCalledTimes(1);
  });

  it("supports disabled-or-failed reasons and errorClass", async () => {
    for (const reason of ["config-disabled", "store-unavailable", "list-failed", "injector-threw"] as const) {
      const result = await emitGoalInjectionDiagnostic(
        buildInput({
          outcome: "disabled-or-failed",
          goalCount: 0,
          goalIds: [],
          truncated: false,
          reason,
          errorClass: reason === "list-failed" || reason === "injector-threw" ? "Error" : undefined,
        }),
      );
      expect(result.reason).toBe(reason);
      if (reason === "list-failed" || reason === "injector-threw") {
        expect(result.errorClass).toBe("Error");
      }
    }
  });

  it("does not include forbidden payload keys", async () => {
    const recordRunAuditEvent = vi.fn().mockResolvedValue(undefined);
    const store = { logEntry: vi.fn().mockResolvedValue(undefined), recordRunAuditEvent } as any;

    const result = await emitGoalInjectionDiagnostic(buildInput({ store, runContext: { runId: "run-1", agentId: "agent-1" } }));
    const forbidden = ["title", "description", "body", "prompt", "text"];
    const keys = Object.keys(result);
    const metadataKeys = Object.keys(recordRunAuditEvent.mock.calls[0][0].metadata);
    for (const key of forbidden) {
      expect(keys).not.toContain(key);
      expect(metadataKeys).not.toContain(key);
    }
  });

  it("returns record without side effects when store missing", async () => {
    const result = await emitGoalInjectionDiagnostic(buildInput({ store: undefined, runContext: null }));
    expect(result.outcome).toBe("applied");
  });

  it("skips audit when runContext missing and warns", async () => {
    const store = { logEntry: vi.fn().mockResolvedValue(undefined), recordRunAuditEvent: vi.fn().mockResolvedValue(undefined) } as any;
    await emitGoalInjectionDiagnostic(buildInput({ store, runContext: null }));
    expect(store.recordRunAuditEvent).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
  });

  it("isolates side-effect failures", async () => {
    const storeLogFails = {
      logEntry: vi.fn().mockRejectedValue(new Error("log failed")),
      recordRunAuditEvent: vi.fn().mockResolvedValue(undefined),
    } as any;
    const first = await emitGoalInjectionDiagnostic(buildInput({ store: storeLogFails, runContext: { runId: "run-1", agentId: "agent-1" } }));
    expect(first.outcome).toBe("applied");
    expect(storeLogFails.recordRunAuditEvent).toHaveBeenCalledTimes(1);

    const storeAuditFails = {
      logEntry: vi.fn().mockResolvedValue(undefined),
      recordRunAuditEvent: vi.fn().mockRejectedValue(new Error("audit failed")),
    } as any;
    const second = await emitGoalInjectionDiagnostic(buildInput({ store: storeAuditFails, runContext: { runId: "run-1", agentId: "agent-1", taskId: "FN-1" } }));
    expect(second.outcome).toBe("applied");
    expect(storeAuditFails.logEntry).toHaveBeenCalledTimes(1);
  });
});
