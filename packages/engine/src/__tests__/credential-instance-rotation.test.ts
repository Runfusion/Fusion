import { describe, expect, it, vi } from "vitest";
import {
  CREDENTIAL_INSTANCE_COOLDOWN_MS,
  CredentialInstanceRotator,
  createRotationPlan,
} from "../credential-instance-rotation.js";

const ref = (instanceId: string) => ({ providerId: "anthropic", instanceId });

describe("CredentialInstanceRotator", () => {
  it("has a zero-side-effect no-op gate for zero and single-instance inventories", async () => {
    for (const instances of [[], [ref("default")]]) {
      const audit = vi.fn();
      const rotator = new CredentialInstanceRotator({ instanceSource: { listInstances: () => instances, getDefaultInstance: () => undefined }, recordRunAuditEvent: audit });
      expect(await rotator.beginEvent({ providerId: "anthropic", startingInstanceId: "default", lane: "executor-step" })).toBeUndefined();
      expect(rotator.isCoolingDown(ref("default"))).toBe(false);
      expect(audit).not.toHaveBeenCalled();
    }
  });

  it("orders candidates deterministically and excludes cooling down refs", () => {
    const plan = createRotationPlan("anthropic", "b", [ref("c"), ref("a"), ref("b")], new Map([["anthropic[c]", 101]]), 100);
    expect(plan.candidates.map((candidate) => candidate.instanceId)).toEqual(["a"]);
    expect(plan.skippedCooldownInstanceIds).toEqual(["c"]);
  });

  it("emits immutable attempt, outcome, and exhaustion records for a real empty plan", async () => {
    let now = 100;
    const audit = vi.fn();
    const rotator = new CredentialInstanceRotator({ instanceSource: { listInstances: () => [ref("a"), ref("b")], getDefaultInstance: () => ref("a") }, now: () => now, recordRunAuditEvent: audit });
    rotator.markLimited(ref("b"));
    const event = await rotator.beginEvent({ providerId: "anthropic", startingInstanceId: "a", lane: "executor-step", taskId: "FN-1" });
    expect(event?.candidateCount).toBe(0);
    expect(await event?.next()).toBeUndefined();
    event?.finishExhausted(); event?.finishExhausted();
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls[0]).toEqual(["credential:instance-rotation-exhausted", expect.objectContaining({ instanceCount: 2, attemptedCount: 0, startingInstanceId: "a" })]);
    now += CREDENTIAL_INSTANCE_COOLDOWN_MS;
    expect(rotator.isCoolingDown(ref("b"))).toBe(false);
  });

  it("prunes elapsed cooldowns while planning a later multi-instance event", async () => {
    let now = 0;
    const rotator = new CredentialInstanceRotator({
      instanceSource: { listInstances: () => [ref("a"), ref("b")], getDefaultInstance: () => ref("a") },
      now: () => now,
    });
    rotator.markLimited(ref("b"));
    now += CREDENTIAL_INSTANCE_COOLDOWN_MS;
    await rotator.beginEvent({ providerId: "anthropic", startingInstanceId: "a", lane: "executor-step" });
    expect((rotator as unknown as { cooldowns: Map<string, number> }).cooldowns.size).toBe(0);
  });

  it("offers each candidate once and clears only the recovered provider", async () => {
    const rotator = new CredentialInstanceRotator({ instanceSource: { listInstances: () => [ref("a"), ref("b"), ref("c")], getDefaultInstance: () => ref("a") } });
    const event = await rotator.beginEvent({ providerId: "anthropic", startingInstanceId: "a", lane: "executor-agent" });
    expect((await event?.next())?.instanceId).toBe("b");
    expect((await event?.next())?.instanceId).toBe("c");
    expect(await event?.next()).toBeUndefined();
    expect(await event?.next()).toBeUndefined();
    rotator.markLimited(ref("b"));
    rotator.clearCooldowns("anthropic");
    expect(rotator.isCoolingDown(ref("b"))).toBe(false);
  });

  it("keeps attempt and terminal outcome immutable and ignores audit failures", async () => {
    const audit = vi.fn((type: string) => {
      if (type.endsWith("outcome")) throw new Error("audit unavailable");
    });
    const rotator = new CredentialInstanceRotator({
      instanceSource: { listInstances: () => [ref("a"), ref("b")], getDefaultInstance: () => ref("a") },
      recordRunAuditEvent: audit,
    });
    const event = await rotator.beginEvent({ providerId: "anthropic", startingInstanceId: "a", lane: "executor-agent", taskId: "FN-1" });
    await event?.next();
    event?.recordOutcome("rotation-succeeded");
    expect(audit.mock.calls).toEqual([
      ["credential:instance-rotation-attempt", {
        providerId: "anthropic", fromInstanceId: "a", toInstanceId: "b", attempt: 1,
        candidateCount: 1, outcome: "rotated", lane: "executor-agent", taskId: "FN-1",
      }],
      ["credential:instance-rotation-outcome", {
        providerId: "anthropic", toInstanceId: "b", attempt: 1, outcome: "rotation-succeeded",
        lane: "executor-agent", taskId: "FN-1",
      }],
    ]);
  });
});
