import { describe, expect, it, vi } from "vitest";
import { CredentialInstanceRotator, type RotationLane } from "../credential-instance-rotation.js";

const lanes: RotationLane[] = ["executor-step", "executor-agent", "agent-heartbeat"];

describe("credential rotation lane audit attribution", () => {
  it.each(lanes)("attributes a rotated retry to %s", async (lane) => {
    const audit = vi.fn();
    const rotator = new CredentialInstanceRotator({
      instanceSource: { listInstances: () => [
        { providerId: "anthropic", instanceId: "a" },
        { providerId: "anthropic", instanceId: "b" },
      ], getDefaultInstance: () => undefined },
      recordRunAuditEvent: audit,
    });
    const event = await rotator.beginEvent({ providerId: "anthropic", startingInstanceId: "a", lane });
    await event?.next();
    expect(audit).toHaveBeenCalledWith("credential:instance-rotation-attempt", expect.objectContaining({ lane, toInstanceId: "b" }));
  });
});
