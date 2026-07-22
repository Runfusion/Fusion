import { describe, expect, it, vi } from "vitest";
import type { Goal } from "@fusion/core";
import {
  emitGoalInjectionDiagnostic,
  resolveAndEmitGoalContext,
  resolveGoalContextForDiagnostics,
} from "../goals/goal-injection-diagnostics.js";

/*
FNXC:PgMigrationQuarantine 2026-07-18-04:15:
Goal injection awaits GoalStore listGoals under the PostgreSQL backend. These
wiring mocks return promises to preserve diagnostic and audit assertions at
the production-shaped async collaborator boundary.
*/

function goal(id: string, title: string, createdAt: string): Goal {
  return {
    id,
    title,
    description: undefined,
    status: "active",
    createdAt,
    updatedAt: createdAt,
  };
}

describe("goal injection diagnostics wiring seam", () => {
  it("resolveAndEmitGoalContext emits applied diagnostics and audit for planning lane", async () => {
    const goals = [goal("G-1", "one", "2026-01-01T00:00:00.000Z")];
    const store = {
      getGoalStore: () => ({ listGoals: async () => goals }),
      logEntry: vi.fn().mockResolvedValue(undefined),
      recordRunAuditEvent: vi.fn().mockResolvedValue(undefined),
    } as any;
    const audit = { database: vi.fn().mockResolvedValue(undefined) } as any;

    const resolution = await resolveAndEmitGoalContext({
      lane: "planning",
      store,
      audit,
      taskId: "FN-1",
      runContext: { runId: "plan-run", agentId: "agent-1", taskId: "FN-1", phase: "plan" },
    });

    expect(resolution.classification).toMatchObject({ outcome: "applied", goalCount: 1, goalIds: ["G-1"] });
    expect(audit.database).toHaveBeenCalledTimes(1);
    expect(store.recordRunAuditEvent).toHaveBeenCalledTimes(1);
  });

  it("resolveAndEmitGoalContext emits no-goals semantics when goal store is empty", async () => {
    const store = {
      getGoalStore: () => ({ listGoals: async () => [] }),
      logEntry: vi.fn().mockResolvedValue(undefined),
      recordRunAuditEvent: vi.fn().mockResolvedValue(undefined),
    } as any;
    const audit = { database: vi.fn().mockResolvedValue(undefined) } as any;

    const resolution = await resolveAndEmitGoalContext({
      lane: "executor",
      store,
      audit,
      taskId: "FN-1",
      runContext: { runId: "exec-run", agentId: "agent-1", taskId: "FN-1", phase: "execute" },
    });

    expect(resolution.goalContext).toBe("");
    expect(resolution.classification).toMatchObject({ outcome: "no-goals", goalCount: 0, goalIds: [] });
    expect(audit.database.mock.calls[0][0]).toMatchObject({
      type: "goal:injection-skipped",
      metadata: { lane: "executor", count: 0, reason: "no-active-goals" },
    });
  });

  it("routes heartbeat executor and planning lanes through the same canonical helper", async () => {
    const lanes = ["heartbeat", "executor", "planning"] as const;
    for (const lane of lanes) {
      const store = {
        getGoalStore: () => ({ listGoals: async () => [goal("G-1", "one", "2026-01-01T00:00:00.000Z")] }),
        getMissionStore: () => ({ listGoalIdsForTask: () => ["G-PROV-1", "G-PROV-2"] }),
        logEntry: vi.fn().mockResolvedValue(undefined),
        recordRunAuditEvent: vi.fn().mockResolvedValue(undefined),
      } as any;
      const audit = { database: vi.fn().mockResolvedValue(undefined) } as any;

      const resolution = await resolveAndEmitGoalContext({
        lane,
        store,
        audit,
        taskId: "FN-1",
        runContext: { runId: `${lane}-run`, agentId: "agent-1", taskId: "FN-1", phase: lane },
      });

      expect(resolution.classification).toMatchObject({ outcome: "applied", goalCount: 1, goalIds: ["G-1"] });
      expect(audit.database).toHaveBeenCalledTimes(1);
      expect(audit.database.mock.calls[0][0].metadata.lane).toBe(lane);
      expect(store.recordRunAuditEvent).toHaveBeenCalledTimes(1);
      expect(store.recordRunAuditEvent.mock.calls[0][0].metadata).toMatchObject({
        lane,
        provenanceGoalIds: ["G-PROV-1", "G-PROV-2"],
      });
      expect(store.logEntry.mock.calls[0][1]).toContain('provenance=["G-PROV-1","G-PROV-2"]');
    }
  });

  it("resolveAndEmitGoalContext handles missing getGoalStore with disabled classification", async () => {
    const store = {
      getMissionStore: () => ({ listGoalIdsForTask: () => [] }),
      logEntry: vi.fn().mockResolvedValue(undefined),
      recordRunAuditEvent: vi.fn().mockResolvedValue(undefined),
    } as any;
    const audit = { database: vi.fn().mockResolvedValue(undefined) } as any;

    const resolution = await resolveAndEmitGoalContext({
      lane: "heartbeat",
      store,
      audit,
      taskId: "FN-1",
      runContext: { runId: "hb-run", agentId: "agent-1", taskId: "FN-1", phase: "heartbeat" },
    });

    expect(resolution.goalContext).toBe("");
    expect(resolution.classification).toMatchObject({ outcome: "disabled-or-failed", reason: "store-unavailable" });
    expect(audit.database).toHaveBeenCalledTimes(1);
    expect(store.recordRunAuditEvent).toHaveBeenCalledTimes(1);
    expect(store.recordRunAuditEvent.mock.calls[0][0].metadata).toMatchObject({ provenanceGoalIds: [] });
  });
  it("emits applied audit metadata for positive injection", async () => {
    const goals = [goal("G-1", "one", "2026-01-01T00:00:00.000Z"), goal("G-2", "two", "2026-01-02T00:00:00.000Z")];
    const recordRunAuditEvent = vi.fn().mockResolvedValue(undefined);
    const store = { logEntry: vi.fn().mockResolvedValue(undefined), recordRunAuditEvent } as any;

    const resolution = resolveGoalContextForDiagnostics({ listActiveGoals: () => goals });
    await emitGoalInjectionDiagnostic({
      lane: "executor",
      ...resolution.classification,
      runId: "exec-run",
      agentId: "agent-1",
      taskId: "FN-1",
      store,
      runContext: { runId: "exec-run", agentId: "agent-1", taskId: "FN-1", phase: "execute" },
    });

    expect(recordRunAuditEvent).toHaveBeenCalledTimes(1);
    const event = recordRunAuditEvent.mock.calls[0][0];
    expect(event.mutationType).toBe("prompt:goal-injection");
    expect(event.metadata).toMatchObject({ outcome: "applied", goalCount: 2, goalIds: ["G-1", "G-2"] });
  });

  it("emits no-goals audit metadata when active goals are empty", async () => {
    const recordRunAuditEvent = vi.fn().mockResolvedValue(undefined);
    const store = { logEntry: vi.fn().mockResolvedValue(undefined), recordRunAuditEvent } as any;

    const resolution = resolveGoalContextForDiagnostics({ listActiveGoals: () => [] });
    await emitGoalInjectionDiagnostic({
      lane: "executor",
      ...resolution.classification,
      runId: "exec-run",
      agentId: "agent-1",
      taskId: "FN-1",
      store,
      runContext: { runId: "exec-run", agentId: "agent-1", taskId: "FN-1", phase: "execute" },
    });

    expect(recordRunAuditEvent).toHaveBeenCalledTimes(1);
    expect(recordRunAuditEvent.mock.calls[0][0].metadata).toMatchObject({ outcome: "no-goals", goalCount: 0, goalIds: [] });
  });

  it("fails soft when provenance resolution throws", async () => {
    const store = {
      getGoalStore: () => ({ listGoals: async () => [goal("G-1", "one", "2026-01-01T00:00:00.000Z")] }),
      getMissionStore: () => ({
        listGoalIdsForTask: () => {
          throw new Error("boom");
        },
      }),
      logEntry: vi.fn().mockResolvedValue(undefined),
      recordRunAuditEvent: vi.fn().mockResolvedValue(undefined),
    } as any;
    const audit = { database: vi.fn().mockResolvedValue(undefined) } as any;

    await expect(resolveAndEmitGoalContext({
      lane: "executor",
      store,
      audit,
      taskId: "FN-1",
      runContext: { runId: "exec-run", agentId: "agent-1", taskId: "FN-1", phase: "execute" },
    })).resolves.toMatchObject({
      classification: { outcome: "applied", goalIds: ["G-1"] },
    });

    expect(store.recordRunAuditEvent.mock.calls[0][0].metadata).toMatchObject({ provenanceGoalIds: [] });
  });

  it("classifies list failure and keeps prompt construction alive", async () => {
    const recordRunAuditEvent = vi.fn().mockResolvedValue(undefined);
    const store = { logEntry: vi.fn().mockResolvedValue(undefined), recordRunAuditEvent } as any;

    const resolution = resolveGoalContextForDiagnostics({
      listActiveGoals: () => {
        throw new TypeError("boom");
      },
    });

    await expect(
      emitGoalInjectionDiagnostic({
        lane: "executor",
        ...resolution.classification,
        runId: "exec-run",
        agentId: "agent-1",
        taskId: "FN-1",
        store,
        runContext: { runId: "exec-run", agentId: "agent-1", taskId: "FN-1", phase: "execute" },
      }),
    ).resolves.toBeTruthy();
    expect(recordRunAuditEvent).toHaveBeenCalledTimes(1);
    expect(recordRunAuditEvent.mock.calls[0][0].metadata).toMatchObject({
      outcome: "disabled-or-failed",
      reason: "list-failed",
      errorClass: "TypeError",
    });
    expect(resolution.goalContext).toBe("");
  });
});
