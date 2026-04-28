// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GenerationGuard, isAbortError, createAbortError } from "../ai-session-timeout.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GenerationGuard", () => {
  it("resolves with the operation result when it completes before the timeout", async () => {
    const guard = new GenerationGuard();
    const onTimeout = vi.fn();

    const result = await guard.run("s1", 1_000, { onTimeout }, async () => "ok");

    expect(result).toBe("ok");
    expect(onTimeout).not.toHaveBeenCalled();
    expect(guard.has("s1")).toBe(false);
  });

  it("fires onTimeout, aborts the operation, and rejects with AbortError when the timer fires", async () => {
    const guard = new GenerationGuard();
    const onTimeout = vi.fn();

    let opSettled = false;
    const promise = guard.run("s1", 1_000, { onTimeout }, async () => {
      // Simulate a hung prompt() that never resolves on its own.
      await new Promise<void>(() => { /* intentionally never resolves */ });
      opSettled = true;
      return "should-not-reach";
    });

    // Catch promise rejection now so it doesn't become unhandled when timers advance.
    const settled = promise.then(
      (v) => ({ ok: true as const, v }),
      (err) => ({ ok: false as const, err }),
    );

    await vi.advanceTimersByTimeAsync(1_000);
    const outcome = await settled;

    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? null : outcome.err).toSatisfy((err: unknown) => isAbortError(err));
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(opSettled).toBe(false);
    expect(guard.has("s1")).toBe(false);
  });

  it("fires onUserStop (not onTimeout) when stop() aborts before the timer", async () => {
    const guard = new GenerationGuard();
    const onTimeout = vi.fn();
    const onUserStop = vi.fn();

    const promise = guard.run("s1", 10_000, { onTimeout, onUserStop }, async () => {
      await new Promise<void>(() => { /* hang */ });
    });
    const settled = promise.then(
      () => ({ ok: true as const }),
      (err) => ({ ok: false as const, err }),
    );

    // Stop before the timer fires.
    expect(guard.stop("s1")).toBe(true);

    const outcome = await settled;
    expect(outcome.ok).toBe(false);
    expect(onTimeout).not.toHaveBeenCalled();
    expect(onUserStop).toHaveBeenCalledTimes(1);

    // Subsequent stop is a no-op.
    expect(guard.stop("s1")).toBe(false);
  });

  it("re-entrant run for the same id aborts the prior generation", async () => {
    const guard = new GenerationGuard();
    const firstUserStop = vi.fn();

    const first = guard.run(
      "s1",
      10_000,
      { onTimeout: vi.fn(), onUserStop: firstUserStop },
      async () => { await new Promise<void>(() => { /* hang */ }); },
    );
    const firstSettled = first.then(
      () => ({ ok: true as const }),
      (err) => ({ ok: false as const, err }),
    );

    const second = guard.run("s1", 10_000, { onTimeout: vi.fn() }, async () => "fresh");

    await expect(second).resolves.toBe("fresh");
    const firstOutcome = await firstSettled;
    expect(firstOutcome.ok).toBe(false);
    // Re-entrant cancellation goes through the internal cancel path, not the
    // user-facing stop, so onUserStop is intentionally not fired for the
    // displaced generation. The displaced caller still observes AbortError.
    expect(firstUserStop).not.toHaveBeenCalled();
    expect(guard.has("s1")).toBe(false);
  });

  it("reset() aborts every active generation", async () => {
    const guard = new GenerationGuard();

    const a = guard.run("a", 10_000, { onTimeout: vi.fn() }, async () => {
      await new Promise<void>(() => { /* hang */ });
    });
    const b = guard.run("b", 10_000, { onTimeout: vi.fn() }, async () => {
      await new Promise<void>(() => { /* hang */ });
    });
    const aSettled = a.catch((err) => err);
    const bSettled = b.catch((err) => err);

    guard.reset();

    expect(isAbortError(await aSettled)).toBe(true);
    expect(isAbortError(await bSettled)).toBe(true);
    expect(guard.has("a")).toBe(false);
    expect(guard.has("b")).toBe(false);
  });

  it("createAbortError is identifiable via isAbortError", () => {
    expect(isAbortError(createAbortError())).toBe(true);
    expect(isAbortError(new Error("other"))).toBe(false);
    expect(isAbortError("not an error")).toBe(false);
  });
});
