import { describe, it, expect } from "vitest";
import {
  recordPlannerIntervention,
  parseInterventionEntry,
  getPlannerInterventionTimeline,
  type PlannerInterventionStore,
} from "../planner-intervention.js";
import { OVERSEER_INTERVENTION_MUTATION } from "../types.js";
import type { RunAuditEvent, RunAuditEventFilter, RunAuditEventInput } from "../types.js";

/*
FNXC:PlannerOversight 2026-07-04-18:00:
FN-7519 unit tests for the planner-intervention record/read/parse helpers.
Uses a minimal in-memory fake implementing `PlannerInterventionStore` rather
than a real TaskStore/SQLite instance — these helpers only depend on the
`recordRunAuditEvent`/`getRunAuditEvents` seam, so a narrow fake keeps this
suite fast per the project's "Do Not Add Slow Tests" standing rule.
*/
class FakeRunAuditStore implements PlannerInterventionStore {
  events: RunAuditEvent[] = [];
  private counter = 0;

  recordRunAuditEvent(input: RunAuditEventInput): RunAuditEvent {
    const event: RunAuditEvent = {
      id: `evt-${++this.counter}`,
      timestamp: input.timestamp ?? new Date(Date.now() + this.counter).toISOString(),
      taskId: input.taskId,
      agentId: input.agentId,
      runId: input.runId,
      domain: input.domain,
      mutationType: input.mutationType,
      target: input.target,
      metadata: input.metadata,
    };
    this.events.push(event);
    return event;
  }

  getRunAuditEvents(options: RunAuditEventFilter = {}): RunAuditEvent[] {
    return this.events
      .filter((event) => (options.taskId ? event.taskId === options.taskId : true))
      .filter((event) => (options.mutationType ? event.mutationType === options.mutationType : true))
      .slice()
      .sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0))
      .slice(0, options.limit ?? undefined);
  }
}

describe("recordPlannerIntervention", () => {
  it("writes an overseer:intervention run-audit event with all six field groups in metadata", () => {
    const store = new FakeRunAuditStore();

    recordPlannerIntervention(store, {
      taskId: "FN-1",
      stage: "executor",
      reason: "Executor stalled without progress",
      action: "retry",
      outcome: "pending",
      attemptCount: 1,
      attemptLimit: 3,
      sourceLinks: [{ kind: "agent-log", label: "Agent log", target: "run-1" }],
    });

    expect(store.events).toHaveLength(1);
    const event = store.events[0];
    expect(event.mutationType).toBe(OVERSEER_INTERVENTION_MUTATION);
    expect(event.taskId).toBe("FN-1");
    expect(event.domain).toBe("database");
    expect(event.metadata).toMatchObject({
      stage: "executor",
      reason: "Executor stalled without progress",
      action: "retry",
      outcome: "pending",
      attemptCount: 1,
      attemptLimit: 3,
      sourceLinks: [{ kind: "agent-log", label: "Agent log", target: "run-1" }],
    });
  });

  it("does not throw and omits optional fields when absent", () => {
    const store = new FakeRunAuditStore();

    expect(() =>
      recordPlannerIntervention(store, {
        taskId: "FN-2",
        stage: "reviewer",
        reason: "Reviewer awaiting confirmation",
        action: "observe",
        outcome: "awaiting-confirmation",
      }),
    ).not.toThrow();

    const event = store.events[0];
    expect(event.metadata).not.toHaveProperty("attemptCount");
    expect(event.metadata).not.toHaveProperty("attemptLimit");
    expect(event.metadata).not.toHaveProperty("sourceLinks");
  });
});

describe("getPlannerInterventionTimeline", () => {
  it("returns entries newest-first and filters out non-intervention events", () => {
    const store = new FakeRunAuditStore();

    recordPlannerIntervention(store, {
      taskId: "FN-3",
      stage: "merger",
      reason: "First intervention",
      action: "escalate",
      outcome: "failed",
      timestamp: "2026-07-04T10:00:00.000Z",
    });
    store.recordRunAuditEvent({
      taskId: "FN-3",
      agentId: "system",
      runId: "unrelated-run",
      domain: "database",
      mutationType: "task:handoff",
      target: "FN-3",
      timestamp: "2026-07-04T10:30:00.000Z",
    });
    recordPlannerIntervention(store, {
      taskId: "FN-3",
      stage: "pull-request",
      reason: "Second intervention",
      action: "request-confirmation",
      outcome: "awaiting-confirmation",
      timestamp: "2026-07-04T11:00:00.000Z",
    });

    const timeline = getPlannerInterventionTimeline(store, "FN-3");

    expect(timeline).toHaveLength(2);
    expect(timeline[0].reason).toBe("Second intervention");
    expect(timeline[1].reason).toBe("First intervention");
  });

  it("returns [] when there are no interventions for the task", () => {
    const store = new FakeRunAuditStore();
    expect(getPlannerInterventionTimeline(store, "FN-4")).toEqual([]);
  });
});

describe("parseInterventionEntry", () => {
  it("returns null for unrelated audit events", () => {
    const event: RunAuditEvent = {
      id: "evt-x",
      timestamp: "2026-07-04T10:00:00.000Z",
      taskId: "FN-5",
      agentId: "system",
      runId: "run-x",
      domain: "database",
      mutationType: "task:handoff",
      target: "FN-5",
    };
    expect(parseInterventionEntry(event)).toBeNull();
  });

  it("tolerates missing attemptCount/attemptLimit, missing/empty sourceLinks, and unknown enum values without throwing", () => {
    const event: RunAuditEvent = {
      id: "evt-y",
      timestamp: "2026-07-04T10:00:00.000Z",
      taskId: "FN-6",
      agentId: "overseer",
      runId: "run-y",
      domain: "database",
      mutationType: OVERSEER_INTERVENTION_MUTATION,
      target: "FN-6",
      metadata: {
        stage: "some-future-stage",
        reason: "",
        action: "some-future-action",
        outcome: "some-future-outcome",
        sourceLinks: [],
      },
    };

    let parsed: ReturnType<typeof parseInterventionEntry> = null;
    expect(() => {
      parsed = parseInterventionEntry(event);
    }).not.toThrow();

    expect(parsed).not.toBeNull();
    expect(parsed!.stage).toBe("workflow-gate");
    expect(parsed!.action).toBe("observe");
    expect(parsed!.outcome).toBe("pending");
    expect(parsed!.reason).toBe("Unknown reason");
    expect(parsed!.attemptCount).toBeUndefined();
    expect(parsed!.attemptLimit).toBeUndefined();
    expect(parsed!.sourceLinks).toBeUndefined();
  });

  it("handles a missing metadata object on an intervention event without throwing", () => {
    const event: RunAuditEvent = {
      id: "evt-z",
      timestamp: "2026-07-04T10:00:00.000Z",
      taskId: "FN-7",
      agentId: "overseer",
      runId: "run-z",
      domain: "database",
      mutationType: OVERSEER_INTERVENTION_MUTATION,
      target: "FN-7",
    };
    expect(() => parseInterventionEntry(event)).not.toThrow();
    const parsed = parseInterventionEntry(event);
    expect(parsed).not.toBeNull();
    expect(parsed!.stage).toBe("workflow-gate");
  });
});
