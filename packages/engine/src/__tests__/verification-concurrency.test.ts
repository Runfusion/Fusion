import { describe, expect, it, beforeEach } from "vitest";
import {
  clampMaxConcurrentVerifications,
  getMaxConcurrentVerifications,
  getVerificationSemaphore,
  MAX_CONCURRENT_VERIFICATIONS_HARD_CAP,
  registerProjectVerificationLimit,
  resetVerificationLimitRegistryForTests,
  setMaxConcurrentVerifications,
  unregisterProjectVerificationLimit,
  withVerificationSlot,
} from "../verification-concurrency.js";

describe("verification concurrency", () => {
  beforeEach(() => {
    resetVerificationLimitRegistryForTests();
    setMaxConcurrentVerifications(1);
    // Drain any leaked active count from other tests (should be 0).
    getVerificationSemaphore().reconcileActiveCount(0);
  });

  it("defaults to one concurrent verification", () => {
    expect(getMaxConcurrentVerifications()).toBe(1);
  });

  it("clamps limit to 1–8", () => {
    expect(clampMaxConcurrentVerifications(0)).toBe(1);
    expect(clampMaxConcurrentVerifications(-3)).toBe(1);
    expect(clampMaxConcurrentVerifications(50)).toBe(MAX_CONCURRENT_VERIFICATIONS_HARD_CAP);
    expect(clampMaxConcurrentVerifications(3.9)).toBe(3);
    setMaxConcurrentVerifications(99);
    expect(getMaxConcurrentVerifications()).toBe(8);
  });

  it("uses the minimum of registered project limits (most restrictive wins)", () => {
    registerProjectVerificationLimit("proj-a", 8);
    registerProjectVerificationLimit("proj-b", 1);
    expect(getMaxConcurrentVerifications()).toBe(1);
    unregisterProjectVerificationLimit("proj-b");
    expect(getMaxConcurrentVerifications()).toBe(8);
    unregisterProjectVerificationLimit("proj-a");
    setMaxConcurrentVerifications(2);
    expect(getMaxConcurrentVerifications()).toBe(2);
  });

  it("serializes overlapping withVerificationSlot callers when limit is 1", async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = withVerificationSlot(async () => {
      order.push("first-enter");
      await firstGate;
      order.push("first-exit");
    });

    // Let first acquire the slot.
    await Promise.resolve();
    await Promise.resolve();

    const second = withVerificationSlot(async () => {
      order.push("second");
    });

    // Second must not run while first holds the only slot.
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["first-enter"]);

    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-enter", "first-exit", "second"]);
  });

  it("allows two concurrent slots when limit is 2", async () => {
    setMaxConcurrentVerifications(2);
    let concurrent = 0;
    let peak = 0;

    await Promise.all(
      [1, 2].map(() =>
        withVerificationSlot(async () => {
          concurrent++;
          peak = Math.max(peak, concurrent);
          await new Promise((r) => setTimeout(r, 20));
          concurrent--;
        }),
      ),
    );

    expect(peak).toBe(2);
  });

  it("rejects with AbortError when aborted while queued for a slot", async () => {
    setMaxConcurrentVerifications(1);
    let releaseHolder!: () => void;
    const holderGate = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });

    const holder = withVerificationSlot(async () => {
      await holderGate;
    });
    await Promise.resolve();
    await Promise.resolve();

    const ac = new AbortController();
    const waiting = withVerificationSlot(async () => "ran", ac.signal);
    await Promise.resolve();
    await Promise.resolve();
    ac.abort();

    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    releaseHolder();
    await holder;
  });
});
