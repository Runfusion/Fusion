import { describe, expect, it } from "vitest";
import { derivePlannerOverseerState } from "../planner-overseer-state.js";

describe("derivePlannerOverseerState", () => {
  it("returns idle when oversightLevel is off, regardless of other inputs", () => {
    expect(
      derivePlannerOverseerState({
        oversightLevel: "off",
        hasObservation: true,
        attemptCount: 5,
        pendingConfirmationCount: 2,
      }),
    ).toBe("idle");
  });

  it("returns idle when there is no active observation", () => {
    expect(
      derivePlannerOverseerState({
        oversightLevel: "autonomous",
        hasObservation: false,
        attemptCount: 3,
        pendingConfirmationCount: 1,
      }),
    ).toBe("idle");
  });

  it("returns awaiting-confirmation when a pending confirmation exists, winning over attempts", () => {
    expect(
      derivePlannerOverseerState({
        oversightLevel: "autonomous",
        hasObservation: true,
        attemptCount: 2,
        pendingConfirmationCount: 1,
      }),
    ).toBe("awaiting-confirmation");
  });

  it("returns recovering when an attempt has been recorded and there is no pending confirmation", () => {
    expect(
      derivePlannerOverseerState({
        oversightLevel: "autonomous",
        hasObservation: true,
        attemptCount: 1,
        pendingConfirmationCount: 0,
      }),
    ).toBe("recovering");
  });

  it("returns steering for an active steer-level observation with no attempts/pending", () => {
    expect(
      derivePlannerOverseerState({
        oversightLevel: "steer",
        hasObservation: true,
        attemptCount: 0,
        pendingConfirmationCount: 0,
      }),
    ).toBe("steering");
  });

  it("returns watching for observe/autonomous active observations with no attempts/pending", () => {
    expect(
      derivePlannerOverseerState({
        oversightLevel: "observe",
        hasObservation: true,
      }),
    ).toBe("watching");
    expect(
      derivePlannerOverseerState({
        oversightLevel: "autonomous",
        hasObservation: true,
      }),
    ).toBe("watching");
  });

  it("never throws on undefined optional inputs", () => {
    expect(() =>
      derivePlannerOverseerState({
        oversightLevel: "autonomous",
        hasObservation: true,
        attemptCount: undefined,
        pendingConfirmationCount: undefined,
      }),
    ).not.toThrow();
  });
});
