import { describe, it, expect } from "vitest";
import {
  emitOverseerObservation,
  emitOverseerSteering,
  emitOverseerRecoveryAttempt,
  emitOverseerRetry,
  emitOverseerConfirmation,
  emitOverseerEscalation,
} from "../planner-overseer-events.js";
import { getPlannerInterventionTimeline, type PlannerInterventionStore } from "../planner-intervention.js";
import { OVERSEER_INTERVENTION_MUTATION } from "../types.js";
import type { RunAuditEvent, RunAuditEventFilter, RunAuditEventInput } from "../types.js";

/*
FNXC:PlannerOversight 2026-07-04-19:30:
FN-7520 unit tests for the canonical `emitOverseer*` emission façade. Uses the
same narrow in-memory fake store pattern as FN-7519's
`planner-intervention.test.ts` (only depends on the
`recordRunAuditEvent`/`getRunAuditEvents` seam) to keep this suite fast per
the project's "Do Not Add Slow Tests" standing rule.
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

  async getRunAuditEventsAsync(options: RunAuditEventFilter = {}): Promise<RunAuditEvent[]> {
    return this.events
      .filter((event) => (options.taskId ? event.taskId === options.taskId : true))
      .filter((event) => (options.mutationType ? event.mutationType === options.mutationType : true))
      .slice()
      .sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0))
      .slice(0, options.limit ?? undefined);
  }
}

describe("emitOverseer* façade", () => {
  it("emitOverseerObservation records action=observe, default outcome=succeeded, no attempt fields", async () => {
    const store = new FakeRunAuditStore();
    emitOverseerObservation({
      store,
      taskId: "FN-1",
      runId: "run-1",
      stage: "executor",
      reason: "Executor is progressing normally",
    });

    const timeline = await getPlannerInterventionTimeline(store, "FN-1");
    expect(timeline).toHaveLength(1);
    expect(timeline[0].action).toBe("observe");
    expect(timeline[0].outcome).toBe("succeeded");
    expect(timeline[0].stage).toBe("executor");
    expect(timeline[0].reason).toBe("Executor is progressing normally");
    expect(timeline[0].attemptCount).toBeUndefined();
    expect(timeline[0].attemptLimit).toBeUndefined();
  });

  it("emitOverseerSteering records action=inject-guidance, default outcome=pending", async () => {
    const store = new FakeRunAuditStore();
    emitOverseerSteering({
      store,
      taskId: "FN-2",
      stage: "executor",
      reason: "Injecting guidance to unblock stalled step",
    });

    const timeline = await getPlannerInterventionTimeline(store, "FN-2");
    expect(timeline[0].action).toBe("inject-guidance");
    expect(timeline[0].outcome).toBe("pending");
  });

  it("emitOverseerRecoveryAttempt records action=request-fix, default outcome=pending, persists attempt fields", async () => {
    const store = new FakeRunAuditStore();
    emitOverseerRecoveryAttempt({
      store,
      taskId: "FN-3",
      stage: "reviewer",
      reason: "Requesting fix for failing review checks",
      attemptCount: 1,
      attemptLimit: 3,
    });

    const timeline = await getPlannerInterventionTimeline(store, "FN-3");
    expect(timeline[0].action).toBe("request-fix");
    expect(timeline[0].outcome).toBe("pending");
    expect(timeline[0].attemptCount).toBe(1);
    expect(timeline[0].attemptLimit).toBe(3);
  });

  it("emitOverseerRetry records action=retry, default outcome=pending, persists attempt fields", async () => {
    const store = new FakeRunAuditStore();
    emitOverseerRetry({
      store,
      taskId: "FN-4",
      stage: "merger",
      reason: "Retrying stuck merge step",
      attemptCount: 2,
      attemptLimit: 4,
    });

    const timeline = await getPlannerInterventionTimeline(store, "FN-4");
    expect(timeline[0].action).toBe("retry");
    expect(timeline[0].outcome).toBe("pending");
    expect(timeline[0].attemptCount).toBe(2);
    expect(timeline[0].attemptLimit).toBe(4);
  });

  it("emitOverseerConfirmation records action=request-confirmation, default outcome=awaiting-confirmation", async () => {
    const store = new FakeRunAuditStore();
    emitOverseerConfirmation({
      store,
      taskId: "FN-5",
      stage: "pull-request",
      reason: "Requesting human confirmation before merge",
    });

    const timeline = await getPlannerInterventionTimeline(store, "FN-5");
    expect(timeline[0].action).toBe("request-confirmation");
    expect(timeline[0].outcome).toBe("awaiting-confirmation");
  });

  it("emitOverseerEscalation records action=escalate, default outcome=failed", async () => {
    const store = new FakeRunAuditStore();
    emitOverseerEscalation({
      store,
      taskId: "FN-6",
      stage: "workflow-gate",
      reason: "Bounded recovery exhausted; escalating to human",
    });

    const timeline = await getPlannerInterventionTimeline(store, "FN-6");
    expect(timeline[0].action).toBe("escalate");
    expect(timeline[0].outcome).toBe("failed");
  });

  it("an explicit outcome overrides each emitter's default", async () => {
    const store = new FakeRunAuditStore();
    emitOverseerObservation({
      store,
      taskId: "FN-7",
      stage: "executor",
      reason: "Observation with overridden outcome",
      outcome: "failed",
    });
    emitOverseerEscalation({
      store,
      taskId: "FN-7",
      stage: "workflow-gate",
      reason: "Escalation bypassed by human-control guard",
      outcome: "skipped",
    });

    const timeline = await getPlannerInterventionTimeline(store, "FN-7");
    // Newest-first ordering.
    expect(timeline[0].action).toBe("escalate");
    expect(timeline[0].outcome).toBe("skipped");
    expect(timeline[1].action).toBe("observe");
    expect(timeline[1].outcome).toBe("failed");
  });

  it("sourceLinks round-trip through metadata for every kind used by producers", async () => {
    const store = new FakeRunAuditStore();
    emitOverseerRecoveryAttempt({
      store,
      taskId: "FN-8",
      stage: "reviewer",
      reason: "Requesting fix with linked evidence",
      attemptCount: 1,
      attemptLimit: 2,
      sourceLinks: [
        { kind: "agent-log", label: "Agent log excerpt" },
        { kind: "failed-check", label: "Failing lint check" },
        { kind: "merge-error", label: "Merge conflict detail" },
        { kind: "pr-state", label: "PR review state" },
      ],
    });

    const timeline = await getPlannerInterventionTimeline(store, "FN-8");
    expect(timeline[0].sourceLinks).toEqual([
      { kind: "agent-log", label: "Agent log excerpt", target: undefined, url: undefined },
      { kind: "failed-check", label: "Failing lint check", target: undefined, url: undefined },
      { kind: "merge-error", label: "Merge conflict detail", target: undefined, url: undefined },
      { kind: "pr-state", label: "PR review state", target: undefined, url: undefined },
    ]);
  });

  it("is non-throwing when only the minimal required fields are supplied", async () => {
    const store = new FakeRunAuditStore();
    expect(() =>
      emitOverseerObservation({
        store,
        taskId: "FN-9",
        runId: "run-9",
        stage: "executor",
        reason: "Minimal observation",
      }),
    ).not.toThrow();

    const timeline = await getPlannerInterventionTimeline(store, "FN-9");
    expect(timeline).toHaveLength(1);
  });

  it("enforces the single-writer contract: every emitter produces only overseer:intervention events via recordPlannerIntervention", () => {
    const store = new FakeRunAuditStore();
    emitOverseerObservation({ store, taskId: "FN-10", stage: "executor", reason: "r1" });
    emitOverseerSteering({ store, taskId: "FN-10", stage: "executor", reason: "r2" });
    emitOverseerRecoveryAttempt({ store, taskId: "FN-10", stage: "reviewer", reason: "r3", attemptCount: 1, attemptLimit: 2 });
    emitOverseerRetry({ store, taskId: "FN-10", stage: "merger", reason: "r4", attemptCount: 1, attemptLimit: 2 });
    emitOverseerConfirmation({ store, taskId: "FN-10", stage: "pull-request", reason: "r5" });
    emitOverseerEscalation({ store, taskId: "FN-10", stage: "workflow-gate", reason: "r6" });

    expect(store.events).toHaveLength(6);
    for (const event of store.events) {
      expect(event.mutationType).toBe(OVERSEER_INTERVENTION_MUTATION);
      expect(event.mutationType).toBe("overseer:intervention");
    }
    // No other overseer:* mutation types are introduced by this façade.
    const mutationTypes = new Set(store.events.map((e) => e.mutationType));
    expect(mutationTypes.size).toBe(1);
  });
});
