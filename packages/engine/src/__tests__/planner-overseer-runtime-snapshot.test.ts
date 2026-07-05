import { describe, expect, it } from "vitest";
import { assemblePlannerOverseerRuntimeSnapshot } from "../planner-overseer-runtime-snapshot.js";
import type { OverseerStageObservation, OverseerWatchedStage } from "../planner-overseer.js";

function observation(overrides: Partial<OverseerStageObservation> = {}): OverseerStageObservation {
  return {
    taskId: "FN-1",
    stage: "executor" as OverseerWatchedStage,
    signal: "progressing",
    oversightLevel: "autonomous",
    observedAt: 1700000000000,
    reason: "test",
    sources: [],
    ...overrides,
  };
}

function fakeMonitor(observations: OverseerStageObservation[]) {
  return {
    getObservations: (taskId: string) => (taskId === "FN-1" ? observations : []),
  };
}

function fakeController(
  opts: { pending?: { status?: string }[]; attempts?: Record<string, number>; lastActions?: Record<string, string> } = {},
) {
  return {
    getPendingConfirmations: () => opts.pending ?? [],
    getAttemptCount: (_taskId: string, stage: string) => opts.attempts?.[stage] ?? 0,
    getLastAction: (_taskId: string, stage: string) => opts.lastActions?.[stage],
  };
}

describe("assemblePlannerOverseerRuntimeSnapshot", () => {
  it("returns null when there is no observation for the task", () => {
    const monitor = fakeMonitor([]);
    const controller = fakeController();
    expect(assemblePlannerOverseerRuntimeSnapshot("FN-1", monitor, controller)).toBeNull();
  });

  it("returns null when the monitor is undefined", () => {
    expect(assemblePlannerOverseerRuntimeSnapshot("FN-1", undefined, fakeController())).toBeNull();
  });

  it("returns a watching snapshot for an active observation with no attempts/pending", () => {
    const obs = observation({ oversightLevel: "autonomous", stage: "reviewer" as OverseerWatchedStage, signal: "stuck" });
    const snapshot = assemblePlannerOverseerRuntimeSnapshot("FN-1", fakeMonitor([obs]), fakeController());
    expect(snapshot).toMatchObject({
      state: "watching",
      oversightLevel: "autonomous",
      watchedStage: "reviewer",
      signal: "stuck",
      attemptCount: 0,
      pendingConfirmation: false,
      observedAt: 1700000000000,
    });
    expect(snapshot?.attemptLimit).toBeGreaterThan(0);
  });

  it("returns a steering snapshot for an active steer-level observation", () => {
    const obs = observation({ oversightLevel: "steer" });
    const snapshot = assemblePlannerOverseerRuntimeSnapshot("FN-1", fakeMonitor([obs]), fakeController());
    expect(snapshot?.state).toBe("steering");
  });

  it("returns a recovering snapshot with attemptCount/attemptLimit when attempts are recorded", () => {
    const obs = observation({ stage: "executor" as OverseerWatchedStage });
    const controller = fakeController({ attempts: { executor: 2 } });
    const snapshot = assemblePlannerOverseerRuntimeSnapshot("FN-1", fakeMonitor([obs]), controller);
    expect(snapshot).toMatchObject({ state: "recovering", attemptCount: 2 });
    expect(snapshot?.attemptLimit).toBeGreaterThan(0);
  });

  it("returns an awaiting-confirmation snapshot with pendingConfirmation:true when a confirmation is pending", () => {
    const obs = observation();
    const controller = fakeController({ pending: [{ status: "pending" }] });
    const snapshot = assemblePlannerOverseerRuntimeSnapshot("FN-1", fakeMonitor([obs]), controller);
    expect(snapshot).toMatchObject({ state: "awaiting-confirmation", pendingConfirmation: true });
  });

  it("uses the latest observation when the ring buffer has multiple entries", () => {
    const older = observation({ signal: "progressing", observedAt: 1 });
    const latest = observation({ signal: "failed", observedAt: 2 });
    const snapshot = assemblePlannerOverseerRuntimeSnapshot("FN-1", fakeMonitor([older, latest]), fakeController());
    expect(snapshot?.signal).toBe("failed");
    expect(snapshot?.observedAt).toBe(2);
  });

  it("passes through the observation's `reason` verbatim (FN-7517)", () => {
    const obs = observation({ reason: "Executor stage paused: waiting on human input" });
    const snapshot = assemblePlannerOverseerRuntimeSnapshot("FN-1", fakeMonitor([obs]), fakeController());
    expect(snapshot?.reason).toBe("Executor stage paused: waiting on human input");
  });

  it("includes lastAction from the recovery controller when present (FN-7517)", () => {
    const obs = observation({ stage: "executor" as OverseerWatchedStage });
    const controller = fakeController({ lastActions: { executor: "manual_nudge" } });
    const snapshot = assemblePlannerOverseerRuntimeSnapshot("FN-1", fakeMonitor([obs]), controller);
    expect(snapshot?.lastAction).toBe("manual_nudge");
  });

  it("omits lastAction entirely when the controller has no recorded action (FN-7517)", () => {
    const obs = observation({ stage: "executor" as OverseerWatchedStage });
    const snapshot = assemblePlannerOverseerRuntimeSnapshot("FN-1", fakeMonitor([obs]), fakeController());
    expect(snapshot && "lastAction" in snapshot).toBe(false);
  });

  it("never throws — a throwing monitor/controller degrades to null", () => {
    const throwingMonitor = {
      getObservations: () => {
        throw new Error("boom");
      },
    };
    expect(assemblePlannerOverseerRuntimeSnapshot("FN-1", throwingMonitor, fakeController())).toBeNull();

    const throwingController = {
      getPendingConfirmations: () => {
        throw new Error("boom");
      },
      getAttemptCount: () => 0,
    };
    expect(
      assemblePlannerOverseerRuntimeSnapshot("FN-1", fakeMonitor([observation()]), throwingController),
    ).toBeNull();
  });
});
