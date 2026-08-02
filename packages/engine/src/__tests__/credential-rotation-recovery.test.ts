import { describe, expect, it } from "vitest";
import { CREDENTIAL_INSTANCE_COOLDOWN_MS, CredentialInstanceRotator } from "../credential-instance-rotation.js";

describe("credential rotation recovery bounds", () => {
  it("self-expires a dashboard-monitor-unobserved cooldown", async () => {
    let now = 0;
    const ref = { providerId: "anthropic", instanceId: "backup" };
    const rotator = new CredentialInstanceRotator({
      instanceSource: { listInstances: () => [ref, { providerId: "anthropic", instanceId: "default" }], getDefaultInstance: () => undefined },
      now: () => now,
    });
    rotator.markLimited(ref);
    expect(rotator.isCoolingDown(ref)).toBe(true);
    now += CREDENTIAL_INSTANCE_COOLDOWN_MS;
    expect(rotator.isCoolingDown(ref)).toBe(false);
    const event = await rotator.beginEvent({ providerId: "anthropic", startingInstanceId: "default", lane: "agent-heartbeat" });
    expect((await event?.next())?.instanceId).toBe("backup");
  });
});
