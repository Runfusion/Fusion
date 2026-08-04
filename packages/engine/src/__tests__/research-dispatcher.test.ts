import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResearchRun, ResearchStore } from "@fusion/core";
import type { ResearchOrchestrator } from "../research/research-orchestrator.js";
import { ResearchRunDispatcher } from "../research/research-dispatcher.js";

/*
FNXC:ResearchDispatcher 2026-08-04-00:03:
This is a pure timer-driven polling unit test (no subprocess, no network), so it uses
FAKE TIMERS instead of real `sleep()` waits per AGENTS.md "Do Not Add Slow Tests" /
"Prefer fake timers over real polling/time waits". The previous real-sleep version was
both slow (~200ms of wall-clock waits) AND weaker: the dispatcher clamps tickIntervalMs
to a 100ms floor, so 30-40ms real sleeps never let the interval re-fire — only the
immediate `void this.tick()` in start() ran. The double-dispatch and stop-cancels-timer
cases therefore never exercised a SECOND tick. Advancing fake timers past the 100ms
interval now deterministically fires follow-up ticks, so those invariants are genuinely
asserted. stop()'s drain loop only spins when inFlight is non-empty, so every test drains
inFlight (immediate/resolved runs) before stop, keeping the fake-timer clock from stalling
in that real-`setTimeout` loop.
*/
describe("ResearchRunDispatcher", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function createStore(runs: ResearchRun[]): ResearchStore {
    return {
      listRuns: vi.fn(() => runs),
    } as unknown as ResearchStore;
  }

  it("dispatches queued runs", async () => {
    vi.useFakeTimers();
    const runs = [{ id: "RR-1", query: "hello", status: "queued" } as ResearchRun];
    const store = createStore(runs);
    const startRun = vi.fn(async () => ({ id: "RR-1" } as ResearchRun));
    const orchestrator = { startRun } as unknown as ResearchOrchestrator;

    const dispatcher = new ResearchRunDispatcher({ store, orchestrator, tickIntervalMs: 10 });
    dispatcher.start();
    // Flush the immediate `void this.tick()` chain (await listRuns -> startRun).
    await vi.advanceTimersByTimeAsync(0);

    expect(startRun).toHaveBeenCalledWith("RR-1", "hello", expect.objectContaining({ abortSignal: expect.any(AbortSignal) }));
    await dispatcher.stop();
  });

  it("does not double-dispatch in-flight runs", async () => {
    vi.useFakeTimers();
    const runs = [{ id: "RR-1", query: "hello", status: "queued" } as ResearchRun];
    const store = createStore(runs);
    let resolveRun: (() => void) | undefined;
    const startRun = vi.fn(() => new Promise<ResearchRun>((resolve) => {
      resolveRun = () => resolve({ id: "RR-1" } as ResearchRun);
    }));
    const orchestrator = { startRun } as unknown as ResearchOrchestrator;

    const dispatcher = new ResearchRunDispatcher({ store, orchestrator, tickIntervalMs: 10 });
    dispatcher.start();
    // Immediate tick dispatches RR-1 and marks it in-flight (startRun stays pending).
    await vi.advanceTimersByTimeAsync(0);
    expect(startRun).toHaveBeenCalledTimes(1);

    // Fire a follow-up interval tick (100ms floor): the in-flight guard must skip RR-1.
    await vi.advanceTimersByTimeAsync(100);
    expect(startRun).toHaveBeenCalledTimes(1);

    resolveRun?.();
    await vi.advanceTimersByTimeAsync(0);
    await dispatcher.stop();
  });

  it("survives startRun rejection", async () => {
    vi.useFakeTimers();
    const runs = [{ id: "RR-1", query: "hello", status: "queued" } as ResearchRun];
    const store = createStore(runs);
    const startRun = vi.fn(async () => {
      throw new Error("boom");
    });
    const orchestrator = { startRun } as unknown as ResearchOrchestrator;

    const dispatcher = new ResearchRunDispatcher({ store, orchestrator, tickIntervalMs: 10 });
    dispatcher.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(startRun).toHaveBeenCalled();
    await dispatcher.stop();
  });

  it("stop cancels timer", async () => {
    vi.useFakeTimers();
    const runs = [{ id: "RR-1", query: "hello", status: "queued" } as ResearchRun];
    const store = createStore(runs);
    const startRun = vi.fn(async () => ({ id: "RR-1" } as ResearchRun));
    const orchestrator = { startRun } as unknown as ResearchOrchestrator;

    const dispatcher = new ResearchRunDispatcher({ store, orchestrator, tickIntervalMs: 10 });
    dispatcher.start();
    await vi.advanceTimersByTimeAsync(0);
    await dispatcher.stop();

    const callsAfterStop = startRun.mock.calls.length;
    // Advancing well past several intervals must produce no further ticks once stopped.
    await vi.advanceTimersByTimeAsync(300);
    expect(startRun).toHaveBeenCalledTimes(callsAfterStop);
  });
});
