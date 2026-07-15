import { describe, expect, it, beforeEach } from "vitest";
import {
  getMaxConcurrentVerifications,
  getVerificationSemaphore,
  setMaxConcurrentVerifications,
  withVerificationSlot,
} from "../verification-concurrency.js";

describe("verification concurrency", () => {
  beforeEach(() => {
    setMaxConcurrentVerifications(1);
    // Drain any leaked active count from other tests (should be 0).
    getVerificationSemaphore().reconcileActiveCount(0);
  });

  it("defaults to one concurrent verification", () => {
    expect(getMaxConcurrentVerifications()).toBe(1);
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
});
