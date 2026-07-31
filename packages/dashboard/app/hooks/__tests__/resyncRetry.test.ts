import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createResyncRetryRunner, DEFAULT_RESYNC_RETRY_DELAYS_MS } from "../resyncRetry";

/*
FNXC:SseResync 2026-07-26-19:40:
The invariant under test is "a failed reconnect resync retries a BOUNDED number of times and then
reports degradation" — the property every resync handler relies on. The previous behavior (catch and
do nothing, waiting for a reconnect that may never come) is asserted against explicitly.
*/
describe("createResyncRetryRunner", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs once when the attempt succeeds", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const runner = createResyncRetryRunner({ run, delaysMs: [10, 20] });

    runner.trigger();
    await vi.advanceTimersByTimeAsync(100);

    expect(run).toHaveBeenCalledTimes(1);
  });

  it("retries a failed attempt on the configured ladder and stops when it succeeds", async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(undefined);
    const runner = createResyncRetryRunner({ run, delaysMs: [10, 20] });

    runner.trigger();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10);
    expect(run).toHaveBeenCalledTimes(2);

    // Second attempt succeeded: the ladder stops, it does not keep retrying.
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("stops after the ladder is exhausted and reports degradation exactly once", async () => {
    const run = vi.fn().mockRejectedValue(new Error("offline"));
    const onExhausted = vi.fn();
    const runner = createResyncRetryRunner({ run, delaysMs: [10, 20], onExhausted });

    runner.trigger();
    await vi.advanceTimersByTimeAsync(1000);

    // 1 initial attempt + 2 retries, then STOP — bounded, never an unbounded hammer.
    expect(run).toHaveBeenCalledTimes(3);
    expect(onExhausted).toHaveBeenCalledTimes(1);
  });

  it("clears degradation on the first success after an exhausted ladder", async () => {
    const run = vi.fn().mockRejectedValue(new Error("offline"));
    const onExhausted = vi.fn();
    const onRecovered = vi.fn();
    const runner = createResyncRetryRunner({ run, delaysMs: [10], onExhausted, onRecovered });

    runner.trigger();
    await vi.advanceTimersByTimeAsync(1000);
    expect(onExhausted).toHaveBeenCalledTimes(1);
    expect(onRecovered).not.toHaveBeenCalled();

    run.mockResolvedValue(undefined);
    runner.trigger();
    await vi.advanceTimersByTimeAsync(0);

    expect(onRecovered).toHaveBeenCalledTimes(1);
  });

  it("a new trigger supersedes a pending retry instead of stacking attempts", async () => {
    const run = vi.fn().mockRejectedValue(new Error("offline"));
    const runner = createResyncRetryRunner({ run, delaysMs: [100] });

    runner.trigger();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);

    runner.trigger();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(2);

    // The superseded retry timer must not fire a third attempt.
    await vi.advanceTimersByTimeAsync(100);
    expect(run).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("does not overlap attempts while one is in flight", async () => {
    let resolveRun: (() => void) | undefined;
    const run = vi.fn(() => new Promise<void>((resolve) => { resolveRun = () => resolve(); }));
    const runner = createResyncRetryRunner({ run, delaysMs: [10] });

    runner.trigger();
    runner.trigger();
    runner.trigger();
    await vi.advanceTimersByTimeAsync(0);

    expect(run).toHaveBeenCalledTimes(1);
    resolveRun?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("dispose cancels pending retries and suppresses callbacks", async () => {
    const run = vi.fn().mockRejectedValue(new Error("offline"));
    const onExhausted = vi.fn();
    const runner = createResyncRetryRunner({ run, delaysMs: [10], onExhausted });

    runner.trigger();
    await vi.advanceTimersByTimeAsync(0);
    runner.dispose();

    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(1);
    expect(onExhausted).not.toHaveBeenCalled();
  });

  it("defaults to a two-retry ladder", () => {
    expect(DEFAULT_RESYNC_RETRY_DELAYS_MS).toHaveLength(2);
  });
});
