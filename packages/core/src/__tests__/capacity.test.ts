import { describe, expect, it } from "vitest";
import { computeCapacityRisk } from "../capacity.js";

describe("computeCapacityRisk", () => {
  it("is at risk when todo exceeds threshold and idle non-ephemeral count is zero", () => {
    expect(
      computeCapacityRisk({
        todoCount: 21,
        inProgressCount: 3,
        inReviewCount: 1,
        idleNonEphemeralAgentCount: 0,
        threshold: 20,
      }),
    ).toMatchObject({
      atRisk: true,
      reason: "todo-exceeds-threshold-and-no-idle-agents",
    });
  });

  it("is not at risk when idle non-ephemeral agents are available", () => {
    expect(
      computeCapacityRisk({
        todoCount: 30,
        inProgressCount: 2,
        inReviewCount: 4,
        idleNonEphemeralAgentCount: 1,
        threshold: 20,
      }),
    ).toMatchObject({ atRisk: false, reason: "ok" });
  });

  it("is not at risk when todo equals threshold", () => {
    expect(
      computeCapacityRisk({
        todoCount: 20,
        inProgressCount: 0,
        inReviewCount: 0,
        idleNonEphemeralAgentCount: 0,
        threshold: 20,
      }),
    ).toMatchObject({ atRisk: false, reason: "ok" });
  });

  it("is not at risk when todo is below threshold with zero idle agents", () => {
    expect(
      computeCapacityRisk({
        todoCount: 19,
        inProgressCount: 1,
        inReviewCount: 1,
        idleNonEphemeralAgentCount: 0,
        threshold: 20,
      }),
    ).toMatchObject({ atRisk: false, reason: "ok" });
  });
});
