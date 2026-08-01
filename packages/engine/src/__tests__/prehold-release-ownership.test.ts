import { describe, expect, it } from "vitest";
import {
  AgentSemaphore,
  registerPreHeldExecutorSlot,
  takePreHeldExecutorSlot,
  dropPreHeldExecutorSlot,
  clearPreHeldExecutorSlotsForTests,
} from "../concurrency.js";

/*
FNXC:CapacityModel 2026-07-29-17:10 (PR #2574 review — greptile P1):
A drop AFTER a successful transfer must not release a slot it no longer owns.

The two-argument form released the semaphore inside the "did I actually drop
anything?" guard, so a cleanup call following `takePreHeldExecutorSlot` was
intentionally inert — the transferred slot belongs to the lane, which releases it
through `semaphore.run`. Hoisting the release to the call site unconditionally
released a slot the call never held, INFLATING capacity: the opposite of the leak
the cleanup exists to prevent, and invisible because an over-released semaphore
simply admits more work.
*/
describe("pre-held slot release ownership", () => {
  it("reports false after a transfer, so the caller does not double-release", () => {
    clearPreHeldExecutorSlotsForTests();
    const sem = new AgentSemaphore(2);
    expect(sem.tryAcquire()).toBe(true);
    registerPreHeldExecutorSlot("FN-XFER");

    // The lane takes ownership; it will release via its own finally / semaphore.run.
    expect(takePreHeldExecutorSlot("FN-XFER")).toBe(true);

    // The outer cleanup still runs. It must report that it dropped NOTHING.
    const dropped = dropPreHeldExecutorSlot("FN-XFER");
    expect(dropped).toBe(false);

    // Mirrors the call-site guard: release only when the drop acted.
    if (dropped) sem.release();
    expect(sem.activeCount, "the lane still owns its slot").toBe(1);

    sem.release();
    expect(sem.activeCount).toBe(0);
    clearPreHeldExecutorSlotsForTests();
  });

  it("reports true for an untransferred slot, so the caller does release", () => {
    clearPreHeldExecutorSlotsForTests();
    const sem = new AgentSemaphore(2);
    expect(sem.tryAcquire()).toBe(true);
    registerPreHeldExecutorSlot("FN-EARLY-FAIL");

    const dropped = dropPreHeldExecutorSlot("FN-EARLY-FAIL");
    expect(dropped).toBe(true);
    if (dropped) sem.release();
    expect(sem.activeCount, "an early failure returns its untransferred slot").toBe(0);
    clearPreHeldExecutorSlotsForTests();
  });

  it("reports false when nothing was ever registered", () => {
    clearPreHeldExecutorSlotsForTests();
    expect(dropPreHeldExecutorSlot("FN-NEVER")).toBe(false);
  });
});
